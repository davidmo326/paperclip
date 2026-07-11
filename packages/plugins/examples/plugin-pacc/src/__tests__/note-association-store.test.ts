/**
 * T-2.3 — note-association plugin_state store: per-file record, catalog,
 * and summary (per-project counts + unassociated bucket).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createNoteAssociationStore,
  NOTE_ASSOCIATION_CATALOG_KEY,
  recordKeyForPath,
  type NoteAssociationKv,
} from "../lib/note-association/store.js";
import type { AssociationRecord } from "../lib/note-association/associator-core.js";

function memoryKv(): NoteAssociationKv {
  const rows = new Map<string, unknown>();
  return {
    async get(k) {
      return rows.has(k) ? rows.get(k) : null;
    },
    async set(k, v) {
      rows.set(k, v);
    },
    async delete(k) {
      rows.delete(k);
    },
  };
}

function rec(path: string, projectId: string | null, confidence: number): AssociationRecord {
  return {
    path,
    projectId,
    confidence,
    method: projectId === null ? "none" : "frontmatter",
    associatedAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("note-association store", () => {
  let kv: NoteAssociationKv;

  beforeEach(() => {
    kv = memoryKv();
  });

  it("round-trips a record by path", async () => {
    const store = createNoteAssociationStore(kv);
    await store.put(rec("10_Builds/Circlo/note.md", "circlo", 1.0));
    const got = await store.getByPath("10_Builds/Circlo/note.md");
    expect(got).toMatchObject({ projectId: "circlo", confidence: 1.0 });
  });

  it("getByPath returns null for an unindexed path", async () => {
    const store = createNoteAssociationStore(kv);
    expect(await store.getByPath("nope.md")).toBeNull();
  });

  it("stores records under a hashed, prefixed key (not the raw path)", async () => {
    const store = createNoteAssociationStore(kv);
    await store.put(rec("10_Builds/Circlo/note.md", "circlo", 1.0));
    const raw = await kv.get(recordKeyForPath("10_Builds/Circlo/note.md"));
    expect(raw).not.toBeNull();
    expect(await kv.get("10_Builds/Circlo/note.md")).toBeNull();
  });

  it("maintains a catalog for summary without enumerating per-file keys", async () => {
    const store = createNoteAssociationStore(kv);
    await store.put(rec("a.md", "circlo", 1.0));
    await store.put(rec("b.md", "hometrics", 0.85));
    await store.put(rec("c.md", null, 0));

    const catalog = await kv.get(NOTE_ASSOCIATION_CATALOG_KEY);
    expect(Object.keys(catalog as object)).toHaveLength(3);
  });

  it("summary tallies per-project counts and the unassociated bucket", async () => {
    const store = createNoteAssociationStore(kv);
    await store.put(rec("a.md", "circlo", 1.0));
    await store.put(rec("b.md", "circlo", 0.85));
    await store.put(rec("c.md", "hometrics", 0.6));
    await store.put(rec("d.md", null, 0));
    await store.put(rec("e.md", null, 0));

    const summary = await store.summary();
    expect(summary).toEqual({
      totalNotes: 5,
      unassociatedCount: 2,
      byProject: { circlo: 2, hometrics: 1 },
    });
  });

  it("remove() clears both the record and the catalog entry", async () => {
    const store = createNoteAssociationStore(kv);
    await store.put(rec("a.md", "circlo", 1.0));
    await store.remove("a.md");
    expect(await store.getByPath("a.md")).toBeNull();
    const summary = await store.summary();
    expect(summary.totalNotes).toBe(0);
  });
});
