/**
 * T-2.6 — unit tests for stale/drift detection logic.
 *
 * Each test writes to a per-test tmpdir (no shared fixture state) so they
 * can run in parallel cleanly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceRef } from "@paperclipai/shared";

import {
  checkProjectDecay,
  checkSourceRefFreshness,
  checkSourceRefsFreshness,
  collectSourceRefsFromControlPlaneState,
  computeFileHash,
  daysSince,
  lastTouchedAt,
} from "../lib/stale-detection.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

let workdir: string;
beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "pacc-stale-detection-"));
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const p = path.join(workdir, name);
  await writeFile(p, content, "utf8");
  return p;
}

function makeRef(p: string, hash: string, overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    kind: "M1a",
    path: p,
    hash,
    capturedAt: "2026-05-19T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeFileHash + lastTouchedAt
// ---------------------------------------------------------------------------

describe("computeFileHash", () => {
  it("returns a SHA-256 hex of file contents", async () => {
    const filePath = await writeFixture("hash-1.md", "hello world");
    expect(await computeFileHash(filePath)).toBe(sha256Hex("hello world"));
  });

  it("returns null for a missing file", async () => {
    expect(await computeFileHash(path.join(workdir, "no-such-file.md"))).toBeNull();
  });

  it("reflects content changes", async () => {
    const p = await writeFixture("changeling.md", "v1");
    const h1 = await computeFileHash(p);
    await writeFile(p, "v2", "utf8");
    const h2 = await computeFileHash(p);
    expect(h1).not.toBe(h2);
  });
});

describe("lastTouchedAt", () => {
  it("returns a Date for existing files", async () => {
    const p = await writeFixture("ts-1.md", "x");
    const ts = await lastTouchedAt(p);
    expect(ts).toBeInstanceOf(Date);
  });

  it("returns null for missing files", async () => {
    expect(await lastTouchedAt(path.join(workdir, "missing.md"))).toBeNull();
  });
});

describe("daysSince", () => {
  it("returns 0 for now", () => {
    const now = new Date("2026-05-20T12:00:00Z");
    expect(daysSince(now, now)).toBe(0);
  });

  it("returns positive days for past timestamps", () => {
    const past = new Date("2026-04-20T12:00:00Z");
    const now = new Date("2026-05-20T12:00:00Z");
    expect(daysSince(past, now)).toBeCloseTo(30, 5);
  });

  it("returns +Infinity for null", () => {
    expect(daysSince(null)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// checkSourceRefFreshness
// ---------------------------------------------------------------------------

describe("checkSourceRefFreshness", () => {
  it("returns fresh when the hash matches", async () => {
    const content = "doc content";
    const p = await writeFixture("fresh.md", content);
    const ref = makeRef(p, sha256Hex(content));
    const result = await checkSourceRefFreshness(ref);
    expect(result.kind).toBe("fresh");
  });

  it("returns stale when the file content changed since capture", async () => {
    const p = await writeFixture("stale.md", "original");
    const ref = makeRef(p, sha256Hex("original"));
    await writeFile(p, "modified", "utf8");
    const result = await checkSourceRefFreshness(ref);
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") {
      expect(result.expectedHash).toBe(sha256Hex("original"));
      expect(result.currentHash).toBe(sha256Hex("modified"));
    }
  });

  it("returns orphaned when the file was deleted", async () => {
    const ref = makeRef(
      path.join(workdir, "ghost.md"),
      sha256Hex("never written"),
    );
    const result = await checkSourceRefFreshness(ref);
    expect(result.kind).toBe("orphaned");
  });

  it("treats hash comparison case-insensitively", async () => {
    const content = "case test";
    const p = await writeFixture("case.md", content);
    const upperHash = sha256Hex(content).toUpperCase();
    const ref = makeRef(p, upperHash);
    const result = await checkSourceRefFreshness(ref);
    expect(result.kind).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// checkSourceRefsFreshness aggregation
// ---------------------------------------------------------------------------

describe("checkSourceRefsFreshness", () => {
  it("partitions refs into fresh/stale/orphaned and flags hasDrift", async () => {
    const freshContent = "kept";
    const freshPath = await writeFixture("agg-fresh.md", freshContent);
    const stalePath = await writeFixture("agg-stale.md", "before");
    const orphPath = path.join(workdir, "agg-orph.md");

    const refs: SourceRef[] = [
      makeRef(freshPath, sha256Hex(freshContent)),
      makeRef(stalePath, sha256Hex("before")),
      makeRef(orphPath, sha256Hex("never")),
    ];
    await writeFile(stalePath, "after", "utf8");

    const report = await checkSourceRefsFreshness(refs);
    expect(report.totalRefs).toBe(3);
    expect(report.fresh).toHaveLength(1);
    expect(report.stale).toHaveLength(1);
    expect(report.orphaned).toHaveLength(1);
    expect(report.hasDrift).toBe(true);
  });

  it("hasDrift is false when all refs are fresh", async () => {
    const p = await writeFixture("all-fresh.md", "stable");
    const report = await checkSourceRefsFreshness([
      makeRef(p, sha256Hex("stable")),
    ]);
    expect(report.hasDrift).toBe(false);
  });

  it("returns an empty report for zero refs", async () => {
    const report = await checkSourceRefsFreshness([]);
    expect(report).toMatchObject({ totalRefs: 0, hasDrift: false });
  });
});

// ---------------------------------------------------------------------------
// checkProjectDecay
// ---------------------------------------------------------------------------

describe("checkProjectDecay", () => {
  it("returns decayed=false when a referenced file was touched within threshold", async () => {
    const p = await writeFixture("decay-fresh.md", "x");
    // Force mtime to ~5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    await utimes(p, fiveDaysAgo, fiveDaysAgo);

    const result = await checkProjectDecay({
      projectId: "p-1",
      sourceRefs: [makeRef(p, sha256Hex("x"))],
      thresholdDays: 30,
    });
    expect(result.decayed).toBe(false);
    expect(result.daysSinceLastTouch).toBeCloseTo(5, 0);
    expect(result.lastTouchedPath).toBe(p);
  });

  it("returns decayed=true when no file was touched within threshold", async () => {
    const p = await writeFixture("decay-stale.md", "x");
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await utimes(p, ninetyDaysAgo, ninetyDaysAgo);

    const result = await checkProjectDecay({
      projectId: "p-2",
      sourceRefs: [makeRef(p, sha256Hex("x"))],
      thresholdDays: 30,
    });
    expect(result.decayed).toBe(true);
  });

  it("picks the most recently touched file as the reference", async () => {
    const a = await writeFixture("decay-old.md", "a");
    const b = await writeFixture("decay-new.md", "b");
    await utimes(a, new Date(Date.now() - 60 * 86_400_000), new Date(Date.now() - 60 * 86_400_000));
    // b keeps its default fresh mtime

    const result = await checkProjectDecay({
      projectId: "p-3",
      sourceRefs: [makeRef(a, sha256Hex("a")), makeRef(b, sha256Hex("b"))],
      thresholdDays: 30,
    });
    expect(result.decayed).toBe(false);
    expect(result.lastTouchedPath).toBe(b);
  });

  it("treats a project with zero refs as decayed (no grounding at all)", async () => {
    const result = await checkProjectDecay({
      projectId: "p-empty",
      sourceRefs: [],
      thresholdDays: 30,
    });
    expect(result.decayed).toBe(true);
    expect(result.daysSinceLastTouch).toBe(Number.POSITIVE_INFINITY);
    expect(result.lastTouchedPath).toBeNull();
  });

  it("treats a project with only missing files as decayed", async () => {
    const ghost = path.join(workdir, "decay-ghost.md");
    const result = await checkProjectDecay({
      projectId: "p-ghost",
      sourceRefs: [makeRef(ghost, "deadbeef".repeat(8))],
      thresholdDays: 30,
    });
    expect(result.decayed).toBe(true);
    expect(result.lastTouchedPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectSourceRefsFromControlPlaneState
// ---------------------------------------------------------------------------

describe("collectSourceRefsFromControlPlaneState", () => {
  const refA = makeRef("/v/a.md", "a".repeat(64));
  const refB = makeRef("/v/b.md", "b".repeat(64));
  const refC = makeRef("/v/c.md", "c".repeat(64));
  const refDup = makeRef("/v/a.md", "a".repeat(64));

  it("returns [] for null state", () => {
    expect(collectSourceRefsFromControlPlaneState(null)).toEqual([]);
  });

  it("collects from top-level memoryIndexRefs and sourceRefs", () => {
    const refs = collectSourceRefsFromControlPlaneState({
      memoryIndexRefs: [refA],
      sourceRefs: [refB],
    });
    expect(refs.map((r) => r.path)).toEqual(["/v/a.md", "/v/b.md"]);
  });

  it("collects nested refs from assumptions / hypotheses / escalations", () => {
    const refs = collectSourceRefsFromControlPlaneState({
      assumptions: [{ sourceRefs: [refA] }],
      hypotheses: [{ evidenceFor: [refB], evidenceAgainst: [refC] }],
      escalations: [{ sourceRefs: [refB] }],
    });
    expect(refs.map((r) => r.path).sort()).toEqual(["/v/a.md", "/v/b.md", "/v/c.md"]);
  });

  it("deduplicates by path", () => {
    const refs = collectSourceRefsFromControlPlaneState({
      memoryIndexRefs: [refA],
      sourceRefs: [refDup, refB],
    });
    expect(refs).toHaveLength(2);
  });

  it("skips entries that don't look like SourceRefs", () => {
    const refs = collectSourceRefsFromControlPlaneState({
      memoryIndexRefs: [refA, { path: 42, hash: "h" }, "not-a-ref"],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("/v/a.md");
  });
});
