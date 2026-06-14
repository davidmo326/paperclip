/**
 * Capture brief feedback — T-3.9 orchestration (the I/O glue over the pure
 * cores in `feedback.ts` + `kill-criterion.ts`).
 *
 * Flow (per PRD § 13.1):
 *   1. parse the principal's edited brief Markdown (checkbox toggles + footer)
 *   2. persist a `brief_feedback` row keyed by briefDate
 *   3. load the stored `Brief` to derive outcomes (task creation vs escalation
 *      resolution) — returned for the caller to surface; actual issue creation
 *      is T-4.x territory
 *   4. fold `acceptedCount` into the kill-criterion metric so the M-Brief gate
 *      reflects accepted next-actions
 *
 * Pure-ish: all state access goes through injected deps so it's unit-testable
 * with in-memory fakes (no plugin_state, no running worker).
 */

import {
  parseBriefFeedback,
  makeFeedbackRow,
  deriveFeedbackOutcomes,
  type BriefFeedbackRow,
  type FeedbackOutcome,
} from "./feedback.js";
import {
  applyFeedbackToMetric,
  initMetric,
  type KillCriterionMetric,
} from "./kill-criterion.js";
import type { Brief } from "./types.js";

export interface CaptureFeedbackDeps {
  /** Load the stored Brief for a date (null if not found / not yet generated). */
  readBrief(briefDate: string): Promise<Brief | null>;
  /** Persist the feedback row (keyed by briefDate). */
  writeFeedbackRow(row: BriefFeedbackRow): Promise<void>;
  /** Read the kill-criterion metric for a date (null if none yet). */
  readMetric(briefDate: string): Promise<KillCriterionMetric | null>;
  /** Upsert the kill-criterion metric. */
  writeMetric(metric: KillCriterionMetric): Promise<void>;
}

export interface CaptureFeedbackResult {
  briefDate: string;
  /** Whether the stored Brief was found (outcomes can only be derived if so). */
  briefFound: boolean;
  useful: boolean | null;
  acceptedCount: number;
  /** Task-creation / escalation-resolution intents (not executed here). */
  outcomes: FeedbackOutcome[];
  /** Approved items that matched neither an action nor an escalation. */
  unmatched: string[];
  /** The updated kill-criterion metric. */
  metric: KillCriterionMetric;
}

export async function captureBriefFeedback(
  deps: CaptureFeedbackDeps,
  args: { briefDate: string; markdown: string; now?: Date },
): Promise<CaptureFeedbackResult> {
  const now = args.now ?? new Date();
  const parsed = parseBriefFeedback(args.markdown);

  // 2. Persist the feedback row.
  const row = makeFeedbackRow(args.briefDate, parsed, now);
  await deps.writeFeedbackRow(row);

  // 3. Derive outcomes against the stored brief (if available).
  const brief = await deps.readBrief(args.briefDate);
  let outcomes: FeedbackOutcome[] = [];
  let unmatched: string[] = parsed.approvedActions;
  if (brief) {
    const derived = deriveFeedbackOutcomes(parsed, brief);
    outcomes = derived.outcomes;
    unmatched = derived.unmatched;
  }

  // 4. Fold acceptedCount into the kill-criterion metric. Preserve the brief's
  //    suggestion count + any j1 progress; only the accepted count changes.
  const suggestionsCount = brief
    ? brief.highLeverageActions.length + brief.backlogCandidates.length
    : 0;
  const existing = await deps.readMetric(args.briefDate);
  const base = existing ?? initMetric(args.briefDate, suggestionsCount);
  const metric = applyFeedbackToMetric(base, parsed);
  await deps.writeMetric(metric);

  return {
    briefDate: args.briefDate,
    briefFound: brief !== null,
    useful: parsed.useful,
    acceptedCount: row.acceptedCount,
    outcomes,
    unmatched,
    metric,
  };
}
