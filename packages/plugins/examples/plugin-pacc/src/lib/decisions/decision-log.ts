/**
 * Decision log — pure core (T-4.4, PRD § 8.5 / § 12).
 *
 * A committed choice in a project's decision graph. Decisions are append-only:
 * a new decision may *supersede* a prior one (sets `supersededBy` on the prior,
 * never deletes), forming a chain A ← B ← C. `outcome` is never auto-filled —
 * it is L5, judged only by the principal (backfill flow: T-4.7).
 *
 * Storage note (deviation from the literal ticket): the pacc plugin has no
 * access to the core `decisions` table (T-1.4) through the plugin SDK, so the
 * plugin persists decisions via `ctx.entities` (plugin-owned, queryable). The
 * core table is retained for a future core-server decision service. The shape
 * here matches PRD § 8.5 so a later migration into the table is mechanical.
 */

import type { SourceRef } from "@paperclipai/shared";

export type DecisionStatus = "active" | "superseded";

export interface DecisionInput {
  projectId: string;
  summary: string;
  chosenOption: string;
  optionsConsidered: Array<{ label: string; rationale: string; tradeoffs: string }>;
  rationale: string;
  sourceRefs: SourceRef[];
  /** `principal` or `agent:<id>`. */
  decidedBy: string;
  jobClassification: "J1_signal" | "J2_distribution" | "J3_product" | "meta";
  /** Optional id of the decision this one supersedes. */
  supersedes?: string | null;
  /** Optional review date (ISO). */
  reviewDate?: string | null;
  /** Optional reversibility horizon (ISO); null = irreversible. */
  reversibleUntil?: string | null;
}

export interface DecisionRecord {
  id: string;
  projectId: string;
  summary: string;
  chosenOption: string;
  optionsConsidered: Array<{ label: string; rationale: string; tradeoffs: string }>;
  rationale: string;
  sourceRefs: SourceRef[];
  decidedBy: string;
  jobClassification: DecisionInput["jobClassification"];
  /** Prior decision this one replaced (null when none). */
  supersedes: string | null;
  /** Newer decision that replaced this one (null while this is the head). */
  supersededBy: string | null;
  /** Always null at write time — only the principal fills it (T-4.7). */
  outcome: { reviewedAt: string; outcome: "good" | "mixed" | "bad" | "too-early" } | null;
  reviewDate: string | null;
  reversibleUntil: string | null;
  status: DecisionStatus;
  /** Row-level audit actor (same format as decidedBy). */
  actor: string;
  createdAt: string;
  updatedAt: string;
}

const ACTOR_PATTERN = /^(principal|agent:[A-Za-z0-9._:-]+)$/;

export type DecisionError =
  | "INVALID_ACTOR"
  | "NO_SOURCE_REFS"
  | "MISSING_FIELD"
  | "INVALID_JOB_CLASSIFICATION";

export class DecisionValidationError extends Error {
  constructor(
    public readonly code: DecisionError,
    message: string,
  ) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

const VALID_JOB = new Set(["J1_signal", "J2_distribution", "J3_product", "meta"]);

/**
 * Validate + build a new DecisionRecord. Provenance: an agent-actor decision
 * requires non-empty sourceRefs (principal may decide without — the principal
 * IS the source).
 */
export function makeDecisionRecord(
  input: DecisionInput,
  opts: { id: string; now: Date; actor: string },
): DecisionRecord {
  if (!ACTOR_PATTERN.test(input.decidedBy)) {
    throw new DecisionValidationError("INVALID_ACTOR", `decidedBy must match ${ACTOR_PATTERN}, got "${input.decidedBy}"`);
  }
  if (!ACTOR_PATTERN.test(opts.actor)) {
    throw new DecisionValidationError("INVALID_ACTOR", `actor must match ${ACTOR_PATTERN}, got "${opts.actor}"`);
  }
  if (input.decidedBy !== "principal" && input.sourceRefs.length === 0) {
    throw new DecisionValidationError(
      "NO_SOURCE_REFS",
      "agent-decided entries require sourceRefs[] (provenance, PRD § 9.7)",
    );
  }
  for (const [k, v] of Object.entries({ projectId: input.projectId, summary: input.summary, chosenOption: input.chosenOption, rationale: input.rationale })) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new DecisionValidationError("MISSING_FIELD", `${k} is required`);
    }
  }
  if (!VALID_JOB.has(input.jobClassification)) {
    throw new DecisionValidationError("INVALID_JOB_CLASSIFICATION", `jobClassification must be one of ${[...VALID_JOB].join("/")}`);
  }

  const iso = opts.now.toISOString();
  return {
    id: opts.id,
    projectId: input.projectId,
    summary: input.summary,
    chosenOption: input.chosenOption,
    optionsConsidered: input.optionsConsidered ?? [],
    rationale: input.rationale,
    sourceRefs: input.sourceRefs ?? [],
    decidedBy: input.decidedBy,
    jobClassification: input.jobClassification,
    supersedes: input.supersedes ?? null,
    supersededBy: null,
    outcome: null,
    reviewDate: input.reviewDate ?? null,
    reversibleUntil: input.reversibleUntil ?? null,
    status: "active",
    actor: opts.actor,
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Produce the updated prior record when a new decision supersedes it. The prior
 * must be the head of its chain (not already superseded) — superseding a
 * mid-chain decision is rejected so the graph stays a simple chain.
 */
export function applySupersede(
  prior: DecisionRecord,
  newId: string,
  now: Date,
): DecisionRecord {
  if (prior.supersededBy !== null) {
    throw new DecisionValidationError(
      "MISSING_FIELD",
      `decision ${prior.id} is already superseded by ${prior.supersededBy}; supersede the current head instead`,
    );
  }
  return { ...prior, supersededBy: newId, status: "superseded", updatedAt: now.toISOString() };
}

/**
 * Walk the supersession chain that `startId` belongs to, returning records
 * oldest → newest. Tolerates being given any id in the chain.
 */
export function walkSupersedeChain(records: readonly DecisionRecord[], startId: string): DecisionRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const start = byId.get(startId);
  if (!start) return [];

  // Rewind to the oldest (follow `supersedes`).
  let oldest = start;
  const guard = new Set<string>();
  while (oldest.supersedes && byId.has(oldest.supersedes) && !guard.has(oldest.supersedes)) {
    guard.add(oldest.id);
    oldest = byId.get(oldest.supersedes)!;
  }

  // Walk forward (follow `supersededBy`).
  const chain: DecisionRecord[] = [oldest];
  const seen = new Set<string>([oldest.id]);
  let cur = oldest;
  while (cur.supersededBy && byId.has(cur.supersededBy) && !seen.has(cur.supersededBy)) {
    cur = byId.get(cur.supersededBy)!;
    chain.push(cur);
    seen.add(cur.id);
  }
  return chain;
}
