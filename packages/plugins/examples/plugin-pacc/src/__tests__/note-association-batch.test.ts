/**
 * T-2.3 — batch association run (`runAssociation`) over a fixture source
 * index, plus the override-file round-trip acceptance test:
 *   write override -> re-scan -> note's projectId matches override, beats
 *   heuristics.
 *
 * fs-deps.ts (`_pacc_overrides.json` / portfolio-seed.json readers) is
 * exercised here against real temp-dir fixtures, never the live vault or
 * live overrides file — per the ticket, this module never creates/edits
 * `_pacc_overrides.json` itself; tests use fixtures they own.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runAssociation, type SourceIndexReader } from "../lib/note-association/associate.js";
import { createNoteAssociationFsDeps } from "../lib/note-association/fs-deps.js";
import { createNoteAssociationStore, type NoteAssociationKv } from "../lib/note-association/store.js";
import { buildProjectDirectory } from "../lib/note-association/project-directory.js";

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

interface FixtureNote {
  path: string;
  frontmatter: Record<string, string | string[]> | null;
  wikilinks: string[];
}

function fixtureSourceIndex(notes: FixtureNote[]): SourceIndexReader {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  return {
    async listPathsAndHashes() {
      const out: Record<string, string> = {};
      for (const n of notes) out[n.path] = "hash-" + n.path;
      return out;
    },
    async getByPath(p) {
      return byPath.get(p) ?? null;
    },
  };
}

const VAULT_ROOT = "/home/ubuntu/llm_shared/Obsidian";
const PROJECTS = buildProjectDirectory(
  [
    {
      slug: "circlo",
      name: "Circlo",
      obsidianFolder: `${VAULT_ROOT}/10_Builds/Circlo`,
      visionRefs: ["[[BRM_philosophy]]"],
    },
    {
      slug: "hometrics",
      name: "Hometrics",
      obsidianFolder: `${VAULT_ROOT}/10_Builds/Hometrics`,
      visionRefs: [],
    },
  ],
  VAULT_ROOT,
);

describe("runAssociation (batch)", () => {
  it("associates each fixture note and tallies results by method", async () => {
    const notes: FixtureNote[] = [
      { path: "10_Builds/Circlo/note-a.md", frontmatter: null, wikilinks: [] },
      { path: "10_Builds/Hometrics/note-b.md", frontmatter: null, wikilinks: [] },
      { path: "00_Inbox/random.md", frontmatter: null, wikilinks: [] },
    ];
    const store = createNoteAssociationStore(memoryKv());
    const result = await runAssociation({
      sourceIndex: fixtureSourceIndex(notes),
      store,
      projects: PROJECTS,
      overrides: {},
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });

    expect(result.notesProcessed).toBe(3);
    expect(result.associatedCount).toBe(2);
    expect(result.unassociatedCount).toBe(1);
    expect(result.byMethod).toMatchObject({ "path-prefix": 2, none: 1 });

    const a = await store.getByPath("10_Builds/Circlo/note-a.md");
    expect(a?.projectId).toBe("circlo");
  });
});

describe("override round-trip (fs-deps + runAssociation)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pacc-note-assoc-"));
  });

  it("write override -> re-scan -> note's projectId matches override, beats heuristics", async () => {
    const overridesPath = path.join(dir, "_pacc_overrides.json");
    const notePath = "10_Builds/Circlo/note-a.md"; // heuristically associates to circlo via path-prefix

    // Round 1: no override file yet -> heuristic wins.
    const fsDeps = createNoteAssociationFsDeps();
    const overridesBefore = await fsDeps.loadOverrides(overridesPath);
    expect(overridesBefore).toEqual({});

    const store1 = createNoteAssociationStore(memoryKv());
    const notes: FixtureNote[] = [{ path: notePath, frontmatter: null, wikilinks: [] }];
    await runAssociation({
      sourceIndex: fixtureSourceIndex(notes),
      store: store1,
      projects: PROJECTS,
      overrides: overridesBefore,
    });
    const before = await store1.getByPath(notePath);
    expect(before).toMatchObject({ projectId: "circlo", method: "path-prefix" });

    // Write the override file (test fixture — never done by production code).
    await writeFile(overridesPath, JSON.stringify({ [notePath]: "hometrics" }), "utf8");

    // Round 2: re-load overrides, re-scan -> override wins over the heuristic.
    const overridesAfter = await fsDeps.loadOverrides(overridesPath);
    expect(overridesAfter).toEqual({ [notePath]: "hometrics" });

    const store2 = createNoteAssociationStore(memoryKv());
    await runAssociation({
      sourceIndex: fixtureSourceIndex(notes),
      store: store2,
      projects: PROJECTS,
      overrides: overridesAfter,
    });
    const after = await store2.getByPath(notePath);
    expect(after).toMatchObject({ projectId: "hometrics", confidence: 1.0, method: "override" });
  });

  it("a missing overrides file yields {} rather than throwing", async () => {
    const fsDeps = createNoteAssociationFsDeps();
    const overrides = await fsDeps.loadOverrides(path.join(dir, "does-not-exist.json"));
    expect(overrides).toEqual({});
  });

  it("a malformed overrides file yields {} rather than throwing", async () => {
    const overridesPath = path.join(dir, "_pacc_overrides.json");
    await writeFile(overridesPath, "{ not valid json", "utf8");
    const fsDeps = createNoteAssociationFsDeps();
    const overrides = await fsDeps.loadOverrides(overridesPath);
    expect(overrides).toEqual({});
  });

  it("loadProjects parses a fixture portfolio-seed.json into ProjectDef[]", async () => {
    const seedPath = path.join(dir, "portfolio-seed.json");
    await writeFile(
      seedPath,
      JSON.stringify([
        {
          slug: "circlo",
          name: "Circlo",
          obsidianFolder: `${VAULT_ROOT}/10_Builds/Circlo`,
          visionRefs: ["[[BRM_philosophy]]"],
        },
      ]),
      "utf8",
    );
    const fsDeps = createNoteAssociationFsDeps();
    const projects = await fsDeps.loadProjects(seedPath, VAULT_ROOT);
    expect(projects).toEqual([
      { slug: "circlo", name: "Circlo", folderRelPath: "10_Builds/Circlo", hubNoteNames: ["BRM_philosophy"] },
    ]);
  });

  it("loadProjects returns [] for a missing seed file rather than throwing", async () => {
    const fsDeps = createNoteAssociationFsDeps();
    const projects = await fsDeps.loadProjects(path.join(dir, "does-not-exist.json"), VAULT_ROOT);
    expect(projects).toEqual([]);
  });
});
