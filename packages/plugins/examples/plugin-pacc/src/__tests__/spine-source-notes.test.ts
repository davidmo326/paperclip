/**
 * T-6.7 — spine-first source selection + note substance.
 *
 * Covers: rankAssociatedRecords (seed spine before recency, cap preserved),
 * the brief renderer's summary suffix, and the seed loader's spineNotes
 * passthrough. The pipeline promise under test: the daily brief opens on a
 * project's strategy ground, not on whatever file was touched last.
 */
import { describe, expect, it } from "vitest";
import { rankAssociatedRecords } from "../lib/briefer/worker-deps.js";
import type { SourceIndexRecord } from "../lib/source-index/index-core.js";
import { renderBriefMarkdown } from "../lib/briefer/render.js";
import type { Brief } from "../lib/briefer/types.js";
import { buildProjectDirectory } from "../lib/note-association/project-directory.js";

function rec(path: string, modifiedAt: string, summary: string | null = null): SourceIndexRecord {
  return {
    path,
    contentHash: `hash-${path}`,
    modifiedAt,
    frontmatter: {},
    wikilinks: [],
    summary,
    confidence: 0.6,
    lastIndexedAt: "2026-09-10T00:00:00.000Z",
  } as SourceIndexRecord;
}

describe("rankAssociatedRecords (T-6.7 spine-first)", () => {
  const spineNote = rec("10_Builds/Hometrics/First Users - Action Plan.md", "2026-04-21T00:00:00.000Z");
  const freshDeck = rec("10_Builds/Hometrics/Strategy Deck - Investor v2.md", "2026-09-01T00:00:00.000Z");
  const freshLog = rec("10_Builds/Hometrics/PHASE_LOG.md", "2026-08-30T00:00:00.000Z");
  const records = [freshDeck, spineNote, freshLog];

  it("ranks seed spine notes first regardless of mtime", () => {
    const ranked = rankAssociatedRecords(records, ["First Users - Action Plan", "_Dashboard"], 8);
    expect(ranked[0]?.path).toBe("10_Builds/Hometrics/First Users - Action Plan.md");
  });

  it("fills remaining slots by mtime desc after the spine", () => {
    const ranked = rankAssociatedRecords(records, ["First Users - Action Plan"], 8);
    expect(ranked.map((r) => r.path)).toEqual([
      "10_Builds/Hometrics/First Users - Action Plan.md",
      "10_Builds/Hometrics/Strategy Deck - Investor v2.md",
      "10_Builds/Hometrics/PHASE_LOG.md",
    ]);
  });

  it("caps total count (spine counts toward the cap)", () => {
    const ranked = rankAssociatedRecords(records, ["First Users - Action Plan"], 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.some((r) => r.path === "10_Builds/Hometrics/PHASE_LOG.md")).toBe(false);
  });

  it("is pure mtime-recency when the seed declares no spine", () => {
    const ranked = rankAssociatedRecords(records, [], 8);
    expect(ranked[0]?.path).toBe("10_Builds/Hometrics/Strategy Deck - Investor v2.md");
  });

  it("matches spine fragments case-insensitively on the path", () => {
    const ranked = rankAssociatedRecords(records, ["first users"], 8);
    expect(ranked[0]?.path).toBe("10_Builds/Hometrics/First Users - Action Plan.md");
  });
});

describe("brief renderer — source note summaries (T-6.7)", () => {
  function baseBrief(sourceNotes: Brief["sourceNotes"]): Brief {
    return {
      generatedAt: "2026-09-10T08:00:00.000Z",
      briefDate: "2026-09-10",
      inputsCacheKey: "a".repeat(64),
      portfolioSummary: { answer: null, confidence: "unknown", sourceRefs: [] },
      recommendedFocus: null,
      leadQuestion: null,
      openQuestions: [],
      changesSinceLast: { answer: null, confidence: "unknown", sourceRefs: [] },
      staleConflictedMemory: [],
      blockedProjects: [],
      highLeverageActions: [],
      backlogCandidates: [],
      escalations: [],
      doNotRethinkAlerts: [],
      imaginationFeaturesParked: [],
      completedWork: [],
      authoritySafetyIssues: [],
      sourceNotes,
      jobMix: [],
      projectNames: { "p-1": "Hometrics" },
      humanFeedback: { useful: null, wrong: null, changedPriority: null, approvedActions: [] },
      warnings: [],
    } as unknown as Brief;
  }

  it("appends the summary after the path when present", () => {
    const brief = baseBrief([
      { projectId: "p-1", path: "10_Builds/Hometrics/_Dashboard.md", summary: null },
      {
        projectId: "p-1",
        path: "10_Builds/Hometrics/First Users - Action Plan.md",
        summary: "Goal: 5 real inspections done. 1 paying user.",
      },
    ]);
    const md = renderBriefMarkdown(brief, { omitEmptySectionPlaceholders: true });
    expect(md).toContain(
      "- **Hometrics**: `10_Builds/Hometrics/First Users - Action Plan.md` — Goal: 5 real inspections done. 1 paying user.",
    );
  });

  it("renders path-only when the summary is null (pre-T-6.7 briefs)", () => {
    const brief = baseBrief([{ projectId: "p-1", path: "10_Builds/Hometrics/_Dashboard.md", summary: null }]);
    const md = renderBriefMarkdown(brief, { omitEmptySectionPlaceholders: true });
    expect(md).toContain("- **Hometrics**: `10_Builds/Hometrics/_Dashboard.md`\n");
  });

  it("truncates long summaries to keep the brief scannable", () => {
    const long = "x".repeat(300);
    const brief = baseBrief([{ projectId: "p-1", path: "a.md", summary: long }]);
    const md = renderBriefMarkdown(brief, { omitEmptySectionPlaceholders: true });
    expect(md).toMatch(/— x{157}\.\.\./);
    expect(md).not.toContain("x".repeat(158));
  });
});

describe("seed loader — spineNotes passthrough (T-6.7)", () => {
  it("carries declared spine fragments onto the project def", () => {
    const [project] = buildProjectDirectory(
      [
        {
          slug: "hometrics",
          name: "Hometrics",
          obsidianFolder: "/vault/10_Builds/Hometrics",
          visionRefs: [],
          spineNotes: ["First Users - Action Plan", "_Dashboard"],
        },
      ],
      "/vault",
    );
    expect(project.spineNotes).toEqual(["First Users - Action Plan", "_Dashboard"]);
  });
});
