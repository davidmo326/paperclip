import type { SourceRef } from "./source-ref.js";

export type ProjectPortfolioState =
  | "primary"
  | "active"
  | "blocked"
  | "paused"
  | "parked"
  | "closed";

/**
 * Project phase. PRD § 8.1 specifies the 6 forward-looking values
 * (search, validate, build, distribution, scale, maintenance). The two
 * deprecated values (exploration, validation) are kept for backward
 * compatibility with rows written before T-1.3; a future ticket will
 * rename them in-place. New writes should use the PRD-spec values.
 */
export type ProjectPhase =
  | "search"
  | "validate"
  | "build"
  | "distribution"
  | "scale"
  | "maintenance"
  // deprecated aliases kept for backward compat — do not write these in new code:
  | "exploration"
  | "validation";

/**
 * Project constraint lane. PRD § 8.1 widens from the original 3 values
 * (product/customer/distribution) to 6 (+ ops/finance/unknown).
 */
export type ProjectConstraintLane =
  | "product"
  | "customer"
  | "distribution"
  | "ops"
  | "finance"
  | "unknown";

export type ProjectStaleStatus = "fresh" | "aging" | "stale" | "critical";

export interface ProjectControlPlaneLastOutput {
  kind: "issue" | "work_product" | "document" | "external_link" | "note";
  id: string | null;
  title: string;
  url: string | null;
}

/**
 * Job classification per the three-jobs-of-a-solo-entrepreneur value anchor.
 * Used at task level (8.4) and rolled up to project level (8.1 jobClassificationDominant).
 *
 *  - `J1_signal`        — pursuing market signal / customer truth
 *  - `J2_distribution`  — building distribution / audience
 *  - `J3_product`       — building the product itself
 *  - `meta`             — work on the operating system (infra, tooling, refactors)
 */
export type JobClassification = "J1_signal" | "J2_distribution" | "J3_product" | "meta";

/** Authority level per PRD § 10. */
export type AuthorityLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

/**
 * Hypothesis — a testable belief about a project. PRD § 8.6.
 * Lives as a JSON array under `ProjectControlPlaneState.hypotheses` (T-1.4 v2 slim plan).
 */
export interface Hypothesis {
  id: string;
  statement: string;
  evidenceFor: SourceRef[];
  evidenceAgainst: SourceRef[];
  confidence: number;
  testPlan: string | null;
  status: "active" | "validated" | "invalidated" | "inconclusive" | "retired";
  reviewDate: string | null;
}

/**
 * Assumption — a belief currently being relied on. PRD § 8.7.
 * Lives as a JSON array under `ProjectControlPlaneState.assumptions`.
 */
export interface Assumption {
  id: string;
  statement: string;
  sourceRefs: SourceRef[];
  confidence: number;
  riskIfWrong: string | null;
  lastReviewedAt: string | null;
  status: "accepted" | "challenged" | "stale" | "replaced";
}

/**
 * Escalation — a human decision request. PRD § 8.8.
 * Lives as a JSON array under `ProjectControlPlaneState.escalations`.
 */
export interface Escalation {
  id: string;
  trigger: string;
  question: string;
  recommendedDecision: string | null;
  options: Array<{ label: string; tradeoffs: string | null }>;
  risk: string | null;
  requiredBy: string | null;
  sourceRefs: SourceRef[];
  status: "open" | "approved" | "rejected" | "deferred" | "resolved";
}

/**
 * OpenLoop — an unresolved thread surfaced by the principal or steward.
 * Distinct from hypotheses (testable beliefs) and assumptions (relied-on beliefs):
 * an open loop is a known gap that needs deciding-or-closing later.
 */
export interface OpenLoop {
  id: string;
  statement: string;
  createdAt: string;
}

export interface ProjectControlPlaneState {
  // --- v1 fields (pre-T-1.3) ---
  portfolioState: ProjectPortfolioState;
  currentPhase: ProjectPhase;
  constraintLane: ProjectConstraintLane | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  latestEvidenceChanged: string | null;
  resumeBrief: string | null;
  doNotRethink: string | null;
  killCriteria: string | null;
  lastMeaningfulOutput: ProjectControlPlaneLastOutput | null;

  // --- v2 fields (T-1.3, all optional for back-compat with v1 rows) ---

  /** PRD § 8.1: north-star intent for the project. */
  intent?: string | null;
  /** PRD § 8.1: free-text status snapshot (distinct from blockerSummary). */
  currentStatus?: string | null;
  /** PRD § 8.1 / § 10: per-project authority profile id. */
  authorityProfileId?: string | null;
  /** PRD § 8.1: SourceRefs into M1a/M1b that ground this project's context. */
  memoryIndexRefs?: SourceRef[];
  /** PRD § 8.1: per-project default sources (distinct from per-field sourceRefs). */
  sourceRefs?: SourceRef[];
  /** PRD § 8.1: unresolved threads (distinct from assumptions/hypotheses). */
  openLoops?: OpenLoop[];
  /** PRD § 8.7: relied-on beliefs; T-1.4 v2 keeps these in JSON, not a table. */
  assumptions?: Assumption[];
  /** PRD § 8.6: testable beliefs; T-1.4 v2 keeps these in JSON, not a table. */
  hypotheses?: Hypothesis[];
  /** PRD § 8.8: pending decision requests for the principal. */
  escalations?: Escalation[];
  /** PRD § 8.1: cached list of decisions.id linked to this project (denormalized for brief speed). */
  decisionRefs?: string[];
  /** Float 0..1; steward's confidence in current state. */
  confidence?: number | null;
  /** ISO-8601 of last principal/steward review. */
  lastReviewedAt?: string | null;
  /** PRD § 8.1: which job (J1/J2/J3/meta) this project is dominantly serving right now. */
  jobClassificationDominant?: JobClassification | null;
  /** Voice-sensitive content (e.g. Circlo blog) — agent voice gates apply. */
  voiceSensitive?: boolean;
  /**
   * T-6.2 evidence clock: ISO-8601 of the last *evidence event* (decision
   * recorded, hypothesis status/evidence change, completed J1 action).
   * Staleness keys off evidence recency, never state-write recency — author
   * identity never resets the clock, only event type does (grill 2026-08-16).
   */
  lastEvidenceAt?: string | null;
}

export interface ProjectControlPlaneTelemetry {
  lastTouchedAt: string | null;
  lastActivityAt: string | null;
  issueCounts: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  laneIssueCounts: {
    product: { open: number; inProgress: number; blocked: number; done: number; total: number };
    customer: { open: number; inProgress: number; blocked: number; done: number; total: number };
    distribution: { open: number; inProgress: number; blocked: number; done: number; total: number };
  };
  latestArtifact: {
    id: string | null;
    title: string | null;
    url: string | null;
    updatedAt: string | null;
  } | null;
  repoSnapshot: {
    workspaceId: string | null;
    sourceType: string | null;
    status: "ok" | "warning" | "unavailable";
    branch: string | null;
    headShaShort: string | null;
    dirty: boolean | null;
    dirtySummary: string | null;
    lastCommitAt: string | null;
    aheadBy: number | null;
    behindBy: number | null;
  } | null;
  runHealth: {
    status: "ok" | "warning" | "error" | "idle";
    lastRunAt: string | null;
    lastRunOutcome: "success" | "failed" | "cancelled" | "unknown";
  };
  budgetHealth: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  staleStatus: ProjectStaleStatus;
  staleReason: string | null;
  attentionScore: number;
  refreshedAt: string;
}

export interface ProjectControlPlaneResponse {
  projectId: string;
  companyId: string;
  controlPlaneState: ProjectControlPlaneState | null;
  telemetry: ProjectControlPlaneTelemetry | null;
  warnings: string[];
}

export interface ProjectPortfolioSummary {
  projectId: string;
  name: string;
  color: string | null;
  controlPlaneState: ProjectControlPlaneState | null;
  controlPlaneUpdatedAt: string | null;
  staleStatus: ProjectStaleStatus;
  attentionScore: number;
  warnings: string[];
}

export interface PortfolioResponse {
  companyId: string;
  summary: {
    primaryCount: number;
    activeCount: number;
    staleCount: number;
    blockedCount: number;
  };
  warnings: string[];
  projects: ProjectPortfolioSummary[];
}
