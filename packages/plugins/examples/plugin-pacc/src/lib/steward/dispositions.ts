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
  | "dropped";

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
  /** The principal's note on that move, if any. */
  note: string | null;
}

const ACCEPTED: ReadonlySet<Disposition> = new Set(["taken", "sent", "done"]);
const UNDECIDED = new Set(["triage", "intake"]);

function isCos(item: WorkItem): boolean {
  return item.createdBy === "cos";
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
    const move = item.history.find((h) => h.from !== null && UNDECIDED.has(h.from) && !UNDECIDED.has(h.to));
    let disposition: Disposition = "pending";
    if (move) {
      if (move.to === "needs-you") disposition = "taken";
      else if (move.to === "in-progress") disposition = "sent";
      else if (move.to === "done") disposition = /drop/i.test(move.note ?? "") ? "dropped" : "done";
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
      decidedAt: move?.at ?? null,
      note: move?.note ?? null,
    });
  }
  return rows.sort((a, b) => (b.decidedAt ?? "9").localeCompare(a.decidedAt ?? "9") || b.itemId.localeCompare(a.itemId));
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
