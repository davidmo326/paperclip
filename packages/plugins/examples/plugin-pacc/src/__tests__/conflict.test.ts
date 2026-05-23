/**
 * T-2.7 — unit tests for the pure conflict-detection logic.
 */

import { describe, expect, it } from "vitest";
import {
  detectConflict,
  isFieldConflicted,
  listConflictedFields,
  resolveConflict,
  sourceRefsEqual,
  type ProjectConflictsState,
} from "../lib/conflict.js";
import type { SourceRef } from "@paperclipai/shared";

function ref(path: string, hashHex: string): SourceRef {
  return {
    kind: "M1a",
    path,
    hash: hashHex.padEnd(64, "0"),
    capturedAt: "2026-05-21T10:00:00.000Z",
  };
}

const NOW = "2026-05-21T12:00:00.000Z";

const refA = ref("/v/a.md", "aaaa");
const refB = ref("/v/b.md", "bbbb");
const refC = ref("/v/c.md", "cccc");

// ---------------------------------------------------------------------------
// sourceRefsEqual
// ---------------------------------------------------------------------------

describe("sourceRefsEqual", () => {
  it("returns true for the same refs in the same order", () => {
    expect(sourceRefsEqual([refA, refB], [refA, refB])).toBe(true);
  });
  it("returns true regardless of order", () => {
    expect(sourceRefsEqual([refA, refB], [refB, refA])).toBe(true);
  });
  it("returns false when path differs", () => {
    expect(sourceRefsEqual([refA], [refB])).toBe(false);
  });
  it("returns false when hash differs (same path)", () => {
    expect(
      sourceRefsEqual([refA], [ref("/v/a.md", "ffff")]),
    ).toBe(false);
  });
  it("ignores hash case differences", () => {
    const upper: SourceRef = { ...refA, hash: refA.hash.toUpperCase() };
    expect(sourceRefsEqual([refA], [upper])).toBe(true);
  });
  it("returns false for different lengths", () => {
    expect(sourceRefsEqual([refA, refB], [refA])).toBe(false);
  });
  it("returns true for two empty arrays", () => {
    expect(sourceRefsEqual([], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFieldConflicted / listConflictedFields
// ---------------------------------------------------------------------------

describe("isFieldConflicted / listConflictedFields", () => {
  const state: ProjectConflictsState = {
    projectId: "p-1",
    updatedAt: NOW,
    byField: {
      currentStatus: {
        fieldPath: "currentStatus",
        createdAt: NOW,
        resolvedAt: null,
        resolvedBy: null,
        candidates: [],
      },
      doNotRethink: {
        fieldPath: "doNotRethink",
        createdAt: NOW,
        resolvedAt: NOW,
        resolvedBy: "principal",
        candidates: [],
      },
    },
  };

  it("is true for an unresolved field", () => {
    expect(isFieldConflicted(state, "currentStatus")).toBe(true);
  });
  it("is false for a resolved field", () => {
    expect(isFieldConflicted(state, "doNotRethink")).toBe(false);
  });
  it("is false for a field that has no record", () => {
    expect(isFieldConflicted(state, "intent")).toBe(false);
  });
  it("is false when state is null", () => {
    expect(isFieldConflicted(null, "currentStatus")).toBe(false);
  });
  it("lists only unresolved conflicts", () => {
    expect(listConflictedFields(state)).toEqual(["currentStatus"]);
  });
  it("returns [] for null state", () => {
    expect(listConflictedFields(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectConflict
// ---------------------------------------------------------------------------

describe("detectConflict", () => {
  const base = {
    projectId: "p-1",
    fieldPath: "currentStatus",
    newValue: "validating with 3 calls",
    newSourceRefs: [refA],
    newActor: "agent:steward-001",
    newConfidence: 0.9,
    now: NOW,
  };

  it("returns no_conflict when no prior sourceRefs (first write)", () => {
    const result = detectConflict({
      ...base,
      priorValue: null,
      priorSourceRefs: null,
      priorActor: null,
      existingState: null,
    });
    expect(result.kind).toBe("no_conflict");
  });

  it("returns no_conflict when sourceRefs match prior (re-grounded)", () => {
    const result = detectConflict({
      ...base,
      priorValue: "previous value",
      priorSourceRefs: [refA],
      priorActor: "agent:steward-001",
      existingState: null,
    });
    expect(result.kind).toBe("no_conflict");
  });

  it("creates a conflict_created when prior has different sourceRefs", () => {
    const result = detectConflict({
      ...base,
      priorValue: "old value",
      priorSourceRefs: [refB],
      priorActor: "agent:steward-001",
      existingState: null,
    });
    expect(result.kind).toBe("conflict_created");
    if (result.kind === "conflict_created") {
      expect(result.record.fieldPath).toBe("currentStatus");
      expect(result.record.candidates).toHaveLength(2);
      expect(result.record.candidates[1].value).toBe("validating with 3 calls");
      expect(result.record.candidates[1].sourceRefs).toEqual([refA]);
      expect(result.record.candidates[0].sourceRefs).toEqual([refB]);
      expect(result.state.byField.currentStatus).toBe(result.record);
    }
  });

  it("returns already_conflicted when the field is unresolved", () => {
    const existing: ProjectConflictsState = {
      projectId: "p-1",
      updatedAt: NOW,
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: NOW,
          resolvedAt: null,
          resolvedBy: null,
          candidates: [],
        },
      },
    };
    const result = detectConflict({
      ...base,
      priorValue: "x",
      priorSourceRefs: [refB],
      priorActor: "agent:steward-001",
      existingState: existing,
    });
    expect(result.kind).toBe("already_conflicted");
  });

  it("re-creates a conflict if the previous one is resolved (new disagreement)", () => {
    const existing: ProjectConflictsState = {
      projectId: "p-1",
      updatedAt: NOW,
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: "2026-05-01T00:00:00.000Z",
          resolvedAt: "2026-05-02T00:00:00.000Z",
          resolvedBy: "principal",
          candidates: [],
        },
      },
    };
    const result = detectConflict({
      ...base,
      priorValue: "x",
      priorSourceRefs: [refC],
      priorActor: "agent:steward-001",
      existingState: existing,
    });
    expect(result.kind).toBe("conflict_created");
    if (result.kind === "conflict_created") {
      expect(result.record.resolvedAt).toBeNull();
      expect(result.record.candidates).toHaveLength(2);
    }
  });

  it("preserves the projectId across state updates", () => {
    const result = detectConflict({
      ...base,
      priorValue: "x",
      priorSourceRefs: [refB],
      priorActor: "agent:steward-001",
      existingState: null,
    });
    if (result.kind !== "conflict_created") throw new Error("expected conflict");
    expect(result.state.projectId).toBe("p-1");
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe("resolveConflict", () => {
  function makeState(resolved = false): ProjectConflictsState {
    return {
      projectId: "p-1",
      updatedAt: NOW,
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: NOW,
          resolvedAt: resolved ? NOW : null,
          resolvedBy: resolved ? "principal" : null,
          candidates: [],
        },
      },
    };
  }

  it("resolves an unresolved conflict and stamps resolver + timestamp", () => {
    const result = resolveConflict({
      projectId: "p-1",
      fieldPath: "currentStatus",
      resolverActor: "principal",
      now: "2026-05-22T10:00:00.000Z",
      existingState: makeState(false),
    });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.record.resolvedAt).toBe("2026-05-22T10:00:00.000Z");
      expect(result.record.resolvedBy).toBe("principal");
    }
  });

  it("returns no_op when the conflict was already resolved", () => {
    const result = resolveConflict({
      projectId: "p-1",
      fieldPath: "currentStatus",
      resolverActor: "principal",
      now: NOW,
      existingState: makeState(true),
    });
    expect(result.kind).toBe("no_op");
  });

  it("returns no_op when there's no record for the field", () => {
    const result = resolveConflict({
      projectId: "p-1",
      fieldPath: "intent",
      resolverActor: "principal",
      now: NOW,
      existingState: makeState(false),
    });
    expect(result.kind).toBe("no_op");
  });

  it("returns no_op when existingState is null", () => {
    const result = resolveConflict({
      projectId: "p-1",
      fieldPath: "currentStatus",
      resolverActor: "principal",
      now: NOW,
      existingState: null,
    });
    expect(result.kind).toBe("no_op");
  });
});
