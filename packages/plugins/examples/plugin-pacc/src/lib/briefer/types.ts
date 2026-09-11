/**
 * Briefer worker types — T-3.1.
 *
 * The briefer is an **L1-only** worker (per PRD § 7.5 + § 10): it observes
 * canonical state and produces a daily brief, but it never writes to M2
 * canonical state. Authority enforcement is twofold:
 *
 *   1. **Structural** — `BrieferDeps` deliberately does NOT include
 *      `writeM2` or `writeM2Guarded`. Code that holds only `BrieferDeps`
 *      cannot call them. The TS type system enforces this.
 *   2. **Runtime** — `assertBrieferL1` rejects any `requiredAuthority` ≥ L2
 *      that briefer code might try to thread through. Used inside the
 *      briefer's own `proposeM2` wrapper.
 *
 * The brief shape mirrors PRD § 13.1's required sections. Most start empty
 * in T-3.1; downstream tickets (T-3.2, T-3.4, T-3.5) populate them.
 */

import type { AuthorityLevel } from "@paperclipai/shared";
import type {
  AnswerWithCitations,
  ContextCard,
} from "../context-card.js";

// ---------------------------------------------------------------------------
// Brief shape — PRD § 13.1
// ---------------------------------------------------------------------------

/** A high-leverage proposed action surfaced by the briefer. */
export interface ProposedAction {
  /** Project this action belongs to. */
  projectId: string;
  /** One-line summary of the proposed action. */
  summary: string;
  /** Why it matters now. */
  rationale: string;
  /** What "done" looks like for this action. */
  expectedArtifact: string | null;
  /** Authority level required to execute. Briefer can ONLY propose L1/L2 — L3+ requires approval. */
  requiredAuthority: AuthorityLevel;
  /**
   * PRD § 8.5 job classification. `null` when the source project's
   * `jobClassificationDominant` is unset — per D-41 this must never be
   * fabricated as `"meta"`; renderers show "unclassified" instead.
   */
  jobClassification: "J1_signal" | "J2_distribution" | "J3_product" | "meta" | null;
  /** Briefer's confidence, 0..1. */
  confidence: number;
  /** SourceRefs supporting this proposal (provenance per PRD § 9.7). */
  sourceRefs: Array<{ kind: string; path: string; section?: string; hash: string; capturedAt: string }>;
}

/**
 * Job-mix snapshot — populated by T-3.4, unclassified handling per D-41/T-3.13.
 *
 * `j1Pct`..`metaPct` are `null` when there is no classified signal at all for
 * the project in-window (no activities AND no `jobClassificationDominant`
 * fallback) — the renderer shows "—" rather than fabricating 0%/100% shares.
 * Shares are always computed over classified activity only; unclassified
 * activity in the window is surfaced via `unclassifiedCount` and never folds
 * into any class's percentage or into the threshold-breach guard.
 */
export interface JobMixRow {
  projectId: string;
  projectName: string;
  phase: string | null;
  j1Pct: number | null;
  j2Pct: number | null;
  j3Pct: number | null;
  metaPct: number | null;
  /** Count of in-window activities with no `jobClassification` set. Never attributed to any class share. */
  unclassifiedCount: number;
  /** True when the project's `jobClassificationDominant` field itself is unset — surfaced in Memory / Source Issues. */
  dominantUnset: boolean;
  /** Free-text flag if a threshold is breached (e.g. pre-PMF + J1 < 50%). */
  thresholdBreach: string | null;
}

/** One row in the stale/conflict roll-up. */
export interface StaleRollupRow {
  kind: "orphaned" | "stale_pending_re_grounding" | "conflict";
  count: number;
  /** Project ids with rows in this state (capped). */
  projectIds: string[];
}

/** A do-not-rethink alert: queued work touches a settled decision. */
export interface DoNotRethinkAlert {
  projectId: string;
  projectName: string;
  /** Verbatim entry from project's doNotRethink field. */
  settledDecision: string;
  /** Which queued action would touch it. */
  conflictingAction: string;
}

/** Cite-bearing answer for the brief's narrative slots. */
export type BriefAnswer = AnswerWithCitations;

export interface Brief {
  /** ISO-8601 timestamp. */
  generatedAt: string;
  /** YYYY-MM-DD calendar date the brief covers. */
  briefDate: string;
  /** SHA-256 of the underlying inputs (context cards + telemetry hashes). */
  inputsCacheKey: string;

  /** Free-text portfolio synthesis. */
  portfolioSummary: BriefAnswer;
  /**
   * T-3.15: the lead question — the single riskiest non-obvious assumption
   * across active projects (lowest-confidence testable hypothesis), with its
   * welded test. When present, this IS the brief's "Next Action" (the test of
   * the lead question — the question→action weld). Null when no project has a
   * testable hypothesis (the section renders a "no testable lead" prompt).
   */
  leadQuestion: LeadQuestion | null;
  /** The single most important action across the portfolio. */
  recommendedFocus: ProposedAction | null;
  /** What changed since last brief (from M3 episodic; placeholder until M3 lands). */
  changesSinceLast: BriefAnswer;
  /** Roll-up of stale/conflict counts. */
  staleConflictedMemory: StaleRollupRow[];
  /** Blocked projects (portfolioState === 'blocked' or blockerSummary populated). */
  blockedProjects: Array<{ projectId: string; projectName: string; blockerSummary: string | null }>;
  /** Proposed actions ranked by leverage. */
  highLeverageActions: ProposedAction[];
  /** Backlog candidates the steward generated (T-4.x territory). */
  backlogCandidates: ProposedAction[];
  /**
   * T-3.15: the testable candidate questions (per active project, ranked) that
   * the lead question was drawn from — the divergent layer. Lead excluded
   * (it has its own section). Phase 1 surfaces hypotheses with a `testPlan`;
   * assumptions join when test-authoring exists (Phase 2).
   */
  openQuestions: OpenQuestionRow[];
  /** Open escalations requiring principal decision. */
  escalations: Array<{ projectId: string; question: string; recommendedDecision: string | null }>;
  /** Surfaces conflicts between queued work and settled decisions. */
  doNotRethinkAlerts: DoNotRethinkAlert[];
  /** Imagination-features parked this week (FPCP weekly ritual). T-3.11 populates. */
  imaginationFeaturesParked: string[];
  /** Completed work and artifacts since last brief. */
  completedWork: Array<{ projectId: string; artifact: string; completedAt: string }>;
  /** Authority or safety issues raised by the audit. */
  authoritySafetyIssues: string[];
  /** Source notes — pointers into M1. T-6.7: entries may carry the source-index summary (note substance). */
  sourceNotes: Array<{ projectId: string; path: string; summary?: string | null }>;
  /**
   * T-2.10 Part B: the principal's value anchors (M1b registry) as portfolio-
   * level context. Surfaced in every brief so the principal (and, when wired,
   * the briefer model) can ground recommendations in them and cite them per
   * `docs/value-anchor-citation-format.md`. Optional for back-compat with
   * briefs persisted before this field existed.
   */
  valueAnchors?: ValueAnchorSummary[];
  /** Job-mix table (T-3.4). */
  jobMix: JobMixRow[];
  /**
   * projectId -> display name, so the renderer never shows raw UUIDs.
   * Optional for back-compat with briefs persisted before this field existed.
   */
  projectNames?: Record<string, string>;
  /** Slot for principal feedback — populated by `pacc feedback`, T-3.9. */
  humanFeedback: {
    useful: boolean | null;
    wrong: string | null;
    changedPriority: string | null;
    approvedActions: string[];
  };
  /** Soft warnings the briefer wants the principal to see. */
  warnings: string[];
  /**
   * T-6.3 delta-only brief (noise discipline, grill Q12 2026-08-16): projects
   * whose context card, aging status, and escalation state are all unchanged
   * since the last brief. They contribute NOTHING to this brief's per-project
   * sections — "still stuck on the same thing as yesterday" is never repeated.
   * Optional for back-compat with persisted briefs.
   */
  quietProjectIds?: string[];
  /**
   * T-6.3: aging threshold crossings only (fresh→aging→stale and recoveries),
   * never standing statuses. One line per crossing, fires on the crossing day.
   */
  agingCrossings?: Array<{
    projectId: string;
    projectName: string;
    from: string;
    to: string;
  }>;
  /** T-6.3: per-project context-card keys this brief was built from (delta persistence). */
  projectCardKeys?: Record<string, string>;
  /** T-6.3: per-project aging statuses this brief observed (delta persistence). */
  projectAgingStatus?: Record<string, string>;
  /** T-6.3: the lead question's briefDate when it carried over unchanged; null when new. */
  leadUnchangedSince?: string | null;
}

/**
 * T-2.10 Part B: a portfolio-level value anchor (M1b) surfaced on the brief.
 * Slim projection of the T-2.4 `ValueAnchor` — name + purpose + whether the
 * note resolved — enough for the principal/model to reference and cite without
 * leaking the loader's full type through the brief boundary.
 */
export interface ValueAnchorSummary {
  name: string;
  purpose: string;
  resolved: boolean;
}

/**
 * T-3.15: a testable question derived from a hypothesis (Phase 1) — the
 * principal's question plane. `test` is the falsification probe that
 * kill-or-confirms the belief (Hypothesis.testPlan). `fidelityMismatch` flags
 * the #5 signal: a customer/distribution-lane project whose test isn't a
 * market probe (the brief surfaces this inline, per the question-led grill).
 */
export interface OpenQuestionRow {
  projectId: string;
  projectName: string;
  kind: "assumption" | "hypothesis";
  statement: string;
  test: string;
  confidence: number;
  fidelityMismatch: boolean;
}

/**
 * T-3.15: the lead question — the riskiest testable hypothesis (lowest
 * confidence) across active projects. Its `test` is welded to the brief's
 * "Next Action" (the question→action weld). `overridden` is true when the
 * principal overrode the riskiest-first default via the footer (Q10) — visible
 * so a drift toward softer tests is diagnosable.
 */
export interface LeadQuestion {
  projectId: string;
  projectName: string;
  kind: "assumption" | "hypothesis";
  statement: string;
  test: string;
  confidence: number;
  overridden: boolean;
}

/**
 * T-6.3: the delta state persisted with every brief — what the NEXT brief
 * needs to decide which projects are quiet (unchanged) and which aged
 * across a threshold. Kept slim + serializable (plugin_state).
 */
export interface BriefDeltaRecord {
  /** The brief this delta describes (YYYY-MM-DD). */
  briefDate: string;
  /** projectId -> context-card cacheKey (unchanged key = unchanged card). */
  projectCardKeys: Record<string, string>;
  /** projectId -> aging status observed that day ("fresh"|"aging"|"stale"|"critical"). */
  projectAgingStatus: Record<string, string>;
  /** Stable identity of the lead question that day (projectId + statement hash-safe). */
  leadKey: string | null;
  /** briefDate the current lead first appeared. */
  leadSince: string | null;
}

// ---------------------------------------------------------------------------
// Authority guard
// ---------------------------------------------------------------------------

export class BrieferAuthorityViolation extends Error {
  constructor(attemptedLevel: AuthorityLevel, context: string) {
    super(
      `Briefer is L1-only — attempted ${attemptedLevel} write in ${context}. ` +
        `Use proposeM2 instead, or route through the steward for L2+ writes.`,
    );
    this.name = "BrieferAuthorityViolation";
  }
}

/**
 * Hard authority ceiling for briefer code. Any attempt to thread an
 * authority level above L1 through briefer code throws.
 *
 * Used inside the briefer's `proposeM2` wrapper and any other surface that
 * might receive a `requiredAuthority` parameter.
 */
export function assertBrieferL1(level: AuthorityLevel, context: string): void {
  if (level === "L0" || level === "L1") return;
  throw new BrieferAuthorityViolation(level, context);
}

// ---------------------------------------------------------------------------
// Briefer dependencies — what the briefer is allowed to call
// ---------------------------------------------------------------------------

export interface BrieferProjectInput {
  projectId: string;
  projectName: string;
  /** Context card produced by T-2.8 for this project. */
  card: ContextCard;
}

export interface BrieferDeps {
  /** Read-only: list active projects + their context cards. */
  listActiveProjectCards(): Promise<BrieferProjectInput[]>;

  /**
   * Read-only: any episodic notes (M3) to inform "what changed since last
   * brief". Returns null when M3 isn't yet wired (it doesn't exist as a
   * tier in T-2.x). Placeholder for forward compatibility.
   */
  readEpisodicSinceLastBrief?(): Promise<string | null>;

  /**
   * T-2.10 Part B: read-only access to the value-anchor registry (M1b) so the
   * brief can surface the principal's values as portfolio-level context.
   * Optional — when absent the brief renders with no Value Anchors section.
   */
  listValueAnchors?(): Promise<ValueAnchorSummary[]>;

  /**
   * T-6.3 delta-only brief: the previous brief's per-project delta record
   * (card keys, aging statuses, lead key). Optional — when absent, every
   * project renders (first-run behaviour; nothing is quiet).
   */
  readLastBriefDelta?(): Promise<BriefDeltaRecord | null>;

  /**
   * L1 propose-only. Wraps the platform's proposeM2 with an L1 ceiling
   * check. Briefer code that calls this with `requiredAuthority` > L1
   * triggers `BrieferAuthorityViolation`.
   *
   * (Crucially: writeM2 is NOT in this interface. Briefer code literally
   * cannot call it.)
   */
  proposeM2(args: {
    kind: "projectState" | "decision" | "authorityProfile";
    projectId?: string;
    patch?: Record<string, unknown>;
    data?: Record<string, unknown>;
    sourceRefs: Array<{ kind: string; path: string; hash: string; capturedAt: string; section?: string }>;
    confidence: number;
    actor: string;
    jobClassification: "J1_signal" | "J2_distribution" | "J3_product" | "meta";
    requiredAuthority?: AuthorityLevel;
  }): Promise<void>;

  /** Brief storage — the briefer's own write surface. L0/L1 by design. */
  saveBrief(brief: Brief): Promise<{ id: string }>;

  /**
   * LLM call for narrative generation. The briefer uses this for the
   * portfolio synthesis section. The caller routes through the steward's
   * model (default Claude Opus per PRD § 7.5).
   */
  callModel(args: {
    modelId: string;
    prompt: string;
    systemPrompt?: string | null;
  }): Promise<{ text: string | null; sessionId: string | null }>;
}
