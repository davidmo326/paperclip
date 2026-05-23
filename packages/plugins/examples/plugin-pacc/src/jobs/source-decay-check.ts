/**
 * source-decay-check job — T-2.6 / PRD § 15.2 tripwire 7.
 *
 * Once daily: for each project, find the most-recently-touched M1 source.
 * If days-since-last-touch > staleThresholdDays (default 30 per PRD; future
 * tickets may add a per-project override), emit `project.source_decay` so
 * the next brief surfaces a "context may be stale — consider re-grounding"
 * item.
 *
 * Status is also persisted to plugin_state so the UI can decorate the
 * project card without waiting for the next brief.
 */

import type { SourceRef } from "@paperclipai/shared";
import {
  checkProjectDecay,
  collectSourceRefsFromControlPlaneState,
  type DecayCheckResult,
} from "../lib/stale-detection.js";
import {
  DEFAULT_STALE_THRESHOLD_DAYS,
  PLUGIN_NAMESPACE,
  SOURCE_DECAY_STATE_KEY,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Minimal ctx shape
// ---------------------------------------------------------------------------

export interface DecayCtxCompany {
  id: string;
}

export interface DecayCtxProject {
  id: string;
  /** Loosely typed; collector narrows at runtime. */
  controlPlaneState: unknown;
}

export interface DecayLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface SourceDecayCtx {
  companies: {
    list(opts: { limit: number; offset: number }): Promise<DecayCtxCompany[]>;
  };
  projects: {
    list(opts: { companyId: string; limit: number; offset: number }): Promise<DecayCtxProject[]>;
  };
  state: {
    set(scope: { scopeKind: "project"; scopeId: string; namespace: string; stateKey: string }, value: unknown): Promise<void>;
  };
  events: {
    emit(name: string, companyId: string, payload: unknown): Promise<void>;
  };
  logger: DecayLogger;
}

// ---------------------------------------------------------------------------
// Per-project decay payload (plugin_state)
// ---------------------------------------------------------------------------

export interface ProjectDecayRecord {
  projectId: string;
  generatedAt: string;
  decayed: boolean;
  daysSinceLastTouch: number | null;
  thresholdDays: number;
  lastTouchedPath: string | null;
}

function toDecayRecord(
  result: DecayCheckResult,
  now: Date,
): ProjectDecayRecord {
  return {
    projectId: result.projectId,
    generatedAt: now.toISOString(),
    decayed: result.decayed,
    daysSinceLastTouch: Number.isFinite(result.daysSinceLastTouch)
      ? Number(result.daysSinceLastTouch.toFixed(2))
      : null,
    thresholdDays: result.thresholdDays,
    lastTouchedPath: result.lastTouchedPath,
  };
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

export interface RunSourceDecayResult {
  projectsScanned: number;
  decayedProjects: number;
  eventsEmitted: number;
}

/** Event name emitted when a project is detected as decayed. */
export const SOURCE_DECAY_EVENT = "project.source_decay";

export async function runSourceDecayCheck(
  ctx: SourceDecayCtx,
  options: { now?: Date; thresholdDays?: number } = {},
): Promise<RunSourceDecayResult> {
  const now = options.now ?? new Date();
  const thresholdDays = options.thresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;

  const companies = await ctx.companies.list({ limit: 200, offset: 0 });

  let projectsScanned = 0;
  let decayedProjects = 0;
  let eventsEmitted = 0;

  for (const company of companies) {
    const projects = await ctx.projects.list({
      companyId: company.id,
      limit: 200,
      offset: 0,
    });

    for (const project of projects) {
      const refs: SourceRef[] = collectSourceRefsFromControlPlaneState(
        project.controlPlaneState ?? null,
      );

      let result: DecayCheckResult;
      try {
        result = await checkProjectDecay(
          { projectId: project.id, sourceRefs: refs, thresholdDays },
          now,
        );
      } catch (err) {
        ctx.logger.warn("source-decay-check: failed", {
          projectId: project.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      projectsScanned += 1;
      const record = toDecayRecord(result, now);
      await ctx.state.set(
        {
          scopeKind: "project",
          scopeId: project.id,
          namespace: PLUGIN_NAMESPACE,
          stateKey: SOURCE_DECAY_STATE_KEY,
        },
        record,
      );

      if (result.decayed) {
        decayedProjects += 1;
        try {
          await ctx.events.emit(SOURCE_DECAY_EVENT, company.id, {
            projectId: project.id,
            daysSinceLastTouch: record.daysSinceLastTouch,
            thresholdDays,
            lastTouchedPath: result.lastTouchedPath,
          });
          eventsEmitted += 1;
        } catch (err) {
          ctx.logger.warn("source-decay-check: failed to emit event", {
            projectId: project.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  ctx.logger.info("source-decay-check job complete", {
    projectsScanned,
    decayedProjects,
    eventsEmitted,
  });

  return { projectsScanned, decayedProjects, eventsEmitted };
}
