import { describe, it, expect } from "vitest";
import {
  projectControlPlaneStateSchema,
  updateProjectControlPlaneSchema,
} from "../validators/control-plane.js";

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
