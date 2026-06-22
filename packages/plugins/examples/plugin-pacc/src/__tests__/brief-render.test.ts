/**
 * T-3.3 — brief Markdown renderer tests.
 *
 * Two layers:
 *   1. Structural: all PRD § 13.1 headings present; tables have headers;
 *      empty sections render placeholders (omit-able via option).
 *   2. Idempotence: same input → byte-identical output, repeat-safe; any
 *      input change flips the bytes. This is the load-bearing acceptance
 *      for T-3.6's cron schedule.
 */

import { describe, expect, it } from "vitest";
import { renderBriefMarkdown } from "../lib/briefer/render.js";
import type { Brief } from "../lib/briefer/types.js";

function emptyBrief(over: Partial<Brief> = {}): Brief {
  return {
    generatedAt: "2026-05-22T08:00:00.000Z",
    briefDate: "2026-05-22",
    inputsCacheKey: "a".repeat(64),
    portfolioSummary: { answer: null, confidence: "unknown", sourceRefs: [] },
    recommendedFocus: null,
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
    sourceNotes: [],
    jobMix: [],
    projectNames: { circlo: "circlo", hometrics: "hometrics", ndis: "NDIS" },
    humanFeedback: { useful: null, wrong: null, changedPriority: null, approvedActions: [] },
    warnings: [],
    ...over,
  };
}

function fullBrief(): Brief {
  return emptyBrief({
    portfolioSummary: {
      answer: "Validating distribution channel on Circlo; Hometrics paused.",
      confidence: "high",
      sourceRefs: [],
    },
    recommendedFocus: {
      projectId: "circlo",
      summary: "Email cohort A about beta access",
      rationale: "Validate the distribution channel by month-end",
      expectedArtifact: "5 customer-discovery calls scheduled",
      requiredAuthority: "L1",
      jobClassification: "J1_signal",
      confidence: 0.8,
      sourceRefs: [
        {
          kind: "M1a",
          path: "/v/Circlo/PRD.md",
          section: "§ 3.2",
          hash: "a".repeat(64),
          capturedAt: "2026-05-22T00:00:00.000Z",
        },
      ],
    },
    jobMix: [
      {
        projectId: "circlo",
        projectName: "Circlo",
        phase: "validate",
        j1Pct: 60,
        j2Pct: 20,
        j3Pct: 10,
        metaPct: 10,
        thresholdBreach: null,
      },
      {
        projectId: "hometrics",
        projectName: "Hometrics",
        phase: "build",
        j1Pct: 30,
        j2Pct: 30,
        j3Pct: 30,
        metaPct: 10,
        thresholdBreach: "pre-PMF + J1 < 50%",
      },
    ],
    blockedProjects: [
      { projectId: "ndis", projectName: "NDIS", blockerSummary: "waiting on regulator response" },
    ],
    highLeverageActions: [
      {
        projectId: "circlo",
        summary: "Email cohort A",
        rationale: "validate channel",
        expectedArtifact: null,
        requiredAuthority: "L1",
        jobClassification: "J1_signal",
        confidence: 0.8,
        sourceRefs: [],
      },
    ],
    escalations: [
      {
        projectId: "circlo",
        question: "candidate A or B for the landing CTA?",
        recommendedDecision: "A — clearer copy",
      },
    ],
    doNotRethinkAlerts: [
      {
        projectId: "circlo",
        projectName: "Circlo",
        settledDecision: "We are sticking with embedded postgres as the local DB.",
        conflictingAction: "Re-evaluate the database choice this week.",
      },
    ],
    staleConflictedMemory: [
      { kind: "stale_pending_re_grounding", count: 3, projectIds: ["circlo", "hometrics"] },
      { kind: "conflict", count: 1, projectIds: ["ndis"] },
    ],
    sourceNotes: [
      { projectId: "circlo", path: "/v/Circlo/PRD.md" },
      { projectId: "circlo", path: "/v/Circlo/PRD.md" }, // duplicate — should dedupe
      { projectId: "hometrics", path: "/v/Hometrics/research.md" },
    ],
    completedWork: [
      { projectId: "circlo", artifact: "landing v2 published", completedAt: "2026-05-21T16:00:00.000Z" },
    ],
    humanFeedback: {
      useful: true,
      wrong: null,
      changedPriority: null,
      approvedActions: ["email-cohort-a"],
    },
    warnings: ["1 field(s) in conflict; agent writes blocked: currentStatus"],
  });
}

// ---------------------------------------------------------------------------
// 1. Structural
// ---------------------------------------------------------------------------

describe("renderBriefMarkdown — structural", () => {
  it("includes the date header with YYYY-MM-DD only (no time)", () => {
    const md = renderBriefMarkdown(emptyBrief());
    expect(md).toContain("# Daily Operating Brief - 2026-05-22");
    expect(md).not.toContain("08:00"); // no time
    expect(md).not.toContain("T08"); // no ISO time
  });

  it("renders all PRD § 13.1 section headings in order", () => {
    const md = renderBriefMarkdown(fullBrief());
    const expectedSections = [
      "## Portfolio Summary",
      "## Job Mix",
      "## Recommended Focus",
      "## Projects Needing Attention",
      "## Memory / Source Issues",
      "## Escalations",
      "## AI-Proposed Tasks",
      "## Do Not Rethink",
      "## Completed Since Last Brief",
      "## Source Notes",
      "## Human Feedback",
    ];
    let cursor = 0;
    for (const heading of expectedSections) {
      const idx = md.indexOf(heading, cursor);
      expect(idx).toBeGreaterThan(cursor - 1);
      cursor = idx;
    }
  });

  it("renders an empty brief with all section placeholders", () => {
    const md = renderBriefMarkdown(emptyBrief());
    // Each list/table section has a "_no entries_" placeholder
    const noEntries = (md.match(/_no entries_/g) ?? []).length;
    expect(noEntries).toBeGreaterThanOrEqual(6);
  });

  it("omits placeholders when omitEmptySectionPlaceholders is true", () => {
    const md = renderBriefMarkdown(emptyBrief(), { omitEmptySectionPlaceholders: true });
    expect(md).not.toContain("_no entries_");
  });

  it("renders job-mix as a Markdown table with the column header", () => {
    const md = renderBriefMarkdown(fullBrief());
    expect(md).toMatch(/\| Project \| Phase \| J1 \| J2 \| J3 \| Meta \| Threshold Breach \|/);
    expect(md).toMatch(/\| Circlo \| validate \| 60% \| 20% \| 10% \| 10% \|/);
  });

  it("renders recommended focus with all 6 bullets when present", () => {
    const md = renderBriefMarkdown(fullBrief());
    expect(md).toContain("- Primary project: circlo");
    expect(md).toContain("- Why now: Validate the distribution channel");
    expect(md).toContain("- Next smallest action: Email cohort A");
    expect(md).toContain("- Job classification: J1_signal");
    expect(md).toContain("- Expected outcome:");
    expect(md).toContain("- Source support:");
  });

  it("dedupes source notes by (projectId, path)", () => {
    const md = renderBriefMarkdown(fullBrief());
    const occurrences = (md.match(/- \*\*circlo\*\*: `\/v\/Circlo\/PRD\.md`/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("appends a warnings footer when warnings present", () => {
    const md = renderBriefMarkdown(fullBrief());
    expect(md).toContain("## ⚠ Warnings");
    expect(md).toContain("currentStatus");
  });

  it("does NOT render the warnings footer when warnings are empty", () => {
    const md = renderBriefMarkdown(emptyBrief());
    expect(md).not.toContain("## ⚠ Warnings");
  });

  it("recommendedFocus block shows _no entries_ shape when null", () => {
    const md = renderBriefMarkdown(emptyBrief());
    expect(md).toContain("- Primary project: _no entries_");
  });

  it("ends with a single trailing newline (no \\r\\n, no double-newline)", () => {
    const md = renderBriefMarkdown(fullBrief());
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    expect(md.includes("\r")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotence (load-bearing acceptance)
// ---------------------------------------------------------------------------

describe("renderBriefMarkdown — idempotence", () => {
  it("produces byte-identical output for the same input twice", () => {
    const b = fullBrief();
    const a = renderBriefMarkdown(b);
    const c = renderBriefMarkdown(b);
    expect(a).toBe(c);
    expect(a.length).toBe(c.length);
  });

  it("changing generatedAt does NOT change the rendered Markdown", () => {
    // generatedAt is intentionally NOT rendered — only briefDate appears.
    const b1 = fullBrief();
    const b2 = { ...fullBrief(), generatedAt: "2026-05-22T17:30:00.000Z" };
    expect(renderBriefMarkdown(b1)).toBe(renderBriefMarkdown(b2));
  });

  it("changing inputsCacheKey does NOT change the rendered Markdown", () => {
    // inputsCacheKey is metadata; not in the rendered body.
    const b1 = fullBrief();
    const b2 = { ...fullBrief(), inputsCacheKey: "f".repeat(64) };
    expect(renderBriefMarkdown(b1)).toBe(renderBriefMarkdown(b2));
  });

  it("changing briefDate DOES change the rendered Markdown", () => {
    const b1 = fullBrief();
    const b2 = { ...fullBrief(), briefDate: "2026-05-23" };
    expect(renderBriefMarkdown(b1)).not.toBe(renderBriefMarkdown(b2));
  });

  it("changing any data field DOES change the rendered Markdown", () => {
    const b1 = fullBrief();
    const b2 = {
      ...fullBrief(),
      portfolioSummary: {
        answer: "Different summary text.",
        confidence: "high" as const,
        sourceRefs: [],
      },
    };
    expect(renderBriefMarkdown(b1)).not.toBe(renderBriefMarkdown(b2));
  });

  it("array order in inputs doesn't affect output (sorted internally)", () => {
    const b1 = fullBrief();
    const b2 = {
      ...fullBrief(),
      // Reverse the job-mix array order; renderer sorts by projectName
      jobMix: [...fullBrief().jobMix].reverse(),
    };
    expect(renderBriefMarkdown(b1)).toBe(renderBriefMarkdown(b2));
  });

  it("warning order doesn't affect output (sorted internally)", () => {
    const b1 = { ...fullBrief(), warnings: ["a warning", "b warning"] };
    const b2 = { ...fullBrief(), warnings: ["b warning", "a warning"] };
    expect(renderBriefMarkdown(b1)).toBe(renderBriefMarkdown(b2));
  });

  it("escalations sort by (projectId, question) for stability", () => {
    const b1 = {
      ...fullBrief(),
      escalations: [
        { projectId: "z-project", question: "Q1", recommendedDecision: null },
        { projectId: "a-project", question: "Q2", recommendedDecision: null },
      ],
    };
    const b2 = {
      ...fullBrief(),
      escalations: [
        { projectId: "a-project", question: "Q2", recommendedDecision: null },
        { projectId: "z-project", question: "Q1", recommendedDecision: null },
      ],
    };
    expect(renderBriefMarkdown(b1)).toBe(renderBriefMarkdown(b2));
    // And a-project should appear first
    const md = renderBriefMarkdown(b1);
    expect(md.indexOf("a-project")).toBeLessThan(md.indexOf("z-project"));
  });

  it("approvedActions sort alphabetically", () => {
    const b1 = {
      ...fullBrief(),
      humanFeedback: {
        ...fullBrief().humanFeedback,
        approvedActions: ["z-action", "a-action", "m-action"],
      },
    };
    const md = renderBriefMarkdown(b1);
    expect(md).toContain("- Approved actions: a-action, m-action, z-action");
  });
});
