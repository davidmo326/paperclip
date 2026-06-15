/**
 * Decision capture orchestration — T-4.4 (I/O glue over decision-log.ts).
 *
 * Pure-ish: all persistence goes through injected deps so it's unit-testable
 * with an in-memory store. The worker wires these to `ctx.entities`.
 */

import {
  makeDecisionRecord,
  applySupersede,
  applyOutcome,
  walkSupersedeChain,
  DecisionValidationError,
  type DecisionInput,
  type DecisionRecord,
  type OutcomeLabel,
} from "./decision-log.js";

export interface CaptureDecisionDeps {
  /** Load a decision by id (null if not found). */
  getDecision(id: string): Promise<DecisionRecord | null>;
  /** All decisions for a project (for history-chain walking). */
  listProjectDecisions(projectId: string): Promise<DecisionRecord[]>;
  /** Persist a new or updated decision record (upsert by id). */
  putDecision(record: DecisionRecord): Promise<void>;
  /** Generate a fresh decision id (uuid). */
  newId(): string;
}

export interface RecordDecisionResult {
  decision: DecisionRecord;
  /** The prior decision that was marked superseded, if any. */
  supersededPrior: DecisionRecord | null;
}

/**
 * Record a new decision. With `input.supersedes` set, also marks the prior
 * decision superseded (append-only — the prior row is updated, never deleted).
 */
export async function recordDecision(
  deps: CaptureDecisionDeps,
  input: DecisionInput,
  opts: { now: Date; actor: string },
): Promise<RecordDecisionResult> {
  let supersededPrior: DecisionRecord | null = null;

  if (input.supersedes) {
    const prior = await deps.getDecision(input.supersedes);
    if (!prior) {
      throw new DecisionValidationError(
        "MISSING_FIELD",
        `cannot supersede ${input.supersedes}: no such decision`,
      );
    }
    supersededPrior = prior; // applied below once we have the new id
  }

  const id = deps.newId();
  const decision = makeDecisionRecord(input, { id, now: opts.now, actor: opts.actor });
  await deps.putDecision(decision);

  if (supersededPrior) {
    const updated = applySupersede(supersededPrior, id, opts.now);
    await deps.putDecision(updated);
    supersededPrior = updated;
  }

  return { decision, supersededPrior };
}

/**
 * Record the principal's retrospective outcome on a decision (T-4.7). L5 —
 * never auto-filled by an agent. Refuses to overwrite an existing outcome
 * unless `force`.
 */
export async function reviewDecision(
  deps: CaptureDecisionDeps,
  id: string,
  outcome: OutcomeLabel,
  opts: { now: Date; force?: boolean },
): Promise<DecisionRecord> {
  const decision = await deps.getDecision(id);
  if (!decision) {
    throw new DecisionValidationError("MISSING_FIELD", `no such decision: ${id}`);
  }
  const updated = applyOutcome(decision, outcome, opts.now, { force: opts.force });
  await deps.putDecision(updated);
  return updated;
}

/** Return the full supersession chain (oldest → newest) for a decision id. */
export async function getDecisionHistory(
  deps: CaptureDecisionDeps,
  id: string,
): Promise<DecisionRecord[]> {
  const decision = await deps.getDecision(id);
  if (!decision) return [];
  const all = await deps.listProjectDecisions(decision.projectId);
  return walkSupersedeChain(all, id);
}
