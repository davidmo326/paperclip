/**
 * T-2.7 integration test — writeM2Guarded wraps writeM2 with conflict
 * detection + quarantine + human-asserted resolution.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  writeM2Guarded,
  type ConflictEvent,
  type GuardedDeps,
  type GuardedResult,
  type PriorFieldState,
} from "../lib/write-m2-guarded.js";
import {
  InMemoryWriteM2Adapter,
  type WriteM2Op,
  type WriteM2Opts,
} from "../lib/write-m2.js";
import type { ProjectConflictsState } from "../lib/conflict.js";
import type { SourceRef } from "@paperclipai/shared";

const refA: SourceRef = {
  kind: "M1a",
  path: "/v/a.md",
  hash: "a".repeat(64),
  capturedAt: "2026-05-21T10:00:00.000Z",
};
const refB: SourceRef = {
  kind: "M1a",
  path: "/v/b.md",
  hash: "b".repeat(64),
  capturedAt: "2026-05-21T10:00:00.000Z",
};

function baseOpts(overrides: Partial<WriteM2Opts> = {}): WriteM2Opts {
  return {
    sourceRefs: [refA],
    confidence: 0.9,
    confidenceSource: "agent_inferred",
    actor: "agent:steward-001",
    jobClassification: "J1_signal",
    ...overrides,
  };
}

const PROJECT = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Stub deps
// ---------------------------------------------------------------------------

interface StubState {
  adapter: InMemoryWriteM2Adapter;
  conflicts: ProjectConflictsState | null;
  conflictsWrites: ProjectConflictsState[];
  prior: Record<string, PriorFieldState>;
  events: ConflictEvent[];
}

let stub: StubState;
beforeEach(() => {
  stub = {
    adapter: new InMemoryWriteM2Adapter(),
    conflicts: null,
    conflictsWrites: [],
    prior: {},
    events: [],
  };
});

function deps(): GuardedDeps {
  return {
    adapter: stub.adapter,
    async readConflicts() {
      return stub.conflicts;
    },
    async writeConflicts(_projectId, state) {
      stub.conflicts = state;
      stub.conflictsWrites.push(state);
    },
    async readPriorFieldState(_projectId, fields) {
      const out: Record<string, PriorFieldState> = {};
      for (const f of fields) {
        if (stub.prior[f]) out[f] = stub.prior[f];
      }
      return out;
    },
    async emitConflictEvent(event) {
      stub.events.push(event);
    },
  };
}

function patchOp(patch: Record<string, unknown>): WriteM2Op {
  return { kind: "projectState", projectId: PROJECT, patch };
}

// ---------------------------------------------------------------------------
// 1. First-write (no prior state) — no conflict
// ---------------------------------------------------------------------------

describe("writeM2Guarded — first write", () => {
  it("dispatches when no prior state and no conflicts", async () => {
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "validating" }),
      baseOpts(),
      deps(),
    );
    expect(result).toEqual<GuardedResult>({ kind: "success" });
    expect(stub.adapter.projectStateWrites).toHaveLength(1);
    expect(stub.adapter.projectStateWrites[0].patch).toEqual({
      currentStatus: "validating",
    });
    expect(stub.conflictsWrites).toHaveLength(0);
    expect(stub.events).toHaveLength(0);
  });

  it("dispatches when prior sourceRefs match the new write (re-grounding)", async () => {
    stub.prior = {
      currentStatus: {
        value: "old",
        sourceRefs: [refA],
        actor: "agent:steward-001",
      },
    };
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "updated" }),
      baseOpts({ sourceRefs: [refA] }),
      deps(),
    );
    expect(result.kind).toBe("success");
    expect(stub.adapter.projectStateWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Conflict creation — different sources, same field
// ---------------------------------------------------------------------------

describe("writeM2Guarded — conflict creation", () => {
  it("creates a conflict record when prior sources differ", async () => {
    stub.prior = {
      currentStatus: {
        value: "old story",
        sourceRefs: [refB],
        actor: "agent:steward-001",
      },
    };
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "new story" }),
      baseOpts({ sourceRefs: [refA] }),
      deps(),
    );

    // Field went into conflict; nothing was dispatched to the M2 store.
    expect(result.kind).toBe("rejected_conflict");
    if (result.kind === "rejected_conflict") {
      expect(result.conflictedFields).toEqual(["currentStatus"]);
    }
    expect(stub.adapter.projectStateWrites).toHaveLength(0);
    expect(stub.conflicts?.byField.currentStatus).toBeDefined();
    expect(stub.conflicts?.byField.currentStatus.candidates).toHaveLength(2);
    expect(stub.events).toHaveLength(1);
    expect(stub.events[0].kind).toBe("memory.conflict.created");
  });

  it("partial writes succeed when only some fields conflict", async () => {
    stub.prior = {
      currentStatus: {
        value: "old",
        sourceRefs: [refB],
        actor: "agent:steward-001",
      },
      // intent has no prior state → no conflict
    };
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "new", intent: "ship by friday" }),
      baseOpts({ sourceRefs: [refA] }),
      deps(),
    );

    expect(result.kind).toBe("partial");
    if (result.kind === "partial") {
      expect(result.written).toEqual(["intent"]);
      expect(result.conflicted.map((c) => c.fieldPath)).toEqual(["currentStatus"]);
    }
    expect(stub.adapter.projectStateWrites).toHaveLength(1);
    expect(stub.adapter.projectStateWrites[0].patch).toEqual({ intent: "ship by friday" });
  });
});

// ---------------------------------------------------------------------------
// 3. Quarantine — agent writes to conflicted fields are rejected
// ---------------------------------------------------------------------------

describe("writeM2Guarded — quarantine pre-check", () => {
  beforeEach(() => {
    stub.conflicts = {
      projectId: PROJECT,
      updatedAt: "2026-05-21T10:00:00.000Z",
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: "2026-05-21T10:00:00.000Z",
          resolvedAt: null,
          resolvedBy: null,
          candidates: [],
        },
      },
    };
  });

  it("rejects agent writes to a conflicted field without dispatching", async () => {
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "anything" }),
      baseOpts(),
      deps(),
    );
    expect(result.kind).toBe("rejected_conflict");
    expect(stub.adapter.projectStateWrites).toHaveLength(0);
  });

  it("rejects multi-field writes that touch ANY conflicted field", async () => {
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "anything", intent: "ok" }),
      baseOpts(),
      deps(),
    );
    expect(result.kind).toBe("rejected_conflict");
    if (result.kind === "rejected_conflict") {
      expect(result.conflictedFields).toEqual(["currentStatus"]);
    }
    expect(stub.adapter.projectStateWrites).toHaveLength(0);
  });

  it("does NOT reject writes that avoid conflicted fields", async () => {
    const result = await writeM2Guarded(
      patchOp({ intent: "fresh field" }),
      baseOpts(),
      deps(),
    );
    expect(result.kind).toBe("success");
    expect(stub.adapter.projectStateWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Human-asserted resolution
// ---------------------------------------------------------------------------

describe("writeM2Guarded — human-asserted resolution", () => {
  beforeEach(() => {
    stub.conflicts = {
      projectId: PROJECT,
      updatedAt: "2026-05-21T10:00:00.000Z",
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: "2026-05-21T10:00:00.000Z",
          resolvedAt: null,
          resolvedBy: null,
          candidates: [
            {
              actor: "agent:steward-001",
              value: "candidate-A",
              sourceRefs: [refA],
              confidence: 0.7,
              recordedAt: "2026-05-21T10:00:00.000Z",
            },
            {
              actor: "agent:steward-002",
              value: "candidate-B",
              sourceRefs: [refB],
              confidence: 0.8,
              recordedAt: "2026-05-21T10:00:00.000Z",
            },
          ],
        },
      },
    };
  });

  it("bypasses quarantine, resolves, and dispatches when confidenceSource is human_asserted", async () => {
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "the principal's answer" }),
      baseOpts({
        actor: "principal",
        sourceRefs: [],
        confidence: 1,
        confidenceSource: "human_asserted",
      }),
      deps(),
    );

    expect(result.kind).toBe("success");
    expect(stub.adapter.projectStateWrites).toHaveLength(1);
    expect(stub.conflicts?.byField.currentStatus.resolvedAt).not.toBeNull();
    expect(stub.conflicts?.byField.currentStatus.resolvedBy).toBe("principal");
    expect(stub.events.map((e) => e.kind)).toContain("memory.conflict.resolved");
  });

  it("does not emit resolved event when there's nothing to resolve", async () => {
    stub.conflicts = null; // no conflict on this project
    const result = await writeM2Guarded(
      patchOp({ currentStatus: "p says so" }),
      baseOpts({
        actor: "principal",
        sourceRefs: [],
        confidence: 1,
        confidenceSource: "human_asserted",
      }),
      deps(),
    );
    expect(result.kind).toBe("success");
    expect(stub.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Non-projectState ops pass through unchanged
// ---------------------------------------------------------------------------

describe("writeM2Guarded — non-projectState passthrough", () => {
  it("delegates decision writes straight to writeM2", async () => {
    const result = await writeM2Guarded(
      {
        kind: "decision",
        projectId: PROJECT,
        data: { summary: "x", chosenOption: "y" },
      },
      baseOpts({ jobClassification: "meta" }),
      deps(),
    );
    expect(result.kind).toBe("success");
    expect(stub.adapter.decisionWrites).toHaveLength(1);
    expect(stub.adapter.projectStateWrites).toHaveLength(0);
  });

  it("delegates authorityProfile writes straight to writeM2", async () => {
    const result = await writeM2Guarded(
      {
        kind: "authorityProfile",
        data: { agentId: "a-1", actionClass: "state", ceiling: "L2" },
      },
      baseOpts({
        actor: "principal",
        sourceRefs: [],
        jobClassification: "meta",
      }),
      deps(),
    );
    expect(result.kind).toBe("success");
    expect(stub.adapter.authorityProfileWrites).toHaveLength(1);
  });
});
