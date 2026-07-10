/**
 * T-2.2b — glue between the T-2.1 vault watcher and the T-2.2 source
 * indexer, so the index stays live after the initial scan.
 *
 * `withSourceIndexForwarding` wraps an `ObsidianWatcherEventEmitter` so that,
 * in addition to whatever the wrapped emitter does (in production:
 * `ctx.events.emit`), every markdown watcher event is ALSO forwarded to the
 * corresponding T-2.2 indexer `apply*` function. Non-markdown watcher events
 * (the watcher may observe more than `.md`) must not reach the indexer, and
 * an indexer failure on one event must not stop subsequent events from
 * reaching either the wrapped emitter or the indexer.
 */

import { describe, expect, it, vi } from "vitest";
import {
  withSourceIndexForwarding,
  type SourceIndexForwarderDeps,
} from "../lib/obsidian-watcher-deps.js";
import type { ObsidianWatcherEvent } from "../lib/obsidian-watcher.js";

function makeIndexer(overrides: Partial<SourceIndexForwarderDeps> = {}): {
  deps: SourceIndexForwarderDeps;
  calls: { changed: unknown[]; renamed: unknown[]; deleted: unknown[] };
  warnings: unknown[];
} {
  const calls = { changed: [] as unknown[], renamed: [] as unknown[], deleted: [] as unknown[] };
  const warnings: unknown[] = [];
  const deps: SourceIndexForwarderDeps = {
    applyNoteChanged: vi.fn(async (event) => {
      calls.changed.push(event);
    }),
    applyNoteRenamed: vi.fn(async (event) => {
      calls.renamed.push(event);
    }),
    applyNoteDeleted: vi.fn(async (event) => {
      calls.deleted.push(event);
    }),
    logger: { warn: (msg, fields) => warnings.push({ msg, fields }) },
    ...overrides,
  };
  return { deps, calls, warnings };
}

describe("withSourceIndexForwarding", () => {
  it("forwards source.note.changed to applyNoteChanged with the event's path", async () => {
    const { deps, calls } = makeIndexer();
    const downstream: ObsidianWatcherEvent[] = [];
    const emit = withSourceIndexForwarding((e) => void downstream.push(e), deps);

    const event: ObsidianWatcherEvent = {
      type: "source.note.changed",
      path: "/vault/Note.md",
      hash: "abc123",
      modifiedAt: "2026-07-09T00:00:00.000Z",
      tier: "M1a",
    };
    await emit(event);

    expect(calls.changed).toEqual([{ path: "/vault/Note.md" }]);
    expect(downstream).toEqual([event]);
  });

  it("forwards source.note.renamed to applyNoteRenamed with oldPath/newPath", async () => {
    const { deps, calls } = makeIndexer();
    const emit = withSourceIndexForwarding(() => {}, deps);

    await emit({
      type: "source.note.renamed",
      oldPath: "/vault/Old.md",
      newPath: "/vault/New.md",
      hash: "abc123",
      tier: "M1a",
    });

    expect(calls.renamed).toEqual([{ oldPath: "/vault/Old.md", newPath: "/vault/New.md" }]);
  });

  it("forwards source.note.deleted to applyNoteDeleted with the event's path", async () => {
    const { deps, calls } = makeIndexer();
    const emit = withSourceIndexForwarding(() => {}, deps);

    await emit({ type: "source.note.deleted", path: "/vault/Gone.md", tier: "M1a" });

    expect(calls.deleted).toEqual([{ path: "/vault/Gone.md" }]);
  });

  it("does not forward non-.md watcher events to the indexer", async () => {
    const { deps, calls } = makeIndexer();
    const downstream: ObsidianWatcherEvent[] = [];
    const emit = withSourceIndexForwarding((e) => void downstream.push(e), deps);

    const changed: ObsidianWatcherEvent = {
      type: "source.note.changed",
      path: "/vault/attachment.png",
      hash: "abc123",
      modifiedAt: "2026-07-09T00:00:00.000Z",
      tier: "M1a",
    };
    const deleted: ObsidianWatcherEvent = {
      type: "source.note.deleted",
      path: "/vault/attachment.png",
      tier: "M1a",
    };
    await emit(changed);
    await emit(deleted);

    expect(calls.changed).toEqual([]);
    expect(calls.deleted).toEqual([]);
    // Still forwarded downstream (e.g. to ctx.events) — only the indexer is
    // markdown-scoped.
    expect(downstream).toEqual([changed, deleted]);
  });

  it("logs and continues when the indexer throws, without stopping subsequent events", async () => {
    const { deps, calls, warnings } = makeIndexer({
      applyNoteChanged: vi.fn(async (event: { path: string }) => {
        if (event.path === "/vault/Broken.md") {
          throw new Error("boom");
        }
        calls.changed.push(event);
      }),
    });
    const downstream: ObsidianWatcherEvent[] = [];
    const emit = withSourceIndexForwarding((e) => void downstream.push(e), deps);

    await emit({
      type: "source.note.changed",
      path: "/vault/Broken.md",
      hash: "h1",
      modifiedAt: "2026-07-09T00:00:00.000Z",
      tier: "M1a",
    });
    await emit({
      type: "source.note.changed",
      path: "/vault/Fine.md",
      hash: "h2",
      modifiedAt: "2026-07-09T00:00:01.000Z",
      tier: "M1a",
    });

    // The broken note's failure didn't throw out of emit (watcher survives)
    // and the second event still reached the indexer.
    expect(calls.changed).toEqual([{ path: "/vault/Fine.md" }]);
    expect(downstream).toHaveLength(2);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("treats a rename OUT of markdown scope as a deletion of the old path", async () => {
    // note.md -> note.txt: the watcher hash-correlates this into ONE rename
    // event; the index held a record for note.md and must drop it, or the
    // record goes permanently stale.
    await emit({
      type: "source.note.renamed",
      oldPath: "/vault/note.md",
      newPath: "/vault/note.txt",
      hash: "h1",
      tier: "M1a",
    });
    expect(indexerCalls.renamed).toHaveLength(0);
    expect(indexerCalls.deleted).toEqual([{ path: "/vault/note.md" }]);
  });
});
