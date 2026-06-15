/**
 * T-4.4 — decision log + supersede graph tests.
 */
import { describe, expect, it } from "vitest";
import {
  makeDecisionRecord,
  applySupersede,
  applyOutcome,
  selectDecisionsDue,
  walkSupersedeChain,
  type DecisionInput,
  type DecisionRecord,
} from "../lib/decisions/decision-log.js";
import {
  recordDecision,
  reviewDecision,
  getDecisionHistory,
  type CaptureDecisionDeps,
} from "../lib/decisions/capture-decision.js";

const NOW = new Date("2026-06-09T10:00:00.000Z");

const sourceRef = {
  kind: "M1a" as const,
  path: "Obsidian/Project/PRD.md",
  section: "§ 3",
  hash: "a".repeat(64),
  capturedAt: "2026-06-09T00:00:00.000Z",
};

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    projectId: "circlo",
    summary: "Use embedded Postgres locally",
    chosenOption: "embedded-postgres",
    optionsConsidered: [
      { label: "embedded-postgres", rationale: "zero ops", tradeoffs: "single host" },
      { label: "managed pg", rationale: "scalable", tradeoffs: "ops + cost" },
    ],
    rationale: "Solo MVP; ops simplicity wins.",
    sourceRefs: [sourceRef],
    decidedBy: "principal",
    jobClassification: "meta",
    ...over,
  };
}

describe("makeDecisionRecord", () => {
  it("builds an active record with outcome=null", () => {
    const r = makeDecisionRecord(input(), { id: "d1", now: NOW, actor: "principal" });
    expect(r.status).toBe("active");
    expect(r.supersededBy).toBeNull();
    expect(r.outcome).toBeNull();
    expect(r.createdAt).toBe(NOW.toISOString());
  });

  it("allows a principal decision with no sourceRefs", () => {
    const r = makeDecisionRecord(input({ decidedBy: "principal", sourceRefs: [] }), {
      id: "d1",
      now: NOW,
      actor: "principal",
    });
    expect(r.sourceRefs).toEqual([]);
  });

  it("rejects an agent decision with no sourceRefs (provenance)", () => {
    expect(() =>
      makeDecisionRecord(input({ decidedBy: "agent:steward", sourceRefs: [] }), {
        id: "d1",
        now: NOW,
        actor: "agent:steward",
      }),
    ).toThrowError(/sourceRefs/);
  });

  it("rejects an invalid actor + missing field + bad job class", () => {
    expect(() => makeDecisionRecord(input({ decidedBy: "nobody" }), { id: "d", now: NOW, actor: "principal" })).toThrow();
    expect(() => makeDecisionRecord(input({ summary: "" }), { id: "d", now: NOW, actor: "principal" })).toThrow();
    expect(() =>
      makeDecisionRecord(input({ jobClassification: "J9" as never }), { id: "d", now: NOW, actor: "principal" }),
    ).toThrow();
  });
});

describe("applySupersede + walkSupersedeChain", () => {
  it("marks the prior superseded without deleting it", () => {
    const prior = makeDecisionRecord(input(), { id: "A", now: NOW, actor: "principal" });
    const updated = applySupersede(prior, "B", NOW);
    expect(updated.status).toBe("superseded");
    expect(updated.supersededBy).toBe("B");
    expect(updated.id).toBe("A"); // not deleted, same row
  });

  it("rejects superseding an already-superseded decision", () => {
    const prior = { ...makeDecisionRecord(input(), { id: "A", now: NOW, actor: "principal" }), supersededBy: "B", status: "superseded" as const };
    expect(() => applySupersede(prior, "C", NOW)).toThrow();
  });

  it("walks A <- B <- C from any id", () => {
    const a: DecisionRecord = { ...makeDecisionRecord(input(), { id: "A", now: NOW, actor: "principal" }), supersededBy: "B", status: "superseded" };
    const b: DecisionRecord = { ...makeDecisionRecord(input({ supersedes: "A" }), { id: "B", now: NOW, actor: "principal" }), supersededBy: "C", status: "superseded" };
    const c: DecisionRecord = makeDecisionRecord(input({ supersedes: "B" }), { id: "C", now: NOW, actor: "principal" });
    const chain = walkSupersedeChain([c, a, b], "B").map((r) => r.id);
    expect(chain).toEqual(["A", "B", "C"]);
  });
});

class InMemoryDecisions implements CaptureDecisionDeps {
  store = new Map<string, DecisionRecord>();
  seq = 0;
  async getDecision(id: string) {
    return this.store.get(id) ?? null;
  }
  async listProjectDecisions(projectId: string) {
    return [...this.store.values()].filter((d) => d.projectId === projectId);
  }
  async putDecision(record: DecisionRecord) {
    this.store.set(record.id, record);
  }
  newId() {
    this.seq += 1;
    return `dec-${this.seq}`;
  }
}

describe("recordDecision", () => {
  it("records a bare decision (no prior)", async () => {
    const deps = new InMemoryDecisions();
    const res = await recordDecision(deps, input(), { now: NOW, actor: "principal" });
    expect(res.supersededPrior).toBeNull();
    expect(deps.store.get(res.decision.id)?.status).toBe("active");
  });

  it("supersedes a prior: new row exists, prior gets supersededBy, neither deleted", async () => {
    const deps = new InMemoryDecisions();
    const first = await recordDecision(deps, input(), { now: NOW, actor: "principal" });
    const second = await recordDecision(deps, input({ summary: "Switch to managed pg", supersedes: first.decision.id }), {
      now: NOW,
      actor: "principal",
    });

    expect(second.decision.supersedes).toBe(first.decision.id);
    expect(second.supersededPrior?.id).toBe(first.decision.id);
    expect(deps.store.get(first.decision.id)?.supersededBy).toBe(second.decision.id);
    expect(deps.store.get(first.decision.id)?.status).toBe("superseded");
    // Both rows still present.
    expect(deps.store.size).toBe(2);
  });

  it("errors when superseding a non-existent decision", async () => {
    const deps = new InMemoryDecisions();
    await expect(
      recordDecision(deps, input({ supersedes: "ghost" }), { now: NOW, actor: "principal" }),
    ).rejects.toThrowError(/no such decision/);
  });

  it("getDecisionHistory returns the ordered chain", async () => {
    const deps = new InMemoryDecisions();
    const a = await recordDecision(deps, input(), { now: NOW, actor: "principal" });
    const b = await recordDecision(deps, input({ supersedes: a.decision.id }), { now: NOW, actor: "principal" });
    const history = await getDecisionHistory(deps, a.decision.id);
    expect(history.map((d) => d.id)).toEqual([a.decision.id, b.decision.id]);
  });
});

describe("applyOutcome (T-4.7)", () => {
  const base = () => makeDecisionRecord(input(), { id: "d1", now: NOW, actor: "principal" });

  it("fills outcome + reviewedAt", () => {
    const r = applyOutcome(base(), "good", NOW);
    expect(r.outcome).toEqual({ reviewedAt: NOW.toISOString(), outcome: "good" });
  });

  it("rejects an unknown outcome label", () => {
    expect(() => applyOutcome(base(), "great" as never, NOW)).toThrow();
  });

  it("refuses to overwrite an existing outcome unless force", () => {
    const once = applyOutcome(base(), "good", NOW);
    expect(() => applyOutcome(once, "bad", NOW)).toThrowError(/already has outcome/);
    expect(applyOutcome(once, "bad", NOW, { force: true }).outcome?.outcome).toBe("bad");
  });
});

describe("selectDecisionsDue (T-4.7)", () => {
  function rec(over: Partial<DecisionRecord>): DecisionRecord {
    return { ...makeDecisionRecord(input(), { id: "x", now: NOW, actor: "principal" }), ...over };
  }
  const NOW2 = new Date("2026-06-15T00:00:00.000Z");

  it("returns active, outcome-null decisions past their reviewDate", () => {
    const due = rec({ id: "due", reviewDate: "2026-06-01T00:00:00.000Z" });
    const future = rec({ id: "future", reviewDate: "2026-12-01T00:00:00.000Z" });
    const noDate = rec({ id: "nodate", reviewDate: null });
    const reviewed = rec({ id: "done", reviewDate: "2026-06-01T00:00:00.000Z", outcome: { reviewedAt: "x", outcome: "good" } });
    const superseded = rec({ id: "old", reviewDate: "2026-06-01T00:00:00.000Z", status: "superseded", supersededBy: "z" });

    const out = selectDecisionsDue([due, future, noDate, reviewed, superseded], NOW2).map((d) => d.id);
    expect(out).toEqual(["due"]);
  });
});

describe("reviewDecision (T-4.7)", () => {
  it("round-trips: writes outcome, refuses silent overwrite", async () => {
    const deps = new InMemoryDecisions();
    const d = await recordDecision(deps, input(), { now: NOW, actor: "principal" });
    const reviewed = await reviewDecision(deps, d.decision.id, "good", { now: NOW });
    expect(reviewed.outcome?.outcome).toBe("good");
    // persisted
    expect((await deps.getDecision(d.decision.id))?.outcome?.outcome).toBe("good");
    // no silent overwrite
    await expect(reviewDecision(deps, d.decision.id, "bad", { now: NOW })).rejects.toThrow();
    // force overwrites
    const forced = await reviewDecision(deps, d.decision.id, "bad", { now: NOW, force: true });
    expect(forced.outcome?.outcome).toBe("bad");
  });

  it("errors for a non-existent decision", async () => {
    const deps = new InMemoryDecisions();
    await expect(reviewDecision(deps, "ghost", "good", { now: NOW })).rejects.toThrowError(/no such decision/);
  });
});
