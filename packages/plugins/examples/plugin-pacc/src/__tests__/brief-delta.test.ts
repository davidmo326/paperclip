/**
 * T-6.3 delta-only brief tests — noise discipline (grill Q12, 2026-08-16).
 *
 * Verifies: quiet projects (card + aging unchanged, no escalations, not the
 * lead) contribute NOTHING to per-project sections; escalations survive
 * (self-extinguishing); the lead repeats with an "unchanged since" marker;
 * aging crossings fire once on the day; first-ever brief renders everything.
 */

import { describe, expect, it } from "vitest";
import { runBriefer } from "../lib/briefer/briefer.js";
import { extractBriefDelta } from "../lib/briefer/worker-deps.js";
import type { Brief, BriefDeltaRecord } from "../lib/briefer/types.js";
import type { BrieferDeps, BrieferProjectInput } from "../lib/briefer/types.js";
import { buildContextCard, type ContextCardInputs } from "../lib/context-card.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeProject {
  id: string;
  name: string;
  cacheKey: string;
  staleStatus?: string | null;
  escalationQuestion?: string;
  nextAction?: string | null;
}

function cardFor(p: FakeProject): ContextCardInputs["project"] & Record<string, unknown> {
  // Minimal project shape buildContextCard accepts; cacheKey overridden below.
  return {
    id: p.id,
    name: p.name,
    controlPlaneState: null,
    controlPlaneUpdatedAt: null,
  };
}

function makeInputs(p: FakeProject): BrieferProjectInput {
  const inputs: ContextCardInputs = {
    project: cardFor(p) as never,
    telemetry: p.staleStatus ? ({ staleStatus: p.staleStatus } as never) : null,
    freshness: null,
    decay: null,
    conflicts: null,
    recentDecisions: [],
    activeTasks: [],
    authority: [],
    associatedNoteRefs: [],
  };
  const card = buildContextCard(inputs);
  // Test hook: force the card's cacheKey so "unchanged" is controllable.
  (card as { cacheKey: string }).cacheKey = p.cacheKey;
  if (p.escalationQuestion) {
    (card as { openEscalations: unknown[] }).openEscalations = [
      { question: p.escalationQuestion, recommendedDecision: null },
    ];
  }
  if (p.nextAction !== undefined) {
    (card as { nextActions: { answer: string | null; sourceRefs: unknown[] } }).nextActions = {
      answer: p.nextAction,
      sourceRefs: [],
    };
  }
  return { projectId: p.id, projectName: p.name, card };
}

function makeDeps(projects: BrieferProjectInput[], lastDelta: BriefDeltaRecord | null): BrieferDeps {
  return {
    listActiveProjectCards: async () => projects,
    readLastBriefDelta: async () => lastDelta,
    proposeM2: async () => {},
    saveBrief: async () => ({ id: "test" }),
    callModel: async () => ({ text: null, sessionId: null }),
  };
}

// A hypothesis with a test plan so the project can carry the lead question.
function withHypothesis(input: BrieferProjectInput, statement: string): BrieferProjectInput {
  (input.card as { activeHypotheses: unknown[] }).activeHypotheses = [
    {
      id: "h1",
      statement,
      evidenceFor: [],
      evidenceAgainst: [],
      confidence: 0.4,
      testPlan: `test: ${statement}`,
      status: "active",
      reviewDate: null,
    },
  ];
  return input;
}

const LEAD = {
  id: "lead-1",
  name: "Alpha",
  cacheKey: "lead-key-1",
  staleStatus: "fresh",
} as const;

const CHANGING = {
  id: "proj-2",
  name: "Beta",
  cacheKey: "beta-key-2",
  staleStatus: "fresh",
  nextAction: "Draft the Circlo post intro",
} as const;

const QUIET = {
  id: "proj-3",
  name: "Gamma",
  cacheKey: "gamma-key-3",
  staleStatus: "fresh",
} as const;

async function run(projects: BrieferProjectInput[], lastDelta: BriefDeltaRecord | null): Promise<Brief> {
  const brief = await runBriefer(makeDeps(projects, lastDelta), { skipModel: true, now: new Date("2026-08-16T08:00:00Z") });
  return brief;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delta-only brief", () => {
  const projects = () =>
    [
      withHypothesis(makeInputs({ ...LEAD }), "Graveyard builders will talk to us"),
      makeInputs({ ...CHANGING }),
      makeInputs({ ...QUIET }),
    ];

  const yesterdayDelta = (overrides: Partial<BriefDeltaRecord> = {}): BriefDeltaRecord => ({
    briefDate: "2026-08-15",
    projectCardKeys: { [LEAD.id]: LEAD.cacheKey, [CHANGING.id]: "old-key", [QUIET.id]: QUIET.cacheKey },
    projectAgingStatus: { [LEAD.id]: "fresh", [CHANGING.id]: "fresh", [QUIET.id]: "fresh" },
    leadKey: `${LEAD.id}::Graveyard builders will talk to us`,
    leadSince: "2026-08-15",
    ...overrides,
  });

  it("first-ever brief renders everything (no prior delta — nothing quiet)", async () => {
    const brief = await run(projects(), null);
    expect(brief.quietProjectIds).toEqual([]);
    expect(brief.openQuestions.length + (brief.leadQuestion ? 1 : 0)).toBeGreaterThanOrEqual(0);
    expect(brief.sourceNotes.length).toBeGreaterThanOrEqual(0);
    // Beta's action present, Gamma present in projectNames
    expect(brief.projectNames?.[QUIET.id]).toBe(QUIET.name);
  });

  it("an unchanged, escalation-free, non-lead project goes quiet", async () => {
    const brief = await run(projects(), yesterdayDelta());
    expect(brief.quietProjectIds).toEqual([QUIET.id]);
    // Gamma contributes nothing per-project:
    expect(brief.sourceNotes.some((s) => s.projectId === QUIET.id)).toBe(false);
    expect(brief.openQuestions.some((q) => q.projectId === QUIET.id)).toBe(false);
    expect(brief.highLeverageActions.some((a) => a.projectId === QUIET.id)).toBe(false);
    // Beta (card changed) still renders its action:
    expect(brief.highLeverageActions.some((a) => a.projectId === CHANGING.id)).toBe(true);
  });

  it("the lead project never goes quiet and repeats with an unchanged marker", async () => {
    const brief = await run(projects(), yesterdayDelta());
    expect(brief.quietProjectIds).not.toContain(LEAD.id);
    expect(brief.leadQuestion?.projectId).toBe(LEAD.id);
    expect(brief.leadUnchangedSince).toBe("2026-08-15");
  });

  it("a changed lead resets the marker", async () => {
    const brief = await run(projects(), yesterdayDelta({ leadKey: "something-else", leadSince: "2026-08-10" }));
    expect(brief.leadUnchangedSince).toBeNull();
  });

  it("escalations keep a quiet project visible (self-extinguishing — principal-gated)", async () => {
    const noisy = makeInputs({ ...QUIET, escalationQuestion: "Pick a pricing model" });
    const brief = await run([withHypothesis(makeInputs({ ...LEAD }), "x"), noisy], yesterdayDelta());
    expect(brief.quietProjectIds).toEqual([]);
    expect(brief.escalations.some((e) => e.projectId === QUIET.id)).toBe(true);
  });

  it("aging crossings fire once on the crossing day, then the project quiets", async () => {
    // Yesterday Gamma was fresh and unchanged; today its status is stale.
    const aged = makeInputs({ ...QUIET, staleStatus: "stale" });
    const brief1 = await run(
      [withHypothesis(makeInputs({ ...LEAD }), "x"), makeInputs({ ...CHANGING }), aged],
      yesterdayDelta(),
    );
    expect(brief1.agingCrossings).toEqual([
      { projectId: QUIET.id, projectName: QUIET.name, from: "fresh", to: "stale" },
    ]);
    expect(brief1.quietProjectIds).toEqual([]); // crossing day: not quiet

    // Tomorrow: status still stale, card unchanged → no repeat crossing, and
    // Gamma quiets (Beta's card also stopped changing by then → quiet too).
    const brief2 = await run(
      [withHypothesis(makeInputs({ ...LEAD }), "x"), makeInputs({ ...CHANGING }), aged],
      extractBriefDelta(brief1),
    );
    expect(brief2.agingCrossings).toEqual([]);
    expect(brief2.quietProjectIds).toContain(QUIET.id);
    expect(brief2.quietProjectIds).toContain(CHANGING.id);
  });

  it("extractBriefDelta keeps the original lead-since across carries", () => {
    const brief = {
      briefDate: "2026-08-16",
      leadQuestion: { projectId: "p1", statement: "s" },
      leadUnchangedSince: "2026-08-14",
      projectCardKeys: { p1: "k" },
      projectAgingStatus: { p1: "fresh" },
    } as unknown as Brief;
    const delta = extractBriefDelta(brief);
    expect(delta.leadKey).toBe("p1::s");
    expect(delta.leadSince).toBe("2026-08-14");
  });

  it("extractBriefDelta degrades safely on pre-T-6.3 briefs", () => {
    const delta = extractBriefDelta({ briefDate: "2026-08-16" } as Brief);
    expect(delta.projectCardKeys).toEqual({});
    expect(delta.projectAgingStatus).toEqual({});
    expect(delta.leadKey).toBeNull();
    expect(delta.leadSince).toBeNull();
  });
});
