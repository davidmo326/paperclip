/**
 * T-2.2 — source index: pure core, plugin_state-backed store, interruptible
 * initial scan, and the T-2.1 event-consumption surface.
 *
 * Acceptance coverage (PLAN T-2.2 + v3 amendments):
 *   - fixture scan indexes every file with all record fields;
 *   - single-note re-index < 2s (timing assertion);
 *   - interruptibility: stop mid-scan → restart → completes without
 *     re-reading already-indexed files (read-count spy);
 *   - rename moves the record (old key gone, new key present, hash kept);
 *   - frontmatter extraction verified against a REAL note shape copied from
 *     10_Builds/ (Circlo/BRM_philosophy.md — list-valued tags, quoted
 *     wikilink topics/related, scalar type/created/status);
 *   - records are tier-agnostic (no M1a/M1b field — joined at query time).
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildIndexRecord,
  computeConfidence,
  extractSummary,
  extractWikilinks,
  hashContent,
  parseFrontmatter,
} from "../lib/source-index/index-core.js";
import {
  createSourceIndexStore,
  recordKeyForPath,
  SOURCE_INDEX_CATALOG_KEY,
  SOURCE_INDEX_SCAN_CHECKPOINT_KEY,
  type SourceIndexKv,
} from "../lib/source-index/store.js";
import {
  applyNoteChanged,
  applyNoteDeleted,
  applyNoteRenamed,
  runInitialScan,
  toVaultRelative,
  type SourceIndexerDeps,
  type SourceIndexerFs,
} from "../lib/source-index/indexer.js";
import { createSourceIndexerFs } from "../lib/source-index/fs-deps.js";
import { makeSourceIndexerDeps, makeSourceIndexKv } from "../lib/source-index/worker-deps.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function memoryKv(): SourceIndexKv & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
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

/** Fs port over an in-memory vault map (relPath → content), with a read spy. */
function memoryFs(
  vaultRoot: string,
  files: Map<string, string>,
): SourceIndexerFs & { readCounts: Map<string, number> } {
  const readCounts = new Map<string, number>();
  return {
    readCounts,
    async listMarkdownFiles() {
      return [...files.keys()].map((rel) => path.join(vaultRoot, rel));
    },
    async readFile(absPath) {
      const rel = path.relative(vaultRoot, absPath);
      readCounts.set(rel, (readCounts.get(rel) ?? 0) + 1);
      const content = files.get(rel);
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    },
    async statModifiedAt() {
      return "2026-07-09T00:00:00.000Z";
    },
  };
}

function makeDeps(
  vaultRoot: string,
  files: Map<string, string>,
): SourceIndexerDeps & {
  fs: ReturnType<typeof memoryFs>;
  kv: ReturnType<typeof memoryKv>;
} {
  const kv = memoryKv();
  const fs = memoryFs(vaultRoot, files);
  return { vaultRoot, fs, store: createSourceIndexStore(kv), kv };
}

const VAULT = "/vault";

/**
 * REAL frontmatter shape — copied from
 * /home/ubuntu/llm_shared/Obsidian/10_Builds/Circlo/BRM_philosophy.md
 * (fixture copy per acceptance criteria; tests never read the live vault).
 */
const REAL_NOTE = `---
type: build
tags:
  - benefits
  - brm
  - decision-making
topics:
  - "[[Benefits Realization]]"
  - "[[Metrics & Measurement]]"
  - "[[Strategy]]"
related:
  - "[[Working messaging]]"
  - "[[Startup Ladder of Value]]"
created: 2026-01-27
status: archive
---
Role
You are a Value Architect and Strategic Contrarian. Your purpose is to dismantle the "delivery-as-success" delusion in enterprise programs.

1. The Philosophy (The Core Truths)
The Chasm: Project Delivery (outputs) and Business Operations (outcomes) are separated by a canyon.
`;

// ---------------------------------------------------------------------------
// index-core: frontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses the real 10_Builds note shape: scalars, lists, quoted wikilinks", () => {
    const { frontmatter, body } = parseFrontmatter(REAL_NOTE);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.type).toBe("build");
    expect(frontmatter?.status).toBe("archive");
    expect(frontmatter?.created).toBe("2026-01-27");
    expect(frontmatter?.tags).toEqual(["benefits", "brm", "decision-making"]);
    expect(frontmatter?.topics).toEqual([
      "[[Benefits Realization]]",
      "[[Metrics & Measurement]]",
      "[[Strategy]]",
    ]);
    expect(frontmatter?.related).toEqual(["[[Working messaging]]", "[[Startup Ladder of Value]]"]);
    expect(body.startsWith("Role\n")).toBe(true);
  });

  it("returns null frontmatter for notes without a block", () => {
    const { frontmatter, body } = parseFrontmatter("# Heading\n\nBody text.\n");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# Heading\n\nBody text.\n");
  });

  it("handles CRLF line endings", () => {
    const { frontmatter } = parseFrontmatter("---\r\ntype: build\r\n---\r\nBody\r\n");
    expect(frontmatter?.type).toBe("build");
  });

  it("unquotes single- and double-quoted scalars", () => {
    const { frontmatter } = parseFrontmatter(`---\na: "quoted"\nb: 'single'\n---\n`);
    expect(frontmatter?.a).toBe("quoted");
    expect(frontmatter?.b).toBe("single");
  });

  it("an empty-valued key with no list items parses as an empty list", () => {
    const { frontmatter } = parseFrontmatter("---\ntags:\nstatus: ok\n---\n");
    expect(frontmatter?.tags).toEqual([]);
    expect(frontmatter?.status).toBe("ok");
  });

  it("a malformed block degrades to null frontmatter, not a throw", () => {
    // Unclosed block: no terminating --- means no frontmatter at all.
    const { frontmatter } = parseFrontmatter("---\ntype: build\nBody without closing fence\n");
    expect(frontmatter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// index-core: wikilinks, summary, confidence, record
// ---------------------------------------------------------------------------

describe("extractWikilinks", () => {
  it("extracts, dedupes, and strips alias/anchor suffixes", () => {
    const links = extractWikilinks(
      "See [[Alpha]] and [[Beta|the beta note]] and [[Gamma#Section]] and [[Alpha]] again.",
    );
    expect(links).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("includes frontmatter-quoted wikilinks (they are outbound links too)", () => {
    const links = extractWikilinks(REAL_NOTE);
    expect(links).toContain("Benefits Realization");
    expect(links).toContain("Startup Ladder of Value");
  });

  it("returns [] when there are none", () => {
    expect(extractWikilinks("plain text")).toEqual([]);
  });
});

describe("extractSummary", () => {
  it("prefers frontmatter description", () => {
    expect(extractSummary({ description: "The description." }, "First para.")).toBe(
      "The description.",
    );
  });

  it("falls back to first paragraph, stripping heading markers", () => {
    expect(extractSummary(null, "# Title\nFirst line.\n\nSecond para.")).toBe(
      "Title First line.",
    );
  });

  it("returns null for empty bodies", () => {
    expect(extractSummary(null, "\n\n  \n")).toBeNull();
  });

  it("caps very long paragraphs at 500 chars", () => {
    const summary = extractSummary(null, "x".repeat(900));
    expect(summary?.length).toBe(501); // 500 + ellipsis
    expect(summary?.endsWith("…")).toBe(true);
  });
});

describe("computeConfidence", () => {
  it("scores 1.0 with frontmatter + description, 0.8 fm-only, 0.6 body-only, 0.3 nothing", () => {
    expect(computeConfidence({ description: "d" }, "d", true)).toBe(1.0);
    expect(computeConfidence({ type: "build" }, "first para", false)).toBe(0.8);
    expect(computeConfidence(null, "first para", false)).toBe(0.6);
    expect(computeConfidence(null, null, false)).toBe(0.3);
  });
});

describe("buildIndexRecord", () => {
  it("produces every field of the record shape", () => {
    const now = new Date("2026-07-09T10:00:00.000Z");
    const record = buildIndexRecord("10_Builds/Circlo/BRM_philosophy.md", REAL_NOTE, "2026-07-01T00:00:00.000Z", now);
    expect(record.path).toBe("10_Builds/Circlo/BRM_philosophy.md");
    expect(record.contentHash).toBe(hashContent(REAL_NOTE));
    expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.modifiedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(record.frontmatter?.type).toBe("build");
    expect(record.wikilinks).toContain("Strategy");
    expect(record.summary).toContain("Role");
    expect(record.confidence).toBe(0.8); // frontmatter, no description
    expect(record.lastIndexedAt).toBe("2026-07-09T10:00:00.000Z");
    // Tier-agnostic by design (v3 amendment): no tier field on the record.
    expect("tier" in record).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe("createSourceIndexStore", () => {
  it("put/getByPath round-trips and maintains the catalog + count", async () => {
    const kv = memoryKv();
    const store = createSourceIndexStore(kv);
    const rec = buildIndexRecord("a/b.md", "# B\n\nBody.\n", "2026-07-09T00:00:00.000Z");
    await store.put(rec);
    expect(await store.getByPath("a/b.md")).toEqual(rec);
    expect(await store.listPathsAndHashes()).toEqual({ "a/b.md": rec.contentHash });
    expect(await store.count()).toBe(1);
    // Keyed per-file under sha256(path) — fixed-length, separator-free.
    expect(kv.rows.has(recordKeyForPath("a/b.md"))).toBe(true);
  });

  it("remove deletes the row and the catalog entry", async () => {
    const store = createSourceIndexStore(memoryKv());
    await store.put(buildIndexRecord("x.md", "x", "2026-07-09T00:00:00.000Z"));
    await store.remove("x.md");
    expect(await store.getByPath("x.md")).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it("rename moves the record: old key removed, new key present, hash preserved", async () => {
    const kv = memoryKv();
    const store = createSourceIndexStore(kv);
    const rec = buildIndexRecord("old.md", "content", "2026-07-09T00:00:00.000Z");
    await store.put(rec);
    const moved = await store.rename("old.md", "new/dir/new.md");
    expect(moved?.path).toBe("new/dir/new.md");
    expect(moved?.contentHash).toBe(rec.contentHash);
    expect(kv.rows.has(recordKeyForPath("old.md"))).toBe(false);
    expect(kv.rows.has(recordKeyForPath("new/dir/new.md"))).toBe(true);
    expect(await store.getByPath("old.md")).toBeNull();
    expect((await store.getByPath("new/dir/new.md"))?.contentHash).toBe(rec.contentHash);
    expect(await store.listPathsAndHashes()).toEqual({ "new/dir/new.md": rec.contentHash });
  });

  it("rename of an unindexed path returns null", async () => {
    const store = createSourceIndexStore(memoryKv());
    expect(await store.rename("ghost.md", "elsewhere.md")).toBeNull();
  });

  it("checkpoint set/get/clear round-trips", async () => {
    const store = createSourceIndexStore(memoryKv());
    expect(await store.getCheckpoint()).toBeNull();
    await store.setCheckpoint({ lastScannedPath: "m.md", startedAt: "2026-07-09T00:00:00.000Z", filesIndexed: 3 });
    expect((await store.getCheckpoint())?.lastScannedPath).toBe("m.md");
    await store.clearCheckpoint();
    expect(await store.getCheckpoint()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// initial scan
// ---------------------------------------------------------------------------

const FIXTURE_FILES = new Map<string, string>([
  ["10_Builds/Circlo/BRM_philosophy.md", REAL_NOTE],
  ["10_Builds/Hometrics/PRD.md", "---\ndescription: Hometrics PRD\n---\n# PRD\n\nBody with [[Hometrics Hub]].\n"],
  ["00_Daily/2026-07-08.md", "# Daily\n\nDid things. See [[Circlo]].\n"],
  ["Plain Note.md", "Just a paragraph with no frontmatter.\n"],
  ["Empty.md", ""],
]);

describe("runInitialScan", () => {
  it("indexes every fixture file with all fields present", async () => {
    const deps = makeDeps(VAULT, FIXTURE_FILES);
    const result = await runInitialScan(deps);

    expect(result.completed).toBe(true);
    expect(result.filesIndexed).toBe(FIXTURE_FILES.size);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(await deps.store.count()).toBe(FIXTURE_FILES.size);

    for (const relPath of FIXTURE_FILES.keys()) {
      const rec = await deps.store.getByPath(relPath);
      expect(rec, relPath).not.toBeNull();
      expect(rec?.path).toBe(relPath);
      expect(rec?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rec?.modifiedAt).toBe("2026-07-09T00:00:00.000Z");
      expect(typeof rec?.confidence).toBe("number");
      expect(rec?.lastIndexedAt).toBeTruthy();
      expect(Array.isArray(rec?.wikilinks)).toBe(true);
      // frontmatter/summary may legitimately be null (Plain Note, Empty) but
      // the keys must exist on the record.
      expect(rec && "frontmatter" in rec).toBe(true);
      expect(rec && "summary" in rec).toBe(true);
    }

    // description-bearing note used it as summary at confidence 1.0
    const prd = await deps.store.getByPath("10_Builds/Hometrics/PRD.md");
    expect(prd?.summary).toBe("Hometrics PRD");
    expect(prd?.confidence).toBe(1.0);
    // empty note: nothing extractable
    const empty = await deps.store.getByPath("Empty.md");
    expect(empty?.summary).toBeNull();
    expect(empty?.confidence).toBe(0.3);

    // checkpoint cleared on completion
    expect(await deps.store.getCheckpoint()).toBeNull();
  });

  it("stops cooperatively mid-scan and resumes without re-reading indexed files", async () => {
    const deps = makeDeps(VAULT, FIXTURE_FILES);

    // Stop after 2 files ("kill" mid-scan; the checkpoint is the survivor).
    let indexed = 0;
    const first = await runInitialScan(deps, {
      shouldContinue: () => indexed++ < 2,
    });
    expect(first.completed).toBe(false);
    expect(first.filesIndexed).toBe(2);
    const checkpoint = await deps.store.getCheckpoint();
    expect(checkpoint).not.toBeNull();

    const readsAfterFirstRun = new Map(deps.fs.readCounts);

    // Restart: scan completes, and the 2 already-indexed files are NOT re-read.
    const second = await runInitialScan(deps);
    expect(second.completed).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.filesSkipped).toBe(2);
    expect(second.filesIndexed).toBe(FIXTURE_FILES.size - 2);
    expect(await deps.store.count()).toBe(FIXTURE_FILES.size);
    expect(await deps.store.getCheckpoint()).toBeNull();

    const sorted = [...FIXTURE_FILES.keys()].sort();
    for (const alreadyIndexed of sorted.slice(0, 2)) {
      expect(deps.fs.readCounts.get(alreadyIndexed), alreadyIndexed).toBe(
        readsAfterFirstRun.get(alreadyIndexed),
      );
      expect(deps.fs.readCounts.get(alreadyIndexed)).toBe(1);
    }
  });

  it("a file that fails to read is logged + skipped, and the scan still completes", async () => {
    const files = new Map(FIXTURE_FILES);
    const deps = makeDeps(VAULT, files);
    const failures: string[] = [];
    deps.logger = {
      info: () => undefined,
      warn: (_msg, fields) => {
        if (fields?.path) failures.push(String(fields.path));
      },
    };
    // Present in the listing but unreadable:
    const listing = deps.fs.listMarkdownFiles.bind(deps.fs);
    deps.fs.listMarkdownFiles = async () => [...(await listing()), path.join(VAULT, "Broken.md")];

    const result = await runInitialScan(deps);
    expect(result.completed).toBe(true);
    expect(result.filesFailed).toBe(1);
    expect(failures).toContain("Broken.md");
    expect(await deps.store.count()).toBe(FIXTURE_FILES.size);
  });
});

// ---------------------------------------------------------------------------
// event-consumption surface (T-2.1 payload shapes)
// ---------------------------------------------------------------------------

describe("applyNoteChanged / applyNoteRenamed / applyNoteDeleted", () => {
  it("applyNoteChanged re-indexes one note in < 2s", async () => {
    const files = new Map(FIXTURE_FILES);
    const deps = makeDeps(VAULT, files);
    await runInitialScan(deps);

    files.set("Plain Note.md", "Edited content with [[New Link]].\n");
    const t0 = performance.now();
    const record = await applyNoteChanged(deps, { path: path.join(VAULT, "Plain Note.md") });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(2000); // acceptance: re-index < 2s
    expect(record.contentHash).toBe(hashContent("Edited content with [[New Link]].\n"));
    expect(record.wikilinks).toEqual(["New Link"]);
    expect((await deps.store.getByPath("Plain Note.md"))?.contentHash).toBe(record.contentHash);
    expect((await deps.store.listPathsAndHashes())["Plain Note.md"]).toBe(record.contentHash);
  });

  it("applyNoteRenamed moves the record without re-reading the file", async () => {
    const files = new Map(FIXTURE_FILES);
    const deps = makeDeps(VAULT, files);
    await runInitialScan(deps);
    const before = await deps.store.getByPath("Plain Note.md");
    const readsBefore = deps.fs.readCounts.get("Plain Note.md");

    const moved = await applyNoteRenamed(deps, {
      oldPath: path.join(VAULT, "Plain Note.md"),
      newPath: path.join(VAULT, "20_Archive/Plain Note.md"),
    });

    expect(moved.path).toBe("20_Archive/Plain Note.md");
    expect(moved.contentHash).toBe(before?.contentHash); // hash preserved
    expect(await deps.store.getByPath("Plain Note.md")).toBeNull(); // old key removed
    expect(await deps.store.getByPath("20_Archive/Plain Note.md")).not.toBeNull(); // new key present
    expect(deps.fs.readCounts.get("Plain Note.md")).toBe(readsBefore); // no re-read
  });

  it("applyNoteRenamed for an unindexed oldPath indexes newPath from disk", async () => {
    const files = new Map(FIXTURE_FILES);
    const deps = makeDeps(VAULT, files);
    const record = await applyNoteRenamed(deps, {
      oldPath: path.join(VAULT, "never-indexed.md"),
      newPath: path.join(VAULT, "Plain Note.md"),
    });
    expect(record.path).toBe("Plain Note.md");
    expect(record.contentHash).toBe(hashContent(files.get("Plain Note.md")!));
  });

  it("applyNoteDeleted removes the record and catalog entry", async () => {
    const deps = makeDeps(VAULT, new Map(FIXTURE_FILES));
    await runInitialScan(deps);
    await applyNoteDeleted(deps, { path: path.join(VAULT, "Empty.md") });
    expect(await deps.store.getByPath("Empty.md")).toBeNull();
    expect("Empty.md" in (await deps.store.listPathsAndHashes())).toBe(false);
    expect(await deps.store.count()).toBe(FIXTURE_FILES.size - 1);
  });

  it("accepts vault-relative paths in event payloads too", async () => {
    const deps = makeDeps(VAULT, new Map(FIXTURE_FILES));
    await runInitialScan(deps);
    const record = await applyNoteChanged(deps, { path: "Plain Note.md" });
    expect(record.path).toBe("Plain Note.md");
  });
});

describe("toVaultRelative", () => {
  it("normalizes absolute and relative forms to the same key", () => {
    expect(toVaultRelative("/vault", "/vault/a/b.md")).toBe("a/b.md");
    expect(toVaultRelative("/vault", "a/b.md")).toBe("a/b.md");
  });
});

// ---------------------------------------------------------------------------
// real-filesystem fs-deps (temp vault on disk)
// ---------------------------------------------------------------------------

describe("createSourceIndexerFs", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), "pacc-t22-"));
    await mkdir(path.join(vaultRoot, "10_Builds"), { recursive: true });
    await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
    await writeFile(path.join(vaultRoot, "10_Builds", "Note.md"), REAL_NOTE);
    await writeFile(path.join(vaultRoot, ".obsidian", "decoy.md"), "internals");
  });

  it("lists markdown files (dot-dirs excluded), reads, and stats mtime", async () => {
    const fs = createSourceIndexerFs(vaultRoot);
    const files = await fs.listMarkdownFiles();
    expect(files).toEqual([path.join(vaultRoot, "10_Builds", "Note.md")]);
    expect(await fs.readFile(files[0]!)).toBe(REAL_NOTE);
    const mtime = await fs.statModifiedAt(files[0]!);
    expect(new Date(mtime).getTime()).toBeGreaterThan(0);
  });

  it("end-to-end scan against a real temp vault", async () => {
    const kv = memoryKv();
    const deps: SourceIndexerDeps = {
      vaultRoot,
      fs: createSourceIndexerFs(vaultRoot),
      store: createSourceIndexStore(kv),
    };
    const result = await runInitialScan(deps);
    expect(result.completed).toBe(true);
    expect(result.filesIndexed).toBe(1);
    const rec = await deps.store.getByPath(path.join("10_Builds", "Note.md"));
    expect(rec?.frontmatter?.type).toBe("build");
    expect(rec?.contentHash).toBe(hashContent(REAL_NOTE));
  });
});

// ---------------------------------------------------------------------------
// worker adapter (plugin_state KV mapping)
// ---------------------------------------------------------------------------

describe("makeSourceIndexKv / makeSourceIndexerDeps", () => {
  function stubCtx() {
    const rows = new Map<string, unknown>();
    const mapKey = (k: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
      `${k.scopeKind}|${k.scopeId ?? ""}|${k.namespace ?? ""}|${k.stateKey}`;
    const keys: Array<{ scopeKind: string; namespace?: string; stateKey: string }> = [];
    return {
      rows,
      keys,
      state: {
        async get(k: never) {
          return rows.get(mapKey(k)) ?? null;
        },
        async set(k: never, v: unknown) {
          keys.push(k);
          rows.set(mapKey(k), v);
        },
        async delete(k: never) {
          rows.delete(mapKey(k));
        },
      },
      logger: { info: () => undefined, warn: () => undefined },
    };
  }

  it("maps string keys to instance-scoped plugin_state rows under the pacc namespace", async () => {
    const ctx = stubCtx();
    const kv = makeSourceIndexKv(ctx as never);
    await kv.set("source-index.v1:abc", { hello: 1 });
    expect(ctx.keys[0]).toEqual({
      scopeKind: "instance",
      namespace: "pacc",
      stateKey: "source-index.v1:abc",
    });
    expect(await kv.get("source-index.v1:abc")).toEqual({ hello: 1 });
    await kv.delete("source-index.v1:abc");
    expect(await kv.get("source-index.v1:abc")).toBeNull();
  });

  it("assembles full deps with an explicit vaultRoot override", () => {
    const ctx = stubCtx();
    const deps = makeSourceIndexerDeps(ctx as never, { vaultRoot: "/tmp/custom-vault" });
    expect(deps.vaultRoot).toBe("/tmp/custom-vault");
    expect(deps.store).toBeDefined();
    expect(deps.fs).toBeDefined();
  });

  it("store state keys land where the spec says: per-file hash rows + catalog + checkpoint", async () => {
    const ctx = stubCtx();
    const kv = makeSourceIndexKv(ctx as never);
    const store = createSourceIndexStore(kv);
    const rec = buildIndexRecord("n.md", "content", "2026-07-09T00:00:00.000Z");
    await store.put(rec);
    await store.setCheckpoint({ lastScannedPath: "n.md", startedAt: "2026-07-09T00:00:00.000Z", filesIndexed: 1 });
    const stateKeys = ctx.keys.map((k) => k.stateKey);
    expect(stateKeys).toContain(recordKeyForPath("n.md"));
    expect(stateKeys).toContain(SOURCE_INDEX_CATALOG_KEY);
    expect(stateKeys).toContain(SOURCE_INDEX_SCAN_CHECKPOINT_KEY);
  });
});
