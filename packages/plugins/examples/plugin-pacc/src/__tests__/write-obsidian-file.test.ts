/**
 * T-2.4 — M1b write-mediator rejection matrix.
 *
 * `writeObsidianFile` is the single function through which ALL agent writes
 * to the Obsidian vault flow (PRD § 9.6, tripwire 1 § 15.2). Safety-critical:
 * the rejection matrix must cover exact anchor paths, the registry note
 * itself, folder prefixes, case variants, symlinks, and vault escapes.
 * Every attempt — allowed or rejected — emits `agent.m1b_write_attempt`.
 *
 * These tests use a REAL temp-dir vault (not mocked fs) because symlink and
 * case-variant behavior is exactly what mocks get wrong.
 */

import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createObsidianFileWriter,
  M1bWriteAttemptError,
  type ObsidianFileWriter,
} from "../lib/value-anchor/write-obsidian-file.js";

interface EmittedEvent {
  name: string;
  payload: Record<string, unknown>;
}

let vaultRoot: string;
let events: EmittedEvent[];
let writer: ObsidianFileWriter;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), "pacc-t24-vault-"));
  await mkdir(path.join(vaultRoot, "10_Builds", "Circlo"), { recursive: true });
  await mkdir(path.join(vaultRoot, "30_Principles"), { recursive: true });

  await writeFile(path.join(vaultRoot, "Value Anchors.md"), "# Value Anchors\n## Registry\n- [[My World Optics]] — values\n");
  await writeFile(path.join(vaultRoot, "My World Optics.md"), "# Optics\n");
  await writeFile(path.join(vaultRoot, "30_Principles", "Anchor Folder Note.md"), "# In protected folder\n");
  await writeFile(path.join(vaultRoot, "10_Builds", "Circlo", "draft.md"), "old\n");

  events = [];
  writer = createObsidianFileWriter({
    vaultRoot,
    // Protected: the registry note itself, one anchor note, and one folder.
    async getProtectedPaths() {
      return [
        path.join(vaultRoot, "Value Anchors.md"),
        path.join(vaultRoot, "My World Optics.md"),
        path.join(vaultRoot, "30_Principles"),
      ];
    },
    async emitEvent(name, payload) {
      events.push({ name, payload });
    },
  });
});

function lastEvent(): EmittedEvent | undefined {
  return events[events.length - 1];
}

describe("writeObsidianFile — allowed writes", () => {
  it("writes a regular note and emits an allowed audit event", async () => {
    const target = path.join(vaultRoot, "10_Builds", "Circlo", "pitch.draft.md");
    const result = await writer(target, "# Draft\n");
    expect(result.kind).toBe("wrote");
    expect(await readFile(target, "utf8")).toBe("# Draft\n");
    expect(lastEvent()?.name).toBe("agent.m1b_write_attempt");
    expect(lastEvent()?.payload.outcome).toBe("allowed");
  });

  it("is idempotent: byte-identical rewrite reports unchanged", async () => {
    const target = path.join(vaultRoot, "10_Builds", "Circlo", "same.md");
    await writer(target, "content\n");
    const second = await writer(target, "content\n");
    expect(second.kind).toBe("unchanged");
  });

  it("creates missing parent directories inside the vault", async () => {
    const target = path.join(vaultRoot, "10_Builds", "NewProject", "notes.draft.md");
    const result = await writer(target, "x\n");
    expect(result.kind).toBe("wrote");
  });
});

describe("writeObsidianFile — rejection matrix", () => {
  async function expectRejected(target: string, content = "malicious\n") {
    await expect(writer(target, content)).rejects.toBeInstanceOf(M1bWriteAttemptError);
    expect(lastEvent()?.name).toBe("agent.m1b_write_attempt");
    expect(lastEvent()?.payload.outcome).toBe("rejected");
  }

  it("rejects a write to a registry-listed anchor note", async () => {
    await expectRejected(path.join(vaultRoot, "My World Optics.md"));
    // File untouched:
    expect(await readFile(path.join(vaultRoot, "My World Optics.md"), "utf8")).toBe("# Optics\n");
  });

  it("rejects a write to the registry note itself", async () => {
    await expectRejected(path.join(vaultRoot, "Value Anchors.md"));
  });

  it("rejects a case-variant of a protected path", async () => {
    await expectRejected(path.join(vaultRoot, "my world optics.MD"));
  });

  it("rejects any path under a protected folder", async () => {
    await expectRejected(path.join(vaultRoot, "30_Principles", "Anchor Folder Note.md"));
    await expectRejected(path.join(vaultRoot, "30_Principles", "new-file.md"));
  });

  it("rejects a symlink that resolves to a protected note", async () => {
    const link = path.join(vaultRoot, "10_Builds", "innocent-looking.md");
    await symlink(path.join(vaultRoot, "My World Optics.md"), link);
    await expectRejected(link);
    expect(await readFile(path.join(vaultRoot, "My World Optics.md"), "utf8")).toBe("# Optics\n");
  });

  it("rejects traversal that escapes the vault root", async () => {
    await expectRejected(path.join(vaultRoot, "..", "outside-vault.md"));
  });

  it("rejects an absolute path outside the vault", async () => {
    await expectRejected(path.join(tmpdir(), "pacc-t24-escape.md"));
  });

  it("does not create a file when the write is rejected", async () => {
    const target = path.join(vaultRoot, "30_Principles", "should-not-exist.md");
    await expect(writer(target, "x\n")).rejects.toBeInstanceOf(M1bWriteAttemptError);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeObsidianFile — audit posture", () => {
  it("emits exactly one attempt event per call, allowed or rejected", async () => {
    await writer(path.join(vaultRoot, "10_Builds", "a.md"), "a\n");
    await expect(
      writer(path.join(vaultRoot, "Value Anchors.md"), "x\n"),
    ).rejects.toBeInstanceOf(M1bWriteAttemptError);
    const attempts = events.filter((e) => e.name === "agent.m1b_write_attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((e) => e.payload.outcome)).toEqual(["allowed", "rejected"]);
  });

  it("rejected events carry the target path and matched protected path", async () => {
    await expect(
      writer(path.join(vaultRoot, "My World Optics.md"), "x\n"),
    ).rejects.toBeInstanceOf(M1bWriteAttemptError);
    const payload = lastEvent()?.payload ?? {};
    expect(String(payload.targetPath)).toContain("My World Optics.md");
    expect(String(payload.matchedProtectedPath)).toContain("My World Optics.md");
  });
});
