/**
 * Scheduled-steward orchestrator — T-4.8.
 *
 * Mirrors scheduled-brief.ts thread-for-thread:
 *
 *   1. pause check        — separate `steward_paused` flag (D-39 semantics,
 *                           shared 24h sightings window, steward-side flag)
 *   2. acquireLock        — overlap guard via plugin_state
 *   3. runSteward         — rehydration pack → StewardJournal (model or
 *                           deterministic state-diff)
 *   4. draft writes       — *.draft.md via the T-2.4 mediator (L1, § 9.6)
 *   5. renderStewardJournalMarkdown
 *   6. hallucination tripwire (D-39 — model-generated only self-pauses)
 *   7. writeObsidianBrief — 00_Daily/Steward Journal - YYYY-MM-DD.md
 *   8. emit `steward.journal.generated`
 *   9. releaseLock        — always, in finally
 *
 * Travel mode (D-46) needs no special path: the L0/L1 cap plus the
 * awaitingReturn queue IS travel mode. Documented in docs/steward-runbook.md.
 */

import { renderStewardJournalMarkdown } from "./render.js";
import { runSteward, type RunStewardOptions, type StewardDeps } from "./steward.js";
import {
  obsidianBriefExists,
  writeObsidianBrief,
  type ObsidianBriefWriteResult,
  type WriteObsidianBriefOptions,
} from "../briefer/obsidian-writer.js";
import {
  acquireLock,
  releaseLock,
  type AcquireLockResult,
  type OverlapGuardStore,
} from "../briefer/overlap-guard.js";
import {
  annotateHallucinations,
  appendSightings,
  countUniqueModelRefs,
  detectHallucinations,
  normalizeReference,
  pausedBriefMarkdown,
  pruneOldSightings,
  shouldPause,
  type HallucinationCounterState,
  type HallucinationSighting,
} from "../briefer/hallucination.js";
import type { HallucinationDeps } from "../briefer/scheduled-brief.js";

export const STEWARD_JOURNAL_GENERATED_EVENT = "steward.journal.generated";
export const STEWARD_SELF_PAUSED_EVENT = "agent.self_paused";

export const STEWARD_JOURNAL_FILENAME_PREFIX = "Steward Journal - ";

export interface ScheduledStewardDeps {
  steward: StewardDeps;
  lock: OverlapGuardStore;
  emitEvent(name: string, payload: Record<string, unknown>): Promise<void>;
  logger: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error?(msg: string, fields?: Record<string, unknown>): void;
  };
  /** D-39 tripwire — separate steward pause flag, shared sightings window. */
  hallucination?: HallucinationDeps;
}

export interface RunScheduledStewardOptions {
  now?: Date;
  runId?: string;
  obsidianBaseDir?: string;
  lockStaleAfterMs?: number;
  obsidianGuard?: WriteObsidianBriefOptions["guard"];
  stewardOptions?: RunStewardOptions;
}

export type ScheduledStewardResult =
  | {
      kind: "completed";
      obsidianWrite: ObsidianBriefWriteResult;
      lockOutcome: Extract<AcquireLockResult, { acquired: true }>;
      hallucinationFlagCount: number;
      selfPaused: boolean;
    }
  | {
      kind: "skipped_overlap";
      reason: string;
      existingLock: Extract<AcquireLockResult, { acquired: false }>["existingLock"];
      ageMs: number;
    }
  | {
      kind: "skipped_paused";
      reason: string;
      obsidianWrite: ObsidianBriefWriteResult;
    }
  | {
      kind: "failed";
      error: string;
    };

const DEFAULT_OBSIDIAN_DIR =
  process.env.HOME ?
    `${process.env.HOME}/llm_shared/Obsidian/00_Daily`
  : "./Obsidian/00_Daily";

export async function runScheduledSteward(
  deps: ScheduledStewardDeps,
  options: RunScheduledStewardOptions = {},
): Promise<ScheduledStewardResult> {
  const now = options.now ?? new Date();
  const obsidianBaseDir = options.obsidianBaseDir ?? DEFAULT_OBSIDIAN_DIR;
  const journalDate = formatLocalDate(now);

  // 0. Self-pause check — steward's own flag, not the briefer's.
  if (deps.hallucination) {
    const pauseState = await deps.hallucination.isPaused();
    if (pauseState.paused) {
      const reason = pauseState.reason ?? "hallucination self-pause";
      const stub = pausedBriefMarkdown(journalDate, reason);
      const obsidianWrite = await writeObsidianBrief(stub, {
        baseDir: obsidianBaseDir,
        briefDate: journalDate,
        filenamePrefix: STEWARD_JOURNAL_FILENAME_PREFIX,
        guard: options.obsidianGuard,
      });
      deps.logger.warn("scheduled steward: self-paused; wrote stub journal", {
        runId: options.runId,
        reason,
        path: obsidianWrite.path,
      });
      return { kind: "skipped_paused", reason, obsidianWrite };
    }
  }

  // 1. Overlap guard.
  const lockResult = await acquireLock(deps.lock, {
    now,
    runId: options.runId ?? null,
    staleAfterMs: options.lockStaleAfterMs,
  });
  if (!lockResult.acquired) {
    const ageSeconds = Math.round(lockResult.ageMs / 1000);
    const reason = `steward run already in progress (lock acquired ${ageSeconds}s ago)`;
    deps.logger.info("scheduled steward: skipping overlap", {
      runId: options.runId,
      existingRunId: lockResult.existingLock.runId,
    });
    return {
      kind: "skipped_overlap",
      reason,
      existingLock: lockResult.existingLock,
      ageMs: lockResult.ageMs,
    };
  }
  if (lockResult.reason === "stale_lock_overwritten") {
    deps.logger.warn("scheduled steward: overwrote stale lock", { runId: options.runId });
  }

  try {
    // 2. Produce the journal.
    const journal = await runSteward(deps.steward, {
      ...options.stewardOptions,
      now,
      onSchemaViolation: (error) => {
        deps.logger.warn(`scheduled steward: model schema violation; journal degraded to deterministic — ${String(error).slice(0, 300)}`, {
          runId: options.runId,
          error,
        });
      },
    });

    // 3. Persist the journal (DB row) — before drafts so the diff baseline
    //    exists even if a draft write fails.
    await deps.steward.saveJournal(journal);

    // 4. Draft writes — *.draft.md through the mediator (validated paths
    //    already; containment + protected-path enforcement live in the guard).
    for (const draft of journal.drafts) {
      if (typeof draft.content !== "string") continue;
      try {
        await deps.steward.writeDraft(draft.path, draft.content);
      } catch (err) {
        deps.logger.warn("scheduled steward: draft write rejected", {
          runId: options.runId,
          path: draft.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Render.
    let markdown = renderStewardJournalMarkdown(journal);

    // 6. Hallucination tripwire (D-39). Grounding: project names + source
    //    refs from the journal itself are known by construction.
    let hallucinationFlagCount = 0;
    let selfPaused = false;
    if (deps.hallucination) {
      const modelGenerated = journal.modelGenerated;
      const sourcePaths = [...journal.attention.flatMap((a) => a.sourceRefs), ...journal.drafts.map((d) => d.path)];
      const groundingPhrases = [...journal.attention.map((a) => a.project), ...(deps.hallucination.groundingText ?? [])];
      const flags = detectHallucinations({
        briefMarkdown: markdown,
        knownIds: deps.hallucination.knownIds,
        sourcePaths,
        groundingPhrases,
        ignoreProseCompounds: true,
      });
      hallucinationFlagCount = flags.length;
      if (flags.length > 0) {
        markdown = annotateHallucinations(markdown, flags);
        for (const flag of flags) {
          await deps.emitEvent("agent.hallucination_flag", {
            journalDate,
            reference: flag.reference,
            kind: flag.kind,
            excerpt: flag.excerpt,
            modelGenerated,
            runId: options.runId ?? null,
          });
        }
        if (!modelGenerated) {
          deps.logger.warn(
            "scheduled steward: hallucination flags on a deterministic journal — warning only, never pauses (D-39)",
            { runId: options.runId, flagCount: flags.length },
          );
        }
        const newSightings: HallucinationSighting[] = flags.map((flag) => ({
          at: now.toISOString(),
          briefDate: journalDate,
          ref: normalizeReference(flag.reference),
          rawRef: flag.reference,
          modelGenerated,
        }));
        const prior = await deps.hallucination.readFlags();
        const updated = appendSightings(prior, newSightings, now, deps.hallucination.windowMs);
        await deps.hallucination.writeFlags(updated);
        if (modelGenerated) {
          const inWindow = pruneOldSightings(updated, now, deps.hallucination.windowMs);
          if (shouldPause(inWindow, deps.hallucination.pauseThreshold)) {
            selfPaused = true;
            const uniqueCount = countUniqueModelRefs(inWindow);
            const reason = `${uniqueCount} unique hallucinated reference(s) within window`;
            await deps.hallucination.setPaused(reason);
            await deps.emitEvent(STEWARD_SELF_PAUSED_EVENT, {
              reason,
              uniqueRefCount: uniqueCount,
              runId: options.runId ?? null,
            });
            deps.logger.warn("scheduled steward: self-paused on hallucination threshold", {
              runId: options.runId,
              uniqueRefCount: uniqueCount,
            });
          }
        }
      }
    }

    // 7. Idempotent Obsidian write.
    const obsidianWrite = await writeObsidianBrief(markdown, {
      baseDir: obsidianBaseDir,
      briefDate: journalDate,
      filenamePrefix: STEWARD_JOURNAL_FILENAME_PREFIX,
      guard: options.obsidianGuard,
    });
    deps.logger.info("scheduled steward: obsidian write", {
      runId: options.runId,
      path: obsidianWrite.path,
      kind: obsidianWrite.kind,
      byteLength: obsidianWrite.byteLength,
    });

    // 8. Emit event.
    await deps.emitEvent(STEWARD_JOURNAL_GENERATED_EVENT, {
      journalDate,
      generatedAt: journal.generatedAt,
      modelGenerated: journal.modelGenerated,
      attentionCount: journal.attention.length,
      awaitingReturnCount: journal.awaitingReturn.length,
      inputsCacheKey: journal.inputsCacheKey,
      obsidianPath: obsidianWrite.path,
      byteLength: obsidianWrite.byteLength,
      hallucinationFlagCount,
      runId: options.runId ?? null,
    });

    return {
      kind: "completed",
      obsidianWrite,
      lockOutcome: lockResult,
      hallucinationFlagCount,
      selfPaused,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error?.("scheduled steward: failed", { runId: options.runId, error: msg });
    return { kind: "failed", error: msg };
  } finally {
    // 9. Always release the lock.
    await releaseLock(deps.lock).catch((err) => {
      deps.logger.warn("scheduled steward: failed to release lock", {
        runId: options.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Missed-run check (plugin startup) — mirrors the brief's catch-up
// ---------------------------------------------------------------------------

export interface MissedStewardCheckOptions {
  now?: Date;
  /** Hour-of-day after which a missing journal triggers a catch-up. Default 8. */
  thresholdHourLocal?: number;
  obsidianBaseDir?: string;
}

export type MissedStewardCheckResult =
  | { shouldRun: false; reason: "journal_already_exists" | "too_early" }
  | { shouldRun: true; reason: "missed_run_catch_up"; journalDate: string };

export async function checkMissedStewardRun(
  options: MissedStewardCheckOptions = {},
): Promise<MissedStewardCheckResult> {
  const now = options.now ?? new Date();
  const thresholdHour = options.thresholdHourLocal ?? 8;
  const baseDir = options.obsidianBaseDir ?? DEFAULT_OBSIDIAN_DIR;

  if (now.getHours() < thresholdHour) {
    return { shouldRun: false, reason: "too_early" };
  }

  const journalDate = formatLocalDate(now);
  const exists = await obsidianBriefExists({
    baseDir,
    briefDate: journalDate,
    filenamePrefix: STEWARD_JOURNAL_FILENAME_PREFIX,
  });
  if (exists) {
    return { shouldRun: false, reason: "journal_already_exists" };
  }
  return { shouldRun: true, reason: "missed_run_catch_up", journalDate };
}

export interface MissedStewardCatchUpOptions {
  now?: Date;
  thresholdHourLocal?: number;
  obsidianBaseDir?: string;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  runner: (options: RunScheduledStewardOptions) => Promise<ScheduledStewardResult>;
  runnerOptions?: Partial<RunScheduledStewardOptions>;
}

export type MissedStewardCatchUpOutcome =
  | { ran: false; reason: "journal_already_exists" | "too_early" }
  | { ran: true; result: ScheduledStewardResult };

export async function runMissedStewardCatchUp(
  options: MissedStewardCatchUpOptions,
): Promise<MissedStewardCatchUpOutcome> {
  const check = await checkMissedStewardRun({
    now: options.now,
    thresholdHourLocal: options.thresholdHourLocal,
    obsidianBaseDir: options.obsidianBaseDir,
  });
  if (!check.shouldRun) {
    options.logger.info("steward missed-run check: no catch-up needed", { reason: check.reason });
    return { ran: false, reason: check.reason };
  }
  options.logger.warn("steward missed-run check: today's journal missing past threshold — running catch-up", {
    journalDate: check.journalDate,
  });
  const result = await options.runner({
    ...options.runnerOptions,
    now: options.now,
    runId: `missed-run-${check.journalDate}`,
    obsidianBaseDir: options.obsidianBaseDir,
  });
  return { ran: true, result };
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
