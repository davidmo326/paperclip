/**
 * Conflict tracking for M2 fields — T-2.7 / PRD § 9.4 + § 15.2 tripwire 4.
 *
 * When two agent writes target the same field with *different* sourceRefs[],
 * the field enters a `conflict` quarantine: agents may not write to it until
 * either a human-asserted write resolves the conflict, or a higher-priority
 * source rule discriminates between candidates.
 *
 * Conflict state lives **side-band** in plugin_state[conflicts.v1] per
 * project, keyed by field path. This avoids retroactively extending the
 * T-1.3 ProjectControlPlaneState schema with per-field provenance (which
 * would be a bigger lift); the brief generator (T-3.x) reads the overlay
 * alongside canonical state to decorate conflicted fields.
 *
 * Pure functions only. Adapter wiring (read/write plugin_state, emit events)
 * lives in src/lib/write-m2-guarded.ts.
 */

import type { SourceRef } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One competing claim for a conflicted field. */
export interface ConflictCandidate {
  /** Actor who wrote this value (`principal` or `agent:<id>`). */
  actor: string;
  /** Snapshot of the value the actor proposed. Stored as JSON for diffability. */
  value: unknown;
  /** Sources backing this candidate. */
  sourceRefs: SourceRef[];
  /** Confidence at time of write. */
  confidence: number;
  /** When the candidate was recorded (ISO 8601). */
  recordedAt: string;
}

/** Per-field conflict record. Lives at `conflicts.v1.byField[fieldPath]`. */
export interface ConflictRecord {
  /** e.g. `nextSmallestAction`, `currentStatus`. Single-level for now. */
  fieldPath: string;
  /** When the conflict was first detected. */
  createdAt: string;
  /** When the conflict was resolved (null until then). */
  resolvedAt: string | null;
  /** Actor that resolved it (only set when resolvedAt is non-null). */
  resolvedBy: string | null;
  /** The two-or-more competing claims. Always ≥2 while unresolved. */
  candidates: ConflictCandidate[];
}

/** Whole-project conflict map. The value at plugin_state[conflicts.v1]. */
export interface ProjectConflictsState {
  /** Project this map belongs to. */
  projectId: string;
  /** When this map was last updated. */
  updatedAt: string;
  /** Conflict records keyed by field path. Resolved ones are kept for audit. */
  byField: Record<string, ConflictRecord>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two SourceRef arrays by their (path, hash) signatures. Order is
 * not significant. Two refs with the same path but different hashes are
 * treated as *different* (they cite different versions of the same file).
 */
export function sourceRefsEqual(
  a: readonly SourceRef[],
  b: readonly SourceRef[],
): boolean {
  if (a.length !== b.length) return false;
  const sig = (refs: readonly SourceRef[]) =>
    refs
      .map((r) => `${r.path}:${r.hash.toLowerCase()}`)
      .sort()
      .join("|");
  return sig(a) === sig(b);
}

/** True iff the field is currently in conflict (record exists and unresolved). */
export function isFieldConflicted(
  state: ProjectConflictsState | null | undefined,
  fieldPath: string,
): boolean {
  if (!state) return false;
  const rec = state.byField[fieldPath];
  return rec != null && rec.resolvedAt === null;
}

/** Read-only summary: which fields are currently quarantined? */
export function listConflictedFields(
  state: ProjectConflictsState | null | undefined,
): string[] {
  if (!state) return [];
  return Object.keys(state.byField).filter(
    (k) => state.byField[k].resolvedAt === null,
  );
}

// ---------------------------------------------------------------------------
// Mutations (pure — return new state, never mutate input)
// ---------------------------------------------------------------------------

export interface DetectInput {
  projectId: string;
  fieldPath: string;
  /** The new value being written (this write's claim). */
  newValue: unknown;
  /** SourceRefs from the new write. */
  newSourceRefs: SourceRef[];
  /** Actor of the new write. */
  newActor: string;
  /** Confidence of the new write. */
  newConfidence: number;
  /** The value currently accepted (null = first write to this field). */
  priorValue: unknown;
  /** Sources backing the prior accepted value (null = unknown / unrecorded). */
  priorSourceRefs: SourceRef[] | null;
  /** Actor that wrote the prior value (null if unknown). */
  priorActor: string | null;
  /** Existing conflict state, if any. */
  existingState: ProjectConflictsState | null;
  /** Current timestamp (overridable for tests). */
  now: string;
}

export type DetectResult =
  | { kind: "no_conflict" }
  | {
      kind: "conflict_created";
      state: ProjectConflictsState;
      record: ConflictRecord;
    }
  | {
      kind: "conflict_widened";
      state: ProjectConflictsState;
      record: ConflictRecord;
    }
  | { kind: "already_conflicted"; record: ConflictRecord };

/**
 * Detect a conflict between the new write and existing state.
 *
 *  - If the field is already conflicted and unresolved → `already_conflicted`
 *    (caller should reject this write).
 *  - If `priorSourceRefs` is null (unknown), or matches `newSourceRefs`
 *    by signature → no conflict, write proceeds.
 *  - Otherwise → create or widen a conflict record.
 *
 * Pure: does not write to anything; returns the new state for the caller to persist.
 */
export function detectConflict(input: DetectInput): DetectResult {
  const existingRec = input.existingState?.byField[input.fieldPath];
  if (existingRec && existingRec.resolvedAt === null) {
    return { kind: "already_conflicted", record: existingRec };
  }

  // No prior recorded sources → first agent write to this field; no conflict.
  if (input.priorSourceRefs === null) {
    return { kind: "no_conflict" };
  }
  // Sources match → same evidence basis; no conflict.
  if (sourceRefsEqual(input.newSourceRefs, input.priorSourceRefs)) {
    return { kind: "no_conflict" };
  }

  // We have a conflict. Build or extend a record.
  const newCandidate: ConflictCandidate = {
    actor: input.newActor,
    value: input.newValue,
    sourceRefs: input.newSourceRefs,
    confidence: input.newConfidence,
    recordedAt: input.now,
  };

  if (existingRec && existingRec.resolvedAt !== null) {
    // Previously resolved; treat as a fresh conflict starting over.
    const priorCandidate: ConflictCandidate = {
      actor: input.priorActor ?? "unknown",
      value: input.priorValue,
      sourceRefs: input.priorSourceRefs,
      confidence: 0,
      recordedAt: input.now,
    };
    const newRecord: ConflictRecord = {
      fieldPath: input.fieldPath,
      createdAt: input.now,
      resolvedAt: null,
      resolvedBy: null,
      candidates: [priorCandidate, newCandidate],
    };
    return {
      kind: "conflict_created",
      record: newRecord,
      state: applyRecord(input.existingState, input.projectId, newRecord, input.now),
    };
  }

  // No existing record at all: a fresh first-time conflict.
  const priorCandidate: ConflictCandidate = {
    actor: input.priorActor ?? "unknown",
    value: input.priorValue,
    sourceRefs: input.priorSourceRefs,
    confidence: 0,
    recordedAt: input.now,
  };
  const newRecord: ConflictRecord = {
    fieldPath: input.fieldPath,
    createdAt: input.now,
    resolvedAt: null,
    resolvedBy: null,
    candidates: [priorCandidate, newCandidate],
  };
  return {
    kind: "conflict_created",
    record: newRecord,
    state: applyRecord(input.existingState, input.projectId, newRecord, input.now),
  };
}

/**
 * Resolve a conflict via a human-asserted write. Returns the new conflict state
 * with the field's record marked resolved. If the field wasn't conflicted,
 * returns the input unchanged with `kind: 'no_op'`.
 */
export interface ResolveInput {
  projectId: string;
  fieldPath: string;
  /** Actor doing the resolution. Must be `principal` or `agent:*`, but tripwire 4 only allows `human_asserted`. */
  resolverActor: string;
  /** When the resolution happened. */
  now: string;
  existingState: ProjectConflictsState | null;
}

export type ResolveResult =
  | { kind: "no_op" }
  | { kind: "resolved"; state: ProjectConflictsState; record: ConflictRecord };

export function resolveConflict(input: ResolveInput): ResolveResult {
  const existing = input.existingState;
  if (!existing) return { kind: "no_op" };
  const rec = existing.byField[input.fieldPath];
  if (!rec || rec.resolvedAt !== null) return { kind: "no_op" };

  const resolvedRecord: ConflictRecord = {
    ...rec,
    resolvedAt: input.now,
    resolvedBy: input.resolverActor,
  };
  return {
    kind: "resolved",
    record: resolvedRecord,
    state: applyRecord(existing, input.projectId, resolvedRecord, input.now),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyRecord(
  existing: ProjectConflictsState | null,
  projectId: string,
  record: ConflictRecord,
  now: string,
): ProjectConflictsState {
  const base: ProjectConflictsState = existing ?? {
    projectId,
    updatedAt: now,
    byField: {},
  };
  return {
    projectId: base.projectId,
    updatedAt: now,
    byField: { ...base.byField, [record.fieldPath]: record },
  };
}
