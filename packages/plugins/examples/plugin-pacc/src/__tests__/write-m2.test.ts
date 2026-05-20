import { describe, it, expect, beforeEach } from "vitest";
import {
  writeM2,
  proposeM2,
  M2WriteError,
  InMemoryWriteM2Adapter,
  type WriteM2Op,
  type WriteM2Opts,
} from "../lib/write-m2.js";

const validSourceRef = {
  kind: "M1a" as const,
  path: "Obsidian/10_Builds/Project X/PRD.md",
  section: "§ 3.2",
  hash: "a".repeat(64),
  capturedAt: "2026-05-20T10:00:00.000Z",
};

const projectStateOp: WriteM2Op = {
  kind: "projectState",
  projectId: "00000000-0000-0000-0000-000000000001",
  patch: { currentStatus: "Validating with 3 customer calls" },
};

function baseOpts(overrides: Partial<WriteM2Opts> = {}): WriteM2Opts {
  return {
    sourceRefs: [validSourceRef],
    confidence: 0.85,
    confidenceSource: "agent_inferred",
    actor: "agent:steward-001",
    jobClassification: "J1_signal",
    ...overrides,
  };
}

let adapter: InMemoryWriteM2Adapter;
beforeEach(() => {
  adapter = new InMemoryWriteM2Adapter();
});

describe("writeM2 — happy paths", () => {
  it("writes a projectState patch and emits success audit", async () => {
    await writeM2(projectStateOp, baseOpts(), adapter);
    expect(adapter.projectStateWrites).toHaveLength(1);
    expect(adapter.auditEvents).toHaveLength(1);
    expect(adapter.auditEvents[0]).toMatchObject({
      status: "success",
      opKind: "projectState",
      actor: "agent:steward-001",
      sourceRefCount: 1,
      authorityLevel: "L2",
    });
  });

  it("allows principal-actor write without sourceRefs (principal is the source)", async () => {
    await writeM2(
      projectStateOp,
      baseOpts({ actor: "principal", sourceRefs: [] }),
      adapter,
    );
    expect(adapter.projectStateWrites).toHaveLength(1);
    expect(adapter.auditEvents[0].status).toBe("success");
  });

  it("allows L3 write with high enough confidence", async () => {
    await writeM2(
      projectStateOp,
      baseOpts({ confidence: 0.9, requiredAuthority: "L3" }),
      adapter,
    );
    expect(adapter.auditEvents[0].status).toBe("success");
  });

  it("bypasses the L3 floor when confidenceSource is human_asserted", async () => {
    await writeM2(
      projectStateOp,
      baseOpts({
        confidence: 0.4,
        confidenceSource: "human_asserted",
        requiredAuthority: "L3",
      }),
      adapter,
    );
    expect(adapter.auditEvents[0].status).toBe("success");
  });

  it("writes a decision and returns through the adapter", async () => {
    const op: WriteM2Op = {
      kind: "decision",
      projectId: "00000000-0000-0000-0000-000000000001",
      data: { summary: "switched stack", chosenOption: "Postgres" },
    };
    await writeM2(op, baseOpts({ jobClassification: "meta" }), adapter);
    expect(adapter.decisionWrites).toHaveLength(1);
    expect(adapter.auditEvents[0].opKind).toBe("decision");
  });

  it("writes an authorityProfile", async () => {
    const op: WriteM2Op = {
      kind: "authorityProfile",
      data: { agentId: "agent-1", actionClass: "state", ceiling: "L2" },
    };
    await writeM2(
      op,
      baseOpts({ actor: "principal", jobClassification: "meta", sourceRefs: [] }),
      adapter,
    );
    expect(adapter.authorityProfileWrites).toHaveLength(1);
  });
});

describe("writeM2 — tripwire 1 (provenance)", () => {
  it("rejects agent-actor write with empty sourceRefs and emits rejected audit", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ sourceRefs: [] }), adapter),
    ).rejects.toThrow(M2WriteError);

    expect(adapter.projectStateWrites).toHaveLength(0);
    expect(adapter.auditEvents).toHaveLength(1);
    expect(adapter.auditEvents[0]).toMatchObject({
      status: "rejected",
      errorCode: "NO_SOURCE_REFS",
    });
  });

  it("rejects writes with malformed SourceRef (bad hash)", async () => {
    const badRef = { ...validSourceRef, hash: "not-a-hash" };
    await expect(
      writeM2(projectStateOp, baseOpts({ sourceRefs: [badRef] }), adapter),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_REF" });
    expect(adapter.auditEvents[0].errorCode).toBe("INVALID_SOURCE_REF");
  });
});

describe("writeM2 — tripwire 3 (confidence floors)", () => {
  it("rejects L2 agent_inferred write with confidence < 0.7", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ confidence: 0.5 }), adapter),
    ).rejects.toMatchObject({ code: "CONFIDENCE_FLOOR" });
    expect(adapter.auditEvents[0].errorCode).toBe("CONFIDENCE_FLOOR");
  });

  it("rejects L3 agent_inferred write with confidence < 0.85", async () => {
    await expect(
      writeM2(
        projectStateOp,
        baseOpts({ confidence: 0.8, requiredAuthority: "L3" }),
        adapter,
      ),
    ).rejects.toMatchObject({ code: "CONFIDENCE_FLOOR" });
  });

  it("rejects L4 writes (must go through approval)", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ requiredAuthority: "L4" }), adapter),
    ).rejects.toMatchObject({ code: "L4_REQUIRES_HUMAN_APPROVAL" });
  });

  it("rejects L5 writes", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ requiredAuthority: "L5" }), adapter),
    ).rejects.toMatchObject({ code: "L4_REQUIRES_HUMAN_APPROVAL" });
  });
});

describe("writeM2 — input shape validation", () => {
  it("rejects invalid actor pattern", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ actor: "not-an-actor" }), adapter),
    ).rejects.toMatchObject({ code: "INVALID_ACTOR" });
  });

  it("accepts agent: actor with uuid-style id", async () => {
    await writeM2(
      projectStateOp,
      baseOpts({ actor: "agent:00000000-0000-0000-0000-000000000abc" }),
      adapter,
    );
    expect(adapter.auditEvents[0].status).toBe("success");
  });

  it("rejects confidence > 1", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ confidence: 1.2 }), adapter),
    ).rejects.toMatchObject({ code: "INVALID_CONFIDENCE" });
  });

  it("rejects negative confidence", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ confidence: -0.1 }), adapter),
    ).rejects.toMatchObject({ code: "INVALID_CONFIDENCE" });
  });

  it("rejects NaN confidence", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ confidence: Number.NaN }), adapter),
    ).rejects.toMatchObject({ code: "INVALID_CONFIDENCE" });
  });

  it("rejects unknown jobClassification", async () => {
    await expect(
      writeM2(
        projectStateOp,
        baseOpts({ jobClassification: "J9_unknown" as never }),
        adapter,
      ),
    ).rejects.toMatchObject({ code: "INVALID_JOB_CLASSIFICATION" });
  });
});

describe("writeM2 — audit events", () => {
  it("emits exactly one audit event per call (success path)", async () => {
    await writeM2(projectStateOp, baseOpts(), adapter);
    expect(adapter.auditEvents).toHaveLength(1);
  });

  it("emits exactly one audit event per call (rejection path)", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ sourceRefs: [] }), adapter),
    ).rejects.toThrow();
    expect(adapter.auditEvents).toHaveLength(1);
  });

  it("audit event carries opKind, actor, confidence, authority, sourceRefCount", async () => {
    await writeM2(projectStateOp, baseOpts({ confidence: 0.9 }), adapter);
    expect(adapter.auditEvents[0]).toMatchObject({
      opKind: "projectState",
      actor: "agent:steward-001",
      confidence: 0.9,
      confidenceSource: "agent_inferred",
      authorityLevel: "L2",
      jobClassification: "J1_signal",
      sourceRefCount: 1,
    });
    expect(adapter.auditEvents[0].emittedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("does not write to the adapter target when validation fails", async () => {
    await expect(
      writeM2(projectStateOp, baseOpts({ confidence: 0.1 }), adapter),
    ).rejects.toThrow();
    expect(adapter.projectStateWrites).toHaveLength(0);
  });
});

describe("proposeM2 — candidate flow", () => {
  it("emits a candidate audit event without writing to the target", async () => {
    await proposeM2(projectStateOp, baseOpts(), adapter);
    expect(adapter.projectStateWrites).toHaveLength(0);
    expect(adapter.decisionWrites).toHaveLength(0);
    expect(adapter.auditEvents).toHaveLength(1);
    expect(adapter.auditEvents[0].status).toBe("candidate");
  });

  it("still requires sourceRefs for agent actors (tripwire 1 applies)", async () => {
    await expect(
      proposeM2(projectStateOp, baseOpts({ sourceRefs: [] }), adapter),
    ).rejects.toMatchObject({ code: "NO_SOURCE_REFS" });
    expect(adapter.auditEvents[0].status).toBe("rejected");
  });

  it("bypasses confidence floors (proposals are drafts)", async () => {
    // 0.3 would be rejected by writeM2 at L2, but accepted by proposeM2
    await proposeM2(projectStateOp, baseOpts({ confidence: 0.3 }), adapter);
    expect(adapter.auditEvents[0].status).toBe("candidate");
  });

  it("emits candidate event regardless of opKind", async () => {
    await proposeM2(
      { kind: "decision", projectId: "p-1", data: {} },
      baseOpts({ jobClassification: "J2_distribution" }),
      adapter,
    );
    expect(adapter.auditEvents[0]).toMatchObject({
      status: "candidate",
      opKind: "decision",
    });
  });
});
