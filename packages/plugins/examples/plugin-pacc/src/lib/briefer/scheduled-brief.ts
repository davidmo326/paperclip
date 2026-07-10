/**
 * Scheduled-brief orchestrator — T-3.6.
 *
 * The function that the daily cron job invokes (and that the
 * missed-run-on-startup check also invokes). Threads:
 *
 *   1. acquireLock         — overlap guard via plugin_state
 *   2. runBriefer          — T-3.1 produces a structured Brief
 *   3. renderBriefMarkdown — T-3.3 produces deterministic Markdown
 *   4. writeObsidianBrief  — T-3.6 idempotent vault write
 *   5. emit event          — `steward.brief.generated`
 *   6. releaseLock         — always, in finally
 *
 * If any step throws, the lock is released and the failure reason is
 * surfaced via the return result. Cron caller decides whether to log
 * + retry next tick.
 */

import { renderBriefMarkdown } from "./render.js";
import { runBriefer, type RunBrieferOptions } from "./briefer.js";
import type { Brief, BrieferDeps } from "./types.js";
import {
  obsidianBriefExists,
  writeObsidianBrief,
  type ObsidianBriefWriteResult,
  type WriteObsidianBriefOptions,
} from "./obsidian-writer.js";
import {
  acquireLock,
  releaseLock,
  type AcquireLockResult,
  type OverlapGuardStore,
} from "./overlap-guard.js";
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
} from "./hallucination.js";
import {
  initMetric,
  type KillCriterionMetric,
} from "./kill-criterion.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Event the orchestrator emits on a successful brief generation. */
export const BRIEF_GENERATED_EVENT = "steward.brief.generated";
/** Event emitted per hallucinated reference detected in a brief (T-3.7). */
export const HALLUCINATION_FLAG_EVENT = "agent.hallucination_flag";
/** Event emitted when the briefer self-pauses (T-3.7). */
export const SELF_PAUSED_EVENT = "agent.self_paused";
/** Event emitted when the model returns schema-invalid output twice (T-3.2). */
export const SCHEMA_VIOLATION_EVENT = "briefer.schema_violation";

/**
 * Optional hallucination-tripwire wiring (T-3.7). When provided, the
 * orchestrator: (1) checks the pause flag before running, writing a stub
 * brief if paused; (2) scans the rendered Markdown for unknown IDs after
 * running, annotating + recording flags + self-pausing at threshold.
 */
export interface HallucinationDeps {
  /** Canonical IDs the briefer was given — used to validate references. */
  knownIds: ReadonlySet<string>;
  /** Read/write the rolling 24h flag counter (plugin_state). */
  readFlags(): Promise<HallucinationCounterState | null>;
  writeFlags(state: HallucinationCounterState): Promise<void>;
  /** Read/write the self-pause flag (plugin_state). */
  isPaused(): Promise<{ paused: boolean; reason: string | null }>;
  setPaused(reason: string): Promise<void>;
  /** Optional override for the rolling window + threshold (defaults from hallucination.ts). */
  windowMs?: number;
  pauseThreshold?: number;
}

export interface ScheduledBriefDeps {
  /** The briefer's own deps (T-3.1). */
  briefer: BrieferDeps;
  /** plugin_state-backed lock store (T-3.6). */
  lock: OverlapGuardStore;
  /**
   * Emit a domain event. The orchestrator emits `steward.brief.generated`
   * with payload `{ briefDate, byteLength, obsidianPath, runId }`.
   * Wraps paperclip's `ctx.events.emit` in production; mocks in tests.
   */
  emitEvent(name: string, payload: Record<string, unknown>): Promise<void>;
  /** Logger compatible with paperclip's plugin logger. */
  logger: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error?(msg: string, fields?: Record<string, unknown>): void;
  };
  /** Optional T-3.7 hallucination tripwire. Omit to disable the check. */
  hallucination?: HallucinationDeps;
  /**
   * Optional T-3.10 kill-criterion meter. When provided, the orchestrator
   * persists a metric for this brief (idempotent: a same-day re-run keeps the
   * accepted/J1 counts and only refreshes suggestionsCount) and threads the
   * full metric history into the render so the "Control-plane self-check"
   * section shows real 7-day rolling totals + the gate red-flag.
   */
  killCriterion?: KillCriterionDeps;
}

export interface KillCriterionDeps {
  /** Read every persisted metric (one per brief, keyed by briefDate). */
  readAllMetrics(): Promise<KillCriterionMetric[]>;
  /** Upsert the metric for one brief (keyed by briefDate). */
  writeMetric(metric: KillCriterionMetric): Promise<void>;
}

export interface RunScheduledBriefOptions {
  /** Override "now" for tests. */
  now?: Date;
  /** Brief job correlation id (e.g. paperclip's PluginJobContext.runId). */
  runId?: string;
  /**
   * Base directory for the Obsidian write.
   * Default: `${HOME}/llm_shared/Obsidian/00_Daily` per PRD § 13.1.
   */
  obsidianBaseDir?: string;
  /** Lock TTL passed through to acquireLock. */
  lockStaleAfterMs?: number;
  /**
   * T-2.4 M1b write-mediator. When provided, every Obsidian write in this
   * run flows through it (protection check + audit event + atomic write).
   */
  obsidianGuard?: WriteObsidianBriefOptions["guard"];
  /** Pass-through options to runBriefer (e.g. skipModel). */
  brieferOptions?: RunBrieferOptions;
}

export type ScheduledBriefResult =
  | {
      kind: "completed";
      brief: Brief;
      obsidianWrite: ObsidianBriefWriteResult;
      lockOutcome: Extract<AcquireLockResult, { acquired: true }>;
      /** Count of hallucinated references detected this run (T-3.7). */
      hallucinationFlagCount: number;
      /** True if this run tripped the self-pause threshold. */
      selfPaused: boolean;
    }
  | {
      kind: "skipped_overlap";
      reason: string;
      existingLock: Extract<AcquireLockResult, { acquired: false }>["existingLock"];
      ageMs: number;
    }
  | {
      /** Briefer is self-paused (T-3.7); a stub brief was written instead. */
      kind: "skipped_paused";
      reason: string;
      obsidianWrite: ObsidianBriefWriteResult;
    }
  | {
      kind: "failed";
      error: string;
    };

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_OBSIDIAN_DIR =
  process.env.HOME ?
    `${process.env.HOME}/llm_shared/Obsidian/00_Daily`
  : "./Obsidian/00_Daily";

export async function runScheduledBrief(
  deps: ScheduledBriefDeps,
  options: RunScheduledBriefOptions = {},
): Promise<ScheduledBriefResult> {
  const now = options.now ?? new Date();
  const obsidianBaseDir = options.obsidianBaseDir ?? DEFAULT_OBSIDIAN_DIR;
  const briefDate = now.toISOString().slice(0, 10);

  // 0. Self-pause check (T-3.7). If the briefer is paused, write a stub
  //    brief to Obsidian and skip the run entirely.
  if (deps.hallucination) {
    const pauseState = await deps.hallucination.isPaused();
    if (pauseState.paused) {
      const reason = pauseState.reason ?? "hallucination self-pause";
      const stub = pausedBriefMarkdown(briefDate, reason);
      const obsidianWrite = await writeObsidianBrief(stub, {
        baseDir: obsidianBaseDir,
        briefDate,
        guard: options.obsidianGuard,
      });
      deps.logger.warn("scheduled brief: briefer is self-paused; wrote stub", {
        runId: options.runId,
        reason,
        path: obsidianWrite.path,
      });
      return { kind: "skipped_paused", reason, obsidianWrite };
    }
  }

  // 1. Acquire overlap-guard lock.
  const lockResult = await acquireLock(deps.lock, {
    now,
    runId: options.runId ?? null,
    staleAfterMs: options.lockStaleAfterMs,
  });
  if (!lockResult.acquired) {
    const ageSeconds = Math.round(lockResult.ageMs / 1000);
    const reason = `brief already in progress (lock acquired ${ageSeconds}s ago)`;
    deps.logger.info("scheduled brief: skipping overlap", {
      runId: options.runId,
      existingLockAcquiredAt: lockResult.existingLock.acquiredAt,
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
    deps.logger.warn("scheduled brief: overwrote stale lock", {
      runId: options.runId,
    });
  }

  try {
    // 2. Produce structured Brief. Capture any T-3.2 schema violation so we can
    //    emit `briefer.schema_violation` after the brief is built.
    let schemaViolationError: string | null = null;
    const brief = await runBriefer(deps.briefer, {
      ...options.brieferOptions,
      now,
      onSchemaViolation: (err) => {
        schemaViolationError = err;
      },
    });
    if (schemaViolationError !== null) {
      await deps.emitEvent(SCHEMA_VIOLATION_EVENT, {
        briefDate: brief.briefDate,
        error: schemaViolationError,
        runId: options.runId ?? null,
      });
      deps.logger.warn("scheduled brief: model schema violation; narrative degraded to offline", {
        runId: options.runId,
        error: schemaViolationError,
      });
    }

    // 2b. Kill-criterion metric (T-3.10): persist a metric for this brief and
    //     gather history so the self-check section renders real totals.
    //     Idempotent — a same-day re-run preserves accepted/J1 (which feedback
    //     bumps) and only refreshes the suggestion count.
    let selfCheck: { metrics: KillCriterionMetric[]; now: Date } | undefined;
    if (deps.killCriterion) {
      const suggestionsCount =
        brief.highLeverageActions.length + brief.backlogCandidates.length;
      const existing = await deps.killCriterion.readAllMetrics();
      const priorForDate = existing.find((m) => m.briefDate === brief.briefDate);
      const metric: KillCriterionMetric =
        priorForDate ?
          { ...priorForDate, suggestionsCount }
        : initMetric(brief.briefDate, suggestionsCount);
      await deps.killCriterion.writeMetric(metric);
      const merged = [
        ...existing.filter((m) => m.briefDate !== brief.briefDate),
        metric,
      ];
      selfCheck = { metrics: merged, now };
    }

    // 3. Render to Markdown.
    let markdown = renderBriefMarkdown(brief, selfCheck ? { selfCheck } : {});

    // 3b. Hallucination tripwire (T-3.7, D-39 fix T-3.12): scan rendered
    //     Markdown for unknown ID references, annotate (always — deterministic
    //     or model-generated, both get the inline warning), record sightings
    //     for audit, and self-pause only when the flagged brief was
    //     model-generated AND the unique-reference threshold is met.
    let hallucinationFlagCount = 0;
    let selfPaused = false;
    if (deps.hallucination) {
      const modelGenerated = !(options.brieferOptions?.skipModel ?? false);
      const flags = detectHallucinations({
        briefMarkdown: markdown,
        knownIds: deps.hallucination.knownIds,
      });
      hallucinationFlagCount = flags.length;
      if (flags.length > 0) {
        markdown = annotateHallucinations(markdown, flags);
        // Emit one event per flagged reference (both origins — audit trail).
        for (const flag of flags) {
          await deps.emitEvent(HALLUCINATION_FLAG_EVENT, {
            briefDate: brief.briefDate,
            reference: flag.reference,
            kind: flag.kind,
            excerpt: flag.excerpt,
            modelGenerated,
            runId: options.runId ?? null,
          });
        }
        if (!modelGenerated) {
          deps.logger.warn(
            "scheduled brief: hallucination flags on a deterministic/offline brief — warning only, never pauses (D-39)",
            { runId: options.runId, flagCount: flags.length },
          );
        }

        // Record sightings (unique-ref dedup happens at read time, not here —
        // each occurrence is stored so audit can show first-seen accurately).
        const newSightings: HallucinationSighting[] = flags.map((flag) => ({
          at: now.toISOString(),
          briefDate: brief.briefDate,
          ref: normalizeReference(flag.reference),
          rawRef: flag.reference,
          modelGenerated,
        }));
        const prior = await deps.hallucination.readFlags();
        const updated = appendSightings(prior, newSightings, now, deps.hallucination.windowMs);
        await deps.hallucination.writeFlags(updated);

        // Self-pause only ever considers model-generated sightings (D-39).
        if (modelGenerated) {
          const inWindow = pruneOldSightings(updated, now, deps.hallucination.windowMs);
          if (shouldPause(inWindow, deps.hallucination.pauseThreshold)) {
            selfPaused = true;
            const uniqueCount = countUniqueModelRefs(inWindow);
            const reason = `${uniqueCount} unique hallucinated reference(s) within window`;
            await deps.hallucination.setPaused(reason);
            await deps.emitEvent(SELF_PAUSED_EVENT, {
              reason,
              uniqueRefCount: uniqueCount,
              runId: options.runId ?? null,
            });
            deps.logger.warn("scheduled brief: self-paused on hallucination threshold", {
              runId: options.runId,
              uniqueRefCount: uniqueCount,
            });
          }
        }
      }
    }

    // 4. Idempotent Obsidian write (annotated markdown if flags were found).
    const obsidianWrite = await writeObsidianBrief(markdown, {
      baseDir: obsidianBaseDir,
      briefDate: brief.briefDate,
      guard: options.obsidianGuard,
    });
    deps.logger.info("scheduled brief: obsidian write", {
      runId: options.runId,
      path: obsidianWrite.path,
      kind: obsidianWrite.kind,
      byteLength: obsidianWrite.byteLength,
    });

    // 5. Emit event.
    await deps.emitEvent(BRIEF_GENERATED_EVENT, {
      briefDate: brief.briefDate,
      generatedAt: brief.generatedAt,
      inputsCacheKey: brief.inputsCacheKey,
      obsidianPath: obsidianWrite.path,
      obsidianWriteKind: obsidianWrite.kind,
      byteLength: obsidianWrite.byteLength,
      hallucinationFlagCount,
      runId: options.runId ?? null,
    });

    return {
      kind: "completed",
      brief,
      obsidianWrite,
      lockOutcome: lockResult,
      hallucinationFlagCount,
      selfPaused,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error?.("scheduled brief: failed", {
      runId: options.runId,
      error: msg,
    });
    return { kind: "failed", error: msg };
  } finally {
    // 6. Always release the lock — even on failure.
    await releaseLock(deps.lock).catch((err) => {
      deps.logger.warn("scheduled brief: failed to release lock", {
        runId: options.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Missed-run check (plugin startup)
// ---------------------------------------------------------------------------

export interface MissedRunCheckOptions {
  /** Override "now" for tests. */
  now?: Date;
  /** Hour-of-day after which a missing brief triggers a catch-up run. Default 8 per PRD § 13.1. */
  thresholdHourLocal?: number;
  /** Base directory for the Obsidian write. Same default as runScheduledBrief. */
  obsidianBaseDir?: string;
}

export type MissedRunCheckResult =
  | { shouldRun: false; reason: "brief_already_exists" | "too_early" }
  | { shouldRun: true; reason: "missed_run_catch_up"; briefDate: string };

/**
 * Decide whether the briefer should run "now" because today's scheduled
 * brief was missed (e.g. the host was asleep at 08:00). Plugin startup
 * calls this; if `shouldRun` is true the caller invokes
 * `runScheduledBrief` immediately.
 *
 * Pure-ish: only filesystem access via obsidianBriefExists.
 */
export async function checkMissedRun(
  options: MissedRunCheckOptions = {},
): Promise<MissedRunCheckResult> {
  const now = options.now ?? new Date();
  const thresholdHour = options.thresholdHourLocal ?? 8;
  const baseDir = options.obsidianBaseDir ?? DEFAULT_OBSIDIAN_DIR;

  if (now.getHours() < thresholdHour) {
    return { shouldRun: false, reason: "too_early" };
  }

  const briefDate = formatBriefDate(now);
  const exists = await obsidianBriefExists({ baseDir, briefDate });
  if (exists) {
    return { shouldRun: false, reason: "brief_already_exists" };
  }
  return { shouldRun: true, reason: "missed_run_catch_up", briefDate };
}

function formatBriefDate(d: Date): string {
  // YYYY-MM-DD in local time (the brief date is a calendar date, not UTC).
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Missed-run catch-up composition (T-3.6 review fix, 2026-07-10)
// ---------------------------------------------------------------------------

export interface MissedBriefCatchUpOptions {
  now?: Date;
  thresholdHourLocal?: number;
  obsidianBaseDir?: string;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Injected for tests; production callers pass a closure over real deps. */
  runner: (options: RunScheduledBriefOptions) => Promise<ScheduledBriefResult>;
  /** Extra options forwarded to the runner (guard, briefer options…). */
  runnerOptions?: Partial<RunScheduledBriefOptions>;
}

export type MissedBriefCatchUpOutcome =
  | { ran: false; reason: "brief_already_exists" | "too_early" }
  | { ran: true; result: ScheduledBriefResult };

/**
 * Startup-time catch-up: if today's brief was missed (host down at 08:00),
 * run it now through the exact same pipeline as the cron. This is the
 * wiring `checkMissedRun` always assumed — live-fire on 2026-07-09 showed
 * the decision function existed but nothing called it, reproducing the
 * June silent-death mode. The runId carries `missed-run` so the audit
 * trail records why the run happened outside the schedule.
 */
export async function runMissedBriefCatchUp(
  options: MissedBriefCatchUpOptions,
): Promise<MissedBriefCatchUpOutcome> {
  const check = await checkMissedRun({
    now: options.now,
    thresholdHourLocal: options.thresholdHourLocal,
    obsidianBaseDir: options.obsidianBaseDir,
  });
  if (!check.shouldRun) {
    options.logger.info("missed-run check: no catch-up needed", { reason: check.reason });
    return { ran: false, reason: check.reason };
  }
  options.logger.warn("missed-run check: today's brief missing past threshold — running catch-up", {
    briefDate: check.briefDate,
  });
  const result = await options.runner({
    ...options.runnerOptions,
    now: options.now,
    runId: `missed-run-${check.briefDate}`,
    obsidianBaseDir: options.obsidianBaseDir,
  });
  return { ran: true, result };
}
