/**
 * Evidence clock — T-6.2.
 *
 * Grill resolutions Q6/Q6b (2026-08-16): per-project aging runs a **dual
 * clock**. The principal-engagement clock (days since the principal touched
 * the project) resets only on principal touch. The **evidence clock** — days
 * since the project's evidence base last changed — is the decay key:
 * staleness thresholds key off it alone, and state-writes (whosever) never
 * reset it. Invariant: **author identity never resets a clock; only event
 * type does.**
 *
 * Evidence events (the only resetters of the evidence clock):
 *   - a new/changed M1a source associated to the project
 *     (observed read-side via the source-decay record's file mtimes)
 *   - a decision recorded (observed read-side via the decisions ledger)
 *   - a hypothesis status/evidence change (writeM2 stamps `lastEvidenceAt`
 *     when a projectState patch touches `hypotheses`)
 *   - a completed J1 action (future: T-4.x feedback attribution)
 *
 * NOT evidence events: state-field edits, brief renders, agent drafts.
 *
 * Pure functions only — the wiring (writeM2 stamping, telemetry re-key)
 * lives in write-m2.ts / worker.ts.
 */

import type { ProjectPortfolioState, ProjectStaleStatus } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Thresholds (moved from worker.ts — single source of truth)
// ---------------------------------------------------------------------------

export const STALE_THRESHOLDS_MS: Record<
  ProjectPortfolioState,
  { aging: number; stale: number } | null
> = {
  primary: { aging: 2 * 24 * 60 * 60 * 1000, stale: 4 * 24 * 60 * 60 * 1000 },
  active:  { aging: 5 * 24 * 60 * 60 * 1000, stale: 10 * 24 * 60 * 60 * 1000 },
  blocked: { aging: 3 * 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
  paused:  null,
  parked:  null,
  closed:  null,
};

// ---------------------------------------------------------------------------
// Write side: which patches are evidence events
// ---------------------------------------------------------------------------

/**
 * True when a projectState patch changes the project's *evidence base* —
 * per the grill, only hypothesis status/evidence changes qualify at patch
 * level. (Decisions and M1a sources are observed read-side; state-field
 * edits — nextSmallestAction, blockers, intent… — are NOT evidence.)
 */
export function patchTouchesEvidence(patch: Record<string, unknown>): boolean {
  return "hypotheses" in patch;
}

/**
 * Stamp `lastEvidenceAt` onto a patch when (and only when) it is an evidence
 * event. Returns the original patch object reference when not — callers may
 * use the result unconditionally. Existing later stamps are never moved back
 * (max semantics belong to the read-side reducer; here we stamp "now").
 */
export function withEvidenceStamp(
  patch: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  if (!patchTouchesEvidence(patch)) return patch;
  const existing = typeof patch.lastEvidenceAt === "string" ? patch.lastEvidenceAt : null;
  return { ...patch, lastEvidenceAt: existing && existing > nowIso ? existing : nowIso };
}

// ---------------------------------------------------------------------------
// Read side: the evidence-age reducer
// ---------------------------------------------------------------------------

export interface EvidenceClockInputs {
  /** Source-decay record: days since the project's M1a sources last changed (file mtimes). Null = job hasn't run. */
  sourceDecayDaysSinceTouch: number | null;
  /** ISO-8601 of the last patch-level evidence event (hypotheses change). */
  lastEvidenceAt: string | null;
  /** ISO-8601 of the project's most recent decision (`createdAt` in the decisions ledger). Null = no decisions. */
  latestDecisionAt: string | null;
}

/** Days elapsed for one ISO timestamp; null when missing/unparseable. */
function isoAgeDays(iso: string | null, now: Date): number | null {
  if (iso === null || iso.length === 0) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return (now.getTime() - ts) / 86_400_000;
}

/**
 * The evidence clock's age in days: the MINIMUM (most recent) across every
 * available evidence signal. Returns null when no signal exists (a project
 * with no evidence at all — callers decide the legacy fallback).
 */
export function evidenceAgeDays(inputs: EvidenceClockInputs, now: Date = new Date()): number | null {
  const ages: number[] = [];
  const decay = inputs.sourceDecayDaysSinceTouch;
  if (decay !== null && Number.isFinite(decay)) ages.push(decay);
  const stamped = isoAgeDays(inputs.lastEvidenceAt, now);
  if (stamped !== null) ages.push(stamped);
  const decided = isoAgeDays(inputs.latestDecisionAt, now);
  if (decided !== null) ages.push(decided);
  if (ages.length === 0) return null;
  return Math.min(...ages);
}

/**
 * Classify evidence age into the stale-status vocabulary, using the same
 * per-portfolioState thresholds as the legacy detector. Null age (no signal)
 * or threshold-less states (paused/parked/closed) → "fresh" (no opinion).
 */
export function agingFromEvidenceDays(
  portfolioState: ProjectPortfolioState | null | undefined,
  ageDays: number | null,
): ProjectStaleStatus {
  if (ageDays === null || !Number.isFinite(ageDays)) return "fresh";
  if (!portfolioState) return "fresh";
  const thresholds = STALE_THRESHOLDS_MS[portfolioState] ?? null;
  if (thresholds === null) return "fresh";
  if (ageDays * 86_400_000 >= thresholds.stale) return "stale";
  if (ageDays * 86_400_000 >= thresholds.aging) return "aging";
  return "fresh";
}
