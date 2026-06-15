/**
 * T-3.11 — weekend prep tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildWeekendPrep,
  renderWeekendPrepMarkdown,
  DEFAULT_SELF_PAUSE_BOUNDARIES,
  type WeekendProjectInput,
} from "../lib/briefer/weekend-prep.js";

const NOW = new Date("2026-06-12T16:00:00.000Z"); // a Friday

function proj(over: Partial<WeekendProjectInput> = {}): WeekendProjectInput {
  return {
    projectId: "p",
    projectName: "P",
    portfolioState: "active",
    blockerSummary: null,
    preAuthorizedAsyncWork: [],
    ...over,
  };
}

describe("buildWeekendPrep", () => {
  it("derives must-land-by-Monday from blocked projects", () => {
    const prep = buildWeekendPrep({
      now: NOW,
      projects: [
        proj({ projectName: "Alpha", portfolioState: "blocked", blockerSummary: "waiting on regulator" }),
        proj({ projectName: "Bravo" }),
      ],
    });
    expect(prep.date).toBe("2026-06-12");
    expect(prep.mustLandByMonday).toEqual([{ projectName: "Alpha", reason: "waiting on regulator" }]);
    expect(prep.selfPauseBoundaries).toEqual(DEFAULT_SELF_PAUSE_BOUNDARIES);
  });

  it("surfaces pre-authorized async work when present", () => {
    const prep = buildWeekendPrep({
      now: NOW,
      projects: [proj({ projectName: "Alpha", preAuthorizedAsyncWork: ["run the scraper", "draft the post"] })],
    });
    expect(prep.preAuthorized).toEqual([
      { projectName: "Alpha", items: ["run the scraper", "draft the post"] },
    ]);
  });
});

describe("renderWeekendPrepMarkdown", () => {
  const prep = () =>
    buildWeekendPrep({
      now: NOW,
      projects: [proj({ projectName: "Alpha", portfolioState: "blocked", blockerSummary: "waiting on regulator" })],
    });

  it("renders all PRD § 13.4 sections", () => {
    const md = renderWeekendPrepMarkdown(prep());
    expect(md).toContain("# Weekend Prep - 2026-06-12");
    expect(md).toContain("## Pre-authorized Async Work");
    expect(md).toContain("## Self-pause Boundaries");
    expect(md).toContain("## Must Land Before Monday");
    expect(md).toContain("waiting on regulator");
  });

  it("shows the not-wired note for pre-authorized work when empty", () => {
    const md = renderWeekendPrepMarkdown(buildWeekendPrep({ now: NOW, projects: [proj()] }));
    expect(md).toContain("not yet wired");
  });

  it("is idempotent", () => {
    expect(renderWeekendPrepMarkdown(prep())).toBe(renderWeekendPrepMarkdown(prep()));
  });
});
