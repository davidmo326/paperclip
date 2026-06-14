/**
 * T-3.9 — captureBriefFeedback orchestration tests (in-memory deps).
 */
import { describe, expect, it } from "vitest";
import { renderBriefMarkdown } from "../lib/briefer/render.js";
import {
  captureBriefFeedback,
  type CaptureFeedbackDeps,
} from "../lib/briefer/capture-feedback.js";
import type { BriefFeedbackRow } from "../lib/briefer/feedback.js";
import type { KillCriterionMetric } from "../lib/briefer/kill-criterion.js";
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
    humanFeedback: { useful: null, wrong: null, changedPriority: null, approvedActions: [] },
    warnings: [],
    ...over,
  };
}

function action(summary: string, projectId = "circlo") {
  return {
    projectId,
    summary,
    rationale: "because",
    expectedArtifact: null,
    requiredAuthority: "L1" as const,
    jobClassification: "J1_signal" as const,
    confidence: 0.8,
    sourceRefs: [],
  };
}

class InMemoryDeps implements CaptureFeedbackDeps {
  briefs = new Map<string, Brief>();
  rows: BriefFeedbackRow[] = [];
  metrics = new Map<string, KillCriterionMetric>();
  async readBrief(d: string) {
    return this.briefs.get(d) ?? null;
  }
  async writeFeedbackRow(row: BriefFeedbackRow) {
    this.rows.push(row);
  }
  async readMetric(d: string) {
    return this.metrics.get(d) ?? null;
  }
  async writeMetric(m: KillCriterionMetric) {
    this.metrics.set(m.briefDate, m);
  }
}

function checkAction(md: string, summary: string): string {
  return md.replace(`- [ ] **${summary}**`, `- [x] **${summary}**`);
}

const NOW = new Date("2026-05-22T18:00:00.000Z");

describe("captureBriefFeedback", () => {
  it("persists a row, derives task outcomes, and folds accepted into the metric", async () => {
    const brief = emptyBrief({
      highLeverageActions: [action("Email cohort A"), action("Draft pricing page")],
    });
    const deps = new InMemoryDeps();
    deps.briefs.set(brief.briefDate, brief);

    let md = renderBriefMarkdown(brief);
    md = checkAction(md, "Email cohort A");
    md = checkAction(md, "Draft pricing page");

    const result = await captureBriefFeedback(deps, {
      briefDate: brief.briefDate,
      markdown: md,
      now: NOW,
    });

    expect(result.briefFound).toBe(true);
    expect(result.acceptedCount).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.kind === "task")).toBe(true);
    expect(result.unmatched).toEqual([]);

    // Row persisted.
    expect(deps.rows).toHaveLength(1);
    expect(deps.rows[0].acceptedCount).toBe(2);
    // Metric folded.
    expect(deps.metrics.get(brief.briefDate)?.acceptedCount).toBe(2);
    expect(deps.metrics.get(brief.briefDate)?.suggestionsCount).toBe(2);
  });

  it("preserves an existing metric's suggestions/J1 while setting accepted", async () => {
    const brief = emptyBrief({ highLeverageActions: [action("Email cohort A")] });
    const deps = new InMemoryDeps();
    deps.briefs.set(brief.briefDate, brief);
    deps.metrics.set(brief.briefDate, {
      briefDate: brief.briefDate,
      suggestionsCount: 1,
      acceptedCount: 0,
      j1CompletedCount: 2,
    });

    const md = checkAction(renderBriefMarkdown(brief), "Email cohort A");
    await captureBriefFeedback(deps, { briefDate: brief.briefDate, markdown: md, now: NOW });

    const m = deps.metrics.get(brief.briefDate);
    expect(m?.acceptedCount).toBe(1);
    expect(m?.j1CompletedCount).toBe(2); // preserved
  });

  it("still records feedback when the stored brief is missing (unmatched approvals)", async () => {
    const deps = new InMemoryDeps(); // no brief stored
    const md = "## Human Feedback\n- Useful: yes\n- Approved actions: Some action\n";
    const result = await captureBriefFeedback(deps, {
      briefDate: "2026-05-22",
      markdown: md,
      now: NOW,
    });

    expect(result.briefFound).toBe(false);
    expect(result.useful).toBe(true);
    expect(result.acceptedCount).toBe(1);
    expect(result.outcomes).toEqual([]);
    expect(result.unmatched).toEqual(["Some action"]);
    expect(deps.metrics.get("2026-05-22")?.acceptedCount).toBe(1);
  });
});
