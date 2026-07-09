/**
 * Job-mix computation — T-3.4.
 *
 * Counts each project's J1/J2/J3/meta share over a rolling 7-day window
 * and flags pre-PMF projects whose J1 share has dropped and isn't
 * recovering. Implements PRD § 0.5 ("the steward enforces Job 1 against
 * every portfolio project — including against itself") + § 13.1 (job-mix
 * brief section).
 *
 * Pure logic — caller supplies activities + projects, function returns
 * `JobMixRow[]` that drops straight into the Brief's `jobMix` field for
 * T-3.3 to render.
 *
 * Three-clause guard for "pre-PMF J1-deficient" (PLAN T-3.4):
 *   (a) phase ∈ {search, validate}              — pre-PMF projects only
 *   (b) J1 share < 50% over rolling 7d           — sustained deficit
 *   (c) trend isn't recovering: J1 this 7d ≤
 *       J1 prior 7d                              — not improving
 *
 * All three must hold. Single low-day noise can't trip a flag because
 * we average over 7d AND require the prior 7d to be at-or-above the
 * current window.
 */

import type { JobMixRow } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobClass = "J1_signal" | "J2_distribution" | "J3_product" | "meta";

/** One activity record — a task assignment or decision tagged with a job class. */
export interface JobActivity {
  projectId: string;
  /**
   * `null` when the source task/decision has no `jobClassification` set
   * (D-41: never fabricated as `"meta"`). Unclassified activities are
   * counted (`JobMixRow.unclassifiedCount`) but excluded from every class's
   * percentage — shares are computed over classified activity only.
   */
  jobClassification: JobClass | null;
  /** ISO-8601 timestamp. */
  at: string;
}

/**
 * The phase strings T-3.4 cares about for the pre-PMF guard. Includes the
 * v1 deprecated aliases per T-1.3's back-compat decision.
 */
export type JobMixPhase =
  | "search"
  | "validate"
  | "build"
  | "distribution"
  | "scale"
  | "maintenance"
  // deprecated v1 aliases (still in the data)
  | "exploration"
  | "validation";

export interface JobMixProjectInput {
  projectId: string;
  projectName: string;
  phase: JobMixPhase | null;
  /**
   * Fallback used when the project has zero activities in the window.
   * Without this fallback most seeded projects would render as all-zero
   * mixes (noise). PRD § 8.1 puts this field on the Project.
   */
  jobClassificationDominant: JobClass | null;
}

export interface ComputeJobMixOptions {
  /** Reference "now" — defaults to current time. Overrideable for tests. */
  now?: Date;
  /** Rolling window length in days. Default 7 per PRD § 13.1. */
  windowDays?: number;
}

// ---------------------------------------------------------------------------
// computeJobMix
// ---------------------------------------------------------------------------

/**
 * For each project, count activities by job class over the rolling window
 * and the immediately-preceding window of the same length. Compute
 * percentages, apply the three-clause pre-PMF guard, return JobMixRows.
 */
export function computeJobMix(
  projects: readonly JobMixProjectInput[],
  activities: readonly JobActivity[],
  options: ComputeJobMixOptions = {},
): JobMixRow[] {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 7;
  const windowMs = windowDays * 86_400_000;

  const currentStart = now.getTime() - windowMs;
  const priorStart = currentStart - windowMs;

  const rows: JobMixRow[] = [];

  for (const project of projects) {
    const current = countWindow(
      activities,
      project.projectId,
      currentStart,
      now.getTime(),
    );
    const prior = countWindow(
      activities,
      project.projectId,
      priorStart,
      currentStart,
    );

    // Shares are computed over classified activity only — `counts` never
    // includes unclassified entries (see `countWindow`).
    const currentTotal = totalCount(current.counts);
    let row: JobMixRow;

    if (currentTotal === 0) {
      // Fallback: project has no *classified* activity in window. Render the
      // dominant job class as 100% to keep the brief signal-rich; when the
      // dominant field is also unset, there is no classified signal at all —
      // render as unclassified (null shares) rather than fabricating a class.
      row = buildFallbackRow(project);
    } else {
      row = buildRowFromCounts(project, current.counts);
    }
    row.unclassifiedCount = current.unclassifiedCount;

    // Three-clause guard. A row with no classified signal (`j1Pct === null`)
    // cannot trigger — or mask — a breach on its own; there's nothing to
    // measure against clause (b).
    row.thresholdBreach = computeThresholdBreach({
      phase: project.phase,
      currentJ1Pct: row.j1Pct,
      priorJ1Pct: percentageOf("J1_signal", prior.counts),
      windowDays,
    });

    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Threshold-breach guard
// ---------------------------------------------------------------------------

const PRE_PMF_PHASES = new Set<JobMixPhase>(["search", "validate", "exploration", "validation"]);

interface BreachInput {
  phase: JobMixPhase | null;
  /**
   * `null` when the project has no classified activity at all in-window
   * (unclassified/unset, per D-41). There is nothing to measure clause (b)
   * against, so a `null` share can never trigger — or mask — a breach.
   */
  currentJ1Pct: number | null;
  /**
   * J1 share in the immediately-preceding 7d window. `NaN` when the prior
   * window had zero *classified* activities (treat as "no baseline" → not
   * enough data to flag; clause (c) fails).
   */
  priorJ1Pct: number;
  windowDays: number;
}

export function computeThresholdBreach(input: BreachInput): string | null {
  // No classified signal at all → nothing to flag.
  if (input.currentJ1Pct === null) return null;

  // Clause (a): pre-PMF
  if (input.phase === null || !PRE_PMF_PHASES.has(input.phase)) return null;

  // Clause (b): J1 share < 50%
  if (input.currentJ1Pct >= 50) return null;

  // Clause (c): trend not recovering (current ≤ prior).
  // If priorJ1Pct is NaN (no prior data), we can't establish a trend →
  // don't flag (avoid false positives on freshly-seeded projects).
  if (!Number.isFinite(input.priorJ1Pct)) return null;
  if (input.currentJ1Pct > input.priorJ1Pct) return null;

  return (
    `pre-PMF J1 share ${Math.round(input.currentJ1Pct)}% over ${input.windowDays}d` +
    ` (prior ${input.windowDays}d: ${Math.round(input.priorJ1Pct)}%); ` +
    `not recovering`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type JobCounts = Record<JobClass, number>;

function emptyCounts(): JobCounts {
  return { J1_signal: 0, J2_distribution: 0, J3_product: 0, meta: 0 };
}

function totalCount(c: JobCounts): number {
  return c.J1_signal + c.J2_distribution + c.J3_product + c.meta;
}

interface WindowCounts {
  counts: JobCounts;
  /** Activities in-window with `jobClassification === null` — never folded into `counts`. */
  unclassifiedCount: number;
}

function countWindow(
  activities: readonly JobActivity[],
  projectId: string,
  startMs: number,
  endMs: number,
): WindowCounts {
  const counts = emptyCounts();
  let unclassifiedCount = 0;
  for (const a of activities) {
    if (a.projectId !== projectId) continue;
    const t = Date.parse(a.at);
    if (!Number.isFinite(t)) continue;
    if (t < startMs || t >= endMs) continue;
    if (a.jobClassification === null) {
      unclassifiedCount += 1;
      continue;
    }
    counts[a.jobClassification] += 1;
  }
  return { counts, unclassifiedCount };
}

function percentageOf(cls: JobClass, counts: JobCounts): number {
  const total = totalCount(counts);
  if (total === 0) return Number.NaN;
  return (counts[cls] / total) * 100;
}

function buildRowFromCounts(project: JobMixProjectInput, c: JobCounts): JobMixRow {
  const total = totalCount(c);
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    phase: project.phase,
    j1Pct: (c.J1_signal / total) * 100,
    j2Pct: (c.J2_distribution / total) * 100,
    j3Pct: (c.J3_product / total) * 100,
    metaPct: (c.meta / total) * 100,
    unclassifiedCount: 0, // set by caller after compute
    dominantUnset: project.jobClassificationDominant === null,
    thresholdBreach: null, // set by caller after compute
  };
}

function buildFallbackRow(project: JobMixProjectInput): JobMixRow {
  const dominantUnset = project.jobClassificationDominant === null;
  if (dominantUnset) {
    // No classified activity AND no dominant fallback → no signal at all.
    // Per D-41: never fabricate a class (e.g. "meta"); render as
    // unclassified (null shares) so the renderer shows "—" instead of a
    // misleading 0%/100% split.
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      phase: project.phase,
      j1Pct: null,
      j2Pct: null,
      j3Pct: null,
      metaPct: null,
      unclassifiedCount: 0, // set by caller after compute
      dominantUnset: true,
      thresholdBreach: null,
    };
  }

  // No activity in window, but the project declares a dominant class →
  // render it at 100%, others 0.
  const j1 = project.jobClassificationDominant === "J1_signal" ? 100 : 0;
  const j2 = project.jobClassificationDominant === "J2_distribution" ? 100 : 0;
  const j3 = project.jobClassificationDominant === "J3_product" ? 100 : 0;
  const meta = project.jobClassificationDominant === "meta" ? 100 : 0;
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    phase: project.phase,
    j1Pct: j1,
    j2Pct: j2,
    j3Pct: j3,
    metaPct: meta,
    unclassifiedCount: 0, // set by caller after compute
    dominantUnset: false,
    thresholdBreach: null,
  };
}
