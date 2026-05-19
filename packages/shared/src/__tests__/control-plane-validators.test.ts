import { describe, it, expect } from "vitest";
import {
  projectControlPlaneStateSchema,
  updateProjectControlPlaneSchema,
  hypothesisSchema,
  assumptionSchema,
  escalationSchema,
  jobClassificationSchema,
} from "../validators/control-plane.js";
import { sourceRefSchema } from "../validators/source-ref.js";

const validFullState = {
  portfolioState: "primary",
  currentPhase: "exploration",
  constraintLane: "product",
  nextSmallestAction: "Ship landing page",
  blockerSummary: null,
  latestEvidenceChanged: "User interviewed 2026-03-28",
  resumeBrief: "Focus on conversion",
  doNotRethink: "The tech stack",
  killCriteria: "No paying user by April",
  lastMeaningfulOutput: {
    kind: "issue",
    id: "abc-123",
    title: "Landing page draft",
    url: null,
  },
} as const;

const validNullState = {
  portfolioState: "parked",
  currentPhase: "exploration",
  constraintLane: null,
  nextSmallestAction: null,
  blockerSummary: null,
  latestEvidenceChanged: null,
  resumeBrief: null,
  doNotRethink: null,
  killCriteria: null,
  lastMeaningfulOutput: null,
} as const;

describe("projectControlPlaneStateSchema", () => {
  it("accepts a fully-populated state", () => {
    const result = projectControlPlaneStateSchema.parse(validFullState);
    expect(result.portfolioState).toBe("primary");
    expect(result.constraintLane).toBe("product");
    expect(result.lastMeaningfulOutput?.kind).toBe("issue");
  });

  it("accepts all-null optional fields", () => {
    const result = projectControlPlaneStateSchema.parse(validNullState);
    expect(result.portfolioState).toBe("parked");
    expect(result.constraintLane).toBeNull();
  });

  it("rejects unknown portfolioState values", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({ ...validNullState, portfolioState: "zombie" }),
    ).toThrow();
  });

  it("rejects unknown currentPhase values", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({ ...validNullState, currentPhase: "growth" }),
    ).toThrow();
  });
});

describe("updateProjectControlPlaneSchema (patch)", () => {
  it("accepts partial updates", () => {
    const result = updateProjectControlPlaneSchema.parse({
      portfolioState: "blocked",
      blockerSummary: "Waiting for legal review",
    });
    expect(result.portfolioState).toBe("blocked");
    expect(result.nextSmallestAction).toBeUndefined();
  });

  it("accepts empty patch", () => {
    const result = updateProjectControlPlaneSchema.parse({});
    expect(result).toEqual({});
  });

  it("strips unknown keys (attentionScore is a derived telemetry field, not canonical)", () => {
    const result = updateProjectControlPlaneSchema.parse({
      portfolioState: "active",
      attentionScore: 999,
    } as any);
    expect((result as any).attentionScore).toBeUndefined();
  });
});

// --- T-1.3 additions ----------------------------------------------------------

const validSourceRef = {
  kind: "M1b",
  path: "Obsidian/My World Optics.md",
  section: "§ Job 1 boundary rule",
  hash: "a".repeat(64),
  capturedAt: "2026-05-19T10:00:00.000Z",
} as const;

describe("sourceRefSchema (T-1.3)", () => {
  it("accepts a well-formed SourceRef", () => {
    const result = sourceRefSchema.parse(validSourceRef);
    expect(result.kind).toBe("M1b");
    expect(result.hash).toHaveLength(64);
  });

  it("accepts a SourceRef without optional section", () => {
    const { section: _section, ...rest } = validSourceRef;
    const result = sourceRefSchema.parse(rest);
    expect(result.section).toBeUndefined();
  });

  it("rejects a SourceRef with a non-hex hash", () => {
    expect(() =>
      sourceRefSchema.parse({ ...validSourceRef, hash: "not-a-hash" }),
    ).toThrow();
  });

  it("rejects a SourceRef with a short hash", () => {
    expect(() =>
      sourceRefSchema.parse({ ...validSourceRef, hash: "a".repeat(40) }),
    ).toThrow();
  });

  it("rejects a SourceRef with an unknown kind", () => {
    expect(() =>
      sourceRefSchema.parse({ ...validSourceRef, kind: "M99" }),
    ).toThrow();
  });

  it("rejects a SourceRef with a non-ISO capturedAt", () => {
    expect(() =>
      sourceRefSchema.parse({ ...validSourceRef, capturedAt: "yesterday" }),
    ).toThrow();
  });
});

describe("hypothesisSchema (T-1.3)", () => {
  const validHypothesis = {
    id: "hyp-1",
    statement: "Users will pay $20/mo for the steward",
    evidenceFor: [validSourceRef],
    evidenceAgainst: [],
    confidence: 0.4,
    testPlan: "Run 5 customer-discovery calls in week 3",
    status: "active",
    reviewDate: "2026-06-01T00:00:00.000Z",
  } as const;

  it("accepts a valid hypothesis", () => {
    const result = hypothesisSchema.parse(validHypothesis);
    expect(result.confidence).toBe(0.4);
    expect(result.evidenceFor).toHaveLength(1);
  });

  it("rejects confidence outside 0..1", () => {
    expect(() =>
      hypothesisSchema.parse({ ...validHypothesis, confidence: 1.5 }),
    ).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      hypothesisSchema.parse({ ...validHypothesis, status: "maybe" }),
    ).toThrow();
  });
});

describe("assumptionSchema (T-1.3)", () => {
  const valid = {
    id: "asm-1",
    statement: "Embedded Postgres is fine for solo MVP",
    sourceRefs: [validSourceRef],
    confidence: 0.9,
    riskIfWrong: "Need to migrate to managed pg later",
    lastReviewedAt: "2026-05-19T00:00:00.000Z",
    status: "accepted",
  } as const;

  it("accepts a valid assumption", () => {
    const result = assumptionSchema.parse(valid);
    expect(result.status).toBe("accepted");
  });

  it("rejects when sourceRefs is missing (provenance enforcement)", () => {
    const { sourceRefs: _s, ...rest } = valid;
    expect(() => assumptionSchema.parse(rest)).toThrow();
  });
});

describe("escalationSchema (T-1.3)", () => {
  it("accepts a valid escalation", () => {
    const result = escalationSchema.parse({
      id: "esc-1",
      trigger: "Schema migration introduces breaking enum",
      question: "Rename in-place or keep aliases?",
      recommendedDecision: "Keep aliases for back-compat",
      options: [
        { label: "Rename in-place", tradeoffs: "Breaks existing rows" },
        { label: "Keep aliases", tradeoffs: "Schema carries dead enum values" },
      ],
      risk: "Data loss if wrong",
      requiredBy: "2026-05-20T00:00:00.000Z",
      sourceRefs: [validSourceRef],
      status: "open",
    });
    expect(result.options).toHaveLength(2);
  });
});

describe("projectControlPlaneStateSchema — v1 back-compat (T-1.3)", () => {
  const v1Row = {
    portfolioState: "primary",
    currentPhase: "exploration", // deprecated alias kept for back-compat
    constraintLane: "product",
    nextSmallestAction: "Ship landing page",
    blockerSummary: null,
    latestEvidenceChanged: "User interviewed 2026-03-28",
    resumeBrief: "Focus on conversion",
    doNotRethink: "The tech stack",
    killCriteria: "No paying user by April",
    lastMeaningfulOutput: {
      kind: "issue",
      id: "abc-123",
      title: "Landing page draft",
      url: null,
    },
  } as const;

  it("still accepts a v1 row written before T-1.3", () => {
    const result = projectControlPlaneStateSchema.parse(v1Row);
    expect(result.currentPhase).toBe("exploration");
    expect(result.intent).toBeUndefined();
  });

  it("accepts a v2 row with new PRD-spec phase value", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Row,
      currentPhase: "search",
    });
    expect(result.currentPhase).toBe("search");
  });

  it("accepts a v2 row with new constraint-lane values", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Row,
      constraintLane: "ops",
    });
    expect(result.constraintLane).toBe("ops");
  });
});

describe("projectControlPlaneStateSchema — v2 fields (T-1.3)", () => {
  const v1Base = {
    portfolioState: "active",
    currentPhase: "search",
    constraintLane: null,
    nextSmallestAction: null,
    blockerSummary: null,
    latestEvidenceChanged: null,
    resumeBrief: null,
    doNotRethink: null,
    killCriteria: null,
    lastMeaningfulOutput: null,
  } as const;

  it("accepts intent + currentStatus + jobClassificationDominant", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Base,
      intent: "Validate distribution channel by month-end",
      currentStatus: "Mid-validation, 2 of 5 calls done",
      jobClassificationDominant: "J1_signal",
    });
    expect(result.jobClassificationDominant).toBe("J1_signal");
  });

  it("accepts arrays of hypotheses, assumptions, escalations", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Base,
      assumptions: [],
      hypotheses: [],
      escalations: [],
      openLoops: [],
    });
    expect(result.assumptions).toEqual([]);
  });

  it("accepts decisionRefs as array of uuids", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Base,
      decisionRefs: ["550e8400-e29b-41d4-a716-446655440000"],
    });
    expect(result.decisionRefs).toHaveLength(1);
  });

  it("rejects decisionRefs that aren't uuids", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({
        ...v1Base,
        decisionRefs: ["not-a-uuid"],
      }),
    ).toThrow();
  });

  it("rejects confidence outside 0..1", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({ ...v1Base, confidence: 1.5 }),
    ).toThrow();
  });

  it("accepts voiceSensitive boolean", () => {
    const result = projectControlPlaneStateSchema.parse({
      ...v1Base,
      voiceSensitive: true,
    });
    expect(result.voiceSensitive).toBe(true);
  });
});

describe("jobClassificationSchema (T-1.3)", () => {
  it("accepts the four PRD values", () => {
    for (const v of ["J1_signal", "J2_distribution", "J3_product", "meta"] as const) {
      expect(jobClassificationSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown values", () => {
    expect(() => jobClassificationSchema.parse("J4_marketing")).toThrow();
  });
});
