/**
 * T-2.8 — context-card builder + renderer tests.
 */

import { describe, expect, it } from "vitest";
import {
  buildContextCard,
  computeCacheKey,
  getUnansweredQuestions,
  type AuthoritySummary,
  type ContextCardInputs,
  type DecisionSummary,
  type TaskSummary,
} from "../lib/context-card.js";
import { renderContextCardMarkdown } from "../lib/context-card-render.js";
import type {
  Assumption,
  Escalation,
  Hypothesis,
  ProjectControlPlaneState,
  ProjectControlPlaneTelemetry,
  SourceRef,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-21T12:00:00.000Z");

function ref(path: string, hashChar: string): SourceRef {
  return {
    kind: "M1a",
    path,
    hash: hashChar.repeat(64),
    capturedAt: "2026-05-20T10:00:00.000Z",
  };
}
const refPrd = ref("/v/PRD.md", "a");
const refIdeas = ref("/v/ideas.md", "b");

function baseState(overrides: Partial<ProjectControlPlaneState> = {}): ProjectControlPlaneState {
  return {
    portfolioState: "active",
    currentPhase: "validate",
    constraintLane: "customer",
    nextSmallestAction: "Run 5 customer calls",
    blockerSummary: null,
    latestEvidenceChanged: "Pitch reviewed 2026-05-15",
    resumeBrief: null,
    doNotRethink: "Tech stack",
    killCriteria: "No paying user by July",
    lastMeaningfulOutput: null,
    intent: "Validate the distribution channel",
    currentStatus: "2 of 5 calls done",
    sourceRefs: [refPrd],
    confidence: 0.8,
    jobClassificationDominant: "J1_signal",
    ...overrides,
  };
}

function baseInputs(overrides: Partial<ContextCardInputs> = {}): ContextCardInputs {
  return {
    project: {
      id: "p-1",
      name: "Distribution validation",
      controlPlaneState: baseState(),
      controlPlaneUpdatedAt: "2026-05-20T09:00:00.000Z",
    },
    telemetry: null,
    freshness: null,
    decay: null,
    conflicts: null,
    recentDecisions: [],
    activeTasks: [],
    authority: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("buildContextCard — happy path", () => {
  it("produces a card with the § 9.1 fields populated", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.projectId).toBe("p-1");
    expect(card.projectName).toBe("Distribution validation");
    expect(card.portfolioState).toBe("active");
    expect(card.currentPhase).toBe("validate");
    expect(card.goal.answer).toBe("Validate the distribution channel");
    expect(card.currentStatus.answer).toBe("2 of 5 calls done");
    expect(card.nextActions.answer).toBe("Run 5 customer calls");
    expect(card.killCriteria.answer).toBe("No paying user by July");
    expect(card.doNotRethink.answer).toBe("Tech stack");
    expect(card.confidence).toBe(0.8);
  });

  it("attributes the cited sources to grounded answers as 'high' confidence", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.goal.confidence).toBe("high");
    expect(card.goal.sourceRefs.map((r) => r.path)).toEqual(["/v/PRD.md"]);
  });

  it("treats answers without sourceRefs as 'low' confidence", () => {
    const inputs = baseInputs({
      project: {
        id: "p-1",
        name: "x",
        controlPlaneState: { ...baseState(), sourceRefs: [] },
        controlPlaneUpdatedAt: null,
      },
    });
    const card = buildContextCard(inputs, NOW);
    expect(card.goal.confidence).toBe("low");
  });

  it("treats missing answers as 'unknown' with no citations", () => {
    const inputs = baseInputs({
      project: {
        id: "p-1",
        name: "x",
        controlPlaneState: { ...baseState(), intent: null, currentStatus: null },
        controlPlaneUpdatedAt: null,
      },
    });
    const card = buildContextCard(inputs, NOW);
    expect(card.goal.answer).toBeNull();
    expect(card.goal.confidence).toBe("unknown");
  });

  it("collects all unique SourceRefs across nested state", () => {
    const refC = ref("/v/research.md", "c");
    const assumption: Assumption = {
      id: "asm-1",
      statement: "Embedded postgres is fine for solo MVP",
      sourceRefs: [refC],
      confidence: 0.9,
      riskIfWrong: null,
      lastReviewedAt: null,
      status: "accepted",
    };
    const inputs = baseInputs({
      project: {
        id: "p-1",
        name: "x",
        controlPlaneState: {
          ...baseState(),
          assumptions: [assumption],
          memoryIndexRefs: [refIdeas],
        },
        controlPlaneUpdatedAt: null,
      },
    });
    const card = buildContextCard(inputs, NOW);
    const paths = card.sourceRefs.map((r) => r.path).sort();
    expect(paths).toEqual(["/v/PRD.md", "/v/ideas.md", "/v/research.md"]);
  });
});

// ---------------------------------------------------------------------------
// Eight questions
// ---------------------------------------------------------------------------

describe("buildContextCard — eight questions", () => {
  it("answers 'achieve' from intent", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.eightQuestions.achieve.answer).toBe("Validate the distribution channel");
  });

  it("returns null + unknown for 'decisions' when there are no recent decisions", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.eightQuestions.decisions.answer).toBeNull();
    expect(card.eightQuestions.decisions.confidence).toBe("unknown");
  });

  it("synthesizes 'decisions' from recentDecisions with citations", () => {
    const d: DecisionSummary = {
      id: "d-1",
      summary: "Pick distribution channel",
      chosenOption: "warm intro list",
      rationale: "cheapest path to 5 calls",
      decidedBy: "principal",
      createdAt: "2026-05-20T00:00:00.000Z",
      reviewDate: null,
      reversibleUntil: null,
      jobClassification: "J2_distribution",
      sourceRefs: [refPrd],
      supersedes: null,
      outcome: null,
    };
    const card = buildContextCard(baseInputs({ recentDecisions: [d] }), NOW);
    expect(card.eightQuestions.decisions.answer).toContain("Pick distribution channel");
    expect(card.eightQuestions.decisions.answer).toContain("warm intro list");
    expect(card.eightQuestions.decisions.confidence).toBe("high");
  });

  it("synthesizes 'assumptions' from active assumptions only", () => {
    const accepted: Assumption = {
      id: "a-1",
      statement: "TAM is large enough",
      sourceRefs: [refPrd],
      confidence: 0.8,
      riskIfWrong: null,
      lastReviewedAt: null,
      status: "accepted",
    };
    const stale: Assumption = {
      id: "a-2",
      statement: "Old assumption",
      sourceRefs: [],
      confidence: 0.5,
      riskIfWrong: null,
      lastReviewedAt: null,
      status: "stale",
    };
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), assumptions: [accepted, stale] },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    expect(card.activeAssumptions).toHaveLength(1);
    expect(card.eightQuestions.assumptions.answer).toContain("TAM is large enough");
    expect(card.eightQuestions.assumptions.answer).not.toContain("Old assumption");
  });

  it("includes only active hypotheses (status='active')", () => {
    const active: Hypothesis = {
      id: "h-1",
      statement: "Email outreach converts at 20%",
      evidenceFor: [refIdeas],
      evidenceAgainst: [],
      confidence: 0.4,
      testPlan: "5 calls in week 3",
      status: "active",
      reviewDate: null,
    };
    const retired: Hypothesis = {
      id: "h-2",
      statement: "old hyp",
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0.2,
      testPlan: null,
      status: "retired",
      reviewDate: null,
    };
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), hypotheses: [active, retired] },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    expect(card.activeHypotheses).toHaveLength(1);
    expect(card.activeHypotheses[0].id).toBe("h-1");
  });

  it("'blocked' surfaces blockerSummary when present", () => {
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), blockerSummary: "Waiting on legal" },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    expect(card.eightQuestions.blocked.answer).toBe("Waiting on legal");
  });

  it("'changed' includes latestEvidenceChanged + telemetry + stale marker count", () => {
    const telemetry: ProjectControlPlaneTelemetry = {
      lastTouchedAt: null,
      lastActivityAt: "2026-05-19T00:00:00.000Z",
      issueCounts: { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
      laneIssueCounts: {
        product: { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
        customer: { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
        distribution: { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
      },
      latestArtifact: null,
      repoSnapshot: null,
      runHealth: { status: "ok", lastRunAt: null, lastRunOutcome: "unknown" },
      budgetHealth: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      staleStatus: "fresh",
      staleReason: null,
      attentionScore: 0,
      refreshedAt: NOW.toISOString(),
    };
    const card = buildContextCard(baseInputs({ telemetry }), NOW);
    expect(card.eightQuestions.changed.answer).toContain("Pitch reviewed");
    expect(card.eightQuestions.changed.answer).toContain("Last activity");
  });

  it("'safeNext' returns nextActions for clean state", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.eightQuestions.safeNext.answer).toBe("Run 5 customer calls");
  });

  it("'safeNext' warns when a conflicted field is present", () => {
    const card = buildContextCard(
      baseInputs({
        conflicts: {
          projectId: "p-1",
          updatedAt: NOW.toISOString(),
          byField: {
            currentStatus: {
              fieldPath: "currentStatus",
              createdAt: NOW.toISOString(),
              resolvedAt: null,
              resolvedBy: null,
              candidates: [],
            },
          },
        },
      }),
      NOW,
    );
    expect(card.eightQuestions.safeNext.answer).toContain("Quarantined");
    expect(card.eightQuestions.safeNext.confidence).toBe("high");
  });

  it("'safeNext' falls back to low-confidence prompt when nextAction missing", () => {
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), nextSmallestAction: null },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    expect(card.eightQuestions.safeNext.answer).toContain("smaller-than-12-words");
    expect(card.eightQuestions.safeNext.confidence).toBe("low");
  });

  it("'requiresApproval' lists open escalations", () => {
    const e: Escalation = {
      id: "e-1",
      trigger: "Conflict on currentStatus",
      question: "Which candidate value should we accept?",
      recommendedDecision: "candidate-A",
      options: [],
      risk: null,
      requiredBy: null,
      sourceRefs: [refPrd],
      status: "open",
    };
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), escalations: [e] },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    expect(card.eightQuestions.requiresApproval.answer).toContain(
      "Which candidate value should we accept?",
    );
  });

  it("'requiresApproval' returns default text when nothing pending", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.eightQuestions.requiresApproval.answer).toContain("Nothing currently pending");
  });

  it("unansweredQuestions surfaces all unknown answers", () => {
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: {
            ...baseState(),
            intent: null,
            currentStatus: null,
            blockerSummary: null,
            nextSmallestAction: null,
            latestEvidenceChanged: null,
          },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    const unanswered = getUnansweredQuestions(card);
    expect(unanswered).toContain("achieve");
    expect(unanswered).toContain("status");
    expect(unanswered).toContain("decisions");
    expect(unanswered).toContain("changed");
  });
});

// ---------------------------------------------------------------------------
// Stale markers + warnings
// ---------------------------------------------------------------------------

describe("buildContextCard — stale markers + warnings", () => {
  it("produces drift markers from freshness overlay", () => {
    const card = buildContextCard(
      baseInputs({
        freshness: {
          projectId: "p-1",
          generatedAt: NOW.toISOString(),
          totalRefs: 2,
          freshCount: 0,
          staleCount: 1,
          orphanedCount: 1,
          hasDrift: true,
          drifts: [
            { path: "/v/PRD.md", kind: "stale", expectedHash: "old", currentHash: "new" },
            { path: "/v/gone.md", kind: "orphaned", expectedHash: "old" },
          ],
        },
      }),
      NOW,
    );
    expect(card.staleMarkers.map((m) => m.kind).sort()).toEqual(["drift", "orphan"]);
    expect(card.warnings.some((w) => w.includes("drifted or orphaned"))).toBe(true);
  });

  it("produces a decay marker when project is decayed", () => {
    const card = buildContextCard(
      baseInputs({
        decay: {
          projectId: "p-1",
          generatedAt: NOW.toISOString(),
          decayed: true,
          daysSinceLastTouch: 45,
          thresholdDays: 30,
          lastTouchedPath: "/v/PRD.md",
        },
      }),
      NOW,
    );
    expect(card.staleMarkers.some((m) => m.kind === "decay")).toBe(true);
    expect(card.warnings.some((w) => w.includes("re-grounding"))).toBe(true);
  });

  it("produces conflict markers from conflicts overlay", () => {
    const card = buildContextCard(
      baseInputs({
        conflicts: {
          projectId: "p-1",
          updatedAt: NOW.toISOString(),
          byField: {
            currentStatus: {
              fieldPath: "currentStatus",
              createdAt: NOW.toISOString(),
              resolvedAt: null,
              resolvedBy: null,
              candidates: [],
            },
          },
        },
      }),
      NOW,
    );
    expect(card.staleMarkers.some((m) => m.kind === "conflict")).toBe(true);
    expect(card.warnings.some((w) => w.includes("in conflict"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

describe("computeCacheKey", () => {
  it("returns the same key for identical inputs", () => {
    expect(computeCacheKey(baseInputs())).toBe(computeCacheKey(baseInputs()));
  });

  it("returns the same key regardless of property order", () => {
    const inputs1 = baseInputs();
    // Reconstruct with different key order
    const inputs2: ContextCardInputs = {
      authority: inputs1.authority,
      activeTasks: inputs1.activeTasks,
      recentDecisions: inputs1.recentDecisions,
      conflicts: inputs1.conflicts,
      decay: inputs1.decay,
      freshness: inputs1.freshness,
      telemetry: inputs1.telemetry,
      project: inputs1.project,
    };
    expect(computeCacheKey(inputs1)).toBe(computeCacheKey(inputs2));
  });

  it("changes when any underlying field changes", () => {
    const a = computeCacheKey(baseInputs());
    const b = computeCacheKey(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), intent: "different" },
          controlPlaneUpdatedAt: null,
        },
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when freshness overlay changes", () => {
    const a = computeCacheKey(baseInputs());
    const b = computeCacheKey(
      baseInputs({
        freshness: {
          projectId: "p-1",
          generatedAt: NOW.toISOString(),
          totalRefs: 1,
          freshCount: 1,
          staleCount: 0,
          orphanedCount: 0,
          hasDrift: false,
          drifts: [],
        },
      }),
    );
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

describe("renderContextCardMarkdown", () => {
  it("renders all top sections", () => {
    const card = buildContextCard(baseInputs(), NOW);
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("# Context Card — Distribution validation");
    expect(md).toContain("## State");
    expect(md).toContain("## Goal");
    expect(md).toContain("## Eight Questions");
  });

  it("includes the eight-questions block with all 8 labels", () => {
    const card = buildContextCard(baseInputs(), NOW);
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("What is this project trying to achieve?");
    expect(md).toContain("What is the current status?");
    expect(md).toContain("What decisions have already been made?");
    expect(md).toContain("What assumptions are we operating under?");
    expect(md).toContain("What is blocked?");
    expect(md).toContain("What changed recently?");
    expect(md).toContain("What can I safely do next?");
    expect(md).toContain("What requires human approval?");
  });

  it("renders citations inline with grounded answers", () => {
    const card = buildContextCard(baseInputs(), NOW);
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("/v/PRD.md");
  });

  it("renders authority grants when present", () => {
    const grant: AuthoritySummary = {
      agentId: "agent-1234567890",
      actionClass: "state",
      ceiling: "L2",
      expiresAt: "2026-06-30T00:00:00.000Z",
      revoked: false,
    };
    const card = buildContextCard(baseInputs({ authority: [grant] }), NOW);
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("## Authority Grants");
    expect(md).toContain("agent-12");
    expect(md).toContain("L2");
  });

  it("surfaces unanswered list at the bottom", () => {
    const card = buildContextCard(
      baseInputs({
        project: {
          id: "p-1",
          name: "x",
          controlPlaneState: { ...baseState(), intent: null, currentStatus: null },
          controlPlaneUpdatedAt: null,
        },
      }),
      NOW,
    );
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("🟡 unanswered:");
  });

  it("warnings block appears at the top when there are warnings", () => {
    const card = buildContextCard(
      baseInputs({
        conflicts: {
          projectId: "p-1",
          updatedAt: NOW.toISOString(),
          byField: {
            currentStatus: {
              fieldPath: "currentStatus",
              createdAt: NOW.toISOString(),
              resolvedAt: null,
              resolvedBy: null,
              candidates: [],
            },
          },
        },
      }),
      NOW,
    );
    const md = renderContextCardMarkdown(card);
    const warningsIdx = md.indexOf("## ⚠ Warnings");
    const stateIdx = md.indexOf("## State");
    expect(warningsIdx).toBeGreaterThanOrEqual(0);
    expect(warningsIdx).toBeLessThan(stateIdx);
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe("activeTasks pass-through", () => {
  it("includes activeTasks in the card and renders them", () => {
    const t: TaskSummary = {
      id: "t-1",
      title: "Email cohort A",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: "principal",
      whyItMatters: "Drives the conversion experiment",
      requiredAuthority: null,
    };
    const card = buildContextCard(baseInputs({ activeTasks: [t] }), NOW);
    expect(card.activeTasks).toHaveLength(1);
    const md = renderContextCardMarkdown(card);
    expect(md).toContain("Email cohort A");
    expect(md).toContain("user:principal");
  });
});

describe("buildContextCard — T-2.10 grounding (associatedNoteRefs)", () => {
  it("grounds nextActions in associated M1a notes, upgrading low->high when M2 had no refs", () => {
    const inputs = baseInputs({
      project: {
        id: "p-1",
        name: "x",
        controlPlaneState: { ...baseState(), sourceRefs: [] },
        controlPlaneUpdatedAt: null,
      },
      associatedNoteRefs: [ref("/v/notes/research.md", "c"), ref("/v/notes/cohort.md", "d")],
    });
    const card = buildContextCard(inputs, NOW);
    expect(card.nextActions.confidence).toBe("high");
    expect(card.nextActions.sourceRefs.map((r) => r.path)).toEqual([
      "/v/notes/cohort.md",
      "/v/notes/research.md",
    ]);
  });

  it("merges M2 sourceRefs with associatedNoteRefs, deduped by path and sorted", () => {
    const inputs = baseInputs({
      associatedNoteRefs: [ref("/v/zzz.md", "z"), ref("/v/PRD.md", "a")], // PRD.md dupes state.sourceRefs
    });
    const card = buildContextCard(inputs, NOW);
    expect(card.nextActions.sourceRefs.map((r) => r.path)).toEqual(["/v/PRD.md", "/v/zzz.md"]);
  });

  it("includes associatedNoteRefs in the card-level sourceRefs", () => {
    const inputs = baseInputs({ associatedNoteRefs: [ref("/v/notes/extra.md", "e")] });
    const card = buildContextCard(inputs, NOW);
    expect(card.sourceRefs.map((r) => r.path)).toContain("/v/notes/extra.md");
  });

  it("is deterministic: same associatedNoteRefs in any input order yield the same nextActions.sourceRefs", () => {
    const a = buildContextCard(
      baseInputs({ associatedNoteRefs: [ref("/v/a.md", "1"), ref("/v/b.md", "2")] }),
      NOW,
    );
    const b = buildContextCard(
      baseInputs({ associatedNoteRefs: [ref("/v/b.md", "2"), ref("/v/a.md", "1")] }),
      NOW,
    );
    expect(a.nextActions.sourceRefs.map((r) => r.path)).toEqual(
      b.nextActions.sourceRefs.map((r) => r.path),
    );
  });

  it("omits associatedNoteRefs gracefully (back-compat): no field -> behaves as before", () => {
    const card = buildContextCard(baseInputs(), NOW);
    expect(card.nextActions.sourceRefs.map((r) => r.path)).toEqual(["/v/PRD.md"]);
  });
});
