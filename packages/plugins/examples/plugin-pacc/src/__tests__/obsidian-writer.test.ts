/**
 * T-3.6 — Obsidian-side brief writer tests.
 *
 * The load-bearing acceptance is "idempotent without mtime touch":
 * re-running the brief with identical bytes must NOT bump the file's
 * mtime. We verify by comparing mtimes before/after a second call.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  briefHasPrincipalEdits,
  obsidianBriefExists,
  obsidianBriefPath,
  writeObsidianBrief,
} from "../lib/briefer/obsidian-writer.js";

let workdir: string;
beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "pacc-obsidian-writer-"));
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("obsidianBriefPath", () => {
  it("composes filename from baseDir + date + default prefix", () => {
    const p = obsidianBriefPath({ baseDir: "/v/00_Daily", briefDate: "2026-05-22" });
    expect(p).toBe("/v/00_Daily/Daily Brief - 2026-05-22.md");
  });

  it("honors a custom filenamePrefix", () => {
    const p = obsidianBriefPath({
      baseDir: "/v/00_Daily",
      briefDate: "2026-05-22",
      filenamePrefix: "OB - ",
    });
    expect(p).toBe("/v/00_Daily/OB - 2026-05-22.md");
  });
});

describe("obsidianBriefExists", () => {
  it("returns false for a missing file", async () => {
    const exists = await obsidianBriefExists({
      baseDir: workdir,
      briefDate: "1999-01-01",
    });
    expect(exists).toBe(false);
  });

  it("returns true once a file is written", async () => {
    await writeObsidianBrief("# hello", {
      baseDir: workdir,
      briefDate: "2026-05-20",
    });
    expect(
      await obsidianBriefExists({ baseDir: workdir, briefDate: "2026-05-20" }),
    ).toBe(true);
  });
});

describe("writeObsidianBrief — first write", () => {
  it("creates the file when missing and returns kind='wrote'", async () => {
    const result = await writeObsidianBrief("# brief content", {
      baseDir: workdir,
      briefDate: "2026-05-21",
    });
    expect(result.kind).toBe("wrote");
    expect(result.byteLength).toBe(Buffer.byteLength("# brief content"));
    const content = await readFile(result.path, "utf8");
    expect(content).toBe("# brief content");
  });

  it("creates the base directory if it doesn't exist", async () => {
    const nested = path.join(workdir, "nested", "deeper");
    const result = await writeObsidianBrief("# nested", {
      baseDir: nested,
      briefDate: "2026-05-22",
    });
    expect(result.kind).toBe("wrote");
    const s = await stat(result.path);
    expect(s.isFile()).toBe(true);
  });
});

describe("writeObsidianBrief — idempotence (no mtime touch)", () => {
  it("returns kind='unchanged' on second write with identical content", async () => {
    const date = "2026-05-23";
    const md = "# unchanged content\n";
    const r1 = await writeObsidianBrief(md, { baseDir: workdir, briefDate: date });
    expect(r1.kind).toBe("wrote");
    const r2 = await writeObsidianBrief(md, { baseDir: workdir, briefDate: date });
    expect(r2.kind).toBe("unchanged");
  });

  it("does NOT bump mtime when content is byte-identical", async () => {
    const date = "2026-05-24";
    const md = "# stable content\n";
    const { path: p } = await writeObsidianBrief(md, { baseDir: workdir, briefDate: date });
    const mtimeBefore = (await stat(p)).mtimeMs;
    // Wait a tick so any mtime bump would be observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeObsidianBrief(md, { baseDir: workdir, briefDate: date });
    const mtimeAfter = (await stat(p)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("DOES rewrite (and bump mtime) when content changes", async () => {
    const date = "2026-05-25";
    const { path: p } = await writeObsidianBrief("# v1", { baseDir: workdir, briefDate: date });
    const mtimeBefore = (await stat(p)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const r2 = await writeObsidianBrief("# v2", { baseDir: workdir, briefDate: date });
    const mtimeAfter = (await stat(p)).mtimeMs;
    expect(r2.kind).toBe("wrote");
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
    expect(await readFile(p, "utf8")).toBe("# v2");
  });
});

describe("writeObsidianBrief — atomic write", () => {
  it("doesn't leave a .tmp file behind after a successful write", async () => {
    const { path: targetPath } = await writeObsidianBrief("# clean", {
      baseDir: workdir,
      briefDate: "2026-05-26",
    });
    const dir = path.dirname(targetPath);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const tmpEntries = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpEntries).toEqual([]);
  });

  it("survives an externally-modified file (overwrites)", async () => {
    const date = "2026-05-27";
    const { path: p } = await writeObsidianBrief("# original", {
      baseDir: workdir,
      briefDate: date,
    });
    // Simulate manual edit
    await writeFile(p, "# manually edited", "utf8");
    // Re-write
    const r = await writeObsidianBrief("# fresh", {
      baseDir: workdir,
      briefDate: date,
    });
    expect(r.kind).toBe("wrote");
    expect(await readFile(p, "utf8")).toBe("# fresh");
  });
});

describe("writeObsidianBrief — no-clobber guard (T-6.7b)", () => {
  const footer = (useful: string, wrong: string): string =>
    [
      "# Daily Operating Brief - 2026-09-11",
      "",
      "## Human Feedback",
      "",
      `- Useful: ${useful}`,
      `- Wrong: ${wrong}`,
      "- Changed priority: ",
      "- Today's next action: ",
      "- Approved actions: ",
      "",
    ].join("\n");

  it("refuses to overwrite a brief the principal has annotated", async () => {
    const dir = path.join(workdir, "guard-annotated");
    await mkdir(dir, { recursive: true });
    const annotated = footer("yes", "source notes seem arbitrary");
    await writeFile(path.join(dir, "Daily Brief - 2026-09-11.md"), annotated, "utf8");
    const result = await writeObsidianBrief(annotated.replace("yes", "no — regenerated"), {
      baseDir: dir,
      briefDate: "2026-09-11",
    });
    expect(result.kind).toBe("skipped_edited");
    expect(await readFile(path.join(dir, "Daily Brief - 2026-09-11.md"), "utf8")).toBe(annotated);
  });

  it("still regenerates when the existing footer is unfilled", async () => {
    const dir = path.join(workdir, "guard-unfilled");
    await mkdir(dir, { recursive: true });
    const unfilled = footer("", "");
    await writeFile(path.join(dir, "Daily Brief - 2026-09-11.md"), unfilled, "utf8");
    const result = await writeObsidianBrief(unfilled.replace("# Daily Operating Brief", "# Daily Operating Brief v2"), {
      baseDir: dir,
      briefDate: "2026-09-11",
    });
    expect(result.kind).toBe("wrote");
    expect(await readFile(path.join(dir, "Daily Brief - 2026-09-11.md"), "utf8")).toContain("v2");
  });

  it("treats byte-identical re-renders as unchanged even when annotated", async () => {
    const dir = path.join(workdir, "guard-identical");
    await mkdir(dir, { recursive: true });
    const annotated = footer("yes", "kept");
    await writeFile(path.join(dir, "Daily Brief - 2026-09-11.md"), annotated, "utf8");
    const result = await writeObsidianBrief(annotated, { baseDir: dir, briefDate: "2026-09-11" });
    expect(result.kind).toBe("unchanged");
  });

  it("briefHasPrincipalEdits ignores whitespace-only fills", async () => {
    expect(briefHasPrincipalEdits(footer("  ", "\t"))).toBe(false);
    expect(briefHasPrincipalEdits(footer("yes", ""))).toBe(true);
  });
});
