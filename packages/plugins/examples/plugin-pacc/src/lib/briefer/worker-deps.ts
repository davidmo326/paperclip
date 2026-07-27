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
  BRIEFER_PAUSE_AUDIT_STATE_KEY,
  BRIEF_FEEDBACK_STATE_KEY,
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
import type { Brief, BrieferDeps, BrieferProjectInput, ValueAnchorSummary } from "./types.js";
import type { OverlapGuardStore, BriefInProgressLock } from "./overlap-guard.js";
import {
  auditRowsFromSightings,
  pruneOldSightings,
  resumeBriefer,
  type HallucinationAuditRow,
  type HallucinationCounterState,
  type PauseAuditRow,
  type ResumeBrieferResult,
} from "./hallucination.js";
import type {
  HallucinationDeps,
  KillCriterionDeps,
  ScheduledBriefDeps,
} from "./scheduled-brief.js";
import type { KillCriterionMetric } from "./kill-criterion.js";
import { callModelViaClaudeCli } from "./model-claude-cli.js";
import { BRIEFER_DEFAULT_MODEL } from "./briefer.js";
import { createValueAnchorService } from "../value-anchor/service.js";
import { resolveVaultRoot } from "../vault-root.js";
import {
  createObsidianFileWriter,
  type ObsidianFileWriter,
} from "../value-anchor/write-obsidian-file.js";
import type { CaptureFeedbackDeps } from "./capture-feedback.js";
import type { BriefFeedbackRow } from "./feedback.js";
import type { SourceRef } from "@paperclipai/shared";
import type { SourceIndexRecord } from "../source-index/index-core.js";
import { makeSourceIndexStore } from "../source-index/worker-deps.js";
import { makeNoteAssociationStore, defaultPortfolioSeedPath } from "../note-association/worker-deps.js";
import { createNoteAssociationFsDeps } from "../note-association/fs-deps.js";

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
// Resume path + hallucination audit (T-3.12 / D-39)
// ---------------------------------------------------------------------------

/**
 * `pacc resume-briefer`: clears the self-pause flag if one is active and
 * appends a `principal`-attributed audit row. Returns `not_paused` (caller
 * surfaces a clear CLI error) if there was nothing to resume.
 */
export async function resumeBrieferAction(
  ctx: WorkerCtx,
  actor: string,
  now: Date = new Date(),
): Promise<ResumeBrieferResult> {
  const pauseState = (await ctx.state.get(instanceKey(BRIEFER_PAUSED_STATE_KEY))) as
    | { paused: boolean; reason: string | null }
    | null;
  const result = resumeBriefer({ pauseState, actor, now });
  if (result.kind === "resumed") {
    if (ctx.state.delete) {
      await ctx.state.delete(instanceKey(BRIEFER_PAUSED_STATE_KEY));
    } else {
      await ctx.state.set(instanceKey(BRIEFER_PAUSED_STATE_KEY), null);
    }
    const priorAudit =
      ((await ctx.state.get(instanceKey(BRIEFER_PAUSE_AUDIT_STATE_KEY))) as PauseAuditRow[] | null) ?? [];
    await ctx.state.set(instanceKey(BRIEFER_PAUSE_AUDIT_STATE_KEY), [...priorAudit, result.auditRow]);
  }
  return result;
}

/**
 * `pacc audit hallucinations`: the current 24h window of unique-reference
 * sightings (normalized ref, first-seen timestamp, brief id, origin).
 */
export async function readHallucinationAuditWindow(
  ctx: WorkerCtx,
  now: Date = new Date(),
  windowMs?: number,
): Promise<HallucinationAuditRow[]> {
  const state = (await ctx.state.get(
    instanceKey(HALLUCINATION_FLAGS_STATE_KEY),
  )) as HallucinationCounterState | null;
  const inWindow = pruneOldSightings(state, now, windowMs);
  return auditRowsFromSightings(inWindow);
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
// Capture-feedback deps (T-3.9)
// ---------------------------------------------------------------------------

export function makeCaptureFeedbackDeps(ctx: WorkerCtx): CaptureFeedbackDeps {
  const kc = makeKillCriterionDeps(ctx);
  return {
    async readBrief(briefDate) {
      const v = await ctx.state.get({
        scopeKind: "instance",
        namespace: briefDate,
        stateKey: BRIEF_STORE_STATE_KEY,
      });
      return (v as Brief | null) ?? null;
    },
    async writeFeedbackRow(row: BriefFeedbackRow) {
      await ctx.state.set(
        { scopeKind: "instance", namespace: row.briefDate, stateKey: BRIEF_FEEDBACK_STATE_KEY },
        row,
      );
    },
    async readMetric(briefDate) {
      const all = await kc.readAllMetrics();
      return all.find((m) => m.briefDate === briefDate) ?? null;
    },
    async writeMetric(metric) {
      await kc.writeMetric(metric);
    },
  };
}

// ---------------------------------------------------------------------------
// ContextCard assembly from live projects + overlays
// ---------------------------------------------------------------------------

/**
 * Max associated M1a notes surfaced per project in the brief. The full set
 * stays in the source index (queryable); the brief only needs a recent,
 * readable sample to ground the next action + Source Notes — without it,
 * a project like Circlo (562 associated notes) floods a ~660-line brief that's
 * pure path dump. Most-recent-first (file mtime) keeps the relevant signal.
 */
const ASSOCIATED_NOTE_REF_CAP_PER_PROJECT = 8;

/**
 * T-2.10: build slug -> associated M1a SourceRef[] from the grounding pipeline
 * (note-association catalog -> source-index records). Catalog entries are
 * grouped by their seed-slug projectId, each path resolved to a record
 * (path + contentHash + modifiedAt), then the per-slug list is capped to the
 * {@link ASSOCIATED_NOTE_REF_CAP_PER_PROJECT} most-recent (mtime desc, path asc
 * tie-break) so cards stay readable AND deterministic. Vanished index records
 * are skipped. An unreadable/empty association store yields an empty map
 * (brief degrades to M2-only — not fatal).
 *
 * Firewall-clean: uses only the already-adapter-constructed stores built from
 * the same `ctx` (`Pick<WorkerCtx,"state"|"logger">`).
 */
async function buildAssociatedNoteRefsBySlug(ctx: WorkerCtx): Promise<Map<string, SourceRef[]>> {
  const assocStore = makeNoteAssociationStore(ctx);
  const indexStore = makeSourceIndexStore(ctx);
  let catalog: Record<string, { projectId: string | null }>;
  try {
    catalog = (await assocStore.listCatalog()) as Record<string, { projectId: string | null }>;
  } catch {
    return new Map();
  }
  const pathsBySlug = new Map<string, string[]>();
  for (const [notePath, entry] of Object.entries(catalog)) {
    if (!entry || !entry.projectId) continue; // unassociated bucket
    const list = pathsBySlug.get(entry.projectId);
    if (list) list.push(notePath);
    else pathsBySlug.set(entry.projectId, [notePath]);
  }
  const out = new Map<string, SourceRef[]>();
  for (const [slug, paths] of pathsBySlug) {
    const records = (await Promise.all([...paths].sort().map((p) => indexStore.getByPath(p)))).filter(
      (r): r is SourceIndexRecord => r !== null,
    );
    records.sort((a, b) => {
      if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    out.set(
      slug,
      records.slice(0, ASSOCIATED_NOTE_REF_CAP_PER_PROJECT).map((r) => ({
        kind: "M1a",
        path: r.path,
        hash: r.contentHash,
        capturedAt: r.lastIndexedAt,
      })),
    );
  }
  return out;
}

/**
 * T-2.10: project name -> seed slug. The association catalog is keyed by seed
 * slug; paperclip projects are UUID-keyed and named. The two identity spaces
 * are joined by NAME (seed name === paperclip project name, e.g. "Circlo" /
 * "Storycrafter AI"). Loaded once per run from portfolio-seed.json.
 */
async function buildSlugByName(ctx: WorkerCtx): Promise<Map<string, string>> {
  const fs = createNoteAssociationFsDeps(ctx.logger);
  const seedPath = process.env.PACC_PORTFOLIO_SEED_PATH?.trim() || defaultPortfolioSeedPath();
  const projects = await fs.loadProjects(seedPath, resolveVaultRoot());
  const out = new Map<string, string>();
  for (const p of projects) out.set(p.name, p.slug);
  return out;
}

export async function assembleProjectCards(ctx: WorkerCtx): Promise<BrieferProjectInput[]> {
  const companies = await ctx.companies.list({ limit: 200, offset: 0 });
  // T-2.10: ground the brief in the association catalog (slug-keyed), joined to
  // paperclip projects by name. Both built once per run.
  const [refsBySlug, slugByName] = await Promise.all([
    buildAssociatedNoteRefsBySlug(ctx),
    buildSlugByName(ctx),
  ]);
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

      // T-2.10: this project's associated M1a notes (slug joined by name).
      const associatedNoteRefs = refsBySlug.get(slugByName.get(project.name) ?? "") ?? [];

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
        associatedNoteRefs,
      });
      cards.push({ projectId: project.id, projectName: project.name, card });
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Briefer deps
// ---------------------------------------------------------------------------

export function makeBrieferDeps(
  ctx: WorkerCtx,
  cards: BrieferProjectInput[],
  callModel?: BrieferDeps["callModel"],
): BrieferDeps {
  // T-2.10 Part B: cache the value-anchor registry per run so the brief (and
  // repeated renders) don't re-read the vault note each call.
  let anchorCache: ValueAnchorSummary[] | null = null;
  return {
    async listActiveProjectCards() {
      return cards;
    },
    async listValueAnchors() {
      if (anchorCache) return anchorCache;
      try {
        const service = createValueAnchorService({ vaultRoot: resolveVaultRoot() });
        await service.reload();
        anchorCache = service
          .getValueAnchors()
          .map((a) => ({ name: a.name, purpose: a.purpose, resolved: a.resolved }));
      } catch {
        anchorCache = [];
      }
      return anchorCache;
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
    callModel:
      callModel ??
      // Default: no model wired → null text → deterministic offline summary.
      (async () => ({ text: null, sessionId: null })),
  };
}

// ---------------------------------------------------------------------------
// Briefer model config (subscription-auth Claude CLI)
// ---------------------------------------------------------------------------

export interface BrieferModelConfig {
  /** True when a model id is configured (PACC_BRIEFER_MODEL). */
  enabled: boolean;
  /** Resolved model id, or null when offline. */
  modelId: string | null;
  /** Concrete callModel impl (claude CLI when enabled, else offline-null). */
  callModel: BrieferDeps["callModel"];
}

/**
 * Resolve the briefer's model wiring from the environment.
 *
 *   PACC_BRIEFER_MODEL  — enable narrative generation via the local Claude
 *                         Code CLI (subscription auth — no API key). Accepts:
 *                           - `on` / `true` / `1` / `default` / `yes`
 *                             → enabled with BRIEFER_DEFAULT_MODEL (Sonnet 4.6)
 *                           - a Claude model id (e.g. claude-opus-4-8)
 *                             → enabled with that model
 *                           - unset / `off` / `false` / `0` / `none`
 *                             → deterministic offline briefs
 *   PACC_CLAUDE_BIN     — optional override for the `claude` binary path.
 *   PACC_BRIEFER_MODEL_TIMEOUT_MS — optional call timeout (default 120000).
 */
export function resolveBrieferModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void },
): BrieferModelConfig {
  const raw = env.PACC_BRIEFER_MODEL?.trim();
  const offline: BrieferModelConfig = {
    enabled: false,
    modelId: null,
    callModel: async () => ({ text: null, sessionId: null }),
  };

  if (!raw) return offline;
  const lc = raw.toLowerCase();
  if (["off", "false", "0", "none", "no"].includes(lc)) return offline;

  // `on`-style switches enable with the default model; anything else is a model id.
  const modelId = ["on", "true", "1", "default", "yes"].includes(lc)
    ? BRIEFER_DEFAULT_MODEL
    : raw;
  const binPath = env.PACC_CLAUDE_BIN?.trim() || undefined;
  const timeoutMs = env.PACC_BRIEFER_MODEL_TIMEOUT_MS
    ? Number(env.PACC_BRIEFER_MODEL_TIMEOUT_MS)
    : undefined;
  return {
    enabled: true,
    modelId,
    callModel: (args) => callModelViaClaudeCli(args, { binPath, timeoutMs, logger }),
  };
}

// ---------------------------------------------------------------------------
// Top-level: scheduled-brief deps
// ---------------------------------------------------------------------------

export interface MakeScheduledBriefDepsResult {
  deps: ScheduledBriefDeps;
  /** companyId used for event emission (first company, or 'instance' if none). */
  eventCompanyId: string;
  /** Resolved model wiring — worker uses this to set skipModel/modelId. */
  model: BrieferModelConfig;
}

// ---------------------------------------------------------------------------
// T-2.4: M1b write-mediator assembly
// ---------------------------------------------------------------------------

export interface ObsidianGuard {
  guard: ObsidianFileWriter;
  vaultRoot: string;
  /** Loader warnings (unresolved registry links etc.) — surface in logs/brief. */
  registryWarnings: string[];
}

/**
 * Builds the T-2.4 write-mediator from a fresh registry read. Called at the
 * start of every vault-writing job run, which gives PRD § 9.6 its
 * "reload at every morning sweep" semantics for free — no long-lived cache.
 */
export async function makeObsidianGuard(
  ctx: WorkerCtx,
  eventCompanyId?: string,
): Promise<ObsidianGuard> {
  const companyId =
    eventCompanyId ?? (await ctx.companies.list({ limit: 1, offset: 0 }))[0]?.id ?? "instance";
  const vaultRoot = resolveVaultRoot();
  const service = createValueAnchorService({ vaultRoot });
  await service.reload();
  const guard = createObsidianFileWriter({
    vaultRoot,
    getProtectedPaths: service.getProtectedPaths,
    async emitEvent(name, payload) {
      await ctx.events.emit(name, companyId, payload);
    },
  });
  return { guard, vaultRoot, registryWarnings: service.getWarnings() };
}

// Vault root resolution — extracted to `../vault-root.js` (T-2.1) so the
// filesystem watcher and any other adapter share one resolution order
// instead of duplicating it.

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

  const model = resolveBrieferModelConfig(process.env, ctx.logger);

  const deps: ScheduledBriefDeps = {
    briefer: makeBrieferDeps(ctx, cards, model.callModel),
    lock: makeOverlapStore(ctx),
    async emitEvent(name, payload) {
      await ctx.events.emit(name, eventCompanyId, payload);
    },
    logger: ctx.logger,
    hallucination: makeHallucinationDeps(ctx, knownIds),
    killCriterion: makeKillCriterionDeps(ctx),
  };

  return { deps, eventCompanyId, model };
}
