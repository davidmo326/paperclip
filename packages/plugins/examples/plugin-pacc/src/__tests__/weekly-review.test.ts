/**
 * T-3.11 — weekly portfolio review tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildWeeklyReview,
  renderWeeklyReviewMarkdown,
  isoWeekLabel,
  type WeeklyProjectInput,
} from "../lib/briefer/weekly-review.js";
import type { JobMixRow } from "../lib/briefer/types.js";

const NOW = new Date("2026-06-08T09:00:00.000Z"); // a Monday

function proj(over: Partial<WeeklyProjectInput> = {}): WeeklyProjectInput {
  return {
    projectId: "p",
    projectName: "P",
    portfolioState: "active",
    phase: "validate",
    staleStatus: "fresh",
    nextAction: "do the thing",
    assumptionsDue: [],
    driftCount: 0,
    ...over,
  };
}

function jobMixRow(over: Partial<JobMixRow> = {}): JobMixRow {
  return {
    projectId: "p",
    projectName: "P",
    phase: "validate",
    j1Pct: 60,
    j2Pct: 20,
    j3Pct: 10,
    metaPct: 10,
    thresholdBreach: null,
    ...over,
  };
}

describe("isoWeekLabel", () => {
  it("formats as YYYY-Www", () => {
    expect(isoWeekLabel(NOW)).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("is deterministic", () => {
    expect(isoWeekLabel(NOW)).toBe(isoWeekLabel(new Date(NOW)));
  });

  it("advances by one week seven days later", () => {
    const a = isoWeekLabel(NOW);
    const b = isoWeekLabel(new Date(NOW.getTime() + 7 * 86_400_000));
    expect(a).not.toBe(b);
  });
});

describe("buildWeeklyReview", () => {
  it("groups projects by portfolio state and flags no-next-action + stale", () => {
    const review = buildWeeklyReview({
      now: NOW,
      jobMix: [],
      projects: [
        proj({ projectId: "a", projectName: "Alpha", portfolioState: "primary", nextAction: null }),
        proj({ projectId: "b", projectName: "Bravo", portfolioState: "active", staleStatus: "stale" }),
        proj({ projectId: "c", projectName: "Charlie", portfolioState: "parked" }),
      ],
    });

    const primary = review.rollup.find((r) => r.state === "primary");
    expect(primary?.projects).toEqual(["Alpha"]);
    expect(review.noNextActionProjects).toEqual(["Alpha"]); // primary + null nextAction
    expect(review.staleProjects).toEqual(["Bravo"]);
  });

  it("collects assumptions due and drift counts", () => {
    const review = buildWeeklyReview({
      now: NOW,
      jobMix: [],
      projects: [
        proj({
          projectName: "Alpha",
          assumptionsDue: [{ statement: "users will pay" }],
          driftCount: 2,
        }),
      ],
    });
    expect(review.assumptionsDue).toEqual([{ projectName: "Alpha", statement: "users will pay" }]);
    expect(review.driftPending).toEqual([{ projectName: "Alpha", count: 2 }]);
  });
});

describe("renderWeeklyReviewMarkdown", () => {
  const review = () =>
    buildWeeklyReview({
      now: NOW,
      jobMix: [jobMixRow({ projectName: "Alpha", thresholdBreach: "pre-PMF + J1 < 50%" })],
      projects: [proj({ projectName: "Alpha", portfolioState: "primary", nextAction: null, staleStatus: "stale" })],
    });

  it("renders all PRD § 13.2 section headings", () => {
    const md = renderWeeklyReviewMarkdown(review());
    for (const heading of [
      "# Weekly Portfolio Review - ",
      "## Portfolio Roll-call",
      "## Job Mix (weekly, per project)",
      "## FPCP Ritual",
      "## Assumptions Due for Review",
      "## Decisions Due for Review",
      "## Memory Drift",
      "## Authority Grants Expiring This Week",
      "## Stale Projects",
      "## Projects With No Next Action",
      "## Tasks Completed vs Created",
      "## Agent Performance & Failure Patterns",
      "## Recommended Authority Ceiling Changes",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("includes the FPCP ritual prompts and the job-mix breach flag", () => {
    const md = renderWeeklyReviewMarkdown(review());
    expect(md).toContain("Did this week serve Job 1?");
    expect(md).toContain("Did I build for return, or for intensity?");
    expect(md).toContain("pre-PMF + J1 < 50%");
    expect(md).toContain("Alpha");
  });

  it("is idempotent: same input renders byte-identical output", () => {
    expect(renderWeeklyReviewMarkdown(review())).toBe(renderWeeklyReviewMarkdown(review()));
  });

  it("renders decisions due for review (T-4.7) with the review hint", () => {
    const md = renderWeeklyReviewMarkdown(
      buildWeeklyReview({
        now: NOW,
        jobMix: [],
        projects: [proj({ projectName: "Alpha" })],
        decisionsDue: [{ projectName: "Alpha", summary: "Use embedded Postgres", reviewDate: "2026-06-01" }],
      }),
    );
    expect(md).toContain("Use embedded Postgres");
    expect(md).toContain("pacc decide --review");
    expect(md).toContain("review date 2026-06-01");
  });

  it("renders expiring authority grants (T-4.6)", () => {
    const md = renderWeeklyReviewMarkdown(
      buildWeeklyReview({
        now: NOW,
        jobMix: [],
        projects: [proj({ projectName: "Alpha" })],
        expiringGrants: [{ label: "L2 state @ circlo", expiresAt: "2026-06-18T00:00:00.000Z" }],
      }),
    );
    expect(md).toContain("L2 state @ circlo");
    expect(md).toContain("expires 2026-06-18");
  });

  it("ends with exactly one trailing newline", () => {
    const md = renderWeeklyReviewMarkdown(review());
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});
