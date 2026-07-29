/**
 * T-3.9 — brief feedback capture tests.
 *
 * Load-bearing acceptance (PLAN T-3.9): render brief → principal marks 2
 * actions approved → parse → 2 task rows + acceptedCount === 2. Plus footer
 * edit-shape tolerance (checkbox toggle, inline text).
 */
import { describe, expect, it } from "vitest";
import { renderBriefMarkdown } from "../lib/briefer/render.js";
import {
  parseBriefFeedback,
  makeFeedbackRow,
  deriveFeedbackOutcomes,
} from "../lib/briefer/feedback.js";
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

/** Simulate the principal checking a specific action's checkbox in Obsidian. */
function checkAction(markdown: string, summary: string): string {
  return markdown.replace(`- [ ] **${summary}**`, `- [x] **${summary}**`);
}

describe("parseBriefFeedback — checkbox toggles", () => {
  it("round-trips: 2 checked actions → acceptedCount 2 + 2 task outcomes", () => {
    const brief = emptyBrief({
      highLeverageActions: [action("Email cohort A"), action("Draft pricing page")],
      backlogCandidates: [action("Refactor telemetry", "hometrics")],
    });
    let md = renderBriefMarkdown(brief);
    md = checkAction(md, "Email cohort A");
    md = checkAction(md, "Draft pricing page");

    const parsed = parseBriefFeedback(md);
    expect(parsed.approvedActions).toEqual(["Draft pricing page", "Email cohort A"]);

    const row = makeFeedbackRow(brief.briefDate, parsed, new Date("2026-05-22T18:00:00.000Z"));
    expect(row.acceptedCount).toBe(2);
    expect(row.briefDate).toBe("2026-05-22");

    const { outcomes, unmatched } = deriveFeedbackOutcomes(parsed, brief);
    expect(unmatched).toEqual([]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.kind === "task")).toBe(true);
    expect(outcomes.every((o) => (o as { createdFrom: string }).createdFrom === "brief:2026-05-22")).toBe(true);
  });

  it("ignores unchecked checkboxes", () => {
    const brief = emptyBrief({ highLeverageActions: [action("Email cohort A")] });
    const md = renderBriefMarkdown(brief); // left unchecked
    const parsed = parseBriefFeedback(md);
    expect(parsed.approvedActions).toEqual([]);
  });

  it("does not count checkboxes outside the AI-Proposed Tasks section", () => {
    // A checked box appearing in another section's prose must not count.
    const brief = emptyBrief({ highLeverageActions: [action("Email cohort A")] });
    let md = renderBriefMarkdown(brief);
    md = md.replace("## Do Not Rethink", "## Do Not Rethink\n\n- [x] **Sneaky** — x");
    const parsed = parseBriefFeedback(md);
    expect(parsed.approvedActions).toEqual([]);
  });
});

describe("parseBriefFeedback — footer edit shapes", () => {
  it("parses Useful yes/no/blank", () => {
    expect(parseBriefFeedback("## Human Feedback\n- Useful: yes\n").useful).toBe(true);
    expect(parseBriefFeedback("## Human Feedback\n- Useful: no\n").useful).toBe(false);
    expect(parseBriefFeedback("## Human Feedback\n- Useful:\n").useful).toBeNull();
    expect(parseBriefFeedback("## Human Feedback\n- Useful: ✅\n").useful).toBe(true);
  });

  it("parses Wrong + Changed priority inline text", () => {
    const md =
      "## Human Feedback\n- Useful: no\n- Wrong: missed the NDIS blocker\n- Changed priority: do Hometrics first\n";
    const parsed = parseBriefFeedback(md);
    expect(parsed.wrong).toBe("missed the NDIS blocker");
    expect(parsed.changedPriority).toBe("do Hometrics first");
  });

  it("parses an inline 'Approved actions' footer list", () => {
    const md = "## Human Feedback\n- Approved actions: Email cohort A, Draft pricing page\n";
    const parsed = parseBriefFeedback(md);
    expect(parsed.approvedActions).toEqual(["Draft pricing page", "Email cohort A"]);
  });

  it("unions checkbox + footer approvals and dedupes", () => {
    const brief = emptyBrief({ highLeverageActions: [action("Email cohort A"), action("Draft pricing page")] });
    let md = renderBriefMarkdown(brief);
    md = checkAction(md, "Email cohort A");
    // also list the same action plus a new one on the footer
    md = md.replace(
      "- Approved actions: ",
      "- Approved actions: Email cohort A, Draft pricing page",
    );
    const parsed = parseBriefFeedback(md);
    expect(parsed.approvedActions).toEqual(["Draft pricing page", "Email cohort A"]);
  });

  it("T-3.14: parses Today's next action reach/bypass (canonical + short forms + blank)", () => {
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: acted-from-pacc\n").reachOrBypass).toBe("acted-from-pacc");
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: bypassed-to-cli\n").reachOrBypass).toBe("bypassed-to-cli");
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: pacc\n").reachOrBypass).toBe("acted-from-pacc");
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: cli\n").reachOrBypass).toBe("bypassed-to-cli");
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: \n").reachOrBypass).toBeNull();
    expect(parseBriefFeedback("## Human Feedback\n- Today's next action: gibberish\n").reachOrBypass).toBeNull();
  });

  it("T-3.14: reach/bypass is only read inside the Human Feedback section", () => {
    const md = "## AI-Proposed Tasks\n- Today's next action: acted-from-pacc\n";
    expect(parseBriefFeedback(md).reachOrBypass).toBeNull();
  });
});

describe("deriveFeedbackOutcomes — task vs escalation", () => {
  it("maps an approved escalation question to an escalation resolution", () => {
    const brief = emptyBrief({
      escalations: [
        { projectId: "circlo", question: "candidate A or B for CTA?", recommendedDecision: "A" },
      ],
    });
    const parsed = parseBriefFeedback(
      "## Human Feedback\n- Approved actions: candidate A or B for CTA?\n",
    );
    const { outcomes, unmatched } = deriveFeedbackOutcomes(parsed, brief);
    expect(unmatched).toEqual([]);
    expect(outcomes).toEqual([
      { kind: "escalation_resolution", projectId: "circlo", question: "candidate A or B for CTA?" },
    ]);
  });

  it("returns unmatched approvals that match neither action nor escalation", () => {
    const brief = emptyBrief({ highLeverageActions: [action("Email cohort A")] });
    const parsed = parseBriefFeedback(
      "## Human Feedback\n- Approved actions: Something not in the brief\n",
    );
    const { outcomes, unmatched } = deriveFeedbackOutcomes(parsed, brief);
    expect(outcomes).toEqual([]);
    expect(unmatched).toEqual(["Something not in the brief"]);
  });
});
