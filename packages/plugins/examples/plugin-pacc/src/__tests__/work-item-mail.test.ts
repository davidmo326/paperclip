import { describe, expect, it } from "vitest";
import { applyPatch, makeWorkItem, MAX_AGENT_MAIL, WorkItemValidationError } from "../lib/work-items/work-items.js";

const now = new Date("2026-10-12T00:00:00Z");
const later = new Date("2026-10-12T01:00:00Z");
const base = { projectId: "pacc", title: "Mail on items", workType: "build", size: "bite" };
const item = () => makeWorkItem(base, { id: "w1", now, actor: "principal" });
const HAND = "agent:hand@omarchy-desktop";

function sent() {
  return applyPatch(item(), { message: { id: "msg-000001", to: HAND, body: "Also add the test for an empty body." } }, { now, actor: "principal" });
}

describe("mail on a work item (FABRIC_SPEC D.5, ADR 0007)", () => {
  it("appends a principal message as queued, from the actor", () => {
    const it1 = sent();
    expect(it1.mail).toEqual([
      {
        id: "msg-000001",
        from: "principal",
        to: HAND,
        body: "Also add the test for an empty body.",
        status: "queued",
        ts: now.toISOString(),
        replyTo: null,
        claimedBy: null,
        claimedAt: null,
        surface: null,
      },
    ]);
  });

  it("is idempotent by message id", () => {
    const again = applyPatch(sent(), { message: { id: "msg-000001", to: HAND, body: "different" } }, { now, actor: "principal" });
    expect(again.mail).toHaveLength(1);
    expect(again.mail![0].body).toBe("Also add the test for an empty body.");
  });

  it("refuses bad ids, addresses, empty or long bodies, and self-addressed mail", () => {
    const bad = [
      { id: "x", to: HAND, body: "b" },
      { id: "msg-000002", to: "david", body: "b" },
      { id: "msg-000002", to: HAND, body: "  " },
      { id: "msg-000002", to: HAND, body: "a".repeat(4001) },
      { id: "msg-000002", to: "principal", body: "b" },
    ];
    for (const message of bad) {
      expect(() => applyPatch(item(), { message }, { now, actor: "principal" })).toThrow(WorkItemValidationError);
    }
  });

  it("refuses mail from actors without an address (runtime, hand, cos)", () => {
    for (const actor of ["runtime", "hand", "cos"]) {
      expect(() => applyPatch(item(), { message: { id: "msg-000002", to: HAND, body: "b" } }, { now, actor })).toThrow(/may not write mail/);
    }
  });

  it("lets an agent only reply to a message sent to it, back to its sender", () => {
    const delivered = applyPatch(sent(), { mailStatus: { id: "msg-000001", status: "claimed", claimedBy: "omarchy-desktop" } }, { now, actor: "runtime" });
    const d2 = applyPatch(delivered, { mailStatus: { id: "msg-000001", status: "delivered" } }, { now, actor: "runtime" });
    // unprompted mail to the principal is refused
    expect(() => applyPatch(d2, { message: { id: "msg-000002", to: "principal", body: "hi" } }, { now, actor: HAND })).toThrow(/only reply/);
    // another agent cannot answer a message that was not sent to it
    expect(() =>
      applyPatch(d2, { message: { id: "msg-000002", to: "principal", body: "hi", replyTo: "msg-000001" } }, { now, actor: "agent:t@omarchy-desktop" }),
    ).toThrow(/only reply/);
    const replied = applyPatch(d2, { message: { id: "msg-000002", to: "principal", body: "Added.", replyTo: "msg-000001" } }, { now: later, actor: HAND });
    expect(replied.mail!.map((m) => [m.id, m.status, m.from, m.to])).toEqual([
      ["msg-000001", "answered", "principal", HAND],
      ["msg-000002", "delivered", HAND, "principal"],
    ]);
  });

  it(`bounds agent mail at ${MAX_AGENT_MAIL} per item`, () => {
    let it1 = item();
    for (let n = 0; n <= MAX_AGENT_MAIL; n++) {
      const q = `msg-q${String(n).padStart(5, "0")}`;
      const r = `msg-r${String(n).padStart(5, "0")}`;
      it1 = applyPatch(it1, { message: { id: q, to: HAND, body: "question" } }, { now, actor: "principal" });
      const reply = () => applyPatch(it1, { message: { id: r, to: "principal", body: "answer", replyTo: q } }, { now, actor: HAND });
      if (n < MAX_AGENT_MAIL) it1 = reply();
      else expect(reply).toThrow(/Needs-you/);
    }
  });

  it("moves status only along the allowed moves, by the cockpit or the principal", () => {
    const s = sent();
    expect(() => applyPatch(s, { mailStatus: { id: "msg-000001", status: "claimed" } }, { now, actor: HAND })).toThrow(/may not move mail/);
    expect(() => applyPatch(s, { mailStatus: { id: "msg-000001", status: "answered" } }, { now, actor: "runtime" })).toThrow(/not a move/);
    const c = applyPatch(s, { mailStatus: { id: "msg-000001", status: "claimed", claimedBy: "omarchy-desktop" } }, { now: later, actor: "runtime" });
    expect(c.mail![0]).toMatchObject({ status: "claimed", claimedBy: "omarchy-desktop", claimedAt: later.toISOString() });
    const back = applyPatch(c, { mailStatus: { id: "msg-000001", status: "queued" } }, { now, actor: "runtime" });
    expect(back.mail![0]).toMatchObject({ status: "queued", claimedBy: null, claimedAt: null });
    expect(applyPatch(back, { mailStatus: { id: "msg-000001", status: "dropped" } }, { now, actor: "principal" }).mail![0].status).toBe("dropped");
    expect(() => applyPatch(s, { mailStatus: { id: "nope00", status: "dropped" } }, { now, actor: "runtime" })).toThrow(/not on this item/);
  });
});
