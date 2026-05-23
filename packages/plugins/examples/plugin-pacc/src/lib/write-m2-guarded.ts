/**
 * writeM2Guarded — T-2.7 conflict-aware wrapper around writeM2.
 *
 * Three behaviours layered on top of writeM2:
 *
 *   1. **Pre-check quarantine.** If any field in a `projectState` patch is
 *      currently quarantined (an unresolved conflict record), the write is
 *      rejected and returned as `{ kind: 'rejected_conflict', conflicts }`.
 *      Agents do NOT throw on conflicts — they observe the result.
 *
 *   2. **Detect new conflicts.** For each field in the patch, if a prior
 *      accepted value with *different* sourceRefs exists, record a conflict
 *      and skip the underlying write for that field.
 *
 *   3. **Resolve conflicts on human-asserted writes.** If the new write has
 *      `confidenceSource === 'human_asserted'`, it bypasses the quarantine
 *      AND resolves any existing conflict on those fields.
 *
 * Decision and AuthorityProfile ops are inherently append-only and don't
 * have field-level conflicts; they delegate straight to writeM2.
 */

import { writeM2, type WriteM2Adapter, type WriteM2Op, type WriteM2Opts } from "./write-m2.js";
import {
  detectConflict,
  isFieldConflicted,
  resolveConflict,
  type ConflictRecord,
  type ProjectConflictsState,
} from "./conflict.js";
import type { SourceRef } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-field provenance hint provided by the caller for conflict detection. */
export interface PriorFieldState {
  value: unknown;
  sourceRefs: SourceRef[] | null;
  actor: string | null;
}

export interface GuardedDeps {
  adapter: WriteM2Adapter;
  /** Read the project's current conflict state from plugin_state[conflicts.v1]. */
  readConflicts(projectId: string): Promise<ProjectConflictsState | null>;
  /** Persist the new conflict state to plugin_state[conflicts.v1]. */
  writeConflicts(projectId: string, state: ProjectConflictsState): Promise<void>;
  /**
   * Provide prior accepted state for the fields in this patch. Implementations
   * read controlPlaneState + a provenance side-channel (if any). Returning an
   * empty map disables conflict-detection for that write (first-write case).
   */
  readPriorFieldState(
    projectId: string,
    fields: readonly string[],
  ): Promise<Record<string, PriorFieldState>>;
  /** Optional event sink for conflict lifecycle events (memory.conflict.created/resolved). */
  emitConflictEvent?(event: ConflictEvent): Promise<void>;
}

export type ConflictEvent =
  | { kind: "memory.conflict.created"; projectId: string; record: ConflictRecord }
  | { kind: "memory.conflict.resolved"; projectId: string; record: ConflictRecord };

export type GuardedResult =
  | { kind: "success" }
  | {
      kind: "rejected_conflict";
      conflictedFields: string[];
    }
  | {
      kind: "partial";
      written: string[];
      conflicted: ConflictRecord[];
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write through the conflict-aware mediator. Decision and AuthorityProfile
 * ops short-circuit to writeM2 unchanged. ProjectState ops go through the
 * field-by-field guard.
 */
export async function writeM2Guarded(
  op: WriteM2Op,
  opts: WriteM2Opts,
  deps: GuardedDeps,
): Promise<GuardedResult> {
  if (op.kind !== "projectState") {
    await writeM2(op, opts, deps.adapter);
    return { kind: "success" };
  }

  const projectId = op.projectId;
  const isHumanAsserted = opts.confidenceSource === "human_asserted";
  const fields = Object.keys(op.patch);
  const now = new Date().toISOString();

  let conflictsState = await deps.readConflicts(projectId);

  // (1) Pre-check quarantine — agent writes blocked on conflicted fields.
  if (!isHumanAsserted) {
    const quarantined = fields.filter((f) => isFieldConflicted(conflictsState, f));
    if (quarantined.length > 0) {
      return { kind: "rejected_conflict", conflictedFields: quarantined };
    }
  }

  const prior = await deps.readPriorFieldState(projectId, fields);

  // (3) Human-asserted writes resolve any existing conflicts on their fields
  //     before dispatch, so the resolved state is durable even if the underlying
  //     write fails downstream.
  if (isHumanAsserted) {
    for (const field of fields) {
      const result = resolveConflict({
        projectId,
        fieldPath: field,
        resolverActor: opts.actor,
        now,
        existingState: conflictsState,
      });
      if (result.kind === "resolved") {
        conflictsState = result.state;
        await deps.writeConflicts(projectId, conflictsState);
        if (deps.emitConflictEvent) {
          await deps.emitConflictEvent({
            kind: "memory.conflict.resolved",
            projectId,
            record: result.record,
          });
        }
      }
    }
    // Dispatch the underlying write through writeM2 (validation, audit, etc.)
    await writeM2(op, opts, deps.adapter);
    return { kind: "success" };
  }

  // (2) Detect new conflicts on each field.
  const writable: Record<string, unknown> = {};
  const newConflicts: ConflictRecord[] = [];

  for (const field of fields) {
    const priorState = prior[field];
    const detect = detectConflict({
      projectId,
      fieldPath: field,
      newValue: op.patch[field],
      newSourceRefs: opts.sourceRefs,
      newActor: opts.actor,
      newConfidence: opts.confidence,
      priorValue: priorState?.value ?? null,
      priorSourceRefs: priorState?.sourceRefs ?? null,
      priorActor: priorState?.actor ?? null,
      existingState: conflictsState,
      now,
    });

    if (detect.kind === "no_conflict") {
      writable[field] = op.patch[field];
    } else if (detect.kind === "already_conflicted") {
      // Defensive: pre-check should have caught this; surface anyway.
      newConflicts.push(detect.record);
    } else {
      // conflict_created (or conflict_widened in future)
      conflictsState = detect.state;
      await deps.writeConflicts(projectId, conflictsState);
      newConflicts.push(detect.record);
      if (deps.emitConflictEvent) {
        await deps.emitConflictEvent({
          kind: "memory.conflict.created",
          projectId,
          record: detect.record,
        });
      }
    }
  }

  // Dispatch only the writable subset (fields without conflicts).
  if (Object.keys(writable).length > 0) {
    await writeM2(
      { kind: "projectState", projectId, patch: writable },
      opts,
      deps.adapter,
    );
  }

  if (newConflicts.length === 0) {
    return { kind: "success" };
  }
  if (Object.keys(writable).length === 0) {
    // Every field hit a conflict; nothing was written.
    return {
      kind: "rejected_conflict",
      conflictedFields: newConflicts.map((r) => r.fieldPath),
    };
  }
  return {
    kind: "partial",
    written: Object.keys(writable),
    conflicted: newConflicts,
  };
}
