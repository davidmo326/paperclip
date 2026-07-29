/**
 * Kill-criterion meter — T-3.10.
 *
 * PRD § 0.5 mandate: "If by end of Phase 3, after 5 consecutive daily briefs,
 * the system has not produced at least 3 accepted next actions and at least 2
 * completed J1 actions attributable to the brief/steward, freeze new
 * control-plane feature work."
 *
 * This module is the instrumentation that makes M-Brief *measurable* rather
 * than eyeballed:
 *   - every brief writes a `KillCriterionMetric` (accepted/j1 start at 0)
 *   - T-3.9 feedback bumps `acceptedCount`
 *   - task-completion events tied to a brief bump `j1CompletedCount`
 *   - `evaluateGate` consults the last 5 metrics; the brief renders a
 *     "Control-plane self-check" section with 7-day rolling totals + a red
 *     flag when both thresholds are missed.
 *
 * Pure logic only. Persistence (`kill_criterion` plugin_state) is wired by
 * the worker/CLI layer.
 */

import type { ParsedBriefFeedback, ReachOrBypass } from "./feedback.js";

// ---------------------------------------------------------------------------
// Thresholds (PRD § 0.5)
// ---------------------------------------------------------------------------

export const KILL_WINDOW = 5;
export const KILL_ACCEPTED_THRESHOLD = 3;
export const KILL_J1_THRESHOLD = 2;
export const SELF_CHECK_ROLLING_DAYS = 7;

// ---------------------------------------------------------------------------
// Metric shape (one row per brief, keyed by briefDate)
// ---------------------------------------------------------------------------

export interface KillCriterionMetric {
  /** Natural brief id — one brief per calendar day. */
  briefDate: string;
  /** How many actions/tasks the brief suggested. */
  suggestionsCount: number;
  /** How many of them the principal accepted (via T-3.9 feedback). */
  acceptedCount: number;
  /** How many J1 actions attributable to this brief were completed. */
  j1CompletedCount: number;
  /**
   * T-3.14: did the principal act on the day's next action from pacc, or
   * bypass pacc for the CLI/vault? The H2 anti-pattern signal — null until
   * the principal records it in the brief footer.
   */
  reachOrBypass: ReachOrBypass | null;
}

export function initMetric(briefDate: string, suggestionsCount: number): KillCriterionMetric {
  return { briefDate, suggestionsCount, acceptedCount: 0, j1CompletedCount: 0, reachOrBypass: null };
}

/** Set acceptedCount + reachOrBypass from parsed feedback (idempotent — replaces, not adds). */
export function applyFeedbackToMetric(
  metric: KillCriterionMetric,
  parsed: ParsedBriefFeedback,
): KillCriterionMetric {
  return { ...metric, acceptedCount: parsed.approvedActions.length, reachOrBypass: parsed.reachOrBypass };
}

/** Bump j1CompletedCount when a brief-attributed J1 task completes. */
export function incrementJ1Completed(
  metric: KillCriterionMetric,
  by = 1,
): KillCriterionMetric {
  return { ...metric, j1CompletedCount: metric.j1CompletedCount + by };
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export interface GateResult {
  /** The (up to) last KILL_WINDOW metrics, oldest→newest, that were evaluated. */
  window: KillCriterionMetric[];
  acceptedSum: number;
  j1Sum: number;
  /** True when both thresholds are met across the window. */
  pass: boolean;
  /**
   * True when the window is full (≥ KILL_WINDOW briefs) AND the gate fails.
   * Only a full window can raise the red flag — fewer than 5 briefs is
   * "not yet measurable", not "failed".
   */
  redFlag: boolean;
  /** False until KILL_WINDOW briefs exist. */
  windowFull: boolean;
  /**
   * T-3.14: H2 reach/bypass over the window — how many days the principal
   * acted from pacc vs bypassed to CLI, + the reach rate. The § 0.5
   * anti-pattern signal (a useful brief that the principal nonetheless
   * bypasses is the control-plane-as-J3 trap).
   */
  reachCount: number;
  bypassCount: number;
  reachRate: number | null;
}

/**
 * Evaluate the kill criterion over the most recent KILL_WINDOW briefs.
 * Metrics may be passed in any order; they're sorted by briefDate ascending
 * and the last KILL_WINDOW are used.
 */
export function evaluateGate(metrics: KillCriterionMetric[]): GateResult {
  const sorted = [...metrics].sort((a, b) =>
    a.briefDate < b.briefDate ? -1 : a.briefDate > b.briefDate ? 1 : 0,
  );
  const window = sorted.slice(-KILL_WINDOW);

  const acceptedSum = window.reduce((s, m) => s + m.acceptedCount, 0);
  const j1Sum = window.reduce((s, m) => s + m.j1CompletedCount, 0);
  const reachCount = window.filter((m) => m.reachOrBypass === "acted-from-pacc").length;
  const bypassCount = window.filter((m) => m.reachOrBypass === "bypassed-to-cli").length;
  const recorded = reachCount + bypassCount;
  const reachRate = recorded > 0 ? reachCount / recorded : null;

  const windowFull = window.length >= KILL_WINDOW;
  const pass = acceptedSum >= KILL_ACCEPTED_THRESHOLD && j1Sum >= KILL_J1_THRESHOLD;
  const redFlag = windowFull && !pass;

  return { window, acceptedSum, j1Sum, pass, redFlag, windowFull, reachCount, bypassCount, reachRate };
}

// ---------------------------------------------------------------------------
// Self-check section render (pure: metrics → markdown lines)
// ---------------------------------------------------------------------------

function withinRollingWindow(briefDate: string, now: Date, days: number): boolean {
  // briefDate is YYYY-MM-DD; compare at day granularity, inclusive.
  const then = new Date(`${briefDate}T00:00:00.000Z`);
  if (Number.isNaN(then.getTime())) return false;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate()),
  );
  return then.getTime() >= cutoffDay.getTime() && then.getTime() <= now.getTime();
}

/**
 * Render the "Control-plane self-check" section. Present in every brief from
 * T-3.10 forward. Shows 7-day rolling totals and, when the last-5 gate
 * fails on a full window, the PRD § 0.5 red-flag line.
 */
export function renderSelfCheckSection(
  metrics: KillCriterionMetric[],
  now: Date,
): string[] {
  const out: string[] = [];
  out.push("## Control-plane self-check");
  out.push("");

  const rolling = metrics.filter((m) => withinRollingWindow(m.briefDate, now, SELF_CHECK_ROLLING_DAYS));
  const rSuggestions = rolling.reduce((s, m) => s + m.suggestionsCount, 0);
  const rAccepted = rolling.reduce((s, m) => s + m.acceptedCount, 0);
  const rJ1 = rolling.reduce((s, m) => s + m.j1CompletedCount, 0);
  const rReach = rolling.filter((m) => m.reachOrBypass === "acted-from-pacc").length;
  const rBypass = rolling.filter((m) => m.reachOrBypass === "bypassed-to-cli").length;
  const rRecorded = rReach + rBypass;

  out.push(`- Briefs (last ${SELF_CHECK_ROLLING_DAYS}d): ${rolling.length}`);
  out.push(`- Suggestions: ${rSuggestions}`);
  out.push(`- Accepted next actions: ${rAccepted}`);
  out.push(`- J1 actions completed: ${rJ1}`);
  out.push(
    `- Acted from pacc / bypassed to CLI: ${rReach} / ${rBypass}` +
      (rRecorded > 0 ? ` (${Math.round((rReach / rRecorded) * 100)}% reach)` : " (not yet recorded)"),
  );

  const gate = evaluateGate(metrics);
  if (gate.redFlag) {
    out.push("");
    out.push(
      `> 🚩 **Kill-criterion red flag.** Over the last ${KILL_WINDOW} briefs: ` +
        `${gate.acceptedSum} accepted next actions (need ≥ ${KILL_ACCEPTED_THRESHOLD}) and ` +
        `${gate.j1Sum} completed J1 actions (need ≥ ${KILL_J1_THRESHOLD}). ` +
        `PRD § 0.5: freeze new control-plane feature work until this recovers.`,
    );
  } else if (!gate.windowFull) {
    out.push("");
    out.push(
      `> _Measurement window not yet full (${gate.window.length}/${KILL_WINDOW} briefs)._`,
    );
  }

  // T-3.14: advisory H2 signal — bypass-dominant use suggests pacc may be the
  // anti-pattern even when the accepted-action meter passes (the principal
  // ticks boxes but reaches for the CLI when it's time to actually act).
  if (rRecorded >= 3 && rBypass > rReach) {
    out.push("");
    out.push(
      `> ⚠ **Bypass-dominant** over the last ${SELF_CHECK_ROLLING_DAYS}d (${rBypass} bypass vs ${rReach} reach). ` +
        `A useful brief the principal nonetheless bypasses is the § 0.5 control-plane-as-J3 trap — weigh this before expanding pacc.`,
    );
  }

  out.push("");
  return out;
}
