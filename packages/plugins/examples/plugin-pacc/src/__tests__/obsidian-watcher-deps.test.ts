/**
 * T-2.1 — real-fs / real-chokidar integration for the Obsidian watcher
 * adapter. Complements `obsidian-watcher.test.ts` (pure engine unit tests
 * with fake deps/clock): this file exercises the actual `startObsidianWatcher`
 * wiring against a temp fixture vault, proving the acceptance criteria that
 * require real chokidar + real fs timing:
 *   - touching a file emits `source.note.changed` within 1s
 *   - rename (A -> B within 500ms) collapses to one `source.note.renamed`
 *   - ignore-list writes (.obsidian/, .trash/, *.tmp-*) emit nothing
 *   - tier tagging: registry-listed note -> M1b, regular note -> M1a
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startObsidianWatcher, type ObsidianWatcherHandle } from "../lib/obsidian-watcher-deps.js";
import { createValueAnchorService } from "../lib/value-anchor/service.js";
import type { ObsidianWatcherEvent } from "../lib/obsidian-watcher.js";

let vaultRoot: string;
let handle: ObsidianWatcherHandle | null = null;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "pacc-t21-vault-"));
  await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
  await mkdir(path.join(vaultRoot, ".trash"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "Value Anchors.md"),
    "# Value Anchors\n\n## Registry\n\n- [[Anchor Note]] — test anchor\n",
  );
  await writeFile(path.join(vaultRoot, "Anchor Note.md"), "anchor original\n");
  await writeFile(path.join(vaultRoot, "Regular Note.md"), "regular original\n");
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await rm(vaultRoot, { recursive: true, force: true });
});

function waitForEvents(
  events: ObsidianWatcherEvent[],
  predicate: (events: ObsidianWatcherEvent[]) => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (predicate(events)) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for events: ${JSON.stringify(events)}`));
      }
    }, 20);
  });
}

describe("startObsidianWatcher (real fs + real chokidar)", () => {
  it("emits source.note.changed within 1s of touching a file", async () => {
    const events: ObsidianWatcherEvent[] = [];
    handle = await startObsidianWatcher({
      vaultRoot,
      emit: (e) => void events.push(e),
      tickIntervalMs: 20,
    });

    const target = path.join(vaultRoot, "Regular Note.md");
    const started = Date.now();
    await writeFile(target, "regular changed\n");

    await waitForEvents(
      events,
      (evs) => evs.some((e) => e.type === "source.note.changed" && e.path === target),
      1000,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
  }, 5000);

  it("tags a registry-listed note M1b and a regular note M1a", async () => {
    const events: ObsidianWatcherEvent[] = [];
    handle = await startObsidianWatcher({
      vaultRoot,
      emit: (e) => void events.push(e),
      tickIntervalMs: 20,
    });

    const anchorPath = path.join(vaultRoot, "Anchor Note.md");
    const regularPath = path.join(vaultRoot, "Regular Note.md");
    await writeFile(anchorPath, "anchor changed\n");
    await writeFile(regularPath, "regular changed\n");

    await waitForEvents(
      events,
      (evs) =>
        evs.some((e) => e.type === "source.note.changed" && e.path === anchorPath) &&
        evs.some((e) => e.type === "source.note.changed" && e.path === regularPath),
      1000,
    );

    const anchorEvent = events.find((e) => e.type === "source.note.changed" && e.path === anchorPath);
    const regularEvent = events.find((e) => e.type === "source.note.changed" && e.path === regularPath);
    expect(anchorEvent && "tier" in anchorEvent ? anchorEvent.tier : null).toBe("M1b");
    expect(regularEvent && "tier" in regularEvent ? regularEvent.tier : null).toBe("M1a");
  }, 5000);

  it("emits nothing for writes under .obsidian/, .trash/, or *.tmp-* files", async () => {
    const events: ObsidianWatcherEvent[] = [];
    handle = await startObsidianWatcher({
      vaultRoot,
      emit: (e) => void events.push(e),
      tickIntervalMs: 20,
    });
    // Let the initial-scan add events for the fixture's pre-existing notes
    // settle before asserting on the ignore-list behavior in isolation.
    await new Promise((resolve) => setTimeout(resolve, 400));
    events.length = 0;

    await writeFile(path.join(vaultRoot, ".obsidian", "workspace.json"), "{}");
    await writeFile(path.join(vaultRoot, ".trash", "gone.md"), "trashed");
    await writeFile(path.join(vaultRoot, "note.md.tmp-abc123"), "partial mediator write");

    // Give the watcher a generous window to (not) react.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events).toHaveLength(0);
  }, 5000);

  it("collapses an A -> B rename (within 500ms) into one source.note.renamed, zero delete+create", async () => {
    const events: ObsidianWatcherEvent[] = [];
    handle = await startObsidianWatcher({
      vaultRoot,
      emit: (e) => void events.push(e),
      tickIntervalMs: 20,
    });

    const oldPath = path.join(vaultRoot, "Regular Note.md");
    const newPath = path.join(vaultRoot, "Renamed Note.md");

    // Let the initial content settle into the engine's lastKnownHash cache
    // (mirrors an indexer that already scanned the vault once).
    await new Promise((resolve) => setTimeout(resolve, 400));
    events.length = 0;

    await rename(oldPath, newPath);

    await waitForEvents(
      events,
      (evs) => evs.some((e) => e.type === "source.note.renamed"),
      1500,
    );

    const renameEvents = events.filter((e) => e.type === "source.note.renamed");
    const deleteEvents = events.filter((e) => e.type === "source.note.deleted");
    const changeEvents = events.filter(
      (e) => e.type === "source.note.changed" && (e.path === oldPath || e.path === newPath),
    );
    expect(renameEvents).toHaveLength(1);
    expect(deleteEvents).toHaveLength(0);
    expect(changeEvents).toHaveLength(0);
    expect(renameEvents[0]).toMatchObject({ oldPath, newPath });
  }, 5000);
});

describe("createValueAnchorService reuse (T-2.4)", () => {
  it("the watcher's registry service reload is wired to the same T-2.4 service surface", async () => {
    const service = createValueAnchorService({ vaultRoot });
    await service.reload();
    expect(service.getValueAnchors().map((a) => a.name)).toEqual(["Anchor Note"]);

    const events: ObsidianWatcherEvent[] = [];
    handle = await startObsidianWatcher({
      vaultRoot,
      emit: (e) => void events.push(e),
      registryService: service,
      tickIntervalMs: 20,
    });

    const anchorPath = path.join(vaultRoot, "Anchor Note.md");
    await writeFile(anchorPath, "anchor changed again\n");
    await waitForEvents(
      events,
      (evs) => evs.some((e) => e.type === "source.note.changed" && e.path === anchorPath),
      1000,
    );
    const ev = events.find((e) => e.type === "source.note.changed" && e.path === anchorPath);
    expect(ev && "tier" in ev ? ev.tier : null).toBe("M1b");
  }, 5000);
});
