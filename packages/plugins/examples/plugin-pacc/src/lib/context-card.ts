/**
 * Project Context Card builder — T-2.8 / PRD § 9.1 + § 15.3.
 *
 * Assembles canonical state + telemetry + T-2.6 freshness/decay overlays +
 * T-2.7 conflict overlay + recent decisions + active tasks into a single
 * structured card the steward can load before any action (PRD § 9.1).
 *
 * Also synthesizes answers to the eight questions from PRD § 15.3, each
 * carrying its own sourceRefs. Failing to answer any of them is the
 * `steward.eight_questions.unanswerable` signal — surfaced via
 * `getUnansweredQuestions()` so the caller decides whether to emit the
 * event (we keep this builder side-effect-free).
 *
 * Pure. The caller supplies all inputs; this file does no I/O, no DB
 * reads, no event emission. The cache layer + event emission live in a
 * thin wrapper at the worker level (T-3.x will own that).
 */

import { createHash } from "node:crypto";
import type {
  Assumption,
  AuthorityLevel,
  Escalation,
  Hypothesis,
  ProjectConstraintLane,
  ProjectControlPlaneState,
  ProjectControlPlaneTelemetry,
  ProjectPhase,
  ProjectPortfolioState,
  ProjectStaleStatus,
  SourceRef,
} from "@paperclipai/shared";
import type {
  ProjectConflictsState,
} from "./conflict.js";
import { listConflictedFields } from "./conflict.js";
import type { ProjectFreshnessRecord } from "../jobs/stale-rehash.js";
import type { ProjectDecayRecord } from "../jobs/source-decay-check.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Minimal decision-row shape the card consumes. */
export interface DecisionSummary {
  id: string;
  summary: string;
  chosenOption: string;
  rationale: string;
  decidedBy: string;
  createdAt: string;
  reviewDate: string | null;
  reversibleUntil: string | null;
  jobClassification: string;
  sourceRefs: SourceRef[];
  supersedes: string | null;
  /** Set only after T-4.7 retro job backfills it. */
  outcome: { reviewedAt: string; outcome: string } | null;
}

/** Minimal task-row shape (paperclip's `issues` table). */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Optional T-1.3-ish metadata; null when not yet populated. */
  whyItMatters: string | null;
  requiredAuthority: AuthorityLevel | null;
}

/** Per-(agent × project) authority grant. */
export interface AuthoritySummary {
  agentId: string;
  actionClass: string;
  ceiling: AuthorityLevel;
  expiresAt: string;
  revoked: boolean;
}

export interface ContextCardInputs {
  project: {
    id: string;
    name: string;
    controlPlaneState: ProjectControlPlaneState | null;
    controlPlaneUpdatedAt: string | null;
  };
  telemetry: ProjectControlPlaneTelemetry | null;
  /** Overlay produced by T-2.6 weekly job. */
  freshness: ProjectFreshnessRecord | null;
  /** Overlay produced by T-2.6 daily job. */
  decay: ProjectDecayRecord | null;
  /** Overlay produced by T-2.7 conflict guard. */
  conflicts: ProjectConflictsState | null;
  /** Recent decisions for this project — caller-supplied query result. */
  recentDecisions: DecisionSummary[];
  /** Active tasks (open / in-progress) for this project. */
  activeTasks: TaskSummary[];
  /** Per-project authority grants (filtered to this project, not revoked). */
  authority: AuthoritySummary[];
  /**
   * T-2.10: M1a notes associated to this project by the grounding pipeline
   * (note-association catalog → source index). The caller (worker-deps) must
   * sort these by path so the card's cacheKey + render stay deterministic.
   * Optional only so existing buildContextCard fixtures keep compiling; the
   * live briefer always supplies them (empty [] when a project has none).
   */
  associatedNoteRefs?: SourceRef[];
}

// ---------------------------------------------------------------------------
// Card shape
// ---------------------------------------------------------------------------

export interface AnswerWithCitations {
  /** Free-text answer. Null if no canonical state supports an answer. */
  answer: string | null;
  /** `high` when grounded in state; `low` when partial; `unknown` for nulls. */
  confidence: "high" | "low" | "unknown";
  /** Cited sources for this answer — provenance enforcement (PRD § 9.7). */
  sourceRefs: SourceRef[];
}

/** PRD § 15.3 — the eight questions the steward must answer for any project. */
export interface EightQuestions {
  /** What is this project trying to achieve? */
  achieve: AnswerWithCitations;
  /** What is the current status? */
  status: AnswerWithCitations;
  /** What decisions have already been made? */
  decisions: AnswerWithCitations;
  /** What assumptions are we operating under? */
  assumptions: AnswerWithCitations;
  /** What is blocked? */
  blocked: AnswerWithCitations;
  /** What changed recently? */
  changed: AnswerWithCitations;
  /** What can I safely do next? */
  safeNext: AnswerWithCitations;
  /** What requires human approval? */
  requiresApproval: AnswerWithCitations;
}

/** Lightweight pointer for a field that's marked stale / decayed / conflicted. */
export interface StaleMarker {
  /** What kind of stale signal: `drift` (hash changed), `orphan` (file gone), `decay` (mtime too old), `conflict` (quarantined). */
  kind: "drift" | "orphan" | "decay" | "conflict";
  /** What the marker points at — usually a SourceRef path or a fieldPath. */
  target: string;
  /** Optional human-readable detail (days since touch, etc.). */
  detail?: string;
}

export interface ContextCard {
  projectId: string;
  projectName: string;
  generatedAt: string;
  /** Sha256 of normalized inputs. Caller can use this to skip re-render when unchanged. */
  cacheKey: string;

  // § 9.1 minimum contents
  goal: AnswerWithCitations;
  portfolioState: ProjectPortfolioState | null;
  currentPhase: ProjectPhase | null;
  /** Which job (J1/J2/J3/meta) the project is dominantly serving (PRD § 8.1). */
  jobClassificationDominant: "J1_signal" | "J2_distribution" | "J3_product" | "meta" | null;
  constraintLane: ProjectConstraintLane | null;
  currentStatus: AnswerWithCitations;
  latestDecisions: DecisionSummary[];
  activeAssumptions: Assumption[];
  activeHypotheses: Hypothesis[];
  blockers: AnswerWithCitations;
  nextActions: AnswerWithCitations;
  activeTasks: TaskSummary[];
  dependencies: string[];
  risks: string[];
  authorityCeiling: AuthoritySummary[];
  killCriteria: AnswerWithCitations;
  doNotRethink: AnswerWithCitations;
  openEscalations: Escalation[];
  sourceRefs: SourceRef[];
  confidence: number | null;
  staleStatus: ProjectStaleStatus | null;
  staleMarkers: StaleMarker[];

  // § 15.3
  eightQuestions: EightQuestions;
  /** Subset of eightQuestions whose answer is null or confidence='unknown'. */
  unansweredQuestions: Array<keyof EightQuestions>;

  /** Soft warnings for the brief generator to surface. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildContextCard(
  inputs: ContextCardInputs,
  now: Date = new Date(),
): ContextCard {
  const { project, telemetry, freshness, decay, conflicts, recentDecisions, activeTasks, authority } = inputs;
  const state = project.controlPlaneState;

  const allSourceRefs = collectAllSourceRefs(inputs);
  const staleMarkers = buildStaleMarkers(freshness, decay, conflicts);
  const warnings = buildWarnings(staleMarkers, conflicts);

  const goal = pickAnswer(state?.intent ?? null, state?.sourceRefs ?? []);
  const status = pickAnswer(state?.currentStatus ?? null, state?.sourceRefs ?? []);
  const blockers = pickAnswer(state?.blockerSummary ?? null, state?.sourceRefs ?? []);
  // T-2.10: ground the next action in the project's associated M1a notes (the
  // grounding pipeline's output), merged with any M2 refs the steward cited.
  // Sorted + deduped by path so the card (cacheKey) + brief render are deterministic.
  const nextActions = pickAnswer(
    state?.nextSmallestAction ?? null,
    mergeSourceRefs(state?.sourceRefs ?? [], inputs.associatedNoteRefs ?? []),
  );
  const killCriteria = pickAnswer(state?.killCriteria ?? null, state?.sourceRefs ?? []);
  const doNotRethink = pickAnswer(state?.doNotRethink ?? null, state?.sourceRefs ?? []);

  const activeAssumptions = (state?.assumptions ?? []).filter(
    (a) => a.status === "accepted" || a.status === "challenged",
  );
  const activeHypotheses = (state?.hypotheses ?? []).filter(
    (h) => h.status === "active",
  );
  const openEscalations = (state?.escalations ?? []).filter(
    (e) => e.status === "open" || e.status === "deferred",
  );

  const eightQuestions = synthesizeEightQuestions({
    goal,
    status,
    blockers,
    nextActions,
    state,
    recentDecisions,
    activeAssumptions,
    activeTasks,
    authority,
    openEscalations,
    telemetry,
    staleMarkers,
  });

  const unansweredQuestions = (
    Object.keys(eightQuestions) as Array<keyof EightQuestions>
  ).filter(
    (k) =>
      eightQuestions[k].answer === null || eightQuestions[k].confidence === "unknown",
  );

  const card: ContextCard = {
    projectId: project.id,
    projectName: project.name,
    generatedAt: now.toISOString(),
    cacheKey: "", // filled below

    goal,
    portfolioState: state?.portfolioState ?? null,
    currentPhase: state?.currentPhase ?? null,
    jobClassificationDominant:
      (state?.jobClassificationDominant as ContextCard["jobClassificationDominant"]) ?? null,
    constraintLane: state?.constraintLane ?? null,
    currentStatus: status,
    latestDecisions: recentDecisions.slice(0, 10),
    activeAssumptions,
    activeHypotheses,
    blockers,
    nextActions,
    activeTasks,
    dependencies: [], // not yet modeled; T-2.3 / T-4.x will populate
    risks: [], // ditto
    authorityCeiling: authority,
    killCriteria,
    doNotRethink,
    openEscalations,
    sourceRefs: allSourceRefs,
    confidence: state?.confidence ?? null,
    staleStatus: telemetry?.staleStatus ?? null,
    staleMarkers,

    eightQuestions,
    unansweredQuestions,

    warnings,
  };

  card.cacheKey = computeCacheKey(inputs);
  return card;
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * SHA-256 of a normalized inputs digest. Stable for the same logical inputs
 * regardless of property order in objects. Callers that want to skip re-render
 * when the card hasn't changed can compare this key with a prior value.
 */
export function computeCacheKey(inputs: ContextCardInputs): string {
  return createHash("sha256").update(stableStringify(inputs)).digest("hex");
}

/** Like JSON.stringify but with sorted object keys at every level. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const out = keys.map(
    (k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]),
  );
  return "{" + out.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickAnswer(
  text: string | null,
  refs: SourceRef[],
): AnswerWithCitations {
  if (text === null || text.trim() === "") {
    return { answer: null, confidence: "unknown", sourceRefs: [] };
  }
  return {
    answer: text,
    confidence: refs.length > 0 ? "high" : "low",
    sourceRefs: refs,
  };
}

function collectAllSourceRefs(inputs: ContextCardInputs): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];

  const push = (r: SourceRef | undefined | null) => {
    if (!r) return;
    if (seen.has(r.path)) return;
    seen.add(r.path);
    out.push(r);
  };

  const state = inputs.project.controlPlaneState;
  state?.sourceRefs?.forEach(push);
  state?.memoryIndexRefs?.forEach(push);
  state?.assumptions?.forEach((a) => a.sourceRefs.forEach(push));
  state?.hypotheses?.forEach((h) => {
    h.evidenceFor.forEach(push);
    h.evidenceAgainst.forEach(push);
  });
  state?.escalations?.forEach((e) => e.sourceRefs.forEach(push));
  inputs.recentDecisions.forEach((d) => d.sourceRefs.forEach(push));
  // T-2.10: the grounding pipeline's associated M1a notes (already path-sorted
  // by the caller) so the brief's sourceNotes / card-level sourceRefs carry
  // real vault notes, not just M2 self-references.
  (inputs.associatedNoteRefs ?? []).forEach(push);

  return out;
}

/**
 * Concatenate SourceRef lists, dedupe by path, and sort by path — deterministic
 * (T-2.10 grounding + T-3.3 byte-identical render). The render layer sorts its
 * own arrays too, but the card's cacheKey (SHA-256 of stableStringify(inputs))
 * does NOT normalise array element order, so the merge must be stable here.
 */
function mergeSourceRefs(...lists: SourceRef[][]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const list of lists) {
    for (const ref of list) {
      if (!ref || seen.has(ref.path)) continue;
      seen.add(ref.path);
      out.push(ref);
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function buildStaleMarkers(
  freshness: ProjectFreshnessRecord | null,
  decay: ProjectDecayRecord | null,
  conflicts: ProjectConflictsState | null,
): StaleMarker[] {
  const out: StaleMarker[] = [];

  if (freshness?.drifts) {
    for (const d of freshness.drifts) {
      out.push({
        kind: d.kind === "stale" ? "drift" : "orphan",
        target: d.path,
        detail:
          d.kind === "stale"
            ? "hash changed since cite"
            : "file no longer exists",
      });
    }
  }

  if (decay?.decayed) {
    out.push({
      kind: "decay",
      target: decay.lastTouchedPath ?? "(no source touched)",
      detail:
        decay.daysSinceLastTouch != null
          ? `${decay.daysSinceLastTouch} days since last touch (threshold ${decay.thresholdDays})`
          : `no sources touched within ${decay.thresholdDays} days`,
    });
  }

  for (const fieldPath of listConflictedFields(conflicts)) {
    out.push({
      kind: "conflict",
      target: fieldPath,
      detail: "field is quarantined — requires human-asserted write to resolve",
    });
  }

  return out;
}

function buildWarnings(
  staleMarkers: StaleMarker[],
  conflicts: ProjectConflictsState | null,
): string[] {
  const out: string[] = [];
  const conflicted = listConflictedFields(conflicts);
  if (conflicted.length > 0) {
    out.push(
      `${conflicted.length} field(s) in conflict; agent writes blocked: ${conflicted.join(", ")}`,
    );
  }
  const driftCount = staleMarkers.filter((m) => m.kind === "drift" || m.kind === "orphan").length;
  if (driftCount > 0) {
    out.push(
      `${driftCount} source ref(s) drifted or orphaned since cite — re-grounding recommended`,
    );
  }
  const hasDecay = staleMarkers.some((m) => m.kind === "decay");
  if (hasDecay) {
    out.push("project sources have not been touched recently — consider re-grounding session");
  }
  return out;
}

// ---------------------------------------------------------------------------
// § 15.3 — Eight questions
// ---------------------------------------------------------------------------

interface QuestionContext {
  goal: AnswerWithCitations;
  status: AnswerWithCitations;
  blockers: AnswerWithCitations;
  nextActions: AnswerWithCitations;
  state: ProjectControlPlaneState | null | undefined;
  recentDecisions: DecisionSummary[];
  activeAssumptions: Assumption[];
  activeTasks: TaskSummary[];
  authority: AuthoritySummary[];
  openEscalations: Escalation[];
  telemetry: ProjectControlPlaneTelemetry | null;
  staleMarkers: StaleMarker[];
}

function synthesizeEightQuestions(ctx: QuestionContext): EightQuestions {
  return {
    achieve: ctx.goal,
    status: ctx.status,
    decisions: answerDecisions(ctx),
    assumptions: answerAssumptions(ctx),
    blocked: ctx.blockers,
    changed: answerChanged(ctx),
    safeNext: answerSafeNext(ctx),
    requiresApproval: answerRequiresApproval(ctx),
  };
}

function answerDecisions(ctx: QuestionContext): AnswerWithCitations {
  if (ctx.recentDecisions.length === 0) {
    return { answer: null, confidence: "unknown", sourceRefs: [] };
  }
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const d of ctx.recentDecisions.slice(0, 5)) {
    for (const r of d.sourceRefs) {
      if (!seen.has(r.path)) {
        seen.add(r.path);
        refs.push(r);
      }
    }
  }
  const list = ctx.recentDecisions
    .slice(0, 5)
    .map((d) => `- ${d.summary} (chose: ${d.chosenOption})`)
    .join("\n");
  return {
    answer: list,
    confidence: refs.length > 0 ? "high" : "low",
    sourceRefs: refs,
  };
}

function answerAssumptions(ctx: QuestionContext): AnswerWithCitations {
  if (ctx.activeAssumptions.length === 0) {
    return { answer: null, confidence: "unknown", sourceRefs: [] };
  }
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const a of ctx.activeAssumptions) {
    for (const r of a.sourceRefs) {
      if (!seen.has(r.path)) {
        seen.add(r.path);
        refs.push(r);
      }
    }
  }
  const list = ctx.activeAssumptions
    .map((a) => `- ${a.statement} (status: ${a.status})`)
    .join("\n");
  return {
    answer: list,
    confidence: refs.length > 0 ? "high" : "low",
    sourceRefs: refs,
  };
}

function answerChanged(ctx: QuestionContext): AnswerWithCitations {
  const fragments: string[] = [];
  const refs: SourceRef[] = [];
  if (ctx.state?.latestEvidenceChanged) {
    fragments.push(`Latest evidence: ${ctx.state.latestEvidenceChanged}`);
    for (const r of ctx.state.sourceRefs ?? []) refs.push(r);
  }
  if (ctx.telemetry?.lastActivityAt) {
    fragments.push(`Last activity: ${ctx.telemetry.lastActivityAt}`);
  }
  if (ctx.staleMarkers.length > 0) {
    fragments.push(
      `${ctx.staleMarkers.length} stale marker(s): ${ctx.staleMarkers
        .map((m) => m.kind)
        .join(", ")}`,
    );
  }
  if (fragments.length === 0) {
    return { answer: null, confidence: "unknown", sourceRefs: [] };
  }
  return {
    answer: fragments.join("\n"),
    confidence: refs.length > 0 ? "high" : "low",
    sourceRefs: refs,
  };
}

function answerSafeNext(ctx: QuestionContext): AnswerWithCitations {
  // If next action is null OR any required field is in conflict, we can't
  // safely act.
  if (!ctx.nextActions.answer) {
    return {
      answer: "No defined next action; steward should propose a smaller-than-12-words next step.",
      confidence: "low",
      sourceRefs: [],
    };
  }
  if (ctx.staleMarkers.some((m) => m.kind === "conflict")) {
    return {
      answer: "Quarantined field(s) present — defer action until resolved.",
      confidence: "high",
      sourceRefs: [],
    };
  }
  return ctx.nextActions;
}

function answerRequiresApproval(ctx: QuestionContext): AnswerWithCitations {
  const fragments: string[] = [];
  for (const e of ctx.openEscalations) {
    fragments.push(`- ${e.question}`);
  }
  const l4OrL5 = ctx.authority.filter(
    (a) => a.ceiling === "L4" || a.ceiling === "L5",
  );
  if (l4OrL5.length === 0 && ctx.openEscalations.length === 0) {
    return {
      answer: "Nothing currently pending principal approval.",
      confidence: "high",
      sourceRefs: [],
    };
  }
  if (fragments.length === 0) {
    return {
      answer: "Material side effects (L4) and strategic moves (L5) always require principal approval.",
      confidence: "high",
      sourceRefs: [],
    };
  }
  return {
    answer: fragments.join("\n"),
    confidence: "high",
    sourceRefs: ctx.openEscalations.flatMap((e) => e.sourceRefs),
  };
}

// ---------------------------------------------------------------------------
// Helpers exported for tests
// ---------------------------------------------------------------------------

export function getUnansweredQuestions(
  card: ContextCard,
): Array<keyof EightQuestions> {
  return card.unansweredQuestions;
}
