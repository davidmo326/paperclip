import { describe, expect, it } from "vitest";
import {
  applyPatch,
  defaultAllocation,
  makeCapacityDay,
  makeWorkItem,
  WorkItemValidationError,
} from "../lib/work-items/work-items.js";

const now = new Date("2026-09-29T00:00:00Z");
const base = { projectId: "hometrics", title: "Use the app on own home", workType: "build", size: "bite" };

describe("work items", () => {
  it("defaults to intake and records creation in history", () => {
    const item = makeWorkItem(base, { id: "a", now, actor: "principal" });
    expect(item.stage).toBe("intake");
    expect(item.history).toEqual([{ at: now.toISOString(), from: null, to: "intake", by: "principal" }]);
  });

  it("lets the principal or CoS place an item directly", () => {
    expect(makeWorkItem({ ...base, stage: "needs-you" }, { id: "a", now, actor: "cos" }).stage).toBe("needs-you");
  });

  it("forces J (and any other actor) into intake — intake is not priority", () => {
    expect(makeWorkItem({ ...base, stage: "needs-you" }, { id: "a", now, actor: "j" }).stage).toBe("intake");
  });

  it("rejects unknown work types and sizes", () => {
    expect(() => makeWorkItem({ ...base, workType: "admin" }, { id: "a", now, actor: "principal" })).toThrow(WorkItemValidationError);
    expect(() => makeWorkItem({ ...base, size: "epic" }, { id: "a", now, actor: "principal" })).toThrow(WorkItemValidationError);
  });

  it("appends stage moves to history, ignores no-op moves", () => {
    const item = makeWorkItem(base, { id: "a", now, actor: "principal" });
    const later = new Date("2026-09-30T00:00:00Z");
    const moved = applyPatch(item, { stage: "done", note: "did it" }, { now: later, actor: "principal" });
    expect(moved.stage).toBe("done");
    expect(moved.history.at(-1)).toMatchObject({ from: "intake", to: "done", note: "did it" });
    expect(item.history).toHaveLength(1);
    expect(applyPatch(moved, { stage: "done" }, { now: later, actor: "principal" }).history).toHaveLength(2);
  });
});

describe("capacity days", () => {
  it("treats a missing note as zero capacity", () => {
    const day = makeCapacityDay({ date: "2026-09-29" }, now);
    expect(day.score).toBeNull();
    expect(defaultAllocation(day.score)).toEqual({ deepBlocks: 0, bites: 0 });
  });

  it("maps scores to the starting allocation table", () => {
    expect(defaultAllocation(2)).toEqual({ deepBlocks: 0, bites: 2 });
    expect(defaultAllocation(5)).toEqual({ deepBlocks: 1, bites: 2 });
    expect(defaultAllocation(8)).toEqual({ deepBlocks: 2, bites: 1 });
    expect(defaultAllocation(10)).toEqual({ deepBlocks: 3, bites: 0 });
  });

  it("validates date and score range", () => {
    expect(() => makeCapacityDay({ date: "29/09/2026" }, now)).toThrow(WorkItemValidationError);
    expect(() => makeCapacityDay({ date: "2026-09-29", score: 11 }, now)).toThrow(WorkItemValidationError);
  });
});
