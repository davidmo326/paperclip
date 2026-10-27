/**
 * T-4.8 — scheduled-steward orchestrator tests.
 *
 * Exercises the pipeline (pause check → lock → runSteward → save → drafts →
 * render → hallucination tripwire → Obsidian write → event → release) with
 * mocked StewardDeps, an in-memory lock store, and a real tmpdir for the
 * journal write. Also covers the missed-run catch-up decision, keyed on the
 * record's own journal store (F-cos.0), and the required pause dependency.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkMissedStewardRun,
  runMissedStewardCatchUp,
  runScheduledSteward,
  stewardPauseReason,
  stewardResumeActor,
  stewardResumeRefusal,
  type ScheduledStewardDeps,
  type StewardJournalStoreDeps,
} from "../lib/steward/scheduled-steward.js";
import { makeStewardJournalStore, makeStewardPauseDeps } from "../lib/steward/worker-deps.js";
import {
  PLUGIN_NAMESPACE,
  STEWARD_JOURNAL_DELTA_STATE_KEY,
  STEWARD_JOURNAL_STORE_STATE_KEY,
  STEWARD_PAUSED_STATE_KEY,
} from "../constants.js";
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
  savedJournals: Array<{ journalDate: string }>;
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
  pause: { paused: boolean; reason: string | null };
  /** Paused-day markers the run wrote into the record's journal store. */
  pausedDays: Map<string, string>;
}

/** The record's journal store for these tests: saved journals plus paused-day markers. */
function makeJournalStore(state: DepsState): StewardJournalStoreDeps {
  return {
    async journalExists(date) {
      return state.steward.savedJournals.some((j) => j.journalDate === date) || state.pausedDays.has(date);
    },
    async markPausedDay(date, reason) {
      state.pausedDays.set(date, reason);
    },
  };
}

function makeDeps(state: DepsState, hallucination?: HallucinationDeps): ScheduledStewardDeps {
  return {
    steward: makeStewardDeps(state.steward),
    lock: state.lock,
    paused: { isPaused: async () => state.pause },
    journalStore: makeJournalStore(state),
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
    pause: { paused: false, reason: null },
    pausedDays: new Map(),
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
    state.pause = { paused: true, reason: "test pause" };
    const hallucination: HallucinationDeps = {
      knownIds: new Set(),
      readFlags: async () => null,
      writeFlags: async () => undefined,
      // The tripwire's own flag says "not paused": the run must read deps.paused.
      isPaused: async () => ({ paused: false, reason: null }),
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

  it("paused with no hallucination deps still returns skipped_paused (F-cos.0)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pacc-steward-paused-"));
    try {
      const state = baseState();
      state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
      state.pause = { paused: true, reason: "placeholder pause reason" };
      const result = await runScheduledSteward(makeDeps(state), { now: NOW, obsidianBaseDir: dir });
      expect(result.kind).toBe("skipped_paused");
      expect(state.steward.savedJournals).toHaveLength(0);
      expect(state.lock.state).toBeNull();
      // The paused day is marked in the record's store, so a restart later
      // that day never starts a catch-up run.
      expect(state.pausedDays.get("2026-08-20")).toBe("placeholder pause reason");
      const check = await checkMissedStewardRun({
        now: new Date("2026-08-20T21:07:00"),
        journalExists: makeJournalStore(state).journalExists,
      });
      expect(check).toEqual({ shouldRun: false, reason: "journal_already_exists" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a missing pause dependency throws, never skips the check (F-cos.0)", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    const { paused: _paused, ...withoutPause } = makeDeps(state);
    await expect(
      runScheduledSteward(withoutPause as unknown as ScheduledStewardDeps, { now: NOW, obsidianBaseDir: workdir }),
    ).rejects.toThrow(/pause check is a required dependency/);
    const { journalStore: _store, ...withoutStore } = makeDeps(state);
    await expect(
      runScheduledSteward(withoutStore as unknown as ScheduledStewardDeps, { now: NOW, obsidianBaseDir: workdir }),
    ).rejects.toThrow(/journal store is a required dependency/);
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

describe("checkMissedStewardRun (T-4.8, keyed on the record — F-cos.0)", () => {
  const none = async () => false;

  it("too early before the threshold hour", async () => {
    const r = await checkMissedStewardRun({ now: new Date("2026-08-20T07:30:00"), journalExists: none });
    expect(r).toEqual({ shouldRun: false, reason: "too_early" });
  });

  it("keys on the record's journal store, never the vault file", async () => {
    // Input-only mode: no vault file is ever written, but the record holds
    // today's journal. Vault keying says "missing" and starts a full run on
    // every restart after 08:00 (the 27 Oct 21:07 and 21:21 runs); the record
    // says it ran. This case fails on the old vault-file keying.
    const asked: string[] = [];
    const recordHasToday = await checkMissedStewardRun({
      now: new Date("2026-08-20T21:07:00"),
      journalExists: async (date) => {
        asked.push(date);
        return date === "2026-08-20";
      },
    });
    expect(asked).toEqual(["2026-08-20"]);
    expect(recordHasToday).toEqual({ shouldRun: false, reason: "journal_already_exists" });

    // Nothing in the record for the day: the catch-up runs.
    const recordEmpty = await checkMissedStewardRun({ now: new Date("2026-08-21T10:00:00"), journalExists: none });
    expect(recordEmpty).toEqual({ shouldRun: true, reason: "missed_run_catch_up", journalDate: "2026-08-21" });
  });

  it("an unreadable store fails closed (no catch-up), and a missing journalExists throws", async () => {
    const r = await checkMissedStewardRun({
      now: new Date("2026-08-20T10:00:00"),
      journalExists: async () => {
        throw new Error("store down");
      },
    });
    expect(r).toEqual({ shouldRun: false, reason: "journal_store_unreadable" });
    await expect(
      checkMissedStewardRun({ now: new Date("2026-08-20T10:00:00") } as unknown as Parameters<typeof checkMissedStewardRun>[0]),
    ).rejects.toThrow(/journalExists is a required dependency/);
  });

  it("catch-up runs the pipeline when the journal is missing, then not again that day", async () => {
    const state = baseState();
    state.steward.projects = [{ projectId: "p-1", projectName: "P-1", card: makeCard("p-1") }];
    const deps = makeDeps(state);
    const opts = {
      now: new Date("2026-08-22T10:00:00"),
      obsidianBaseDir: workdir,
      journalExists: deps.journalStore.journalExists,
      logger: { info: () => undefined, warn: () => undefined },
      runner: (options: Parameters<typeof runScheduledSteward>[1]) => runScheduledSteward(deps, options),
    };
    const first = await runMissedStewardCatchUp(opts);
    expect(first.ran).toBe(true);
    if (first.ran) expect(first.result.kind).toBe("completed");
    // A second restart the same day: the record now holds the journal.
    const second = await runMissedStewardCatchUp({ ...opts, now: new Date("2026-08-22T21:21:00") });
    expect(second).toEqual({ ran: false, reason: "journal_already_exists" });
    expect(state.steward.savedJournals).toHaveLength(1);
  });
});

describe("the record's journal store, read back as saveJournal writes it (F-cos.0)", () => {
  function stubState() {
    const store = new Map<string, unknown>();
    const k = (x: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
      `${x.scopeKind}:${x.scopeId ?? ""}:${x.namespace ?? ""}:${x.stateKey}`;
    return {
      store,
      state: {
        async get(x: Parameters<typeof k>[0]) {
          return store.get(k(x)) ?? null;
        },
        async set(x: Parameters<typeof k>[0], v: unknown) {
          store.set(k(x), v);
        },
      },
    };
  }

  it("finds the journal under namespace = date, the delta's journalDate, or the paused marker", async () => {
    const s = stubState();
    const ctx = { state: s.state } as unknown as Parameters<typeof makeStewardJournalStore>[0];
    const fixed = () => new Date("2026-08-20T08:20:00.000Z");
    const store = makeStewardJournalStore(ctx, fixed);
    expect(await store.journalExists("2026-08-20")).toBe(false);

    await s.state.set(
      { scopeKind: "instance", namespace: "2026-08-20", stateKey: STEWARD_JOURNAL_STORE_STATE_KEY },
      { journalDate: "2026-08-20" },
    );
    expect(await store.journalExists("2026-08-20")).toBe(true);
    expect(await store.journalExists("2026-08-21")).toBe(false);

    await s.state.set(
      { scopeKind: "instance", namespace: PLUGIN_NAMESPACE, stateKey: STEWARD_JOURNAL_DELTA_STATE_KEY },
      { journalDate: "2026-08-21", projectCardKeys: {} },
    );
    expect(await store.journalExists("2026-08-21")).toBe(true);

    await store.markPausedDay("2026-08-22", "placeholder reason");
    expect(await store.journalExists("2026-08-22")).toBe(true);
    // The marker sits beside the journal, never on the journal's own key.
    expect(
      await s.state.get({ scopeKind: "instance", namespace: "2026-08-22", stateKey: STEWARD_JOURNAL_STORE_STATE_KEY }),
    ).toBeNull();
  });

  it("the pause deps read the steward's own flag, tolerating a bad row", async () => {
    const s = stubState();
    const ctx = { state: s.state } as unknown as Parameters<typeof makeStewardPauseDeps>[0];
    const pause = makeStewardPauseDeps(ctx);
    expect(await pause.isPaused()).toEqual({ paused: false, reason: null });
    const key = { scopeKind: "instance", namespace: PLUGIN_NAMESPACE, stateKey: STEWARD_PAUSED_STATE_KEY };
    await s.state.set(key, { paused: true, reason: "placeholder" });
    expect(await pause.isPaused()).toEqual({ paused: true, reason: "placeholder" });
    await s.state.set(key, "not an object");
    expect(await pause.isPaused()).toEqual({ paused: false, reason: null });
  });
});

describe("resume-steward records its caller (F-cos.0)", () => {
  it("uses the actor param when a string, else unknown — never principal by default", () => {
    expect(stewardResumeActor({ actor: "principal" })).toBe("principal");
    expect(stewardResumeActor({ actor: "  cockpit:token  " })).toBe("cockpit:token");
    expect(stewardResumeActor({})).toBe("unknown");
    expect(stewardResumeActor({ actor: 7 })).toBe("unknown");
    expect(stewardResumeActor({ actor: "   " })).toBe("unknown");
    expect(stewardResumeActor(undefined)).toBe("unknown");
    expect(stewardResumeActor(null)).toBe("unknown");
    expect(stewardResumeActor({ actor: "x".repeat(300) })).toHaveLength(100);
  });

  it("refuses a resume that names nobody, before anything changes", () => {
    expect(stewardResumeRefusal({})).toMatch(/needs an actor/);
    expect(stewardResumeRefusal({ actor: "  " })).toMatch(/needs an actor/);
    expect(stewardResumeRefusal(undefined)).toMatch(/needs an actor/);
    expect(stewardResumeRefusal({ actor: "principal:token" })).toBeNull();
    expect(stewardResumeRefusal({ actor: "cli" })).toBeNull();
  });
});

describe("pause-steward records its caller (F-cos.0)", () => {
  it("tells the cockpit's own pause from the principal's and names anyone else", () => {
    expect(stewardPauseReason({ actor: "cockpit", reason: "its home answers mail; re-paused at cockpit start" })).toEqual({
      actor: "cockpit",
      reason: "paused by the cockpit: its home answers mail; re-paused at cockpit start",
    });
    expect(stewardPauseReason({ actor: "principal:token", reason: "its home answers mail" })).toEqual({ actor: "principal:token", reason: "paused by the principal: its home answers mail" });
    expect(stewardPauseReason({ actor: "principal" })).toEqual({ actor: "principal", reason: "paused by the principal" });
    expect(stewardPauseReason({ reason: "x" })).toEqual({ actor: "unknown", reason: "paused by unknown: x" });
    expect(stewardPauseReason({ actor: "cli", reason: "y".repeat(300) }).reason).toHaveLength("paused by cli: ".length + 200);
  });
});
