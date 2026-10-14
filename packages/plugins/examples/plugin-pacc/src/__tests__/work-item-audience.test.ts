import { describe, expect, it } from "vitest";
import { applyPatch, makeWorkItem, WorkItemValidationError } from "../lib/work-items/work-items.js";

const now = new Date("2026-10-14T00:00:00Z");
const item = () => makeWorkItem({ projectId: "pacc", title: "Add the log entry for T-e2e", workType: "build", size: "bite" }, { id: "w1", now, actor: "hand" });
const forMe = {
  about: "A hand wrote up yesterday's test-folder work; the write-up is ready.",
  ask: "Merge it from the laptop, or let me do it.",
  options: ["Let me merge it (recommended)", "Merge it yourself", "Drop it"],
  recommend: "Let me merge it",
  by: "agent:cos@omarchy-desktop",
};

describe("who a card is for, and the card in plain words (Addendum J, M)", () => {
  it("lets the principal, the CoS or the cockpit set the audience, and nobody else", () => {
    expect(applyPatch(item(), { audience: "me" }, { now, actor: "principal" }).audience).toBe("me");
    expect(applyPatch(item(), { audience: "agents" }, { now, actor: "cos" }).audience).toBe("agents");
    expect(applyPatch(item(), { audience: null }, { now, actor: "runtime" }).audience).toBeNull();
    expect(() => applyPatch(item(), { audience: "me" }, { now, actor: "hand" })).toThrow(/may not set the audience/);
    expect(() => applyPatch(item(), { audience: "everyone" }, { now, actor: "principal" })).toThrow(WorkItemValidationError);
  });

  it("takes the plain card from the CoS or the cockpit only, with the time it was written", () => {
    const r = applyPatch(item(), { forMe }, { now, actor: "runtime" });
    expect(r.forMe).toEqual({ ...forMe, at: now.toISOString() });
    expect(() => applyPatch(item(), { forMe }, { now, actor: "principal" })).toThrow(/may not write the card/);
    expect(() => applyPatch(item(), { forMe }, { now, actor: "hand" })).toThrow(/may not write the card/);
  });

  it("refuses an empty or long line, a non-agent author, and keeps at most four options", () => {
    for (const bad of [{ about: "" }, { ask: "x".repeat(301) }, { by: "principal" }]) {
      expect(() => applyPatch(item(), { forMe: { ...forMe, ...bad } }, { now, actor: "cos" })).toThrow(WorkItemValidationError);
    }
    const r = applyPatch(item(), { forMe: { ...forMe, options: ["a", "b", "c", "d", "e"] } }, { now, actor: "cos" });
    expect(r.forMe!.options).toEqual(["a", "b", "c", "d"]);
  });
});
