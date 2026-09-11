/**
 * T-4.8 — steward core tests.
 *
 * Covers: model-output parsing, value-anchor citation enforcement (PRD § 9.6
 * drop path), the deterministic state-diff journal, runSteward offline +
 * model paths, and the L0/L1 authority ceiling (assertStewardL1 + the
 * structural key-set of the production deps object).
 */

import { describe, expect, it } from "vitest";
import {
  assertStewardL1,
  deterministicJournal,
  enforceAnchorCitations,
  parseStewardModelOutput,
  runSteward,
  StewardAuthorityViolation,
  type StewardAttentionProposal,
  type StewardDeps,
  type StewardRehydrationPack,
} from "../lib/steward/steward.js";
import { STEWARD_DEPS_ALLOWED_KEYS, makeStewardDeps, type StewardWorkerCtx } from "../lib/steward/worker-deps.js";
import { buildContextCard, type ContextCard } from "../lib/context-card.js";
import type { BrieferProjectInput, ValueAnchorSummary } from "../lib/briefer/types.js";

const NOW = new Date("2026-08-20T08:20:00.000Z");

function makeCard(projectId: string, overrides: Partial<ContextCard> = {}): ContextCard {
  const base = buildContextCard(
    {
      project: {
        id: projectId,
        name: `P-${projectId}`,
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
  return { ...base, ...overrides };
}

function projectInput(projectId: string, overrides?: Partial<ContextCard>): BrieferProjectInput {
  return { projectId, projectName: `P-${projectId}`, card: makeCard(projectId, overrides) };
}

const ANCHORS: ValueAnchorSummary[] = [
  { name: "Ship Small", purpose: "small bets", resolved: true },
  { name: "Customer Contact", purpose: "talk to users", resolved: true },
];

function validProposal(overrides: Partial<StewardAttentionProposal> = {}): StewardAttentionProposal {
  return {
    project: "P-1",
    proposal: "Email the three discovery-call leads",
    whyNow: "calls stalled",
    jobClassification: "J1_signal",
    requiredAuthority: "L1",
    sourceRefs: ["card:p-1"],
    anchorCitations: ["[[Ship Small]] § Bets @ abcd1234"],
    confidence: 0.8,
    riskIfIgnored: "pipeline goes cold",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseStewardModelOutput (T-4.8)", () => {
  const validBody = {
    whatChanged: ["P-1 card changed"],
    attention: [
      {
        project: "P-1",
        proposal: "Email leads",
        whyNow: "stalled",
        jobClassification: "J1_signal",
        requiredAuthority: "L1",
        sourceRefs: ["card:p-1"],
        anchorCitations: ["[[Ship Small]] § Bets @ abcd1234"],
        confidence: 0.8,
        riskIfIgnored: "cold pipeline",
      },
    ],
    drafts: [{ path: "00_Daily/note.draft.md", purpose: "draft email" }],
    awaitingReturn: [{ item: "approve L2 write", authority: "L2+", recommendation: "hold" }],
    dissent: [],
    selfCheck: ["declined to write M2"],
    warnings: [],
    confidence: 0.7,
  };

  it("accepts a valid object (bare JSON)", () => {
    const r = parseStewardModelOutput(JSON.stringify(validBody));
    expect(r.ok).toBe(true);
  });

  it("tolerates a fenced JSON object with surrounding prose", () => {
    const text = `Here is the journal:\n\`\`\`json\n${JSON.stringify(validBody)}\n\`\`\nDone.`;
    const r = parseStewardModelOutput(text);
    expect(r.ok).toBe(true);
  });

  it("rejects non-JSON text", () => {
    expect(parseStewardModelOutput("no json here").ok).toBe(false);
  });

  it("rejects more than 3 attention entries (prompt cap is enforced)", () => {
    const body = { ...validBody, attention: [1, 2, 3, 4].map((i) => ({ ...validBody.attention[0], project: `P-${i}` })) };
    const r = parseStewardModelOutput(JSON.stringify(body));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("at most 3");
  });

  it("rejects an invalid jobClassification", () => {
    const body = { ...validBody, attention: [{ ...validBody.attention[0], jobClassification: "J9_mystery" }] };
    expect(parseStewardModelOutput(JSON.stringify(body)).ok).toBe(false);
  });

  it("rejects an invalid requiredAuthority", () => {
    const body = { ...validBody, attention: [{ ...validBody.attention[0], requiredAuthority: "L9" }] };
    expect(parseStewardModelOutput(JSON.stringify(body)).ok).toBe(false);
  });

  it("rejects a draft path that is not *.draft.md", () => {
    const body = { ...validBody, drafts: [{ path: "00_Daily/real-note.md", purpose: "oops" }] };
    const r = parseStewardModelOutput(JSON.stringify(body));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".draft.md");
  });

  it("accepts the degraded-output fallback object from the prompt", () => {
    const fallback = {
      whatChanged: [],
      attention: [],
      drafts: [],
      awaitingReturn: [],
      dissent: [],
      selfCheck: ["could not synthesise"],
      warnings: ["run failed"],
      confidence: 0,
    };
    expect(parseStewardModelOutput(JSON.stringify(fallback)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Citation enforcement (PRD § 9.6)
// ---------------------------------------------------------------------------

describe("enforceAnchorCitations (T-4.8 / PRD § 9.6)", () => {
  const anchorNames = new Set(ANCHORS.map((a) => a.name));

  it("keeps proposals with valid, registered citations", () => {
    const { kept, warnings } = enforceAnchorCitations([validProposal()], anchorNames);
    expect(kept).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("drops a proposal whose citation is not in [[Name]] § Section @ hash8 format", () => {
    const { kept, warnings } = enforceAnchorCitations(
      [validProposal({ anchorCitations: ["see Ship Small values"] })],
      anchorNames,
    );
    expect(kept).toHaveLength(0);
    expect(warnings[0]).toContain("invalid value-anchor citation");
  });

  it("drops a proposal whose citation names an unregistered anchor", () => {
    const { kept } = enforceAnchorCitations(
      [validProposal({ anchorCitations: ["[[Ghost Anchor]] § X @ 00000000"] })],
      anchorNames,
    );
    expect(kept).toHaveLength(0);
  });

  it("keeps proposals with no citations at all (routine triage)", () => {
    const { kept } = enforceAnchorCitations([validProposal({ anchorCitations: [] })], anchorNames);
    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

describe("deterministicJournal (T-4.8)", () => {
  const pack: StewardRehydrationPack = {
    journalDate: "2026-08-20",
    valueAnchors: ANCHORS,
    projects: [
      { projectId: "p-1", projectName: "P-1", portfolioState: "primary", currentPhase: "validate", staleStatus: null, nextAction: "Call lead", blockers: null, cardKey: "a", sourceNotes: [] },
      { projectId: "p-2", projectName: "P-2", portfolioState: "active", currentPhase: "build", staleStatus: "stale", nextAction: "Refresh evidence", blockers: "waiting on X", cardKey: "b", sourceNotes: [] },
      { projectId: "p-3", projectName: "P-3", portfolioState: "active", currentPhase: "validate", staleStatus: null, nextAction: null, blockers: null, cardKey: "c", sourceNotes: [] },
    ],
    ledgers: {
      decisionsDue: [{ projectName: "P-1", summary: "pick stack", reviewDate: "2026-08-21" }],
      expiringGrants: [{ label: "L2 write @ p-2", expiresAt: "2026-08-22T00:00:00.000Z" }],
    },
    yesterdaysJournal: { journalDate: "2026-08-19", projectCardKeys: { "p-1": "a", "p-2": "OLD" } },
    lastBrief: null,
    briefFeedback: null,
  };

  it("diffs what changed against yesterday's card keys", () => {
    const j = deterministicJournal(pack);
    expect(j.whatChanged.some((w) => w.startsWith("P-2: context changed"))).toBe(true);
    expect(j.whatChanged.some((w) => w.startsWith("P-1: context changed"))).toBe(false);
    expect(j.whatChanged.some((w) => w.startsWith("P-3: new to the steward's view"))).toBe(true);
    expect(j.whatChanged.some((w) => w.startsWith("decision due:"))).toBe(true);
    expect(j.whatChanged.some((w) => w.startsWith("authority grant expiring:"))).toBe(true);
  });

  it("attention is capped at 3, ranked stale+blocked first, and drops null next actions", () => {
    const j = deterministicJournal(pack);
    expect(j.attention.length).toBeLessThanOrEqual(3);
    expect(j.attention[0]!.project).toBe("P-2");
    expect(j.attention.some((a) => a.project === "P-3")).toBe(false);
    expect(j.drafts).toHaveLength(0);
    expect(j.selfCheck[0]).toContain("deterministic mode");
  });
});

// ---------------------------------------------------------------------------
// runSteward
// ---------------------------------------------------------------------------

interface MockState {
  projects: BrieferProjectInput[];
  anchors: ValueAnchorSummary[];
  modelText: string | null;
  saved: unknown[];
  drafts: Array<{ path: string; content: string }>;
  violations: string[];
}

function makeDeps(state: MockState): StewardDeps {
  return {
    async listActiveProjectCards() {
      return state.projects;
    },
    async listValueAnchors() {
      return state.anchors;
    },
    async readOpenLedgers() {
      return { decisionsDue: [], expiringGrants: [] };
    },
    async readLastJournalDelta() {
      return null;
    },
    async readLastBrief() {
      return null;
    },
    async readBriefFeedback() {
      return null;
    },
    async proposeM2(args) {
      const level = args.requiredAuthority ?? "L1";
      assertStewardL1(level, "proposeM2");
    },
    async saveJournal(journal) {
      state.saved.push(journal);
      return { id: "j-1" };
    },
    async writeDraft(path, content) {
      state.drafts.push({ path, content });
      return { path, kind: "wrote" };
    },
    async callModel() {
      return { text: state.modelText, sessionId: null };
    },
  };
}

describe("runSteward (T-4.8)", () => {
  it("offline mode produces a deterministic journal with all sections", async () => {
    const state: MockState = {
      projects: [projectInput("p-1")],
      anchors: ANCHORS,
      modelText: null,
      saved: [],
      drafts: [],
      violations: [],
    };
    const journal = await runSteward(makeDeps(state), { now: NOW, skipModel: true });
    expect(journal.modelGenerated).toBe(false);
    expect(journal.journalDate).toBe("2026-08-20");
    expect(journal.inputsCacheKey).toMatch(/^[0-9a-f]{64}$/);
    for (const section of ["whatChanged", "attention", "drafts", "awaitingReturn", "dissent", "selfCheck", "warnings"]) {
      expect(Array.isArray(journal[section as keyof typeof journal])).toBe(true);
    }
  });

  it("model mode parses valid output and stamps modelGenerated", async () => {
    const state: MockState = {
      projects: [projectInput("p-1")],
      anchors: ANCHORS,
      modelText: JSON.stringify({
        whatChanged: [],
        attention: [{
          project: "P-1",
          proposal: "Email leads",
          whyNow: "stalled",
          jobClassification: "J1_signal",
          requiredAuthority: "L1",
          sourceRefs: ["card:p-1"],
          anchorCitations: ["[[Ship Small]] § Bets @ abcd1234"],
          confidence: 0.8,
          riskIfIgnored: "cold",
        }],
        drafts: [],
        awaitingReturn: [],
        dissent: [],
        selfCheck: ["none"],
        warnings: [],
        confidence: 0.7,
      }),
      saved: [],
      drafts: [],
      violations: [],
    };
    const journal = await runSteward(makeDeps(state), { now: NOW });
    expect(journal.modelGenerated).toBe(true);
    expect(journal.attention).toHaveLength(1);
  });

  it("schema-invalid model output degrades to deterministic + onSchemaViolation fires", async () => {
    const state: MockState = {
      projects: [projectInput("p-1")],
      anchors: ANCHORS,
      modelText: "garbage — no json",
      saved: [],
      drafts: [],
      violations: [],
    };
    const journal = await runSteward(makeDeps(state), {
      now: NOW,
      onSchemaViolation: (e) => state.violations.push(e),
    });
    expect(journal.modelGenerated).toBe(false);
    expect(state.violations).toHaveLength(1);
  });

  it("invalid anchor citations drop the proposal and add a warning (PRD § 9.6)", async () => {
    const state: MockState = {
      projects: [projectInput("p-1")],
      anchors: ANCHORS,
      modelText: JSON.stringify({
        whatChanged: [],
        attention: [
          { ...validProposal(), anchorCitations: ["vague hand-wave"] },
          validProposal({ project: "P-1", anchorCitations: [] }),
        ],
        drafts: [],
        awaitingReturn: [],
        dissent: [],
        selfCheck: [],
        warnings: [],
        confidence: 0.7,
      }),
      saved: [],
      drafts: [],
      violations: [],
    };
    const journal = await runSteward(makeDeps(state), { now: NOW });
    expect(journal.attention).toHaveLength(1);
    expect(journal.warnings.some((w) => w.includes("invalid value-anchor citation"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authority ceiling
// ---------------------------------------------------------------------------

describe("steward authority ceiling (T-4.8)", () => {
  it("assertStewardL1 passes L0/L1 and throws on L2+", () => {
    expect(() => assertStewardL1("L0", "test")).not.toThrow();
    expect(() => assertStewardL1("L1", "test")).not.toThrow();
    expect(() => assertStewardL1("L2", "proposeM2")).toThrow(StewardAuthorityViolation);
    expect(() => assertStewardL1("L4", "anything")).toThrow(/L0\/L1-only/);
  });

  it("proposeM2 throws on L2+ attempts (runtime ceiling)", async () => {
    const state: MockState = {
      projects: [], anchors: [], modelText: null, saved: [], drafts: [], violations: [],
    };
    const deps = makeDeps(state);
    await expect(
      deps.proposeM2({
        kind: "projectState",
        sourceRefs: [],
        confidence: 0.9,
        actor: "agent:steward",
        jobClassification: "meta",
        requiredAuthority: "L2",
      }),
    ).rejects.toThrow(StewardAuthorityViolation);
  });

  it("production deps factory exposes exactly the allowed key set — no writeM2/task/approvals surface", async () => {
    const ctx: StewardWorkerCtx = {
      companies: { list: async () => [{ id: "c-1" }] },
      projects: { list: async () => [] },
      state: {
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
      },
      events: { emit: async () => undefined },
      logger: { info: () => undefined, warn: () => undefined },
      entities: { upsert: async () => ({}) as never, list: async () => [] as never[] },
    };
    const deps = makeStewardDeps(ctx, [], async () => ({ text: null, sessionId: null }));
    expect(Object.keys(deps).sort()).toEqual([...STEWARD_DEPS_ALLOWED_KEYS].sort());
  });

  it("writeDraft refuses non-draft.md paths, traversal, and unwired mediators", async () => {
    const ctx: StewardWorkerCtx = {
      companies: { list: async () => [{ id: "c-1" }] },
      projects: { list: async () => [] },
      state: { get: async () => null, set: async () => undefined },
      events: { emit: async () => undefined },
      logger: { info: () => undefined, warn: () => undefined },
      entities: { upsert: async () => ({}) as never, list: async () => [] as never[] },
    };
    const deps = makeStewardDeps(ctx, [], async () => ({ text: null, sessionId: null }), async (p, c) => ({ path: p, kind: "wrote" }));
    await expect(deps.writeDraft("00_Daily/note.md", "x")).rejects.toThrow(/\.draft\.md/);
    await expect(deps.writeDraft("00_Daily/../evil.draft.md", "x")).rejects.toThrow(/traverse/);
    const noGuard = makeStewardDeps(ctx, [], async () => ({ text: null, sessionId: null }));
    await expect(noGuard.writeDraft("00_Daily/ok.draft.md", "x")).rejects.toThrow(/mediator/);
  });
});
