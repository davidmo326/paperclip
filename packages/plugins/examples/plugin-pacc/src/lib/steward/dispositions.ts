/**
 * CoS proposal dispositions + H1 (ControlPlane ADR 0004, T-cos.1).
 *
 * Every CoS proposal lands in Triage as a work item; what the principal did
 * with it is already on the item (stage history + the frozen `proposed`
 * snapshot). This module reads that back as one structured row per proposal —
 * the "parent + action + outcome" record a replay needs (vault: Dream-RSI) —
 * and folds the rows into the H1 measure: the share of decided proposals the
 * principal accepted without rewriting. Pure; no new store (ADR 0005).
 *
 * Only the principal's own move accepts (F-cos.0). When the first move out of
 * Triage was made by anyone else — the chief of staff routing it, a session
 * closing it — the proposal is never accepted on that move: an agent cannot
 * grade its own proposal (the 27 Oct routes scored as accepted). A close by
 * another actor is decided, never accepted (`closed-by-agent`). A route by
 * another actor (into Needs you, or to a hand) only hands the proposal on: what
 * the principal then does with it is the decision, so it is read from his first
 * move after the route, and it stays pending until he makes one.
 *
 * Only proposals count: an item the cockpit's chief of staff makes as its own
 * channel (the tree lines a close-out carries) is no proposal, and neither is a
 * card made straight into Needs you (a season or weekly card): a proposal is
 * one that lands in Triage or Intake for the principal to dispose of.
 *
 * Rows go to the CoS raw, never as a summary: condensed "lessons" narrow the
 * search; the raw record lets the next run see exactly what was corrected.
 */

import type { CapacityDay, WorkItem } from "../work-items/work-items.js";

export type Disposition =
  /** Still in Triage/Intake — not decided yet. */
  | "pending"
  /** Taken into Needs you. */
  | "taken"
  /** Sent to a hand (in progress). */
  | "sent"
  /** Closed straight from Triage as done (finished without a hand-off). */
  | "done"
  /** Dropped at Triage. */
  | "dropped"
  /** Closed out of Triage by an actor other than the principal. Never accepted. */
  | "closed-by-agent";

export interface ProposalRow {
  itemId: string;
  line: string;
  journalDate: string | null;
  proposed: string;
  size: string;
  disposition: Disposition;
  /**
   * Fields the principal changed from the proposal (title, detail, size,
   * workType, line); [] = accepted as written; null = unknown (item predates
   * the proposal snapshot).
   */
  edited: string[] | null;
  /** The live title when the principal rewrote it. */
  nowTitle: string | null;
  /** When the item first left Triage (null while pending). */
  decidedAt: string | null;
  /** The note on that move, if any (the principal's, unless an agent moved it). */
  note: string | null;
}

const ACCEPTED: ReadonlySet<Disposition> = new Set(["taken", "sent", "done"]);
const UNDECIDED = new Set(["triage", "intake"]);
/** The one actor whose move counts as a decision on a proposal. */
const PRINCIPAL = "principal";

/** The cockpit's tree channel (ControlPlane cockpit/src/reconcile.ts treeLinesTitle): its own bookkeeping, never a proposal. */
const TREE_LINES_TITLE = /^Tree lines for .+'s next close-out$/;

function isCos(item: WorkItem): boolean {
  if (item.createdBy !== "cos") return false;
  if (TREE_LINES_TITLE.test(item.title)) return false;
  // a proposal lands where the principal disposes of it; a card made straight into Needs you is not one
  const made = item.history[0];
  return !made || made.from !== null || UNDECIDED.has(made.to);
}

function editedFields(item: WorkItem): string[] | null {
  const p = item.proposed;
  if (!p) return null;
  const out: string[] = [];
  if (p.projectId !== item.projectId) out.push("line");
  if (p.title !== item.title) out.push("title");
  if ((p.detail ?? null) !== (item.detail ?? null)) out.push("detail");
  if (p.size !== item.size) out.push("size");
  if (p.workType !== item.workType) out.push("workType");
  return out;
}

/** One row per CoS proposal created at or after `since` (ISO), newest first. */
export function cosProposalRows(items: readonly WorkItem[], opts: { since?: string } = {}): ProposalRow[] {
  const rows: ProposalRow[] = [];
  for (const item of items) {
    if (!isCos(item)) continue;
    if (opts.since && item.createdAt < opts.since) continue;
    const first = item.history.find((h) => h.from !== null && UNDECIDED.has(h.from) && !UNDECIDED.has(h.to));
    let disposition: Disposition = "pending";
    // the move that decides: his own first move out of Triage, or, after an agent's route, his first move after it
    let move = first;
    if (first && first.by !== PRINCIPAL) {
      if (first.to === "done") disposition = "closed-by-agent";
      else {
        const i = item.history.indexOf(first);
        move = item.history.slice(i + 1).find((h) => h.by === PRINCIPAL && h.from !== null && h.from !== h.to);
        if (move) disposition = principalDisposition(move.to, move.note);
      }
    } else if (first) {
      disposition = principalDisposition(first.to, first.note);
    }
    const edited = editedFields(item);
    rows.push({
      itemId: item.id,
      line: item.projectId,
      journalDate:
        item.proposed?.journalDate ?? item.sourceRefs.find((r) => r.kind === "steward-journal")?.path ?? null,
      proposed: item.proposed?.title ?? item.title,
      size: item.proposed?.size ?? item.size,
      disposition,
      edited,
      nowTitle: edited?.includes("title") ? item.title : null,
      decidedAt: disposition === "pending" ? null : (move?.at ?? null),
      note: disposition === "pending" ? null : (move?.note ?? null),
    });
  }
  return rows.sort((a, b) => (b.decidedAt ?? "9").localeCompare(a.decidedAt ?? "9") || b.itemId.localeCompare(a.itemId));
}

/**
 * What a principal's move says about a proposal: taken into Needs you (or, after an agent routed it
 * there, kept as his by moving it on), sent to a hand, done, dropped. A move back to Triage or Intake
 * ("later") decides nothing yet.
 */
function principalDisposition(to: string, note: string | null | undefined): Disposition {
  if (to === "done") return /drop/i.test(note ?? "") ? "dropped" : "done";
  if (to === "in-progress") return "sent";
  if (to === "needs-you") return "taken";
  return "pending";
}

export interface H1Summary {
  /** Window start (ISO date) and length. */
  since: string;
  windowDays: number;
  /** Days in the window with a recorded capacity score (ADR 0004 wants ~10). */
  capacityDays: number;
  proposed: number;
  pending: number;
  decided: number;
  accepted: number;
  acceptedUnedited: number;
  acceptedEdited: number;
  dropped: number;
  /** Accepted proposals whose edit state is unknown (pre-snapshot items) — excluded from the rate. */
  unknownEdit: number;
  /** acceptedUnedited / (decided − unknownEdit); null when nothing is decided yet. */
  rate: number | null;
}

/** Fold proposal rows into the H1 measure over the last `windowDays`. */
export function h1Summary(
  items: readonly WorkItem[],
  capacityDays: readonly CapacityDay[],
  now: Date,
  windowDays = 10,
): H1Summary {
  const start = new Date(now.getTime() - windowDays * 86_400_000);
  const since = start.toISOString().slice(0, 10);
  const rows = cosProposalRows(items, { since: start.toISOString() });
  const decided = rows.filter((r) => r.disposition !== "pending");
  const accepted = decided.filter((r) => ACCEPTED.has(r.disposition));
  const acceptedUnedited = accepted.filter((r) => r.edited !== null && r.edited.length === 0).length;
  const acceptedEdited = accepted.filter((r) => r.edited !== null && r.edited.length > 0).length;
  const unknownEdit = accepted.filter((r) => r.edited === null).length;
  const denom = decided.length - unknownEdit;
  return {
    since,
    windowDays,
    capacityDays: capacityDays.filter((d) => d.date >= since && d.score !== null).length,
    proposed: rows.length,
    pending: rows.length - decided.length,
    decided: decided.length,
    accepted: accepted.length,
    acceptedUnedited,
    acceptedEdited,
    dropped: decided.filter((r) => r.disposition === "dropped").length,
    unknownEdit,
    rate: denom > 0 ? Math.round((acceptedUnedited / denom) * 100) / 100 : null,
  };
}
