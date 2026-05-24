/**
 * T-3.1 — briefer worker tests.
 *
 * Two layers:
 *   1. Authority guard: `assertBrieferL1` throws on L2+, the BrieferDeps
 *      interface structurally excludes writeM2.
 *   2. runBriefer happy path: produces a non-empty brief, populates
 *      structural sections from input context cards, handles model
 *      failure gracefully.
 */

import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  BRIEFER_ACTOR,
  BRIEFER_DEFAULT_MODEL,
  runBriefer,
} from "../lib/briefer/briefer.js";
import {
  BrieferAuthorityViolation,
  assertBrieferL1,
  type Brief,
  type BrieferDeps,
  type BrieferProjectInput,
} from "../lib/briefer/types.js";
import { buildContextCard, type ContextCard } from "../lib/context-card.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-22T08:00:00.000Z");

function makeCard(
  projectId: string,
  overrides: { state?: Partial<ContextCard>; cpsPatch?: Record<string, unknown> } = {},
): ContextCard {
  const base = buildContextCard(
    {
      project: {
        id: projectId,
        name: `Project ${projectId}`,
        controlPlaneState: {
          portfolioState: "active",
          currentPhase: "validate",
          constraintLane: "customer",
          nextSmallestAction: `Next for ${projectId}`,
          blockerSummary: null,
          latestEvidenceChanged: null,
          resumeBrief: null,
          doNotRethink: null,
          killCriteria: null,
          lastMeaningfulOutput: null,
          intent: `Intent of ${projectId}`,
          currentStatus: null,
          ...overrides.cpsPatch,
        },
        controlPlaneUpdatedAt: null,
      },
      telemetry: null,
      freshness: null,
      decay: null,
      conflicts: null,
      recentDecisions: [],
      activeTasks: [],
      authority: [],
    },
    NOW,
  );
  return { ...base, ...overrides.state };
}

function projectInput(projectId: string, cardOverride?: Partial<ContextCard>): BrieferProjectInput {
  return {
    projectId,
    projectName: `Project ${projectId}`,
    card: cardOverride ? { ...makeCard(projectId), ...cardOverride } : makeCard(projectId),
  };
}

interface MockState {
  projects: BrieferProjectInput[];
  episodic: string | null;
  brief: Brief | null;
  modelResponses: string[]; // FIFO queue; if empty, default
  modelThrows: boolean;
  proposeCalls: unknown[];
}

function makeDeps(state: MockState): BrieferDeps {
  return {
    async listActiveProjectCards() {
      return state.projects;
    },
    async readEpisodicSinceLastBrief() {
      return state.episodic;
    },
    async proposeM2(args) {
      // Enforce the L1 ceiling on this surface.
      const level = args.requiredAuthority ?? "L1";
      assertBrieferL1(level, "proposeM2");
      state.proposeCalls.push(args);
    },
    async saveBrief(brief) {
      state.brief = brief;
      return { id: "brief-1" };
    },
    async callModel(_args) {
      if (state.modelThrows) throw new Error("model unavailable");
      const text = state.modelResponses.shift() ?? "synthesized summary";
      return { text, sessionId: null };
    },
  };
}

let state: MockState;
beforeEach(() => {
  state = {
    projects: [],
    episodic: null,
    brief: null,
    modelResponses: [],
    modelThrows: false,
    proposeCalls: [],
  };
});

// ---------------------------------------------------------------------------
// 1. Authority guard
// ---------------------------------------------------------------------------

describe("assertBrieferL1", () => {
  it("accepts L0", () => {
    expect(() => assertBrieferL1("L0", "test")).not.toThrow();
  });
  it("accepts L1", () => {
    expect(() => assertBrieferL1("L1", "test")).not.toThrow();
  });
  it("throws BrieferAuthorityViolation on L2", () => {
    expect(() => assertBrieferL1("L2", "writeM2")).toThrow(BrieferAuthorityViolation);
  });
  it("throws on L3", () => {
    expect(() => assertBrieferL1("L3", "writeM2")).toThrow(BrieferAuthorityViolation);
  });
  it("throws on L4 and L5", () => {
    expect(() => assertBrieferL1("L4", "writeM2")).toThrow(BrieferAuthorityViolation);
    expect(() => assertBrieferL1("L5", "writeM2")).toThrow(BrieferAuthorityViolation);
  });
  it("error message names the attempted level + the context", () => {
    try {
      assertBrieferL1("L3", "decision-write");
    } catch (e) {
      expect(e).toBeInstanceOf(BrieferAuthorityViolation);
      expect((e as Error).message).toContain("L3");
      expect((e as Error).message).toContain("decision-write");
    }
  });
});

describe("BrieferDeps interface — structural authority enforcement", () => {
  it("does NOT include writeM2 in its surface", () => {
    // TS-level check: the BrieferDeps type doesn't have writeM2.
    type HasWriteM2 = "writeM2" extends keyof BrieferDeps ? true : false;
    expectTypeOf<HasWriteM2>().toEqualTypeOf<false>();
  });

  it("does NOT include writeM2Guarded in its surface", () => {
    type HasGuarded = "writeM2Guarded" extends keyof BrieferDeps ? true : false;
    expectTypeOf<HasGuarded>().toEqualTypeOf<false>();
  });

  it("proposeM2 rejects L2 attempts at runtime even via the deps surface", async () => {
    const deps = makeDeps(state);
    await expect(
      deps.proposeM2({
        kind: "projectState",
        projectId: "p-1",
        patch: { currentStatus: "anything" },
        sourceRefs: [
          { kind: "M1a", path: "/v/x.md", hash: "a".repeat(64), capturedAt: NOW.toISOString() },
        ],
        confidence: 0.9,
        actor: BRIEFER_ACTOR,
        jobClassification: "meta",
        requiredAuthority: "L2",
      }),
    ).rejects.toThrow(BrieferAuthorityViolation);
  });
});

// ---------------------------------------------------------------------------
// 2. runBriefer happy path + section population
// ---------------------------------------------------------------------------

describe("runBriefer — happy path", () => {
  it("produces a non-empty brief with all required sections present", async () => {
    state.projects = [projectInput("p-1"), projectInput("p-2")];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.generatedAt).toBe(NOW.toISOString());
    expect(brief.briefDate).toBe("2026-05-22");
    expect(brief.portfolioSummary.answer).toBeTruthy();
    expect(brief.inputsCacheKey).toMatch(/^[a-f0-9]{64}$/);
    // Saved
    expect(state.brief).toEqual(brief);
  });

  it("returns 'No active projects' when projects list is empty", async () => {
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.portfolioSummary.answer).toContain("No active projects");
    expect(brief.recommendedFocus).toBeNull();
    expect(brief.highLeverageActions).toEqual([]);
  });

  it("computes blockedProjects from controlPlaneState.portfolioState", async () => {
    state.projects = [
      projectInput("p-1", makeCard("p-1", { cpsPatch: { portfolioState: "blocked", blockerSummary: "waiting on legal" } })),
      projectInput("p-2"),
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.blockedProjects).toHaveLength(1);
    expect(brief.blockedProjects[0]).toMatchObject({
      projectId: "p-1",
      blockerSummary: "waiting on legal",
    });
  });

  it("rolls up stale markers into staleConflictedMemory by kind", async () => {
    const cardA = makeCard("p-1");
    cardA.staleMarkers = [
      { kind: "drift", target: "/v/PRD.md" },
      { kind: "orphan", target: "/v/gone.md" },
      { kind: "decay", target: "/v/PRD.md" }, // ignored in rollup
    ];
    const cardB = makeCard("p-2");
    cardB.staleMarkers = [{ kind: "conflict", target: "currentStatus" }];

    state.projects = [
      { projectId: "p-1", projectName: "P1", card: cardA },
      { projectId: "p-2", projectName: "P2", card: cardB },
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });

    const kinds = brief.staleConflictedMemory.map((r) => r.kind).sort();
    expect(kinds).toEqual(["conflict", "orphaned", "stale_pending_re_grounding"]);
    const drift = brief.staleConflictedMemory.find((r) => r.kind === "stale_pending_re_grounding");
    expect(drift?.projectIds).toContain("p-1");
  });

  it("flattens escalations across projects", async () => {
    const card = makeCard("p-1");
    state.projects = [
      {
        projectId: "p-1",
        projectName: "P1",
        card: {
          ...card,
          openEscalations: [
            {
              id: "e-1",
              trigger: "currentStatus",
              question: "candidate A or B?",
              recommendedDecision: "A",
              options: [],
              risk: null,
              requiredBy: null,
              sourceRefs: [],
              status: "open",
            },
          ],
        },
      },
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.escalations).toEqual([
      { projectId: "p-1", question: "candidate A or B?", recommendedDecision: "A" },
    ]);
  });

  it("picks recommendedFocus as the first primary project with a nextAction", async () => {
    state.projects = [
      projectInput("p-active", makeCard("p-active", { cpsPatch: { portfolioState: "active" } })),
      projectInput("p-primary", makeCard("p-primary", { cpsPatch: { portfolioState: "primary" } })),
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.recommendedFocus?.projectId).toBe("p-primary");
  });

  it("falls back to first active when no primary exists", async () => {
    state.projects = [projectInput("p-1")];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.recommendedFocus?.projectId).toBe("p-1");
  });

  it("surfaces a doNotRethink alert when nextAction overlaps (T-3.5 Jaccard ≥ 0.4)", async () => {
    state.projects = [
      projectInput("p-1", makeCard("p-1", {
        cpsPatch: {
          // Tight token overlap clears the 0.4 Jaccard threshold T-3.5 enforces.
          doNotRethink: "Settled: postgres database choice.",
          nextSmallestAction: "Reconsider postgres database choice sqlite.",
        },
      })),
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.doNotRethinkAlerts).toHaveLength(1);
    expect(brief.doNotRethinkAlerts[0].projectId).toBe("p-1");
  });

  it("collects per-project warnings into brief.warnings", async () => {
    const card = makeCard("p-1");
    state.projects = [
      {
        projectId: "p-1",
        projectName: "P1",
        card: { ...card, warnings: ["something is stale"] },
      },
    ];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.warnings).toContain("something is stale");
  });
});

// ---------------------------------------------------------------------------
// 3. Model handling + fallback
// ---------------------------------------------------------------------------

describe("runBriefer — model handling", () => {
  it("uses the synthesized model response when available", async () => {
    state.projects = [projectInput("p-1")];
    state.modelResponses = ["a sharp two-sentence portfolio summary"];
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.portfolioSummary.answer).toBe("a sharp two-sentence portfolio summary");
  });

  it("falls back to offline summary when the model throws", async () => {
    state.projects = [projectInput("p-1")];
    state.modelThrows = true;
    const brief = await runBriefer(makeDeps(state), { now: NOW });
    expect(brief.portfolioSummary.answer).toContain("offline mode");
  });

  it("uses the default model id by default", async () => {
    state.projects = [projectInput("p-1")];
    let calledWith: string | null = null;
    const deps: BrieferDeps = {
      ...makeDeps(state),
      async callModel(args) {
        calledWith = args.modelId;
        return { text: "ok", sessionId: null };
      },
    };
    await runBriefer(deps, { now: NOW });
    expect(calledWith).toBe(BRIEFER_DEFAULT_MODEL);
  });

  it("skipModel=true skips the model entirely", async () => {
    state.projects = [projectInput("p-1")];
    let called = false;
    const deps: BrieferDeps = {
      ...makeDeps(state),
      async callModel() {
        called = true;
        return { text: null, sessionId: null };
      },
    };
    const brief = await runBriefer(deps, { now: NOW, skipModel: true });
    expect(called).toBe(false);
    expect(brief.portfolioSummary.answer).toContain("offline mode");
  });
});

// ---------------------------------------------------------------------------
// 4. inputsCacheKey stability
// ---------------------------------------------------------------------------

describe("runBriefer — inputsCacheKey", () => {
  it("returns the same key for the same inputs on the same day", async () => {
    state.projects = [projectInput("p-1")];
    const b1 = await runBriefer(makeDeps(state), { now: NOW, skipModel: true });
    const b2 = await runBriefer(makeDeps(state), { now: NOW, skipModel: true });
    expect(b1.inputsCacheKey).toBe(b2.inputsCacheKey);
  });

  it("returns different keys when the underlying card changes", async () => {
    state.projects = [projectInput("p-1")];
    const a = await runBriefer(makeDeps(state), { now: NOW, skipModel: true });
    state.projects = [projectInput("p-1", makeCard("p-1", { cpsPatch: { nextSmallestAction: "different" } }))];
    const b = await runBriefer(makeDeps(state), { now: NOW, skipModel: true });
    expect(a.inputsCacheKey).not.toBe(b.inputsCacheKey);
  });

  it("returns different keys on a different brief date", async () => {
    state.projects = [projectInput("p-1")];
    const a = await runBriefer(makeDeps(state), { now: NOW, skipModel: true });
    const b = await runBriefer(makeDeps(state), {
      now: new Date("2026-05-23T08:00:00.000Z"),
      skipModel: true,
    });
    expect(a.inputsCacheKey).not.toBe(b.inputsCacheKey);
  });
});
