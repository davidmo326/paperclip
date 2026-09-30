/**
 * Steward worker deps — T-4.8.
 *
 * Assembles the steward's dependency object from the paperclip plugin ctx,
 * mirroring the briefer builders. The authority ceiling is enforced twice:
 * structurally (the StewardDeps interface carries no writeM2 / task /
 * approvals surface) and at runtime (proposeM2 throws above L1).
 */

import type { AuthorityLevel } from "@paperclipai/shared";
import type { BrieferProjectInput, ValueAnchorSummary } from "../briefer/types.js";
import type { WorkerCtx } from "../briefer/worker-deps.js";
import type { DecisionCtx } from "../decisions/decision-deps.js";
import type { GrantCtx } from "../authority/grant-deps.js";

/** The steward reads the ledgers, so its ctx needs the entities surface too. */
export type StewardWorkerCtx = WorkerCtx & DecisionCtx & GrantCtx;
import {
  assembleProjectCards,
  makeObsidianGuard,
} from "../briefer/worker-deps.js";
import type { HallucinationDeps } from "../briefer/scheduled-brief.js";
import { makeDecisionDeps } from "../decisions/decision-deps.js";
import { selectDecisionsDue } from "../decisions/decision-log.js";
import { makeGrantDeps } from "../authority/grant-deps.js";
import { selectExpiringGrants } from "../authority/authority-grant.js";
import { callModelViaClaudeCli } from "../briefer/model-claude-cli.js";
import { renderBriefMarkdown } from "../briefer/render.js";
import { BRIEFER_DEFAULT_MODEL } from "../briefer/briefer.js";
import { createValueAnchorService } from "../value-anchor/service.js";
import { resolveVaultRoot } from "../vault-root.js";
import { makeLineDeps } from "../lines/lines-deps.js";
import { promoteJournalToFloor, readStewardFloor } from "../lines/floor-actions.js";
import { makeWorkItemDeps } from "../work-items/work-item-deps.js";
import { vaultWritesEnabled } from "../briefer/obsidian-writer.js";
import { STEWARD_ACTOR, assertStewardL1, type StewardDeps } from "./steward.js";
import type { ScheduledStewardDeps } from "./scheduled-steward.js";
import {
  STEWARD_IN_PROGRESS_STATE_KEY,
  STEWARD_JOURNAL_DELTA_STATE_KEY,
  STEWARD_JOURNAL_STORE_STATE_KEY,
  STEWARD_PAUSED_STATE_KEY,
  HALLUCINATION_FLAGS_STATE_KEY,
  BRIEF_STORE_STATE_KEY,
  BRIEF_DELTA_STATE_KEY,
  BRIEF_FEEDBACK_STATE_KEY,
  PLUGIN_NAMESPACE,
} from "../../constants.js";
import type { Brief } from "../briefer/types.js";

function instanceKey(stateKey: string) {
  return { scopeKind: "instance" as const, namespace: PLUGIN_NAMESPACE, stateKey };
}

// ---------------------------------------------------------------------------
// Steward deps (L0/L1 ceiling by construction)
// ---------------------------------------------------------------------------

/**
 * The exact key set the steward is allowed to hold. A test asserts the
 * production deps object matches this — anything else (writeM2, task
 * creation, approvals) is a capability leak.
 */
export const STEWARD_DEPS_ALLOWED_KEYS = [
  "listActiveProjectCards",
  "readFloor",
  "listValueAnchors",
  "readOpenLedgers",
  "readLastJournalDelta",
  "readLastBrief",
  "readBriefFeedback",
  "proposeM2",
  "saveJournal",
  "writeDraft",
  "callModel",
] as const;

export interface StewardModelConfig {
  enabled: boolean;
  modelId: string | null;
  callModel: StewardDeps["callModel"];
}

/**
 * PACC_STEWARD_MODEL — same semantics as PACC_BRIEFER_MODEL:
 * unset/off/false/0/none/no → deterministic journal; on/true/1/default/yes →
 * default model; anything else = explicit model id. Optional
 * PACC_STEWARD_MODEL_TIMEOUT_MS overrides the call timeout.
 */
export function resolveStewardModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void },
): StewardModelConfig {
  const raw = env.PACC_STEWARD_MODEL?.trim();
  const offline: StewardModelConfig = {
    enabled: false,
    modelId: null,
    callModel: async () => ({ text: null, sessionId: null }),
  };
  if (!raw) return offline;
  const lc = raw.toLowerCase();
  if (["off", "false", "0", "none", "no"].includes(lc)) return offline;
  const modelId = ["on", "true", "1", "default", "yes"].includes(lc) ? BRIEFER_DEFAULT_MODEL : raw;
  const binPath = env.PACC_CLAUDE_BIN?.trim() || undefined;
  // A CoS pass over the whole floor takes minutes, not the CLI provider's
  // 120s default (which silently degraded runs to the deterministic journal).
  const timeoutMs = env.PACC_STEWARD_MODEL_TIMEOUT_MS ? Number(env.PACC_STEWARD_MODEL_TIMEOUT_MS) : 600_000;
  const auth = env.PACC_STEWARD_AUTH?.trim().toLowerCase() === "subscription" ? "subscription" : "env";
  const effort = env.PACC_STEWARD_EFFORT?.trim() || undefined;
  return {
    enabled: true,
    modelId,
    callModel: (args) => callModelViaClaudeCli(args, { binPath, timeoutMs, logger, auth, effort }),
  };
}

export function makeStewardDeps(
  ctx: StewardWorkerCtx,
  cards: BrieferProjectInput[],
  callModel: StewardDeps["callModel"],
  guard?: (targetPath: string, content: string) => Promise<{ path: string; kind: "wrote" | "unchanged" }>,
): StewardDeps {
  let anchorCache: ValueAnchorSummary[] | null = null;
  return {
    async listActiveProjectCards() {
      return cards;
    },
    async readFloor() {
      try {
        return await readStewardFloor({ lines: makeLineDeps(ctx), items: makeWorkItemDeps(ctx) }, new Date());
      } catch {
        return null;
      }
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
    async readOpenLedgers() {
      const decisionDeps = makeDecisionDeps(ctx);
      const projectNameById = new Map(cards.map((c) => [c.projectId, c.projectName]));
      const now = new Date();
      const decisionsDue: Array<{ projectName: string; summary: string; reviewDate: string | null }> = [];
      for (const c of cards) {
        const due = selectDecisionsDue(await decisionDeps.listProjectDecisions(c.projectId), now);
        for (const d of due) {
          decisionsDue.push({
            projectName: projectNameById.get(d.projectId) ?? d.projectId,
            summary: d.summary,
            reviewDate: d.reviewDate,
          });
        }
      }
      const expiringGrants = selectExpiringGrants(await makeGrantDeps(ctx).listGrants(), now, 7).map((g) => ({
        label: `${g.ceiling} ${g.actionClass} @ ${g.projectId ?? "portfolio"}`,
        expiresAt: g.expiresAt,
      }));
      return { decisionsDue, expiringGrants };
    },
    async readLastJournalDelta() {
      const v = (await ctx.state.get(instanceKey(STEWARD_JOURNAL_DELTA_STATE_KEY))) as
        | { journalDate: string; projectCardKeys: Record<string, string> }
        | null;
      return v && typeof v.journalDate === "string" ? v : null;
    },
    async readLastBrief() {
      // The brief store is namespaced by brief-date with no list API — the
      // briefer's delta record (T-6.3) carries the last brief's date.
      const briefDate = await readLastBriefDate(ctx);
      if (briefDate === null) return null;
      const brief = (await ctx.state.get({
        scopeKind: "instance",
        namespace: briefDate,
        stateKey: BRIEF_STORE_STATE_KEY,
      })) as Brief | null;
      if (!brief) return null;
      // T-6.7: the pack promised the brief's markdown and delivered "" —
      // the steward reasoned blind. Render the stored brief (deterministic;
      // self-check appendix omitted) so the model sees what the principal
      // was actually shown.
      return { briefDate, markdown: renderBriefMarkdown(brief) };
    },
    async readBriefFeedback() {
      const briefDate = await readLastBriefDate(ctx);
      if (briefDate === null) return null;
      const rows = (await ctx.state.get({
        scopeKind: "instance",
        namespace: briefDate,
        stateKey: BRIEF_FEEDBACK_STATE_KEY,
      })) as Array<{ wrong?: string | null; changedPriority?: string | null }> | null;
      const parts = (rows ?? [])
        .flatMap((r) => [r.wrong, r.changedPriority])
        .filter((s): s is string => typeof s === "string" && s.trim() !== "");
      return parts.length > 0 ? parts.join("; ") : null;
    },
    async proposeM2(args) {
      // L0/L1 ceiling — an L2+ attempt throws (test-verified).
      if (args.requiredAuthority !== undefined) {
        assertStewardL1(args.requiredAuthority, "proposeM2");
      }
      // Candidate-memory store wiring is the approval-queue ticket (T-4.2/4.3,
      // M-Brief-gated). Parity with the briefer's documented no-op.
    },
    async saveJournal(journal) {
      await ctx.state.set(
        { scopeKind: "instance", namespace: journal.journalDate, stateKey: STEWARD_JOURNAL_STORE_STATE_KEY },
        journal,
      );
      // Delta baseline for tomorrow's "what changed" diff.
      const projectCardKeys: Record<string, string> = {};
      for (const p of cards) {
        projectCardKeys[p.projectId] = p.card.cacheKey;
      }
      await ctx.state.set(instanceKey(STEWARD_JOURNAL_DELTA_STATE_KEY), {
        journalDate: journal.journalDate,
        projectCardKeys,
      });
      // The journal reaches the surface as Triage items (vault is input only),
      // fitted to today's capacity (a recorded 0 writes the day off).
      try {
        const floorDeps = { lines: makeLineDeps(ctx), items: makeWorkItemDeps(ctx) };
        const floor = await readStewardFloor(floorDeps, new Date()).catch(() => null);
        const promoted = await promoteJournalToFloor(floorDeps, journal, new Date(), { capacity: floor?.capacity ?? null });
        ctx.logger.info("steward: journal promoted to floor", {
          created: promoted.created.length,
          unmatched: promoted.unmatched,
          skippedForCapacity: promoted.skippedForCapacity,
        });
      } catch (err) {
        ctx.logger.warn("steward: journal promotion failed", { error: String(err) });
      }
      return { id: `steward-journal-${journal.journalDate}` };
    },
    async writeDraft(targetPath, content) {
      if (!targetPath.endsWith(".draft.md")) {
        throw new Error(`steward draft path must end with .draft.md (got ${targetPath})`);
      }
      if (targetPath.includes("..")) {
        throw new Error(`steward draft path must not traverse (got ${targetPath})`);
      }
      if (!vaultWritesEnabled()) {
        // Vault is input only: drafts reach the principal as Triage items instead.
        return { path: targetPath, kind: "unchanged" as const };
      }
      if (guard === undefined) {
        throw new Error("steward writeDraft: no M1b mediator wired — refusing bare write");
      }
      return guard(targetPath, content);
    },
    callModel,
  };
}

// ---------------------------------------------------------------------------
// Scheduled-steward deps
// ---------------------------------------------------------------------------

export function makeStewardHallucinationDeps(
  ctx: StewardWorkerCtx,
  knownIds: ReadonlySet<string>,
): HallucinationDeps {
  // D-39: the 24h sightings window is SHARED with the briefer (one counter
  // of model-generated unknown refs across the duty cycle), but the pause
  // flag is the steward's own — a briefer pause must not silence the
  // steward and vice versa.
  return {
    knownIds,
    async readFlags() {
      const v = await ctx.state.get(instanceKey(HALLUCINATION_FLAGS_STATE_KEY));
      return (v as never) ?? null;
    },
    async writeFlags(state) {
      await ctx.state.set(instanceKey(HALLUCINATION_FLAGS_STATE_KEY), state);
    },
    async isPaused() {
      const v = (await ctx.state.get(instanceKey(STEWARD_PAUSED_STATE_KEY))) as
        | { paused: boolean; reason: string | null }
        | null;
      return v ?? { paused: false, reason: null };
    },
    async setPaused(reason) {
      await ctx.state.set(instanceKey(STEWARD_PAUSED_STATE_KEY), {
        paused: true,
        reason,
        pausedAt: new Date().toISOString(),
      });
    },
  };
}

export interface MakeScheduledStewardDepsResult {
  deps: ScheduledStewardDeps;
  eventCompanyId: string;
  model: StewardModelConfig;
  /** M1b mediator for journal + draft writes. */
  guard: (targetPath: string, content: string) => Promise<{ path: string; kind: "wrote" | "unchanged" }>;
  registryWarnings: string[];
}

export async function makeScheduledStewardDeps(
  ctx: StewardWorkerCtx,
): Promise<MakeScheduledStewardDepsResult> {
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const eventCompanyId = companies[0]?.id ?? "instance";

  const cards = await assembleProjectCards(ctx);
  const knownIds = new Set<string>();
  for (const c of cards) {
    knownIds.add(c.projectId);
    knownIds.add(c.projectName);
  }

  // T-2.4: fresh registry read per run (morning-sweep reload semantics).
  const m1b = await makeObsidianGuard(ctx, eventCompanyId);

  const model = resolveStewardModelConfig(process.env, ctx.logger);

  const deps: ScheduledStewardDeps = {
    steward: makeStewardDeps(ctx, cards, model.callModel, m1b.guard),
    lock: makeStewardOverlapStore(ctx),
    async emitEvent(name, payload) {
      await ctx.events.emit(name, eventCompanyId, payload);
    },
    logger: ctx.logger,
    hallucination: makeStewardHallucinationDeps(ctx, knownIds),
  };

  return { deps, eventCompanyId, model, guard: m1b.guard, registryWarnings: m1b.registryWarnings };
}

function makeStewardOverlapStore(ctx: StewardWorkerCtx) {
  // Same store shape as the briefer's, against the steward's own key.
  const key = instanceKey(STEWARD_IN_PROGRESS_STATE_KEY);
  return {
    async read() {
      const v = (await ctx.state.get(key)) as { acquiredAt?: string; runId?: string | null } | null;
      if (v === null || typeof v.acquiredAt !== "string") return null;
      return { acquiredAt: v.acquiredAt, runId: typeof v.runId === "string" ? v.runId : null };
    },
    async write(lock: { acquiredAt: string; runId: string | null }) {
      await ctx.state.set(key, lock);
    },
    async clear() {
      if (ctx.state.delete) {
        await ctx.state.delete(key);
      } else {
        await ctx.state.set(key, null);
      }
    },
  };
}

async function readLastBriefDate(ctx: StewardWorkerCtx): Promise<string | null> {
  const delta = (await ctx.state.get(instanceKey(BRIEF_DELTA_STATE_KEY))) as
    | { briefDate?: string }
    | null;
  return typeof delta?.briefDate === "string" ? delta.briefDate : null;
}
