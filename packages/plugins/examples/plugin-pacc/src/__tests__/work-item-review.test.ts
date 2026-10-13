import { describe, expect, it } from "vitest";
import { applyPatch, makeWorkItem, WorkItemValidationError } from "../lib/work-items/work-items.js";

const now = new Date("2026-10-13T00:00:00Z");
const item = () => makeWorkItem({ projectId: "pacc", title: "A small build", workType: "build", size: "bite" }, { id: "w1", now, actor: "principal" });
const review = { by: "agent:cos@omarchy-desktop", verdict: "done", note: "Tests pass.", routed: "done", resultAt: "2026-10-13T00:00:00.000Z", sendBacks: 0 };

describe("the CoS's review on a work item (FABRIC_SPEC D.8)", () => {
  it("is written by the cockpit or the CoS, with the time it was written", () => {
    const r = applyPatch(item(), { review }, { now, actor: "runtime" });
    expect(r.review).toEqual({ ...review, at: now.toISOString() });
    expect(applyPatch(item(), { review, stage: "done" }, { now, actor: "cos" }).stage).toBe("done");
  });

  it("refuses any other writer, a bad verdict or route, a non-agent author, a long note", () => {
    expect(() => applyPatch(item(), { review }, { now, actor: "principal" })).toThrow(/may not write a review/);
    expect(() => applyPatch(item(), { review }, { now, actor: "agent:cos@omarchy-desktop" })).toThrow(/may not write a review/);
    for (const bad of [{ verdict: "ok" }, { routed: "away" }, { by: "principal" }, { note: "x".repeat(1201) }]) {
      expect(() => applyPatch(item(), { review: { ...review, ...bad } }, { now, actor: "runtime" })).toThrow(WorkItemValidationError);
    }
  });

  it("clears with null and clamps sendBacks", () => {
    const r = applyPatch(item(), { review: { ...review, sendBacks: 99 } }, { now, actor: "runtime" });
    expect(r.review!.sendBacks).toBe(0);
    expect(applyPatch(r, { review: null }, { now, actor: "runtime" }).review).toBeNull();
  });
});
