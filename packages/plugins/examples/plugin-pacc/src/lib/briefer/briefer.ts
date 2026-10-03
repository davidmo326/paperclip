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
  LeadQuestion,
  OpenQuestionRow,
  ProposedAction,
  StaleRollupRow,
} from "./types.js";
import { assertBrieferL1 } from "./types.js";
import {
  checkDoNotRethink,
  type RethinkConflict,
} from "./do-not-rethink.js";
import { synthesizeValidated } from "./briefer-output.js";
import { computeJobMix, type JobMixPhase, type JobClass } from "./job-mix.js";

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
  /**
   * Called when the model returns schema-invalid output twice (T-3.2). The
   * caller (scheduled-brief) emits `briefer.schema_violation`. The narrative
   * slot degrades to the deterministic offline summary; the brief still renders.
   */
  onSchemaViolation?: (error: string) => void;
}

function formatBriefDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  // Calendar date in the runtime's local timezone (TZ env) — the brief is a
  // local-morning artifact; toISOString would date it a day behind in
  // anything east of UTC (e.g. Australia/Sydney).
  const briefDate = formatBriefDate(now);
  const inputsCacheKey = createHash("sha256")
    .update(briefDate + "|" + projects.map((p) => p.card.cacheKey).join("|"))
    .digest("hex");

  // Recommended focus — pick the first active project with a non-null
  // nextSmallestAction. Heuristic only; T-3.4 will replace with job-mix-
  // aware ranking.
  let recommendedFocus = recommendFocusFromCards(projects);

  // T-3.15: the question plane — testable hypotheses (those with a testPlan),
  // reframed as the principal's open questions. Phase 1 surfaces hypotheses
  // only (Assumption has no test field → joins in Phase 2 with test-authoring).
  // Riskiest-first: lowest confidence = most uncertain = the riskiest non-
  // obvious assumption. The lead's test is welded to the Next Action (Q1).
  const candidateQuestions: OpenQuestionRow[] = projects.flatMap((p) =>
    p.card.activeHypotheses
      .filter((h) => h.status === "active" && typeof h.testPlan === "string" && h.testPlan.trim() !== "")
      .map((h) => ({
        projectId: p.projectId,
        projectName: p.projectName,
        kind: "hypothesis" as const,
        statement: h.statement,
        test: h.testPlan!,
        confidence: h.confidence,
        // Fidelity marker (Q2/Q11): placeholder until the constraintLane-aware
        // market-keyword heuristic lands in the refinement slice.
        fidelityMismatch: false,
      })),
  );
  candidateQuestions.sort((a, b) => a.confidence - b.confidence);
  const leadQuestion: LeadQuestion | null =
    candidateQuestions.length > 0
      ? { ...candidateQuestions[0]!, overridden: false }
      : null;
  // Open questions = the rest (lead excluded), grouped per project in render.
  // T-6.3: quiet projects filtered out after the delta computation below.
  const candidateRest: OpenQuestionRow[] = candidateQuestions.slice(1);

  // When a lead question exists, weld its test to the Next Action (recommended
  // Focus) so the brief's "do next" IS the test of the lead question. Falls
  // back to the old nextSmallestAction-derived focus when no testable lead.
  if (leadQuestion) {
    recommendedFocus = {
      projectId: leadQuestion.projectId,
      summary: leadQuestion.test,
      rationale: `Test for: ${leadQuestion.statement}`,
      expectedArtifact: null,
      requiredAuthority: "L1" as const,
      jobClassification: null,
      confidence: leadQuestion.confidence,
      sourceRefs: [],
    };
  }

  // T-6.3 delta-only brief (noise discipline, grill Q12 2026-08-16): compute
  // which projects are QUIET — card unchanged, aging status unchanged, no
  // open escalations, not carrying the lead question. Quiet projects
  // contribute nothing to per-project sections. Aging surfaces as threshold
  // crossings only. The lead question repeats until acted on (it IS the
  // welded next action) but carries an "unchanged since" marker.
  const lastDelta = (await deps.readLastBriefDelta?.()) ?? null;
  const prevKeys = lastDelta?.projectCardKeys ?? null;
  const prevAging = lastDelta?.projectAgingStatus ?? null;
  const leadKey = leadQuestion ? `${leadQuestion.projectId}::${leadQuestion.statement}` : null;
  const leadUnchangedSince =
    leadQuestion && lastDelta !== null && lastDelta.leadKey === leadKey
      ? (lastDelta.leadSince ?? lastDelta.briefDate)
      : null;

  const quietProjectIds: string[] = [];
  const projectCardKeys: Record<string, string> = {};
  const projectAgingStatus: Record<string, string> = {};
  const agingCrossings: Array<{
    projectId: string;
    projectName: string;
    from: string;
    to: string;
  }> = [];
  for (const p of projects) {
    projectCardKeys[p.projectId] = p.card.cacheKey;
    const status = p.card.staleStatus ?? "fresh";
    projectAgingStatus[p.projectId] = status;

    // Crossing = status changed vs the previous brief (fires once, on the day).
    const prevStatus = prevAging?.[p.projectId];
    if (prevAging !== null && prevStatus !== undefined && prevStatus !== status) {
      agingCrossings.push({
        projectId: p.projectId,
        projectName: p.projectName,
        from: prevStatus,
        to: status,
      });
    }

    const cardUnchanged = prevKeys !== null && prevKeys[p.projectId] === p.card.cacheKey;
    const agingUnchanged = prevAging !== null && prevAging[p.projectId] === status;
    const isLead = leadQuestion?.projectId === p.projectId;
    const hasEscalations = p.card.openEscalations.length > 0;
    if (cardUnchanged && agingUnchanged && !isLead && !hasEscalations) {
      quietProjectIds.push(p.projectId);
    }
  }
  const quiet = new Set(quietProjectIds);
  const nonQuiet = projects.filter((p) => !quiet.has(p.projectId));

  // Structural sections, delta-filtered where per-project (T-6.3). Escalations
  // stay unfiltered (they self-extinguish when the principal decides);
  // stale-conflicted memory stays (portfolio-level data-quality rollup).
  const blockedProjects = nonQuiet
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
  const doNotRethinkAlerts = computeDoNotRethinkAlerts(nonQuiet);
  const sourceNotes = nonQuiet.flatMap((p) => {
    // T-6.7: attach the note substance (source-index summary) where the ref
    // is one of the associated M1a notes; M2 refs render path-only.
    const summaryByPath = new Map(p.card.associatedNotes.map((n) => [n.path, n.summary]));
    return p.card.sourceRefs.map((r) => ({
      projectId: p.projectId,
      path: r.path,
      summary: summaryByPath.get(r.path) ?? null,
    }));
  });
  const warnings = [...nonQuiet.flatMap((p) => p.card.warnings)];
  const openQuestions: OpenQuestionRow[] = candidateRest.filter(
    (q) => !quiet.has(q.projectId),
  );

  // High-leverage actions — for MVP surface each NON-QUIET project's
  // nextSmallestAction as a proposal. T-3.2 will use the LLM to rank.
  const highLeverageActions: ProposedAction[] = nonQuiet
    .filter((p) => p.card.nextActions.answer !== null)
    .map((p) => ({
      projectId: p.projectId,
      summary: p.card.nextActions.answer ?? "",
      rationale: p.card.goal.answer ?? "(no intent declared)",
      expectedArtifact: null,
      requiredAuthority: "L1" as const,
      // D-41: a missing jobClassificationDominant must never masquerade as
      // "meta" — render null (renderer shows "unclassified").
      jobClassification:
        (p.card as { jobClassificationDominant?: "J1_signal" | "J2_distribution" | "J3_product" | "meta" | null })
          .jobClassificationDominant ?? null,
      confidence: p.card.confidence ?? 0.5,
      sourceRefs: p.card.nextActions.sourceRefs.map((r) => ({
        kind: r.kind,
        path: r.path,
        section: r.section,
        hash: r.hash,
        capturedAt: r.capturedAt,
      })),
    }));
  let portfolioSummary: Brief["portfolioSummary"];
  if (options.skipModel) {
    portfolioSummary = offlinePortfolioSummary(projects);
  } else {
    const syn = await synthesizePortfolioSummary(deps, projects, modelId);
    portfolioSummary = syn.summary;
    if (syn.schemaViolation) {
      warnings.push(
        `briefer narrative degraded to offline — model returned invalid output (${syn.lastError ?? "schema violation"})`,
      );
      options.onSchemaViolation?.(syn.lastError ?? "schema violation");
    }
  }

  const changesSinceLast: Brief["changesSinceLast"] = {
    answer: (await deps.readEpisodicSinceLastBrief?.()) ?? null,
    confidence: "unknown",
    sourceRefs: [],
  };

  // projectId -> name, so the renderer never shows raw UUIDs.
  const projectNames: Record<string, string> = {};
  for (const p of projects) projectNames[p.projectId] = p.projectName;

  // Job-mix table (T-3.4) — the floor's activity stream when T-jev feeds one;
  // projects with no classified activity fall back to their dominant class.
  const jobActivities = (await deps.listJobActivities?.()) ?? [];
  const jobMix = computeJobMix(
    projects.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      phase: (p.card.currentPhase as JobMixPhase | null) ?? null,
      jobClassificationDominant:
        (p.card as { jobClassificationDominant?: JobClass | null }).jobClassificationDominant ?? null,
    })),
    jobActivities,
    { now },
  );

  const valueAnchors = (await deps.listValueAnchors?.()) ?? [];

  const brief: Brief = {
    generatedAt: now.toISOString(),
    briefDate,
    inputsCacheKey,
    portfolioSummary,
    leadQuestion,
    recommendedFocus,
    changesSinceLast,
    staleConflictedMemory,
    blockedProjects,
    highLeverageActions,
    backlogCandidates: [],
    openQuestions,
    escalations,
    doNotRethinkAlerts,
    imaginationFeaturesParked: [],
    completedWork: [],
    authoritySafetyIssues: [],
    sourceNotes,
    valueAnchors,
    jobMix,
    projectNames,
    humanFeedback: {
      useful: null,
      wrong: null,
      changedPriority: null,
      approvedActions: [],
    },
    warnings,
    quietProjectIds,
    agingCrossings,
    projectCardKeys,
    projectAgingStatus,
    leadUnchangedSince,
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
    // D-41: never fabricate "meta" for an unset field — render null.
    jobClassification:
      (chosen.card as { jobClassificationDominant?: "J1_signal" | "J2_distribution" | "J3_product" | "meta" | null })
        .jobClassificationDominant ?? null,
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

interface SynthesisOutcome {
  summary: Brief["portfolioSummary"];
  schemaViolation: boolean;
  lastError: string | null;
}

async function synthesizePortfolioSummary(
  deps: BrieferDeps,
  projects: readonly BrieferProjectInput[],
  modelId: string,
): Promise<SynthesisOutcome> {
  if (projects.length === 0) {
    return {
      summary: { answer: "No active projects.", confidence: "high", sourceRefs: [] },
      schemaViolation: false,
      lastError: null,
    };
  }

  const dataPrompt = buildPortfolioSynthesisPrompt(projects);
  const result = await synthesizeValidated(deps, { modelId, dataPrompt });

  if (result.output) {
    // Map the validated numeric confidence onto the narrative enum. The briefer
    // is L1 — narrative carries no sourceRefs (recommendations do, deterministically).
    return {
      summary: {
        answer: result.output.summary,
        confidence: result.output.confidence >= 0.7 ? "high" : "low",
        sourceRefs: [],
      },
      schemaViolation: false,
      lastError: null,
    };
  }

  // Offline or persistent schema violation → deterministic fallback.
  return {
    summary: offlinePortfolioSummary(projects),
    schemaViolation: result.schemaViolation,
    lastError: result.lastError,
  };
}

function buildPortfolioSynthesisPrompt(projects: readonly BrieferProjectInput[]): string {
  // The role + rules + output format live in the system prompt (T-3.2). This is
  // the data payload only.
  const lines: string[] = [
    "Project context for today's portfolio synthesis:",
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
