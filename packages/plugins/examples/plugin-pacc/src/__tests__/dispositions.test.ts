import { describe, expect, it } from "vitest";
import { cosProposalRows, h1Summary } from "../lib/steward/dispositions.js";
import { applyPatch, makeWorkItem, type CapacityDay, type WorkItem } from "../lib/work-items/work-items.js";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const at = (iso: string) => ({ now: new Date(iso), actor: "principal" });

function cos(id: string, title: string, created = "2026-10-05T00:00:00.000Z"): WorkItem {
  return makeWorkItem(
    { projectId: "hometrics", title, detail: "Why now: x", workType: "market-contact", size: "bite", stage: "triage", proposedFrom: created.slice(0, 10) },
    { id, now: new Date(created), actor: "cos" },
  );
}

describe("CoS proposal dispositions (T-cos.1)", () => {
  it("freezes the proposal only on CoS items", () => {
    expect(cos("a", "Email 3 owners").proposed).toEqual({
      projectId: "hometrics", title: "Email 3 owners", detail: "Why now: x", size: "bite", workType: "market-contact", journalDate: "2026-10-05",
    });
    const mine = makeWorkItem({ projectId: "p", title: "x", workType: "build", size: "bite" }, { id: "b", now: NOW, actor: "principal" });
    expect(mine.proposed).toBeUndefined();
  });

  it("reads taken / sent / dropped / done / pending from the stage history, and edits from the snapshot", () => {
    const taken = applyPatch(cos("t", "Email 3 owners"), { stage: "needs-you", note: "taken at triage" }, at("2026-10-05T01:00:00.000Z"));
    const rewritten = applyPatch(
      applyPatch(cos("r", "Draft a survey"), { title: "Call Sam instead", size: "deep" }, at("2026-10-05T02:00:00.000Z")),
      { stage: "needs-you", note: "taken at triage" },
      at("2026-10-05T02:00:00.000Z"),
    );
    const sent = applyPatch(cos("s", "Scrape listings"), { stage: "in-progress" }, at("2026-10-05T03:00:00.000Z"));
    const dropped = applyPatch(cos("d", "Polish the deck"), { stage: "done", note: "dropped at triage" }, at("2026-10-05T04:00:00.000Z"));
    const done = applyPatch(cos("x", "Reply to Jo"), { stage: "done" }, at("2026-10-05T05:00:00.000Z"));
    const pending = cos("p", "Book a call");
    // later moves after the decision don't change it
    const takenThenDone = applyPatch(taken, { stage: "done" }, at("2026-10-06T00:00:00.000Z"));
    const rows = cosProposalRows([takenThenDone, rewritten, sent, dropped, done, pending]);
    const by = Object.fromEntries(rows.map((r) => [r.itemId, r]));
    expect(by.t).toMatchObject({ disposition: "taken", edited: [], nowTitle: null, decidedAt: "2026-10-05T01:00:00.000Z" });
    expect(by.r).toMatchObject({ disposition: "taken", edited: ["title", "size"], proposed: "Draft a survey", nowTitle: "Call Sam instead", size: "bite" });
    expect(by.s?.disposition).toBe("sent");
    expect(by.d).toMatchObject({ disposition: "dropped", note: "dropped at triage" });
    expect(by.x?.disposition).toBe("done");
    expect(by.p).toMatchObject({ disposition: "pending", decidedAt: null });
    // pending first, then newest decision first
    expect(rows.map((r) => r.itemId)).toEqual(["p", "x", "d", "s", "r", "t"]);
  });

  it("ignores non-CoS items and treats pre-snapshot CoS items as unknown-edit", () => {
    const legacy = { ...cos("l", "Old proposal"), proposed: undefined, sourceRefs: [{ kind: "steward-journal", path: "2026-10-05" }] };
    const decided = applyPatch(legacy, { stage: "needs-you" }, at("2026-10-05T01:00:00.000Z"));
    const mine = makeWorkItem({ projectId: "p", title: "x", workType: "build", size: "bite" }, { id: "m", now: NOW, actor: "principal" });
    const rows = cosProposalRows([decided, mine]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "l", edited: null, journalDate: "2026-10-05" });
  });

  it("H1 = accepted-unedited over decided, windowed, with capacity days counted", () => {
    const items = [
      applyPatch(cos("a", "one"), { stage: "needs-you" }, at("2026-10-05T01:00:00.000Z")),
      applyPatch(cos("b", "two"), { stage: "in-progress" }, at("2026-10-05T01:00:00.000Z")),
      applyPatch(applyPatch(cos("c", "three"), { title: "3" }, at("2026-10-05T01:00:00.000Z")), { stage: "needs-you" }, at("2026-10-05T01:00:00.000Z")),
      applyPatch(cos("d", "four"), { stage: "done", note: "dropped at triage" }, at("2026-10-05T01:00:00.000Z")),
      cos("e", "five"),
      applyPatch(cos("old", "ancient", "2026-09-01T00:00:00.000Z"), { stage: "needs-you" }, at("2026-09-01T01:00:00.000Z")),
    ];
    const days: CapacityDay[] = [
      { date: "2026-10-01", score: 5, occupiedBy: null, source: null, recordedAt: "" },
      { date: "2026-10-02", score: null, occupiedBy: null, source: null, recordedAt: "" },
      { date: "2026-09-01", score: 7, occupiedBy: null, source: null, recordedAt: "" },
    ];
    expect(h1Summary(items, days, NOW)).toEqual({
      since: "2026-09-27", windowDays: 10, capacityDays: 1,
      proposed: 5, pending: 1, decided: 4, accepted: 3, acceptedUnedited: 2, acceptedEdited: 1, dropped: 1, unknownEdit: 0,
      rate: 0.5,
    });
    expect(h1Summary([], [], NOW).rate).toBeNull();
  });
});
