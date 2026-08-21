/**
 * T-4.8 — scheduled-steward orchestrator tests.
 *
 * Exercises the pipeline (pause check → lock → runSteward → save → drafts →
 * render → hallucination tripwire → Obsidian write → event → release) with
 * mocked StewardDeps, an in-memory lock store, and a real tmpdir for the
 * journal write. Also covers the missed-run catch-up decision.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkMissedStewardRun,
  runMissedStewardCatchUp,
  runScheduledSteward,
  STEWARD_JOURNAL_FILENAME_PREFIX,
  type ScheduledStewardDeps,
} from "../lib/steward/scheduled-steward.js";
import type { StewardDeps } from "../lib/steward/steward.js";
import type { BrieferProjectInput, ValueAnchorSummary } from "../lib/briefer/types.js";
import type {
  BriefInProgressLock,
  OverlapGuardStore,
} from "../lib/briefer/overlap-guard.js";
import type { HallucinationDeps } from "../lib/briefer/scheduled-brief.js";
import type { HallucinationCounterState } from "../lib/briefer/hallucination.js";
import { buildContextCard, type ContextCard } from "../lib/context-card.js";

let workdir: string;
beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "pacc-scheduled-steward-"));
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-20T08:20:00.000Z");

class InMemoryLock implements OverlapGuardStore {
  state: BriefInProgressLock | null = null;
  async read() {
    return this.state;
  }
  async write(lock: BriefInProgressLock) {
    this.state = lock;
  }
  async clear() {
    this.state = null;
  }
}

function makeCard(projectId: string, actionText?: string): ContextCard {
  const base = buildContextCard(
    {
      project: {
        id: projectId,
        name: `P-${projectId}`,
        controlPlaneState: {
          portfolioState: "active",
          currentPhase: "validate",
          constraintLane: "customer",
          nextSmallestAction: actionText ?? `Next for ${projectId}`,
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
  return base;
}

const ANCHORS: ValueAnchorSummary[] = [{ name: "Ship Small", purpose: "small bets", resolved: true }];

interface MockSteward {
  projects: BrieferProjectInput[];
  modelText: string | null;
  savedJournals: unknown[];
  drafts: Array<{ path: string; content: string }>;
  draftShouldThrow: boolean;
}

function makeStewardDeps(state: MockSteward): StewardDeps {
  return {
    async listActiveProjectCards() {
      return state.projects;
    },
    async listValueAnchors() {
      return ANCHORS;
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
    async proposeM2() {
      /* not exercised here */
    },
    async saveJournal(journal) {
      state.savedJournals.push(journal);
      return { id: "j-1" };
    },
    async writeDraft(p, content) {
      if (state.draftShouldThrow) throw new Error("rejected by mediator");
      state.drafts.push({ path: p, content });
      return { path: p, kind: "wrote" };
    },
    async callModel() {
      return { text: state.modelText, sessionId: null };
    },
  };
}

interface DepsState {
  steward: MockSteward;
  lock: InMemoryLock;
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
}

function makeDeps(state: DepsState, hallucination?: HallucinationDeps): ScheduledStewardDeps {
  return {
    steward: makeStewardDeps(state.steward),
    lock: state.lock,
    async emitEvent(name, payload) {
      state.events.push({ name, payload });
    },
    logger: {
      info: (msg, fields) => state.logs.push({ level: "info", msg, fields }),
      warn: (msg, fields) => state.logs.push({ level: "warn", msg, fields }),
      error: (msg, fields) => state.logs.push({ level: "error", msg, fields }),
    },
    hallucination,
  };
}

function baseState(): DepsState {
  return {
    steward: { projects: [], modelText: null, savedJournals: [], drafts: [], draftShouldThrow: false },
    lock: new InMemoryLock(),
    events: [],
    logs: [],
  };
}

const validModelJson = JSON.stringify({
  whatChanged: [],
  attention: [
    {
      project: "P-1",
      proposal: "Email leads",
      whyNow: "stalled",
      jobClassification: "J1_signal",
      requiredAuthority: "L1",
      sourceRefs: ["card:p-1"],
      anchorCitations: [],
      confidence: 0.8,
      riskIfIgnored: "cold",
    },
  ],
  drafts: [],
  awaitingReturn: [{ item: "approve L2", authority: "L2+", recommendation: "hold" }],
  dissent: [],
  selfCheck: ["declined nothing"],
  warnings: [],
  confidence: 0.7,
});

describe("runScheduledSteward (T-4.8)", () => {
  it("happy path: journal saved, rendered, written, event emitted, lock released", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    const result = await runScheduledSteward(makeDeps(state), { now: NOW, obsidianBaseDir: workdir });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.obsidianWrite.path).toContain("Steward Journal - 2026-08-20.md");
    expect(state.steward.savedJournals).toHaveLength(1);
    expect(state.lock.state).toBeNull();
    const markdown = await readFile(result.obsidianWrite.path, "utf8");
    expect(markdown).toContain("# Steward Journal — 2026-08-20");
    expect(markdown).toContain("## Attention (top 3)");
    const event = state.events.find((e) => e.name === "steward.journal.generated");
    expect(event?.payload.journalDate).toBe("2026-08-20");
  });

  it("is idempotent per day: same inputs → byte-identical, no rewrite", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    const deps = makeDeps(state);
    const r1 = await runScheduledSteward(deps, { now: NOW, obsidianBaseDir: workdir, runId: "r1" });
    const r2 = await runScheduledSteward(deps, { now: NOW, obsidianBaseDir: workdir, runId: "r2" });
    expect(r1.kind).toBe("completed");
    expect(r2.kind).toBe("completed");
    if (r1.kind !== "completed" || r2.kind !== "completed") return;
    expect(r2.obsidianWrite.kind).toBe("unchanged");
  });

  it("skips with skipped_overlap when the lock is held", async () => {
    const state = baseState();
    await state.lock.write({ acquiredAt: NOW.toISOString(), runId: "other" });
    const result = await runScheduledSteward(makeDeps(state), {
      now: new Date(NOW.getTime() + 5000),
      obsidianBaseDir: workdir,
    });
    expect(result.kind).toBe("skipped_overlap");
    expect(state.steward.savedJournals).toHaveLength(0);
  });

  it("skipped_paused when the steward pause flag is set — writes a stub journal", async () => {
    const state = baseState();
    const hallucination: HallucinationDeps = {
      knownIds: new Set(),
      readFlags: async () => null,
      writeFlags: async () => undefined,
      isPaused: async () => ({ paused: true, reason: "test pause" }),
      setPaused: async () => undefined,
    };
    const result = await runScheduledSteward(makeDeps(state, hallucination), {
      now: NOW,
      obsidianBaseDir: workdir,
    });
    expect(result.kind).toBe("skipped_paused");
    if (result.kind !== "skipped_paused") return;
    const markdown = await readFile(result.obsidianWrite.path, "utf8");
    expect(markdown).toContain("test pause");
    expect(state.steward.savedJournals).toHaveLength(0);
  });

  it("model-generated hallucinations trip the pause at threshold (D-39)", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    // Model output whose prose embeds three distinct unknown ID-shaped tokens.
    state.steward.modelText = JSON.stringify({
      whatChanged: ["ref fake-proj-alpha and fake-proj-beta plus fake-proj-gamma"],
      attention: [],
      drafts: [],
      awaitingReturn: [],
      dissent: [],
      selfCheck: [],
      warnings: [],
      confidence: 0.7,
    });
    let flags: HallucinationCounterState | null = null;
    let pausedWith: string | null = null;
    const hallucination: HallucinationDeps = {
      knownIds: new Set(["p-1", "P-1"]),
      async readFlags() {
        return flags;
      },
      async writeFlags(s) {
        flags = s;
      },
      async isPaused() {
        return { paused: false, reason: null };
      },
      async setPaused(reason) {
        pausedWith = reason;
      },
    };
    const result = await runScheduledSteward(makeDeps(state, hallucination), {
      now: NOW,
      obsidianBaseDir: workdir,
      stewardOptions: { skipModel: false },
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.hallucinationFlagCount).toBeGreaterThanOrEqual(3);
    expect(result.selfPaused).toBe(true);
    expect(pausedWith).toContain("unique hallucinated reference");
  });

  it("deterministic journals never self-pause even when flagged (D-39)", async () => {
    const state = baseState();
    // Deterministic attention text embeds unknown ID-shaped tokens.
    state.steward.projects = [
      { projectId: "p-1", projectName: "P-1", card: makeCard("p-1", "check fake-proj-delta and fake-proj-epsilon") },
    ];
    let setPausedCalled = false;
    const hallucination: HallucinationDeps = {
      knownIds: new Set(["p-1", "P-1"]),
      readFlags: async () => null,
      writeFlags: async () => undefined,
      isPaused: async () => ({ paused: false, reason: null }),
      async setPaused() {
        setPausedCalled = true;
      },
    };
    const result = await runScheduledSteward(makeDeps(state, hallucination), {
      now: NOW,
      obsidianBaseDir: workdir,
      stewardOptions: { skipModel: true },
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(setPausedCalled).toBe(false);
  });

  it("writes drafts through the mediator; a rejected draft fails soft (warn, run completes)", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    state.steward.modelText = JSON.stringify({
      whatChanged: [],
      attention: [],
      drafts: [
        { path: "00_Daily/x.draft.md", purpose: "test draft", content: "draft body" },
      ],
      awaitingReturn: [],
      dissent: [],
      selfCheck: [],
      warnings: [],
      confidence: 0.5,
    });
    state.steward.draftShouldThrow = true;
    const result = await runScheduledSteward(makeDeps(state), {
      now: new Date("2026-08-21T08:20:00.000Z"),
      obsidianBaseDir: workdir,
      stewardOptions: { skipModel: false },
    });
    expect(result.kind).toBe("completed");
    expect(state.logs.some((l) => l.level === "warn" && l.msg.includes("draft write rejected"))).toBe(true);
  });
});

describe("checkMissedStewardRun (T-4.8)", () => {
  it("too early before the threshold hour", async () => {
    const r = await checkMissedStewardRun({
      now: new Date("2026-08-20T07:30:00"),
      obsidianBaseDir: workdir,
    });
    expect(r).toEqual({ shouldRun: false, reason: "too_early" });
  });

  it("no catch-up when today's journal exists", async () => {
    const r = await checkMissedStewardRun({
      now: new Date("2026-08-20T10:00:00"),
      obsidianBaseDir: workdir,
    });
    // The happy-path test above wrote a journal for 2026-08-20 in this dir.
    const wroteOne = await stat(
      path.join(workdir, `${STEWARD_JOURNAL_FILENAME_PREFIX}2026-08-20.md`),
    ).then(() => true, () => false);
    if (wroteOne) {
      expect(r).toEqual({ shouldRun: false, reason: "journal_already_exists" });
    } else {
      expect(r.shouldRun).toBe(true);
    }
  });

  it("catch-up runs the pipeline when the journal is missing", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    const outcome = await runMissedStewardCatchUp({
      now: new Date("2026-08-22T10:00:00"),
      obsidianBaseDir: workdir,
      logger: { info: () => undefined, warn: () => undefined },
      runner: (options) => runScheduledSteward(makeDeps(state), options),
    });
    expect(outcome.ran).toBe(true);
    if (outcome.ran) expect(outcome.result.kind).toBe("completed");
  });
});
