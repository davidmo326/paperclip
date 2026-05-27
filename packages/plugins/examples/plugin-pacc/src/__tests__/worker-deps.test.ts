/**
 * T-3.x worker-integration tests.
 *
 * Drives the worker-deps factory with a stub WorkerCtx (in-memory
 * plugin_state + recorded events). Verifies:
 *   - overlap store round-trips through plugin_state
 *   - hallucination deps read/write flags + pause
 *   - assembleProjectCards reads projects + overlays, skips closed
 *   - makeScheduledBriefDeps wires everything + end-to-end runScheduledBrief
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assembleProjectCards,
  makeHallucinationDeps,
  makeOverlapStore,
  makeScheduledBriefDeps,
  type WorkerCtx,
  type WorkerCtxProject,
} from "../lib/briefer/worker-deps.js";
import { runScheduledBrief } from "../lib/briefer/scheduled-brief.js";
import {
  BRIEFER_PAUSED_STATE_KEY,
  CONFLICTS_STATE_KEY,
  FRESHNESS_STATE_KEY,
  HALLUCINATION_FLAGS_STATE_KEY,
  PLUGIN_NAMESPACE,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Stub WorkerCtx
// ---------------------------------------------------------------------------

interface StubState {
  companies: Array<{ id: string }>;
  projectsByCompany: Map<string, WorkerCtxProject[]>;
  store: Map<string, unknown>;
  events: Array<{ name: string; companyId: string; payload: unknown }>;
}

function keyStr(k: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }): string {
  return `${k.scopeKind}:${k.scopeId ?? ""}:${k.namespace ?? ""}:${k.stateKey}`;
}

function makeCtx(state: StubState): WorkerCtx {
  return {
    companies: {
      async list() {
        return state.companies;
      },
    },
    projects: {
      async list({ companyId }) {
        return state.projectsByCompany.get(companyId) ?? [];
      },
    },
    state: {
      async get(k) {
        return state.store.get(keyStr(k)) ?? null;
      },
      async set(k, v) {
        state.store.set(keyStr(k), v);
      },
      async delete(k) {
        state.store.delete(keyStr(k));
      },
    },
    events: {
      async emit(name, companyId, payload) {
        state.events.push({ name, companyId, payload });
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function freshState(over: Partial<StubState> = {}): StubState {
  return {
    companies: [],
    projectsByCompany: new Map(),
    store: new Map(),
    events: [],
    ...over,
  };
}

function project(id: string, cps: Record<string, unknown> | null): WorkerCtxProject {
  return { id, name: `P-${id}`, controlPlaneState: cps };
}

let state: StubState;
beforeEach(() => {
  state = freshState();
});

// ---------------------------------------------------------------------------
// Overlap store
// ---------------------------------------------------------------------------

describe("makeOverlapStore", () => {
  it("round-trips a lock through plugin_state (instance scope)", async () => {
    const store = makeOverlapStore(makeCtx(state));
    expect(await store.read()).toBeNull();
    await store.write({ acquiredAt: "2026-05-22T08:00:00.000Z", runId: "r1" });
    expect(await store.read()).toMatchObject({ runId: "r1" });
    await store.clear();
    expect(await store.read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hallucination deps
// ---------------------------------------------------------------------------

describe("makeHallucinationDeps", () => {
  it("reads/writes the flag counter + pause flag", async () => {
    const deps = makeHallucinationDeps(makeCtx(state), new Set(["circlo"]));
    expect(await deps.readFlags()).toBeNull();
    await deps.writeFlags({ flags: [{ at: "2026-05-22T08:00:00.000Z", briefDate: "2026-05-22", refs: ["x"] }] });
    expect((await deps.readFlags())?.flags).toHaveLength(1);

    expect(await deps.isPaused()).toEqual({ paused: false, reason: null });
    await deps.setPaused("3 flags in window");
    const p = await deps.isPaused();
    expect(p.paused).toBe(true);
    expect(p.reason).toBe("3 flags in window");
  });

  it("stores flags under the instance-scoped hallucination key", async () => {
    const deps = makeHallucinationDeps(makeCtx(state), new Set());
    await deps.writeFlags({ flags: [] });
    const expectedKey = `instance::${PLUGIN_NAMESPACE}:${HALLUCINATION_FLAGS_STATE_KEY}`;
    expect(state.store.has(expectedKey)).toBe(true);
  });

  it("stores the pause flag under the instance-scoped pause key", async () => {
    const deps = makeHallucinationDeps(makeCtx(state), new Set());
    await deps.setPaused("x");
    const expectedKey = `instance::${PLUGIN_NAMESPACE}:${BRIEFER_PAUSED_STATE_KEY}`;
    expect(state.store.has(expectedKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleProjectCards
// ---------------------------------------------------------------------------

describe("assembleProjectCards", () => {
  it("builds a card per active project across companies", async () => {
    state.companies = [{ id: "co-1" }, { id: "co-2" }];
    state.projectsByCompany.set("co-1", [
      project("a", { portfolioState: "active", currentPhase: "validate", intent: "Validate A" }),
    ]);
    state.projectsByCompany.set("co-2", [
      project("b", { portfolioState: "primary", currentPhase: "build", intent: "Build B" }),
    ]);

    const cards = await assembleProjectCards(makeCtx(state));
    expect(cards.map((c) => c.projectId).sort()).toEqual(["a", "b"]);
    expect(cards.find((c) => c.projectId === "a")?.card.goal.answer).toBe("Validate A");
  });

  it("skips closed projects", async () => {
    state.companies = [{ id: "co-1" }];
    state.projectsByCompany.set("co-1", [
      project("open", { portfolioState: "active" }),
      project("closed", { portfolioState: "closed" }),
    ]);
    const cards = await assembleProjectCards(makeCtx(state));
    expect(cards.map((c) => c.projectId)).toEqual(["open"]);
  });

  it("folds the freshness/decay/conflict overlays into the card stale markers", async () => {
    state.companies = [{ id: "co-1" }];
    state.projectsByCompany.set("co-1", [project("a", { portfolioState: "active" })]);
    // Seed a conflict overlay for project 'a'
    state.store.set(`project:a:${PLUGIN_NAMESPACE}:${CONFLICTS_STATE_KEY}`, {
      projectId: "a",
      updatedAt: "2026-05-22T00:00:00.000Z",
      byField: {
        currentStatus: {
          fieldPath: "currentStatus",
          createdAt: "2026-05-22T00:00:00.000Z",
          resolvedAt: null,
          resolvedBy: null,
          candidates: [],
        },
      },
    });
    // Seed a freshness overlay with drift
    state.store.set(`project:a:${PLUGIN_NAMESPACE}:${FRESHNESS_STATE_KEY}`, {
      projectId: "a",
      generatedAt: "2026-05-22T00:00:00.000Z",
      totalRefs: 1,
      freshCount: 0,
      staleCount: 1,
      orphanedCount: 0,
      hasDrift: true,
      drifts: [{ path: "/v/x.md", kind: "stale", expectedHash: "old", currentHash: "new" }],
    });

    const cards = await assembleProjectCards(makeCtx(state));
    const markers = cards[0].card.staleMarkers.map((m) => m.kind);
    expect(markers).toContain("conflict");
    expect(markers).toContain("drift");
  });

  it("returns [] when there are no companies", async () => {
    expect(await assembleProjectCards(makeCtx(state))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// makeScheduledBriefDeps — end-to-end
// ---------------------------------------------------------------------------

describe("makeScheduledBriefDeps + runScheduledBrief (end-to-end)", () => {
  let workdir: string;
  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "pacc-worker-deps-"));
  });
  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("assembles deps and runs a complete brief to Obsidian", async () => {
    state.companies = [{ id: "co-1" }];
    state.projectsByCompany.set("co-1", [
      project("circlo", {
        portfolioState: "primary",
        currentPhase: "validate",
        intent: "Validate distribution",
        nextSmallestAction: "Email cohort A",
      }),
    ]);

    const { deps, eventCompanyId } = await makeScheduledBriefDeps(makeCtx(state));
    expect(eventCompanyId).toBe("co-1");

    const result = await runScheduledBrief(deps, {
      now: new Date("2026-05-22T08:00:00.000Z"),
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      const content = await readFile(result.obsidianWrite.path, "utf8");
      expect(content).toContain("# Daily Operating Brief - 2026-05-22");
      expect(content).toContain("Email cohort A");
      expect(result.hallucinationFlagCount).toBe(0);
      expect(result.selfPaused).toBe(false);
    }
    // brief.generated event emitted with the company id
    expect(state.events.some((e) => e.name === "steward.brief.generated" && e.companyId === "co-1")).toBe(true);
  });

  it("writes a stub brief + skips when the briefer is paused", async () => {
    state.companies = [{ id: "co-1" }];
    state.projectsByCompany.set("co-1", [project("a", { portfolioState: "active" })]);
    // Pre-pause the briefer
    state.store.set(`instance::${PLUGIN_NAMESPACE}:${BRIEFER_PAUSED_STATE_KEY}`, {
      paused: true,
      reason: "manual test pause",
    });

    const { deps } = await makeScheduledBriefDeps(makeCtx(state));
    const result = await runScheduledBrief(deps, {
      now: new Date("2026-05-22T08:00:00.000Z"),
      obsidianBaseDir: workdir,
      brieferOptions: { skipModel: true },
    });

    expect(result.kind).toBe("skipped_paused");
    if (result.kind === "skipped_paused") {
      const content = await readFile(result.obsidianWrite.path, "utf8");
      expect(content).toContain("BRIEFER PAUSED");
      expect(content).toContain("manual test pause");
    }
  });
});
