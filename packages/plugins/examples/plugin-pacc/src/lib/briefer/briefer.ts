/**
 * Briefer worker — T-3.1.
 *
 * Produces a daily operating brief from canonical state + memory overlays.
 * L1-only: cannot write to M2 (structurally via `BrieferDeps`, runtime via
 * `assertBrieferL1`).
 *
 * For T-3.1 the brief is a *structurally valid* placeholder — sections
 * exist, blocked/stale/escalations are computed from the context cards,
 * and the narrative slots are populated either by a single LLM call (when
 * `callModel` returns useful text) or by a deterministic fallback (so the
 * brief is non-empty even if the model is unavailable). T-3.2 fills in
 * the real system prompt; T-3.4 / T-3.5 fill in specific sections.
 */

import { createHash } from "node:crypto";
import type {
  Brief,
  BrieferDeps,
  BrieferProjectInput,
  DoNotRethinkAlert,
  ProposedAction,
  StaleRollupRow,
} from "./types.js";
import { assertBrieferL1 } from "./types.js";
import {
  checkDoNotRethink,
  type RethinkConflict,
} from "./do-not-rethink.js";

/**
 * Default model for the briefer (configurable per principal). Sonnet 4.6 is
 * the chosen default — a good quality/usage balance for a once-daily brief on
 * the Claude subscription. Override with PACC_BRIEFER_MODEL=<model-id>.
 */
export const BRIEFER_DEFAULT_MODEL = "claude-sonnet-4-6";

/** The briefer's actor identifier. Threaded into every write/propose. */
export const BRIEFER_ACTOR = "agent:briefer";

export interface RunBrieferOptions {
  /** Override the model. Defaults to `claude-opus-4-7`. */
  modelId?: string;
  /** Override the calendar date (for tests). Default: today UTC. */
  now?: Date;
  /** Set to true to skip the LLM call entirely (offline brief). */
  skipModel?: boolean;
}

export async function runBriefer(
  deps: BrieferDeps,
  options: RunBrieferOptions = {},
): Promise<Brief> {
  const now = options.now ?? new Date();
  const modelId = options.modelId ?? BRIEFER_DEFAULT_MODEL;

  const projects = await deps.listActiveProjectCards();

  // Stable cache key — sum the per-project cacheKeys + briefDate. If any
  // upstream context changes, the brief's cacheKey changes too.
  const briefDate = now.toISOString().slice(0, 10);
  const inputsCacheKey = createHash("sha256")
    .update(briefDate + "|" + projects.map((p) => p.card.cacheKey).join("|"))
    .digest("hex");

  // Compute the structural sections (no LLM needed)
  const blockedProjects = projects
    .filter((p) => p.card.portfolioState === "blocked" || p.card.blockers.answer !== null)
    .map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      blockerSummary: p.card.blockers.answer,
    }));

  const staleConflictedMemory = computeStaleRollup(projects);
  const escalations = projects.flatMap((p) =>
    p.card.openEscalations.map((e) => ({
      projectId: p.projectId,
      question: e.question,
      recommendedDecision: e.recommendedDecision,
    })),
  );
  const doNotRethinkAlerts = computeDoNotRethinkAlerts(projects);
  const sourceNotes = projects.flatMap((p) =>
    p.card.sourceRefs.map((r) => ({ projectId: p.projectId, path: r.path })),
  );
  const warnings = projects.flatMap((p) => p.card.warnings);

  // Recommended focus — pick the first active project with a non-null
  // nextSmallestAction. Heuristic only; T-3.4 will replace with job-mix-
  // aware ranking.
  const recommendedFocus = recommendFocusFromCards(projects);

  // High-leverage actions — for MVP just surface every project's
  // nextSmallestAction as a proposal. T-3.2 will use the LLM to rank.
  const highLeverageActions: ProposedAction[] = projects
    .filter((p) => p.card.nextActions.answer !== null)
    .map((p) => ({
      projectId: p.projectId,
      summary: p.card.nextActions.answer ?? "",
      rationale: p.card.goal.answer ?? "(no intent declared)",
      expectedArtifact: null,
      requiredAuthority: "L1" as const,
      jobClassification:
        (p.card as { jobClassificationDominant?: "J1_signal" | "J2_distribution" | "J3_product" | "meta" })
          .jobClassificationDominant ?? "meta",
      confidence: p.card.confidence ?? 0.5,
      sourceRefs: p.card.nextActions.sourceRefs.map((r) => ({
        kind: r.kind,
        path: r.path,
        section: r.section,
        hash: r.hash,
        capturedAt: r.capturedAt,
      })),
    }));

  // Narrative slots — try the model; fall back to a deterministic synthesis.
  const portfolioSummary = options.skipModel
    ? offlinePortfolioSummary(projects)
    : await synthesizePortfolioSummary(deps, projects, modelId);

  const changesSinceLast: Brief["changesSinceLast"] = {
    answer: (await deps.readEpisodicSinceLastBrief?.()) ?? null,
    confidence: "unknown",
    sourceRefs: [],
  };

  const brief: Brief = {
    generatedAt: now.toISOString(),
    briefDate,
    inputsCacheKey,
    portfolioSummary,
    recommendedFocus,
    changesSinceLast,
    staleConflictedMemory,
    blockedProjects,
    highLeverageActions,
    backlogCandidates: [],
    escalations,
    doNotRethinkAlerts,
    imaginationFeaturesParked: [],
    completedWork: [],
    authoritySafetyIssues: [],
    sourceNotes,
    jobMix: [],
    humanFeedback: {
      useful: null,
      wrong: null,
      changedPriority: null,
      approvedActions: [],
    },
    warnings,
  };

  await deps.saveBrief(brief);
  return brief;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeStaleRollup(projects: readonly BrieferProjectInput[]): StaleRollupRow[] {
  const buckets: Record<StaleRollupRow["kind"], { count: number; projectIds: Set<string> }> = {
    stale_pending_re_grounding: { count: 0, projectIds: new Set() },
    orphaned: { count: 0, projectIds: new Set() },
    conflict: { count: 0, projectIds: new Set() },
  };

  for (const p of projects) {
    for (const m of p.card.staleMarkers) {
      if (m.kind === "drift") {
        buckets.stale_pending_re_grounding.count += 1;
        buckets.stale_pending_re_grounding.projectIds.add(p.projectId);
      } else if (m.kind === "orphan") {
        buckets.orphaned.count += 1;
        buckets.orphaned.projectIds.add(p.projectId);
      } else if (m.kind === "conflict") {
        buckets.conflict.count += 1;
        buckets.conflict.projectIds.add(p.projectId);
      }
      // 'decay' markers don't roll into the stale/conflict table — they're
      // surfaced via warnings.
    }
  }

  return (Object.keys(buckets) as Array<StaleRollupRow["kind"]>)
    .filter((k) => buckets[k].count > 0)
    .map((k) => ({
      kind: k,
      count: buckets[k].count,
      projectIds: [...buckets[k].projectIds].slice(0, 20),
    }));
}

function computeDoNotRethinkAlerts(
  projects: readonly BrieferProjectInput[],
): DoNotRethinkAlert[] {
  // T-3.5: Jaccard similarity check (threshold 0.4) against each entry in
  // the project's doNotRethink list. Replaces T-3.1's naive keyword overlap.
  const alerts: DoNotRethinkAlert[] = [];
  for (const p of projects) {
    const dnr = p.card.doNotRethink.answer;
    const next = p.card.nextActions.answer;
    if (!dnr || !next) continue;

    const conflicts: RethinkConflict[] = checkDoNotRethink({
      proposalText: next,
      doNotRethink: dnr,
    });
    for (const c of conflicts) {
      alerts.push({
        projectId: p.projectId,
        projectName: p.projectName,
        settledDecision: c.settledDecision,
        conflictingAction: c.proposalText,
      });
    }
  }
  return alerts;
}

function recommendFocusFromCards(
  projects: readonly BrieferProjectInput[],
): ProposedAction | null {
  // Pick the first 'primary' project with a non-null nextSmallestAction.
  // T-3.4 will replace with job-mix-aware ranking.
  const primary = projects.find(
    (p) => p.card.portfolioState === "primary" && p.card.nextActions.answer !== null,
  );
  const active = projects.find(
    (p) => p.card.portfolioState === "active" && p.card.nextActions.answer !== null,
  );
  const chosen = primary ?? active;
  if (!chosen) return null;

  const next = chosen.card.nextActions;
  return {
    projectId: chosen.projectId,
    summary: next.answer ?? "",
    rationale: chosen.card.goal.answer ?? "(no intent declared)",
    expectedArtifact: null,
    requiredAuthority: "L1",
    jobClassification:
      (chosen.card as { jobClassificationDominant?: "J1_signal" | "J2_distribution" | "J3_product" | "meta" })
        .jobClassificationDominant ?? "meta",
    confidence: chosen.card.confidence ?? 0.5,
    sourceRefs: next.sourceRefs.map((r) => ({
      kind: r.kind,
      path: r.path,
      section: r.section,
      hash: r.hash,
      capturedAt: r.capturedAt,
    })),
  };
}

function offlinePortfolioSummary(
  projects: readonly BrieferProjectInput[],
): Brief["portfolioSummary"] {
  if (projects.length === 0) {
    return { answer: "No active projects.", confidence: "high", sourceRefs: [] };
  }
  const primaryCount = projects.filter((p) => p.card.portfolioState === "primary").length;
  const activeCount = projects.filter((p) => p.card.portfolioState === "active").length;
  const blockedCount = projects.filter((p) => p.card.portfolioState === "blocked").length;
  return {
    answer:
      `Portfolio: ${projects.length} project(s) — ` +
      `${primaryCount} primary, ${activeCount} active, ${blockedCount} blocked. ` +
      `Brief generated in offline mode (no model call).`,
    confidence: "low",
    sourceRefs: [],
  };
}

async function synthesizePortfolioSummary(
  deps: BrieferDeps,
  projects: readonly BrieferProjectInput[],
  modelId: string,
): Promise<Brief["portfolioSummary"]> {
  if (projects.length === 0) {
    return { answer: "No active projects.", confidence: "high", sourceRefs: [] };
  }
  const prompt = buildPortfolioSynthesisPrompt(projects);
  let response: { text: string | null; sessionId: string | null };
  try {
    response = await deps.callModel({ modelId, prompt });
  } catch {
    return offlinePortfolioSummary(projects);
  }
  if (!response.text) {
    return offlinePortfolioSummary(projects);
  }
  return {
    answer: response.text,
    confidence: "low", // Briefer narrative is always L1 draft.
    sourceRefs: [],
  };
}

function buildPortfolioSynthesisPrompt(projects: readonly BrieferProjectInput[]): string {
  const lines: string[] = [
    "You are the briefer. Produce a 2-3 sentence portfolio summary based on the active projects below.",
    "Be concrete. Cite project names. Do not invent state that isn't shown.",
    "",
  ];
  for (const p of projects) {
    lines.push(`### ${p.projectName} (${p.projectId})`);
    lines.push(`- portfolio state: ${p.card.portfolioState ?? "unknown"}`);
    lines.push(`- phase: ${p.card.currentPhase ?? "unknown"}`);
    if (p.card.goal.answer) lines.push(`- goal: ${p.card.goal.answer}`);
    if (p.card.nextActions.answer) lines.push(`- next: ${p.card.nextActions.answer}`);
    if (p.card.blockers.answer) lines.push(`- blocked: ${p.card.blockers.answer}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Re-export the authority guard so callers see it from this module
// ---------------------------------------------------------------------------
export { assertBrieferL1 };
