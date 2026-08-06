/**
 * T-3.10 — kill-criterion meter tests.
 *
 * Load-bearing acceptance (PLAN T-3.10):
 *   - 5 briefs with accepted sums {1,1,0,1,0} (=3) AND j1 sum 2 → gate passes.
 *   - 5 briefs with accepted sum < 3 → gate fails; brief renders red-flag line.
 *   - "Control-plane self-check" section present in every brief.
 */
import { describe, expect, it } from "vitest";
import {
  initMetric,
  applyFeedbackToMetric,
  incrementJ1Completed,
  evaluateGate,
  renderSelfCheckSection,
  KILL_WINDOW,
  type KillCriterionMetric,
} from "../lib/briefer/kill-criterion.js";
import { renderBriefMarkdown } from "../lib/briefer/render.js";
import type { Brief } from "../lib/briefer/types.js";

function metric(
  briefDate: string,
  acceptedCount: number,
  j1CompletedCount: number,
  suggestionsCount = 4,
): KillCriterionMetric {
  return { briefDate, suggestionsCount, acceptedCount, j1CompletedCount, reachOrBypass: null };
}

/** Five consecutive days ending 2026-05-22. */
const DAYS = ["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22"];

describe("metric lifecycle", () => {
  it("initMetric starts accepted/j1 at 0", () => {
    const m = initMetric("2026-05-22", 5);
    expect(m).toEqual({ briefDate: "2026-05-22", suggestionsCount: 5, acceptedCount: 0, j1CompletedCount: 0, reachOrBypass: null });
  });

  it("applyFeedbackToMetric sets acceptedCount from approved actions", () => {
    const m = initMetric("2026-05-22", 5);
    const updated = applyFeedbackToMetric(m, {
      useful: true,
      wrong: null,
      changedPriority: null,
      reachOrBypass: null,
      approvedActions: ["a", "b", "c"],
    });
    expect(updated.acceptedCount).toBe(3);
  });

  it("incrementJ1Completed bumps the counter", () => {
    const m = incrementJ1Completed(initMetric("2026-05-22", 5));
    expect(m.j1CompletedCount).toBe(1);
    expect(incrementJ1Completed(m, 2).j1CompletedCount).toBe(3);
  });
});

describe("evaluateGate", () => {
  it("PASSES with accepted {1,1,0,1,0}=3 and j1 sum 2", () => {
    const metrics = [
      metric(DAYS[0], 1, 0),
      metric(DAYS[1], 1, 1),
      metric(DAYS[2], 0, 0),
      metric(DAYS[3], 1, 1),
      metric(DAYS[4], 0, 0),
    ];
    const gate = evaluateGate(metrics);
    expect(gate.acceptedSum).toBe(3);
    expect(gate.j1Sum).toBe(2);
    expect(gate.windowFull).toBe(true);
    expect(gate.pass).toBe(true);
    expect(gate.redFlag).toBe(false);
  });

  it("FAILS + raises redFlag when accepted sum < 3 over a full window", () => {
    const metrics = [
      metric(DAYS[0], 0, 1),
      metric(DAYS[1], 1, 1),
      metric(DAYS[2], 0, 0),
      metric(DAYS[3], 1, 0),
      metric(DAYS[4], 0, 0),
    ];
    const gate = evaluateGate(metrics);
    expect(gate.acceptedSum).toBe(2);
    expect(gate.pass).toBe(false);
    expect(gate.redFlag).toBe(true);
  });

  it("FAILS when j1 sum < 2 even if accepted ≥ 3", () => {
    const metrics = [
      metric(DAYS[0], 2, 0),
      metric(DAYS[1], 1, 1),
      metric(DAYS[2], 1, 0),
      metric(DAYS[3], 0, 0),
      metric(DAYS[4], 0, 0),
    ];
    const gate = evaluateGate(metrics);
    expect(gate.acceptedSum).toBeGreaterThanOrEqual(3);
    expect(gate.j1Sum).toBe(1);
    expect(gate.pass).toBe(false);
    expect(gate.redFlag).toBe(true);
  });

  it("does NOT raise redFlag before the window is full", () => {
    const gate = evaluateGate([metric(DAYS[0], 0, 0), metric(DAYS[1], 0, 0)]);
    expect(gate.windowFull).toBe(false);
    expect(gate.pass).toBe(false);
    expect(gate.redFlag).toBe(false);
  });

  it("evaluates only the most recent KILL_WINDOW briefs", () => {
    // 6 briefs: an old bad day then 5 good-enough days; gate should ignore the oldest.
    const metrics = [
      metric("2026-05-10", 0, 0), // dropped from window
      metric(DAYS[0], 1, 0),
      metric(DAYS[1], 1, 1),
      metric(DAYS[2], 1, 1),
      metric(DAYS[3], 0, 0),
      metric(DAYS[4], 0, 0),
    ];
    const gate = evaluateGate(metrics);
    expect(gate.window).toHaveLength(KILL_WINDOW);
    expect(gate.window[0].briefDate).toBe(DAYS[0]);
    expect(gate.acceptedSum).toBe(3);
    expect(gate.j1Sum).toBe(2);
    expect(gate.pass).toBe(true);
  });
});

describe("renderSelfCheckSection", () => {
  const now = new Date("2026-05-22T08:00:00.000Z");

  it("shows 7-day rolling totals", () => {
    const lines = renderSelfCheckSection(
      [metric(DAYS[3], 1, 1, 3), metric(DAYS[4], 2, 1, 4)],
      now,
    ).join("\n");
    expect(lines).toContain("## Control-plane self-check");
    expect(lines).toContain("- Briefs (last 7d): 2");
    expect(lines).toContain("- Suggestions: 7");
    expect(lines).toContain("- Accepted next actions: 3");
    expect(lines).toContain("- J1 actions completed: 2");
  });

  it("excludes briefs older than the 7-day rolling window", () => {
    const lines = renderSelfCheckSection(
      [metric("2026-05-01", 9, 9, 9), metric(DAYS[4], 1, 1, 1)],
      now,
    ).join("\n");
    expect(lines).toContain("- Briefs (last 7d): 1");
    expect(lines).toContain("- Accepted next actions: 1");
  });

  it("renders the PRD § 0.5 red-flag line when the gate fails on a full window", () => {
    const metrics = DAYS.map((d) => metric(d, 0, 0));
    const lines = renderSelfCheckSection(metrics, now).join("\n");
    expect(lines).toContain("🚩");
    expect(lines).toContain("freeze new control-plane feature work");
  });

  it("renders a 'window not full' note before 5 briefs", () => {
    const lines = renderSelfCheckSection([metric(DAYS[4], 0, 0)], now).join("\n");
    expect(lines).toContain("Measurement window not yet full (1/5");
    expect(lines).not.toContain("🚩");
  });
});

describe("renderBriefMarkdown — self-check integration", () => {
  function emptyBrief(): Brief {
    return {
      generatedAt: "2026-05-22T08:00:00.000Z",
      briefDate: "2026-05-22",
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
      sourceNotes: [],
      jobMix: [],
      humanFeedback: { useful: null, wrong: null, changedPriority: null, approvedActions: [] },
      warnings: [],
    };
  }

  it("section is present even without metrics wired", () => {
    const md = renderBriefMarkdown(emptyBrief());
    expect(md).toContain("## Control-plane self-check");
  });

  it("renders the self-check with metrics when provided", () => {
    const md = renderBriefMarkdown(emptyBrief(), {
      selfCheck: { metrics: DAYS.map((d) => metric(d, 0, 0)), now: new Date("2026-05-22T08:00:00.000Z") },
    });
    expect(md).toContain("## Control-plane self-check");
    expect(md).toContain("🚩");
  });

  it("self-check appears before Human Feedback", () => {
    const md = renderBriefMarkdown(emptyBrief());
    expect(md.indexOf("## Control-plane self-check")).toBeLessThan(md.indexOf("## Human Feedback"));
  });
});

describe("T-3.14 reach/bypass (H2 signal)", () => {
  it("evaluateGate tallies reach vs bypass over the window + computes reachRate", () => {
    const ms = [
      { ...metric("2026-05-18", 1, 0), reachOrBypass: "acted-from-pacc" as const },
      { ...metric("2026-05-19", 1, 0), reachOrBypass: "bypassed-to-cli" as const },
      { ...metric("2026-05-20", 1, 0), reachOrBypass: "acted-from-pacc" as const },
      { ...metric("2026-05-21", 1, 0), reachOrBypass: null },
      { ...metric("2026-05-22", 1, 0), reachOrBypass: "bypassed-to-cli" as const },
    ];
    const gate = evaluateGate(ms);
    expect(gate.reachCount).toBe(2);
    expect(gate.bypassCount).toBe(2);
    expect(gate.reachRate).toBe(0.5);
  });

  it("reachRate is null when nothing recorded yet", () => {
    const gate = evaluateGate([metric("2026-05-22", 0, 0)]);
    expect(gate.reachRate).toBeNull();
  });

  it("applyFeedbackToMetric carries reachOrBypass through", () => {
    const m = initMetric("2026-05-22", 5);
    const updated = applyFeedbackToMetric(m, {
      useful: true,
      wrong: null,
      changedPriority: null,
      reachOrBypass: "bypassed-to-cli",
      approvedActions: ["a"],
    });
    expect(updated.reachOrBypass).toBe("bypassed-to-cli");
  });

  it("renderSelfCheckSection surfaces reach/bypass + a bypass-dominant advisory", () => {
    const ms = [
      { ...metric("2026-05-20", 1, 0), reachOrBypass: "bypassed-to-cli" as const },
      { ...metric("2026-05-21", 1, 0), reachOrBypass: "bypassed-to-cli" as const },
      { ...metric("2026-05-22", 1, 0), reachOrBypass: "acted-from-pacc" as const },
    ];
    const lines = renderSelfCheckSection(ms, new Date("2026-05-22T08:00:00.000Z"));
    const md = lines.join("\n");
    expect(md).toMatch(/Acted from pacc \/ bypassed to CLI: 1 \/ 2/);
    expect(md).toMatch(/⚠ \*\*Bypass-dominant\*\*/);
  });

  it("no bypass-dominant advisory when reach >= bypass", () => {
    const ms = [
      { ...metric("2026-05-21", 1, 0), reachOrBypass: "acted-from-pacc" as const },
      { ...metric("2026-05-22", 1, 0), reachOrBypass: "acted-from-pacc" as const },
    ];
    const lines = renderSelfCheckSection(ms, new Date("2026-05-22T08:00:00.000Z"));
    expect(lines.join("\n")).not.toMatch(/Bypass-dominant/);
  });
});
