/**
 * T-2.4 — integration layer: real-fs loader deps, the cached registry
 * service, and the guard seam that routes the existing brief writer
 * through the M1b mediator.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createVaultLoaderDeps } from "../lib/value-anchor/fs-deps.js";
import { createValueAnchorService } from "../lib/value-anchor/service.js";
import { writeObsidianBrief } from "../lib/briefer/obsidian-writer.js";
import { M1bWriteAttemptError } from "../lib/value-anchor/write-obsidian-file.js";
import { makeObsidianGuard } from "../lib/briefer/worker-deps.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "pacc-t24-int-"));
  await mkdir(path.join(vaultRoot, "10_Builds", "Circlo"), { recursive: true });
  await mkdir(path.join(vaultRoot, ".obsidian", "plugins"), { recursive: true });
  await mkdir(path.join(vaultRoot, ".trash"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "Value Anchors.md"),
    "# Value Anchors\n\n## Registry\n\n- [[My World Optics]] — values\n",
  );
  await writeFile(path.join(vaultRoot, "My World Optics.md"), "# Optics\n");
  await writeFile(path.join(vaultRoot, "10_Builds", "Circlo", "PRD.md"), "# PRD\n");
  await writeFile(path.join(vaultRoot, ".obsidian", "plugins", "decoy.md"), "not vault content");
  await writeFile(path.join(vaultRoot, ".trash", "deleted.md"), "trashed");
});

describe("createVaultLoaderDeps", () => {
  it("walks markdown files recursively, excluding dot-directories", async () => {
    const deps = createVaultLoaderDeps(vaultRoot);
    const files = await deps.listMarkdownFiles();
    expect(files).toContain(path.join(vaultRoot, "My World Optics.md"));
    expect(files).toContain(path.join(vaultRoot, "10_Builds", "Circlo", "PRD.md"));
    expect(files.some((f) => f.includes(".obsidian"))).toBe(false);
    expect(files.some((f) => f.includes(".trash"))).toBe(false);
  });

  it("reads files by absolute path", async () => {
    const deps = createVaultLoaderDeps(vaultRoot);
    expect(await deps.readFile(path.join(vaultRoot, "My World Optics.md"))).toBe("# Optics\n");
  });
});

describe("createValueAnchorService", () => {
  it("loads anchors and exposes protected paths (registry note + resolved anchors)", async () => {
    const service = createValueAnchorService({ vaultRoot });
    await service.reload();
    expect(service.getValueAnchors().map((a) => a.name)).toEqual(["My World Optics"]);
    const protectedPaths = await service.getProtectedPaths();
    expect(protectedPaths).toContain(path.join(vaultRoot, "Value Anchors.md"));
    expect(protectedPaths).toContain(path.join(vaultRoot, "My World Optics.md"));
  });

  it("reload() picks up registry additions (morning-sweep semantics)", async () => {
    const service = createValueAnchorService({ vaultRoot });
    await service.reload();
    expect(service.getValueAnchors()).toHaveLength(1);

    await writeFile(path.join(vaultRoot, "New Principle.md"), "# New\n");
    await writeFile(
      path.join(vaultRoot, "Value Anchors.md"),
      "# Value Anchors\n\n## Registry\n\n- [[My World Optics]] — values\n- [[New Principle]] — added later\n",
    );
    await service.reload();
    expect(service.getValueAnchors().map((a) => a.name)).toContain("New Principle");
    expect(await service.getProtectedPaths()).toContain(path.join(vaultRoot, "New Principle.md"));
  });

  it("getProtectedPaths() before any reload lazily loads the registry", async () => {
    const service = createValueAnchorService({ vaultRoot });
    const protectedPaths = await service.getProtectedPaths();
    expect(protectedPaths).toContain(path.join(vaultRoot, "My World Optics.md"));
  });
});

describe("makeObsidianGuard (worker adapter)", () => {
  it("builds a guard that protects registry anchors and emits via ctx.events", async () => {
    const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      events: {
        emit: async (name: string, companyId: string, payload: Record<string, unknown>) => {
          emitted.push({ name, companyId, payload });
        },
      },
    };
    process.env.PACC_VAULT_ROOT = vaultRoot;
    try {
      const { guard } = await makeObsidianGuard(ctx as never, "company-1");
      await expect(
        guard(path.join(vaultRoot, "My World Optics.md"), "overwrite attempt"),
      ).rejects.toBeInstanceOf(M1bWriteAttemptError);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.name).toBe("agent.m1b_write_attempt");
      expect(emitted[0]?.companyId).toBe("company-1");
      expect(emitted[0]?.payload.outcome).toBe("rejected");

      const ok = await guard(path.join(vaultRoot, "00_Daily", "Daily Brief - 2026-07-09.md"), "# ok\n");
      expect(ok.kind).toBe("wrote");
      expect(emitted[1]?.payload.outcome).toBe("allowed");
    } finally {
      delete process.env.PACC_VAULT_ROOT;
    }
  });
});

describe("writeObsidianBrief guard seam", () => {
  it("routes the disk write through the guard when one is provided", async () => {
    const calls: Array<{ target: string; bytes: number }> = [];
    const result = await writeObsidianBrief("# Brief\n", {
      baseDir: path.join(vaultRoot, "00_Daily"),
      briefDate: "2026-07-09",
      guard: async (target, content) => {
        calls.push({ target, bytes: Buffer.byteLength(content, "utf8") });
        return { path: target, kind: "wrote", byteLength: Buffer.byteLength(content, "utf8") };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(path.join(vaultRoot, "00_Daily", "Daily Brief - 2026-07-09.md"));
    expect(result.kind).toBe("wrote");
    // The guard owned the write — the direct path must NOT have been written by the legacy code.
    await expect(
      readFile(path.join(vaultRoot, "00_Daily", "Daily Brief - 2026-07-09.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a guard rejection without writing anything", async () => {
    await expect(
      writeObsidianBrief("# Brief\n", {
        baseDir: vaultRoot,
        briefDate: "2026-07-09",
        filenamePrefix: "Value Anchors", // contrived: target collides with the registry note
        guard: async (target) => {
          throw new M1bWriteAttemptError(target, "protected_path", target);
        },
      }),
    ).rejects.toBeInstanceOf(M1bWriteAttemptError);
  });

  it("behaves exactly as before when no guard is provided (legacy path)", async () => {
    const result = await writeObsidianBrief("# Brief\n", {
      baseDir: path.join(vaultRoot, "00_Daily"),
      briefDate: "2026-07-09",
    });
    expect(result.kind).toBe("wrote");
    expect(
      await readFile(path.join(vaultRoot, "00_Daily", "Daily Brief - 2026-07-09.md"), "utf8"),
    ).toBe("# Brief\n");
  });
});
