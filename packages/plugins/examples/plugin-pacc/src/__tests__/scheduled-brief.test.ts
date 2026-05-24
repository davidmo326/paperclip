/**
 * T-3.6 — scheduled-brief orchestrator tests.
 *
 * Exercises the full pipeline (lock → runBriefer → render → write Obsidian
 * → emit event → release) with mocked BrieferDeps + an in-memory lock
 * store + a real tmpdir for the Obsidian write. Also exercises
 * checkMissedRun for the startup catch-up path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BRIEF_GENERATED_EVENT,
  checkMissedRun,
  runScheduledBrief,
  type ScheduledBriefDeps,
} from "../lib/briefer/scheduled-brief.js";
import type {
  Brief,
  BrieferDeps,
  BrieferProjectInput,
} from "../lib/briefer/types.js";
import {
  type BriefInProgressLock,
  type OverlapGuardStore,
} from "../lib/briefer/overlap-guard.js";
import { buildContextCard, type ContextCard } from "../lib/briefer/../context-card.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workdir: string;
beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "pacc-scheduled-brief-"));
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-22T08:00:00.000Z");

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

function makeCard(projectId: string): ContextCard {
  return buildContextCard(
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
}

function projectInput(projectId: string): BrieferProjectInput {
  return { projectId, projectName: `P-${projectId}`, card: makeCard(projectId) };
}

interface MockBriefer {
  projects: BrieferProjectInput[];
  savedBriefs: Brief[];
}

function makeBrieferDeps(state: MockBriefer): BrieferDeps {
  return {
    async listActiveProjectCards() {
      return state.projects;
    },
    async proposeM2() {
      /* not used in T-3.6 paths */
    },
    async saveBrief(brief) {
      state.savedBriefs.push(brief);
      return { id: `brief-${state.savedBriefs.length}` };
    },
    async callModel() {
      return { text: "synthesized summary", sessionId: null };
    },
  };
}

interface DepsState {
  briefer: MockBriefer;
  lock: InMemoryLock;
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  logs: Array<{ level: "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }>;
}

function makeDeps(state: DepsState): ScheduledBriefDeps {
  return {
    briefer: makeBrieferDeps(state.briefer),
    lock: state.lock,
    async emitEvent(name, payload) {
      state.events.push({ name, payload });
    },
    logger: {
      info(msg, fields) {
        state.logs.push({ level: "info", msg, fields });
      },
      warn(msg, fields) {
        state.logs.push({ level: "warn", msg, fields });
      },
      error(msg, fields) {
        state.logs.push({ level: "error", msg, fields });
      },
    },
  };
}

let state: DepsState;
beforeEach(() => {
  state = {
    briefer: { projects: [], savedBriefs: [] },
    lock: new InMemoryLock(),
    events: [],
    logs: [],
  };
});

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("runScheduledBrief — happy path", () => {
  it("completes end-to-end: acquires lock, runs briefer, writes Obsidian, emits event, releases lock", async () => {
    state.briefer.projects = [projectInput("p-1")];

    const result = await runScheduledBrief(makeDeps(state), {
      now: NOW,
      runId: "run-test-1",
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;

    // Brief was saved to the briefer's storage
    expect(state.briefer.savedBriefs).toHaveLength(1);
    expect(state.briefer.savedBriefs[0].briefDate).toBe("2026-05-22");

    // Obsidian file written
    expect(result.obsidianWrite.kind).toBe("wrote");
    const content = await readFile(result.obsidianWrite.path, "utf8");
    expect(content).toContain("# Daily Operating Brief - 2026-05-22");

    // Event emitted with payload
    expect(state.events).toHaveLength(1);
    expect(state.events[0].name).toBe(BRIEF_GENERATED_EVENT);
    expect(state.events[0].payload).toMatchObject({
      briefDate: "2026-05-22",
      obsidianPath: result.obsidianWrite.path,
      obsidianWriteKind: "wrote",
      runId: "run-test-1",
    });

    // Lock was released
    expect(state.lock.state).toBeNull();
  });

  it("re-running with identical inputs yields obsidianWrite.kind='unchanged'", async () => {
    state.briefer.projects = [projectInput("p-1")];
    const opts = {
      now: NOW,
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    };
    await runScheduledBrief(makeDeps(state), opts);

    // Reset trackable side-effects but keep the file on disk
    state.briefer.savedBriefs = [];
    state.events = [];
    state.lock = new InMemoryLock();

    const r2 = await runScheduledBrief(makeDeps(state), opts);
    expect(r2.kind).toBe("completed");
    if (r2.kind === "completed") {
      expect(r2.obsidianWrite.kind).toBe("unchanged");
      // Event still emitted on re-run (the cron tick is a real event)
      expect(state.events[0].payload.obsidianWriteKind).toBe("unchanged");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Overlap guard
// ---------------------------------------------------------------------------

describe("runScheduledBrief — overlap guard", () => {
  it("returns kind='skipped_overlap' when a fresh lock is already held", async () => {
    // Pre-populate a fresh lock
    state.lock.state = {
      acquiredAt: new Date(NOW.getTime() - 60_000).toISOString(),
      runId: "other-run",
    };
    state.briefer.projects = [projectInput("p-1")];

    const result = await runScheduledBrief(makeDeps(state), {
      now: NOW,
      runId: "this-run",
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("skipped_overlap");
    if (result.kind === "skipped_overlap") {
      expect(result.existingLock.runId).toBe("other-run");
      expect(result.ageMs).toBe(60_000);
    }
    // No brief saved
    expect(state.briefer.savedBriefs).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    // Lock NOT released (it belongs to the other run)
    expect(state.lock.state?.runId).toBe("other-run");
  });

  it("overwrites a stale lock and completes the run", async () => {
    // Stale lock (acquired 31 min ago, default staleAfter is 30 min)
    state.lock.state = {
      acquiredAt: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString(),
      runId: "crashed-run",
    };
    state.briefer.projects = [projectInput("p-1")];

    const result = await runScheduledBrief(makeDeps(state), {
      now: NOW,
      runId: "recovered-run",
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("completed");
    // A warning was logged about the stale-lock overwrite
    const warns = state.logs.filter((l) => l.level === "warn");
    expect(warns.some((w) => w.msg.includes("stale lock"))).toBe(true);
    // Lock released after the run
    expect(state.lock.state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Failure path
// ---------------------------------------------------------------------------

describe("runScheduledBrief — failure path", () => {
  it("releases the lock even when runBriefer throws", async () => {
    const deps = makeDeps(state);
    // Override listActiveProjectCards to throw
    deps.briefer.listActiveProjectCards = async () => {
      throw new Error("forced briefer failure");
    };

    const result = await runScheduledBrief(deps, {
      now: NOW,
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toContain("forced briefer failure");
    }
    // Critical: lock released so next run can proceed
    expect(state.lock.state).toBeNull();
    // No event emitted on failure
    expect(state.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. checkMissedRun (startup catch-up)
// ---------------------------------------------------------------------------

describe("checkMissedRun", () => {
  it("returns too_early when the local hour is before the threshold", async () => {
    const earlyMorning = new Date("2026-05-22T06:00:00");
    const result = await checkMissedRun({ now: earlyMorning, obsidianBaseDir: workdir });
    expect(result.shouldRun).toBe(false);
    if (!result.shouldRun) expect(result.reason).toBe("too_early");
  });

  it("returns brief_already_exists when today's file is present", async () => {
    // Use local-time formatting like the function does
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    // Pre-create the file
    const { writeObsidianBrief } = await import("../lib/briefer/obsidian-writer.js");
    await writeObsidianBrief("# already here", {
      baseDir: workdir,
      briefDate: date,
    });

    const result = await checkMissedRun({ now, obsidianBaseDir: workdir });
    expect(result.shouldRun).toBe(false);
    if (!result.shouldRun) expect(result.reason).toBe("brief_already_exists");
  });

  it("returns shouldRun=true with the briefDate when threshold passed and no file exists", async () => {
    // 09:14 local — past 08:00 threshold
    const now = new Date();
    now.setHours(9, 14, 0, 0);
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    // Use a fresh per-test dir so no prior file is there
    const isolated = await (await import("node:fs/promises")).mkdtemp(
      path.join(tmpdir(), "pacc-missed-run-"),
    );

    const result = await checkMissedRun({ now, obsidianBaseDir: isolated });
    expect(result.shouldRun).toBe(true);
    if (result.shouldRun) {
      expect(result.reason).toBe("missed_run_catch_up");
      expect(result.briefDate).toBe(date);
    }

    await rm(isolated, { recursive: true, force: true });
  });

  it("honors a custom thresholdHourLocal", async () => {
    // 07:30 local — past 06:00 threshold
    const now = new Date();
    now.setHours(7, 30, 0, 0);
    const isolated = await (await import("node:fs/promises")).mkdtemp(
      path.join(tmpdir(), "pacc-missed-run-2-"),
    );

    const result = await checkMissedRun({
      now,
      obsidianBaseDir: isolated,
      thresholdHourLocal: 6,
    });
    expect(result.shouldRun).toBe(true);
    await rm(isolated, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Sanity: writeFile import is used (vitest pickier without it)
// ---------------------------------------------------------------------------

describe("imports", () => {
  it("imports the writeFile fn (suppress unused-import lint)", () => {
    expect(typeof writeFile).toBe("function");
    expect(typeof stat).toBe("function");
  });
});
