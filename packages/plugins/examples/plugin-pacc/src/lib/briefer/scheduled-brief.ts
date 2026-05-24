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
} from "./obsidian-writer.js";
import {
  acquireLock,
  releaseLock,
  type AcquireLockResult,
  type OverlapGuardStore,
} from "./overlap-guard.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Event the orchestrator emits on a successful brief generation. */
export const BRIEF_GENERATED_EVENT = "steward.brief.generated";

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
  /** Pass-through options to runBriefer (e.g. skipModel). */
  brieferOptions?: RunBrieferOptions;
}

export type ScheduledBriefResult =
  | {
      kind: "completed";
      brief: Brief;
      obsidianWrite: ObsidianBriefWriteResult;
      lockOutcome: Extract<AcquireLockResult, { acquired: true }>;
    }
  | {
      kind: "skipped_overlap";
      reason: string;
      existingLock: Extract<AcquireLockResult, { acquired: false }>["existingLock"];
      ageMs: number;
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
    // 2. Produce structured Brief.
    const brief = await runBriefer(deps.briefer, {
      ...options.brieferOptions,
      now,
    });

    // 3. Render to Markdown.
    const markdown = renderBriefMarkdown(brief);

    // 4. Idempotent Obsidian write.
    const obsidianWrite = await writeObsidianBrief(markdown, {
      baseDir: obsidianBaseDir,
      briefDate: brief.briefDate,
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
      runId: options.runId ?? null,
    });

    return {
      kind: "completed",
      brief,
      obsidianWrite,
      lockOutcome: lockResult,
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
