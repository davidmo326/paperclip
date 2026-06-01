/**
 * Worker integration — T-3.x worker-integration.
 *
 * Builds the concrete dependency objects (`ScheduledBriefDeps`,
 * `BrieferDeps`, `OverlapGuardStore`, `HallucinationDeps`) from a
 * paperclip `PluginContext`, so the `briefDaily` job handler in worker.ts
 * is a thin one-liner.
 *
 * What's wired:
 *   - plugin_state-backed OverlapGuardStore (T-3.6 advisory lock)
 *   - plugin_state-backed hallucination flag-counter + pause flag (T-3.7)
 *   - plugin_state-backed brief storage (saveBrief)
 *   - ContextCard assembly from live projects + the T-2.6/T-2.7 overlays
 *   - job-mix from per-project jobClassificationDominant fallback (T-3.4)
 *   - plugin_state-backed kill-criterion metrics + self-check render (T-3.10)
 *
 * What's NOT wired (documented gaps — the plugin SDK doesn't expose them):
 *   - callModel: the plugin SDK has no LLM surface. The briefer runs in
 *     deterministic offline mode (skipModel:true). A real model call needs
 *     either a paperclip model-gateway endpoint or an Anthropic key in the
 *     worker env — filed as a follow-up.
 *   - recentDecisions / activeTasks / authority grants: no SDK client for
 *     the decisions / authority_profiles tables (issues client exists but
 *     wiring it is its own diff). Cards ship with empty arrays for these;
 *     the brief still surfaces portfolio state + overlays + job-mix fallback.
 *
 * A minimal `WorkerCtx` interface (subset of PluginContext) keeps this
 * unit-testable with a stub ctx.
 */

import {
  BRIEFER_PAUSED_STATE_KEY,
  BRIEF_STORE_STATE_KEY,
  CONFLICTS_STATE_KEY,
  FRESHNESS_STATE_KEY,
  HALLUCINATION_FLAGS_STATE_KEY,
  KILL_CRITERION_STATE_KEY,
  PLUGIN_NAMESPACE,
  SOURCE_DECAY_STATE_KEY,
  BRIEF_IN_PROGRESS_STATE_KEY,
} from "../../constants.js";
import { buildContextCard, type ContextCard } from "../context-card.js";
import type { ProjectFreshnessRecord } from "../../jobs/stale-rehash.js";
import type { ProjectDecayRecord } from "../../jobs/source-decay-check.js";
import type { ProjectConflictsState } from "../conflict.js";
import type { Brief, BrieferDeps, BrieferProjectInput } from "./types.js";
import type { OverlapGuardStore, BriefInProgressLock } from "./overlap-guard.js";
import type {
  HallucinationCounterState,
} from "./hallucination.js";
import type {
  HallucinationDeps,
  KillCriterionDeps,
  ScheduledBriefDeps,
} from "./scheduled-brief.js";
import type { KillCriterionMetric } from "./kill-criterion.js";

// ---------------------------------------------------------------------------
// Minimal ctx surface
// ---------------------------------------------------------------------------

interface ScopeKey {
  scopeKind: "instance" | "project";
  scopeId?: string;
  namespace?: string;
  stateKey: string;
}

export interface WorkerCtxProject {
  id: string;
  name: string;
  controlPlaneState: unknown;
}

export interface WorkerCtx {
  companies: { list(opts: { limit: number; offset: number }): Promise<Array<{ id: string }>> };
  projects: {
    list(opts: { companyId: string; limit: number; offset: number }): Promise<WorkerCtxProject[]>;
  };
  state: {
    get(key: ScopeKey): Promise<unknown>;
    set(key: ScopeKey, value: unknown): Promise<void>;
    delete?(key: ScopeKey): Promise<void>;
  };
  events: { emit(name: string, companyId: string, payload: unknown): Promise<void> };
  logger: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error?(msg: string, fields?: Record<string, unknown>): void;
  };
}

// ---------------------------------------------------------------------------
// plugin_state scope helpers
// ---------------------------------------------------------------------------

const instanceKey = (stateKey: string): ScopeKey => ({
  scopeKind: "instance",
  namespace: PLUGIN_NAMESPACE,
  stateKey,
});

const projectKey = (projectId: string, stateKey: string): ScopeKey => ({
  scopeKind: "project",
  scopeId: projectId,
  namespace: PLUGIN_NAMESPACE,
  stateKey,
});

// ---------------------------------------------------------------------------
// Overlap-guard store (T-3.6)
// ---------------------------------------------------------------------------

export function makeOverlapStore(ctx: WorkerCtx): OverlapGuardStore {
  return {
    async read() {
      const v = await ctx.state.get(instanceKey(BRIEF_IN_PROGRESS_STATE_KEY));
      return (v as BriefInProgressLock | null) ?? null;
    },
    async write(lock) {
      await ctx.state.set(instanceKey(BRIEF_IN_PROGRESS_STATE_KEY), lock);
    },
    async clear() {
      if (ctx.state.delete) {
        await ctx.state.delete(instanceKey(BRIEF_IN_PROGRESS_STATE_KEY));
      } else {
        await ctx.state.set(instanceKey(BRIEF_IN_PROGRESS_STATE_KEY), null);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Hallucination deps (T-3.7)
// ---------------------------------------------------------------------------

export function makeHallucinationDeps(
  ctx: WorkerCtx,
  knownIds: ReadonlySet<string>,
): HallucinationDeps {
  return {
    knownIds,
    async readFlags() {
      const v = await ctx.state.get(instanceKey(HALLUCINATION_FLAGS_STATE_KEY));
      return (v as HallucinationCounterState | null) ?? null;
    },
    async writeFlags(state) {
      await ctx.state.set(instanceKey(HALLUCINATION_FLAGS_STATE_KEY), state);
    },
    async isPaused() {
      const v = (await ctx.state.get(instanceKey(BRIEFER_PAUSED_STATE_KEY))) as
        | { paused: boolean; reason: string | null }
        | null;
      return v ?? { paused: false, reason: null };
    },
    async setPaused(reason) {
      await ctx.state.set(instanceKey(BRIEFER_PAUSED_STATE_KEY), {
        paused: true,
        reason,
        pausedAt: new Date().toISOString(),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Kill-criterion meter deps (T-3.10)
// ---------------------------------------------------------------------------

/**
 * Metrics live as a single instance-scoped map keyed by briefDate, so
 * `readAllMetrics` needs no key enumeration (the plugin_state API has no
 * list-by-prefix).
 */
export function makeKillCriterionDeps(ctx: WorkerCtx): KillCriterionDeps {
  const key = instanceKey(KILL_CRITERION_STATE_KEY);
  return {
    async readAllMetrics() {
      const map = (await ctx.state.get(key)) as Record<string, KillCriterionMetric> | null;
      return map ? Object.values(map) : [];
    },
    async writeMetric(metric) {
      const map =
        ((await ctx.state.get(key)) as Record<string, KillCriterionMetric> | null) ?? {};
      map[metric.briefDate] = metric;
      await ctx.state.set(key, map);
    },
  };
}

// ---------------------------------------------------------------------------
// ContextCard assembly from live projects + overlays
// ---------------------------------------------------------------------------

export async function assembleProjectCards(ctx: WorkerCtx): Promise<BrieferProjectInput[]> {
  const companies = await ctx.companies.list({ limit: 200, offset: 0 });
  const cards: BrieferProjectInput[] = [];

  for (const company of companies) {
    const projects = await ctx.projects.list({ companyId: company.id, limit: 200, offset: 0 });
    for (const project of projects) {
      const cps = (project.controlPlaneState ?? null) as Record<string, unknown> | null;
      // Skip closed projects — they don't belong in the daily brief.
      if (cps?.portfolioState === "closed") continue;

      const [freshness, decay, conflicts] = await Promise.all([
        ctx.state.get(projectKey(project.id, FRESHNESS_STATE_KEY)) as Promise<ProjectFreshnessRecord | null>,
        ctx.state.get(projectKey(project.id, SOURCE_DECAY_STATE_KEY)) as Promise<ProjectDecayRecord | null>,
        ctx.state.get(projectKey(project.id, CONFLICTS_STATE_KEY)) as Promise<ProjectConflictsState | null>,
      ]);

      const card: ContextCard = buildContextCard({
        project: {
          id: project.id,
          name: project.name,
          controlPlaneState: (project.controlPlaneState ?? null) as never,
          controlPlaneUpdatedAt: null,
        },
        telemetry: null,
        freshness: freshness ?? null,
        decay: decay ?? null,
        conflicts: conflicts ?? null,
        recentDecisions: [], // no decisions-table SDK client yet — follow-up
        activeTasks: [], // no issues wiring yet — follow-up
        authority: [], // no authority_profiles SDK client yet — follow-up
      });
      cards.push({ projectId: project.id, projectName: project.name, card });
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Briefer deps
// ---------------------------------------------------------------------------

export function makeBrieferDeps(ctx: WorkerCtx, cards: BrieferProjectInput[]): BrieferDeps {
  return {
    async listActiveProjectCards() {
      return cards;
    },
    async proposeM2() {
      // Briefer is L1 — it proposes, never writes M2. The actual candidate
      // store wiring is part of T-4.x (approval queue). No-op for now.
    },
    async saveBrief(brief: Brief) {
      await ctx.state.set(
        { scopeKind: "instance", namespace: brief.briefDate, stateKey: BRIEF_STORE_STATE_KEY },
        brief,
      );
      return { id: `brief-${brief.briefDate}` };
    },
    async callModel() {
      // No LLM surface in the plugin SDK yet. Returning null text makes the
      // briefer fall back to its deterministic offline summary. When a model
      // gateway lands, replace this with a real call.
      return { text: null, sessionId: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level: scheduled-brief deps
// ---------------------------------------------------------------------------

export interface MakeScheduledBriefDepsResult {
  deps: ScheduledBriefDeps;
  /** companyId used for event emission (first company, or 'instance' if none). */
  eventCompanyId: string;
}

export async function makeScheduledBriefDeps(
  ctx: WorkerCtx,
): Promise<MakeScheduledBriefDepsResult> {
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const eventCompanyId = companies[0]?.id ?? "instance";

  const cards = await assembleProjectCards(ctx);
  const knownIds = new Set<string>();
  for (const c of cards) {
    knownIds.add(c.projectId);
    knownIds.add(c.projectName);
  }

  const deps: ScheduledBriefDeps = {
    briefer: makeBrieferDeps(ctx, cards),
    lock: makeOverlapStore(ctx),
    async emitEvent(name, payload) {
      await ctx.events.emit(name, eventCompanyId, payload);
    },
    logger: ctx.logger,
    hallucination: makeHallucinationDeps(ctx, knownIds),
    killCriterion: makeKillCriterionDeps(ctx),
  };

  return { deps, eventCompanyId };
}
