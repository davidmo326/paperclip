/**
 * Scheduled-steward orchestrator — T-4.8.
 *
 * Mirrors scheduled-brief.ts thread-for-thread:
 *
 *   1. pause check        — separate `steward_paused` flag (D-39 semantics,
 *                           shared 24h sightings window, steward-side flag);
 *                           a required dependency, and a paused day is
 *                           marked in the record's journal store (F-cos.0)
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

/**
 * The steward's own pause flag. Required, never optional: a guard that sits
 * inside an optional dependency fails open when the dependency is left out
 * (the 27 Oct finding). Principle: the guards fail closed at the seams.
 */
export interface StewardPauseDeps {
  isPaused(): Promise<{ paused: boolean; reason: string | null }>;
}

/**
 * The record's own journal store (plugin_state, namespace = journal date).
 * The vault is input only (`PACC_VAULT_WRITES` off), so a vault file can never
 * say whether today ran; the record can. Principle: the record is the one home
 * of truth for what the steward did.
 */
export interface StewardJournalStoreDeps {
  /** True when the store holds today's journal or a "paused today" marker. */
  journalExists(journalDate: string): Promise<boolean>;
  /** Mark the day as paused so a restart later that day never re-runs it. */
  markPausedDay(journalDate: string, reason: string): Promise<void>;
}

export interface ScheduledStewardDeps {
  steward: StewardDeps;
  /** Required (F-cos.0): a missing one throws, never skips the check. */
  paused: StewardPauseDeps;
  /** Required (F-cos.0): where the missed-run check and the paused marker live. */
  journalStore: StewardJournalStoreDeps;
  lock: OverlapGuardStore;
  emitEvent(name: string, payload: Record<string, unknown>): Promise<void>;
  logger: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error?(msg: string, fields?: Record<string, unknown>): void;
  };
  /** D-39 tripwire — shared sightings window. Optional; the pause check is not part of it. */
  hallucination?: HallucinationDeps;
}

/**
 * Throw when the pause check or the journal store is missing. Called where the
 * deps are built and again at the top of every run, so a caller that forgets
 * them gets an error, never a run that skipped the pause.
 */
export function assertScheduledStewardDeps(deps: ScheduledStewardDeps): void {
  const d = deps as Partial<ScheduledStewardDeps> | null | undefined;
  if (!d || typeof d.paused?.isPaused !== "function") {
    throw new Error("scheduled steward: the pause check is a required dependency (deps.paused.isPaused)");
  }
  if (typeof d.journalStore?.journalExists !== "function" || typeof d.journalStore?.markPausedDay !== "function") {
    throw new Error(
      "scheduled steward: the journal store is a required dependency (deps.journalStore.journalExists / markPausedDay)",
    );
  }
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
  assertScheduledStewardDeps(deps);
  const now = options.now ?? new Date();
  const obsidianBaseDir = options.obsidianBaseDir ?? DEFAULT_OBSIDIAN_DIR;
  const journalDate = formatLocalDate(now);

  // 0. Self-pause check — steward's own flag, not the briefer's. Always runs
  //    (a required dependency), whether or not the tripwire deps are wired.
  const pauseState = await deps.paused.isPaused();
  if (pauseState.paused) {
    const reason = pauseState.reason ?? "hallucination self-pause";
    // Mark the day in the record first: a paused day never re-runs on a
    // restart, even when the vault stub below is skipped (input-only mode).
    try {
      await deps.journalStore.markPausedDay(journalDate, reason);
    } catch (err) {
      deps.logger.warn("scheduled steward: could not mark the paused day", {
        runId: options.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  /**
   * Whether the record's journal store holds this day (a journal or a paused
   * marker). Required: the check is keyed on the record, never on a vault file
   * that input-only mode never writes (F-cos.0, the 27 Oct restarts).
   */
  journalExists: StewardJournalStoreDeps["journalExists"];
}

export type MissedStewardCheckResult =
  | { shouldRun: false; reason: "journal_already_exists" | "too_early" | "journal_store_unreadable" }
  | { shouldRun: true; reason: "missed_run_catch_up"; journalDate: string };

export async function checkMissedStewardRun(
  options: MissedStewardCheckOptions,
): Promise<MissedStewardCheckResult> {
  if (typeof options?.journalExists !== "function") {
    throw new Error("steward missed-run check: journalExists is a required dependency");
  }
  const now = options.now ?? new Date();
  const thresholdHour = options.thresholdHourLocal ?? 8;

  if (now.getHours() < thresholdHour) {
    return { shouldRun: false, reason: "too_early" };
  }

  const journalDate = formatLocalDate(now);
  let exists: boolean;
  try {
    exists = await options.journalExists(journalDate);
  } catch {
    // Fail closed: an unreadable store is no licence to start a full run on
    // every restart. The 08:20 job still runs on schedule.
    return { shouldRun: false, reason: "journal_store_unreadable" };
  }
  if (exists) {
    return { shouldRun: false, reason: "journal_already_exists" };
  }
  return { shouldRun: true, reason: "missed_run_catch_up", journalDate };
}

export interface MissedStewardCatchUpOptions {
  now?: Date;
  thresholdHourLocal?: number;
  /** The record's journal store for the day (see MissedStewardCheckOptions). */
  journalExists: StewardJournalStoreDeps["journalExists"];
  /** Passed to the runner for its vault stub; never read by the check. */
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
  | { ran: false; reason: "journal_already_exists" | "too_early" | "journal_store_unreadable" }
  | { ran: true; result: ScheduledStewardResult };

export async function runMissedStewardCatchUp(
  options: MissedStewardCatchUpOptions,
): Promise<MissedStewardCatchUpOutcome> {
  const check = await checkMissedStewardRun({
    now: options.now,
    thresholdHourLocal: options.thresholdHourLocal,
    journalExists: options.journalExists,
  });
  if (!check.shouldRun) {
    if (check.reason === "journal_store_unreadable") {
      options.logger.warn("steward missed-run check: the record's journal store is unreadable — no catch-up", {
        reason: check.reason,
      });
    } else {
      options.logger.info("steward missed-run check: no catch-up needed", { reason: check.reason });
    }
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

// ---------------------------------------------------------------------------
// Resume: who asked (F-cos.0)
// ---------------------------------------------------------------------------

/**
 * The caller of `resume-steward`, as recorded in its event and log line: the
 * `actor` param when it is a non-empty string, else "unknown". Never
 * "principal" by default — a resume nobody can attribute is the seam the
 * 27 Oct pause slipped through. Principle: record the caller, never assume it.
 */
export function stewardResumeActor(params: unknown): string {
  const raw = params !== null && typeof params === "object" ? (params as { actor?: unknown }).actor : undefined;
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  return trimmed === "" ? "unknown" : trimmed.slice(0, 100);
}

/**
 * Why a resume is refused before anything changes, or null: a call that names
 * no caller. The pause is the safety net while the chief of staff's home
 * answers mail; clearing it without a name would leave the 27 Oct question
 * ("who cleared the pause?") open again. Principle: record the caller, never
 * assume it; a resume with no name is refused, not logged as "unknown".
 */
export function stewardResumeRefusal(params: unknown): string | null {
  return stewardResumeActor(params) === "unknown" ? "resume-steward needs an actor: name who resumes it" : null;
}

/**
 * The pause's recorded reason, from its caller and its words. The cockpit's
 * own pause at start reads "paused by the cockpit: …", David's "paused by the
 * principal: …" (the act page tells the two apart), anyone else's names them.
 * The same caller rule as a resume: the `actor` param, else "unknown".
 */
export function stewardPauseReason(params: unknown): { actor: string; reason: string } {
  const actor = stewardResumeActor(params);
  const p = params !== null && typeof params === "object" ? (params as { reason?: unknown }) : {};
  const raw = typeof p.reason === "string" ? p.reason.trim().slice(0, 200) : "";
  const who = actor === "cockpit" ? "the cockpit" : actor === "principal" || actor.startsWith("principal:") ? "the principal" : actor;
  return { actor, reason: `paused by ${who}${raw ? `: ${raw}` : ""}` };
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
