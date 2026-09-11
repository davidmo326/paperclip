/**
 * T-2.3 — note-to-project association: pure core (confidence formula) +
 * project-directory (portfolio-seed.json -> ProjectDef[]).
 *
 * Fixtures below mirror real portfolio-seed.json entries (paths copied,
 * PLAN v3 amendment binding: acceptance requires each 10_Builds/ project's
 * primary notes associate at confidence >= 0.85 using fixtures mirroring
 * real seed paths).
 */

import { describe, expect, it } from "vitest";
import { computeAssociation, titleFromPath } from "../lib/note-association/associator-core.js";
import { buildProjectDirectory, type PortfolioSeedEntry } from "../lib/note-association/project-directory.js";
import { extractNoteTags } from "../lib/note-association/associate.js";

const VAULT_ROOT = "/home/ubuntu/llm_shared/Obsidian";
const NOW = new Date("2026-07-10T00:00:00.000Z");

// Subset of real portfolio-seed.json entries (T-0.4), copied per T-2.3 spec
// ("copy relevant entries into test fixtures").
const SEED_ENTRIES: PortfolioSeedEntry[] = [
  {
    slug: "circlo",
    name: "Circlo",
    obsidianFolder: `${VAULT_ROOT}/10_Builds/Circlo`,
    visionRefs: ["[[BRM_philosophy]]", "[[Circlo Portfolio Canvas]]", "[[Circlo refocus messaging]]"],
    spineNotes: [],  },
  {
    slug: "hometrics",
    name: "Hometrics",
    obsidianFolder: `${VAULT_ROOT}/10_Builds/Hometrics`,
    visionRefs: ["[[First Users - Action Plan]]", "[[Validation Bet Sequence]]"],
    spineNotes: [],  },
  {
    slug: "ndis",
    name: "NDIS",
    obsidianFolder: `${VAULT_ROOT}/10_Builds/NDIS`,
    visionRefs: ["[[Customer Discovery Scan — Digital Listening Report]]", "[[shapeup_March2026]]"],
    spineNotes: [],  },
  {
    slug: "storycrafter",
    name: "Storycrafter AI",
    obsidianFolder: null, // repo-only project, no Obsidian folder
    visionRefs: [],
    spineNotes: [],
  },
];

const PROJECTS = buildProjectDirectory(SEED_ENTRIES, VAULT_ROOT);

describe("buildProjectDirectory", () => {
  it("derives a vault-relative folder path from the absolute obsidianFolder", () => {
    const circlo = PROJECTS.find((p) => p.slug === "circlo");
    expect(circlo?.folderRelPath).toBe("10_Builds/Circlo");
  });

  it("strips the [[ ]] wrapper from visionRefs to get hub-note names", () => {
    const circlo = PROJECTS.find((p) => p.slug === "circlo");
    expect(circlo?.hubNoteNames).toContain("BRM_philosophy");
    expect(circlo?.hubNoteNames).toContain("Circlo Portfolio Canvas");
  });

  it("leaves folderRelPath null for a project with no obsidianFolder", () => {
    const storycrafter = PROJECTS.find((p) => p.slug === "storycrafter");
    expect(storycrafter?.folderRelPath).toBeNull();
  });
});

describe("titleFromPath", () => {
  it("strips folder prefix and .md extension", () => {
    expect(titleFromPath("10_Builds/Circlo/BRM_philosophy.md")).toBe("BRM_philosophy");
  });
});

describe("computeAssociation — rule precedence", () => {
  it("rule 1: explicit frontmatter project: <slug> -> confidence 1.0", () => {
    const result = computeAssociation(
      { path: "00_Inbox/random-note.md", frontmatter: { project: "circlo" }, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "circlo", confidence: 1.0, method: "frontmatter" });
  });

  it("ignores a frontmatter project value that isn't a known slug", () => {
    const result = computeAssociation(
      { path: "00_Inbox/random-note.md", frontmatter: { project: "not-a-real-project" }, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result.projectId).toBeNull();
  });

  it("rule 2: path prefix 10_Builds/<Project folder>/... -> confidence 0.85", () => {
    const result = computeAssociation(
      { path: "10_Builds/Hometrics/First Users - Action Plan.md", frontmatter: null, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "hometrics", confidence: 0.85, method: "path-prefix" });
  });

  it("path prefix does not false-positive on a sibling folder with a shared prefix", () => {
    const result = computeAssociation(
      { path: "10_Builds/Hometrics-old-drafts/note.md", frontmatter: null, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result.projectId).toBeNull();
  });

  it("rule 3: outbound wikilink to a known project hub note (1 hop) -> confidence 0.6", () => {
    const result = computeAssociation(
      { path: "00_Inbox/random-note.md", frontmatter: null, wikilinks: ["BRM_philosophy"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "circlo", confidence: 0.6, method: "wikilink-hub" });
  });

  it("rule 3 is case-insensitive on the wikilink target", () => {
    const result = computeAssociation(
      { path: "00_Inbox/random-note.md", frontmatter: null, wikilinks: ["brm_philosophy"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result.projectId).toBe("circlo");
  });

  it("rule 4: title fuzzy match (Jaro-Winkler >= 0.9) -> confidence 0.4", () => {
    const result = computeAssociation(
      { path: "00_Inbox/Hometrics Update.md", frontmatter: null, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "hometrics", confidence: 0.4, method: "title-fuzzy" });
  });

  it("no match -> projectId null, confidence 0, method none", () => {
    const result = computeAssociation(
      { path: "00_Inbox/completely-unrelated-thought.md", frontmatter: null, wikilinks: [] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: null, confidence: 0, method: "none" });
  });

  it("highest applicable rule wins: frontmatter (1.0) beats a path-prefix match for a different project", () => {
    const result = computeAssociation(
      {
        path: "10_Builds/NDIS/reclassified-note.md",
        frontmatter: { project: "hometrics" },
        wikilinks: [],
      },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "hometrics", confidence: 1.0, method: "frontmatter" });
  });

  it("manual override beats every heuristic, including frontmatter's 1.0", () => {
    const result = computeAssociation(
      {
        path: "10_Builds/Hometrics/First Users - Action Plan.md",
        frontmatter: { project: "hometrics" },
        wikilinks: [],
      },
      PROJECTS,
      { "10_Builds/Hometrics/First Users - Action Plan.md": "ndis" },
      NOW,
    );
    expect(result).toMatchObject({ projectId: "ndis", confidence: 1.0, method: "override" });
  });
});

describe("computeAssociation — tag rule (T-2.3-tag)", () => {
  // computeAssociation consumes the already-extracted `tags` field (associate.ts's
  // extractNoteTags does the frontmatter->tags work; see the extractNoteTags suite).
  it("rule 3: a note tagged with the project slug, outside 10_Builds, associates at 0.75", () => {
    const result = computeAssociation(
      { path: "00_Inbox/some-research.md", frontmatter: null, wikilinks: [], tags: ["circlo"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "circlo", confidence: 0.75, method: "tag" });
  });

  it("tag (0.75) outranks wikilink-hub (0.6): a note with both takes the tag's project", () => {
    const result = computeAssociation(
      { path: "00_Inbox/note.md", frontmatter: null, wikilinks: ["BRM_philosophy"], tags: ["hometrics"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "hometrics", confidence: 0.75, method: "tag" });
  });

  it("path-prefix (0.85) outranks tag (0.75): a Circlo-folder note tagged 'hometrics' stays Circlo", () => {
    const result = computeAssociation(
      { path: "10_Builds/Circlo/note.md", frontmatter: null, wikilinks: [], tags: ["hometrics"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "circlo", confidence: 0.85, method: "path-prefix" });
  });

  it("tag matching is case-insensitive", () => {
    const result = computeAssociation(
      { path: "00_Inbox/note.md", frontmatter: null, wikilinks: [], tags: ["CIRCLO"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result).toMatchObject({ projectId: "circlo", method: "tag" });
  });

  it("an unrelated tag does not associate", () => {
    const result = computeAssociation(
      { path: "00_Inbox/note.md", frontmatter: null, wikilinks: [], tags: ["random-topic"] },
      PROJECTS,
      {},
      NOW,
    );
    expect(result.projectId).toBeNull();
  });

  it("explicit seed `tags` override the slug default", () => {
    const projects = buildProjectDirectory(
      [
        {
          slug: "business-model-analysis",
          name: "Business Model Analysis",
          obsidianFolder: null,
          visionRefs: [],
          spineNotes: [],
          tags: ["bma"],
        },
      ],
      VAULT_ROOT,
    );
    const hit = computeAssociation(
      { path: "00_Inbox/note.md", frontmatter: null, wikilinks: [], tags: ["bma"] },
      projects,
      {},
      NOW,
    );
    expect(hit).toMatchObject({ projectId: "business-model-analysis", confidence: 0.75, method: "tag" });
    // the slug no longer matches because the explicit tags replaced the default
    const miss = computeAssociation(
      { path: "00_Inbox/note.md", frontmatter: null, wikilinks: [], tags: ["business-model-analysis"] },
      projects,
      {},
      NOW,
    );
    expect(miss.projectId).toBeNull();
  });
});

describe("buildProjectDirectory — matchTags (T-2.3-tag)", () => {
  it("defaults matchTags to [slug] when the seed has no tags", () => {
    const circlo = PROJECTS.find((p) => p.slug === "circlo");
    expect(circlo?.matchTags).toEqual(["circlo"]);
  });

  it("uses explicit seed tags, lowercased + deduped", () => {
    const [project] = buildProjectDirectory(
      [{ slug: "x", name: "X", obsidianFolder: null, visionRefs: [], tags: ["BMA", "bma", "Strategy"], spineNotes: [] }],
      VAULT_ROOT,
    );
    expect(project.matchTags).toEqual(["bma", "strategy"]);
  });
});

describe("extractNoteTags (T-2.3-tag)", () => {
  it("handles the YAML list, scalar, and inline-bracket forms", () => {
    expect(extractNoteTags({ tags: ["circlo", "ndis"] })).toEqual(["circlo", "ndis"]);
    expect(extractNoteTags({ tags: "circlo" })).toEqual(["circlo"]);
    expect(extractNoteTags({ tags: "[circlo, ndis]" })).toEqual(["circlo", "ndis"]);
  });

  it("lowercases, trims, dedupes, drops empties", () => {
    expect(extractNoteTags({ tags: [" Circlo ", "", "circlo", "NDIS"] })).toEqual(["circlo", "ndis"]);
  });

  it("returns [] when there are no tags", () => {
    expect(extractNoteTags(null)).toEqual([]);
    expect(extractNoteTags({})).toEqual([]);
  });
});
