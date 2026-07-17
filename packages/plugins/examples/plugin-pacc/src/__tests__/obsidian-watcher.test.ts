/**
 * T-2.1 — Obsidian filesystem watcher engine.
 *
 * Pure unit tests: fake readFile/hash/registry deps, synthetic clock driven
 * by explicit `tick(now)` calls (no real timers, no real fs) — see
 * docs/substrate-firewall.md. Real-fs / real-chokidar wiring is exercised
 * separately in `obsidian-watcher-deps.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  createObsidianWatcherEngine,
  shouldIgnorePath,
  type ObsidianWatcherEvent,
} from "../lib/obsidian-watcher.js";

function makeRegistry(protectedPaths: string[]) {
  let paths = protectedPaths;
  let reloadCount = 0;
  return {
    async reload() {
      reloadCount += 1;
    },
    async getProtectedPaths() {
      return paths;
    },
    setPaths(next: string[]) {
      paths = next;
    },
    get reloadCount() {
      return reloadCount;
    },
  };
}

function makeFiles(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    async readFile(p: string): Promise<string> {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    write(p: string, content: string) {
      files.set(p, content);
    },
    remove(p: string) {
      files.delete(p);
    },
  };
}

/**
 * Advances the engine's virtual clock in small steps between `from` and
 * `to`, calling `tick()` at each step. Multi-stage transitions (debounce ->
 * verify -> emit) reschedule themselves `verifyDelayMs` after the tick call
 * that observed them, so a single `tick(farFutureNow)` call can't resolve a
 * whole chain in one shot — the caller must call `tick()` again once that
 * later deadline itself has passed. This mirrors the real adapter, which
 * drives `tick()` from a recurring timer rather than a single deferred call.
 */
async function advance(
  engine: { tick(now: number): Promise<void> },
  from: number,
  to: number,
  step = 5,
): Promise<void> {
  for (let t = from; t <= to; t += step) {
    await engine.tick(t);
  }
}

function simpleHash(content: string): string {
  // Deterministic, collision-irrelevant for these tests.
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (h * 31 + content.charCodeAt(i)) | 0;
  }
  return `h${h}`;
}

describe("shouldIgnorePath", () => {
  it("ignores .obsidian/, .trash/, .git/ at any depth", () => {
    expect(shouldIgnorePath("/vault/.obsidian/plugins/x.md")).toBe(true);
    expect(shouldIgnorePath("/vault/.trash/old.md")).toBe(true);
    expect(shouldIgnorePath("/vault/.git/HEAD")).toBe(true);
    expect(shouldIgnorePath("/vault/10_Builds/.git/config")).toBe(true);
  });

  it("ignores *.tmp, ~$*, *.swp, *.tmp-* (mediator atomic writes)", () => {
    expect(shouldIgnorePath("/vault/note.md.tmp")).toBe(true);
    expect(shouldIgnorePath("/vault/~$note.md")).toBe(true);
    expect(shouldIgnorePath("/vault/note.md.swp")).toBe(true);
    expect(shouldIgnorePath("/vault/note.md.tmp-ab12cd")).toBe(true);
  });

  it("ignores Excalidraw swap files", () => {
    expect(shouldIgnorePath("/vault/Excalidraw/Drawing.excalidraw.md.swp")).toBe(true);
  });

  it("does not ignore regular notes", () => {
    expect(shouldIgnorePath("/vault/10_Builds/Circlo/PRD.md")).toBe(false);
    expect(shouldIgnorePath("/vault/Value Anchors.md")).toBe(false);
  });
});

describe("ObsidianWatcherEngine — ignore list", () => {
  it("emits nothing for writes under .obsidian/, .trash/, or *.tmp- files", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles();
    const registry = makeRegistry([]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
    });

    files.write("/vault/.obsidian/workspace.json", "{}");
    engine.handleChange("/vault/.obsidian/workspace.json", 0);
    files.write("/vault/.trash/gone.md", "trashed");
    engine.handleAdd("/vault/.trash/gone.md", 0);
    files.write("/vault/note.md.tmp-abc123", "partial");
    engine.handleAdd("/vault/note.md.tmp-abc123", 0);

    await engine.tick(0);
    await engine.tick(1000);

    expect(events).toHaveLength(0);
  });
});

describe("ObsidianWatcherEngine — change detection", () => {
  it("emits source.note.changed within the debounce+verify window", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/note.md": "hello" });
    const registry = makeRegistry(["/vault/Value Anchors.md"]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 250,
      verifyDelayMs: 60,
    });

    engine.handleChange("/vault/note.md", 0);
    await engine.tick(100); // before debounce fires
    expect(events).toHaveLength(0);

    await engine.tick(260); // debounce fires, first read
    expect(events).toHaveLength(0); // still awaiting verify read

    await engine.tick(330); // verify read, hash stable -> emit
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("source.note.changed");
    if (ev.type === "source.note.changed") {
      expect(ev.path).toBe("/vault/note.md");
      expect(ev.hash).toBe(simpleHash("hello"));
      expect(ev.tier).toBe("M1a");
    }
  });

  it("tags a registry-listed note M1b and a regular note M1a", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({
      "/vault/Anchor Note.md": "anchor content",
      "/vault/Regular Note.md": "regular content",
    });
    const registry = makeRegistry(["/vault/Value Anchors.md", "/vault/Anchor Note.md"]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 10,
      verifyDelayMs: 5,
    });

    engine.handleChange("/vault/Anchor Note.md", 0);
    engine.handleChange("/vault/Regular Note.md", 0);
    await advance(engine, 0, 30);

    const byPath = new Map(events.map((e) => [(e as { path?: string }).path, e]));
    const anchorEvent = byPath.get("/vault/Anchor Note.md");
    const regularEvent = byPath.get("/vault/Regular Note.md");
    expect(anchorEvent?.type).toBe("source.note.changed");
    expect(regularEvent?.type).toBe("source.note.changed");
    if (anchorEvent?.type === "source.note.changed") expect(anchorEvent.tier).toBe("M1b");
    if (regularEvent?.type === "source.note.changed") expect(regularEvent.tier).toBe("M1a");
  });

  it("reloads the registry when the registry note itself changes, before tagging", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/Value Anchors.md": "# registry v2" });
    const registry = makeRegistry(["/vault/Value Anchors.md"]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 10,
      verifyDelayMs: 5,
    });

    engine.handleChange("/vault/Value Anchors.md", 0);
    await advance(engine, 0, 30);

    expect(registry.reloadCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("source.note.changed");
    if (events[0]?.type === "source.note.changed") expect(events[0].tier).toBe("M1b");
  });

  it("torn-write handling: retries once when the hash is still moving, then emits", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/note.md": "partial-1" });
    const registry = makeRegistry([]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 10,
      verifyDelayMs: 5,
    });

    engine.handleChange("/vault/note.md", 0);
    await engine.tick(10); // debounce fires: reads "partial-1"
    expect(events).toHaveLength(0);

    // Torn write: content changes again before the verify read.
    files.write("/vault/note.md", "partial-2-final");
    await engine.tick(15); // verify read: hash differs -> retry once, don't emit yet
    expect(events).toHaveLength(0);

    await engine.tick(20); // second verify read: hash stable now -> emit
    expect(events).toHaveLength(1);
    if (events[0]?.type === "source.note.changed") {
      expect(events[0].hash).toBe(simpleHash("partial-2-final"));
    }
  });
});

describe("ObsidianWatcherEngine — rename detection", () => {
  it("A disappearing + B appearing within 500ms with the same hash -> ONE renamed event, zero delete+create", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/A.md": "same content" });
    const registry = makeRegistry([]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 10,
      verifyDelayMs: 5,
      renameWindowMs: 500,
    });

    // Establish A's known hash first (as if the indexer already saw it).
    engine.handleChange("/vault/A.md", 0);
    await advance(engine, 0, 30);
    expect(events).toHaveLength(1);
    events.length = 0;

    // Now: A disappears, B appears with identical content, within 500ms.
    files.remove("/vault/A.md");
    engine.handleUnlink("/vault/A.md", 1000);
    files.write("/vault/B.md", "same content");
    engine.handleAdd("/vault/B.md", 1050);

    await engine.tick(1070); // debounce fires for B; should match the pending delete for A

    const renameEvents = events.filter((e) => e.type === "source.note.renamed");
    const deleteEvents = events.filter((e) => e.type === "source.note.deleted");
    const changeEvents = events.filter((e) => e.type === "source.note.changed");
    expect(renameEvents).toHaveLength(1);
    expect(deleteEvents).toHaveLength(0);
    expect(changeEvents).toHaveLength(0);
    expect(renameEvents[0]).toMatchObject({ oldPath: "/vault/A.md", newPath: "/vault/B.md" });

    // Advancing time past the original rename window must not retroactively
    // fire a stray delete for A — the pending delete was consumed.
    await engine.tick(2000);
    expect(events.filter((e) => e.type === "source.note.deleted")).toHaveLength(0);
  });

  it("A disappearing with no matching add within the window emits source.note.deleted", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/A.md": "content" });
    const registry = makeRegistry([]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      renameWindowMs: 500,
    });

    engine.handleChange("/vault/A.md", 0);
    await advance(engine, 0, 400, 20); // past default debounce+verify, establishes known hash
    events.length = 0;

    files.remove("/vault/A.md");
    engine.handleUnlink("/vault/A.md", 1000);
    await engine.tick(1400); // 400ms later, no add arrived yet
    expect(events).toHaveLength(0);

    await engine.tick(1501); // window (500ms) has elapsed
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "source.note.deleted", path: "/vault/A.md" });
  });

  it("an unrelated add during the rename window (different hash) does not suppress the eventual delete", async () => {
    const events: ObsidianWatcherEvent[] = [];
    const files = makeFiles({ "/vault/A.md": "content-A" });
    const registry = makeRegistry([]);
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      emit: (e) => void events.push(e),
      debounceMs: 10,
      verifyDelayMs: 5,
      renameWindowMs: 500,
    });

    engine.handleChange("/vault/A.md", 0);
    await advance(engine, 0, 30);
    events.length = 0;

    files.remove("/vault/A.md");
    engine.handleUnlink("/vault/A.md", 1000);
    files.write("/vault/C.md", "unrelated content");
    engine.handleAdd("/vault/C.md", 1050);
    await advance(engine, 1050, 1070);

    expect(events.filter((e) => e.type === "source.note.renamed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "source.note.changed")).toHaveLength(1);

    await engine.tick(1600); // rename window elapses
    expect(events.filter((e) => e.type === "source.note.deleted")).toHaveLength(1);
  });
});

describe("ObsidianWatcherEngine — tick re-entrancy guard (T-2.2-burst)", () => {
  // Reproduces the live storm at unit scale: the adapter drives tick() off a
  // fire-and-forget `setInterval(..., 50)`, so a slow tick (initial-scan burst
  // fanning out to the indexer's state.set RPCs) overlaps subsequent ticks,
  // which drain the same pending-changes queue CONCURRENTLY and flood the
  // worker→host RPC channel until every call times out. The guard must make
  // the drain sequential — at most one emit in flight at a time.
  it("skips ticks fired while another is in flight so a burst drains sequentially (no concurrent RPC flood)", async () => {
    const files = makeFiles({
      "/vault/a.md": "a",
      "/vault/b.md": "b",
      "/vault/c.md": "c",
    });
    const registry = makeRegistry([]);
    let resolveEmit!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const engine = createObsidianWatcherEngine({
      readFile: files.readFile,
      hash: simpleHash,
      registry,
      debounceMs: 0,
      verifyDelayMs: 0,
      // Each emit parks until the test releases it; track concurrent in-flight emits.
      emit: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) => {
          resolveEmit = () => {
            inFlight -= 1;
            resolve();
          };
        });
      },
    });

    // Three files due immediately.
    engine.handleAdd("/vault/a.md", 0);
    engine.handleAdd("/vault/b.md", 0);
    engine.handleAdd("/vault/c.md", 0);

    // Debounce pass (schedules the verifies). No emit here, so it resolves fast.
    await engine.tick(1000);

    // Verify pass: this is where emits happen. Fire the verifying tick, then
    // extra ticks while it's in flight — exactly what the 50ms fire-and-forget
    // timer does. The first parks on file a's emit; the rest must skip.
    const tickVerify = engine.tick(1000);
    void engine.tick(1000); // would double-process concurrently without the guard
    void engine.tick(1000);
    await new Promise((r) => setTimeout(r, 0));

    expect(maxInFlight).toBe(1); // only file a; the concurrent ticks were skipped

    // Release file a; the same in-flight tick moves on to b, then c, sequentially.
    resolveEmit();
    await new Promise((r) => setTimeout(r, 0));
    expect(maxInFlight).toBe(1);
    resolveEmit();
    await new Promise((r) => setTimeout(r, 0));
    resolveEmit();
    await tickVerify;

    expect(maxInFlight).toBe(1); // never concurrent across the whole drain
  });
});
