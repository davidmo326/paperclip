/**
 * T-3.4 — job-mix computation tests.
 *
 * Three test groups:
 *   1. computeJobMix counting (windowing, fallback to dominant, percentages)
 *   2. computeThresholdBreach — each clause exercised individually
 *   3. integration: computeJobMix end-to-end produces correct breaches
 */

import { describe, expect, it } from "vitest";
import {
  computeJobMix,
  computeThresholdBreach,
  type JobActivity,
  type JobMixProjectInput,
} from "../lib/briefer/job-mix.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-22T12:00:00.000Z");

/** ISO string for `daysAgo` from NOW. */
function daysAgo(d: number): string {
  return new Date(NOW.getTime() - d * 86_400_000).toISOString();
}

function project(over: Partial<JobMixProjectInput> = {}): JobMixProjectInput {
  return {
    projectId: "p-1",
    projectName: "Project One",
    phase: "validate",
    jobClassificationDominant: null,
    ...over,
  };
}

function act(
  projectId: string,
  jobClassification: JobActivity["jobClassification"],
  d: number,
): JobActivity {
  return { projectId, jobClassification, at: daysAgo(d) };
}

// ---------------------------------------------------------------------------
// 1. computeJobMix — counting + windowing + fallback
// ---------------------------------------------------------------------------

describe("computeJobMix — counting + windowing", () => {
  it("produces a row per input project", () => {
    const rows = computeJobMix(
      [project({ projectId: "a", projectName: "A" }), project({ projectId: "b", projectName: "B" })],
      [],
      { now: NOW },
    );
    expect(rows.map((r) => r.projectId).sort()).toEqual(["a", "b"]);
  });

  it("counts only activities inside the rolling 7d window", () => {
    const rows = computeJobMix(
      [project()],
      [
        act("p-1", "J1_signal", 2), // inside
        act("p-1", "J1_signal", 6), // inside
        act("p-1", "J2_distribution", 10), // outside (in prior window)
      ],
      { now: NOW },
    );
    // 2 J1 + 0 others in current → 100% J1
    expect(rows[0].j1Pct).toBe(100);
    expect(rows[0].j2Pct).toBe(0);
  });

  it("computes correct percentages for a mixed bag", () => {
    const rows = computeJobMix(
      [project()],
      [
        act("p-1", "J1_signal", 1),
        act("p-1", "J1_signal", 2),
        act("p-1", "J2_distribution", 3),
        act("p-1", "J3_product", 4),
        act("p-1", "meta", 5),
      ],
      { now: NOW },
    );
    // 5 total, J1 = 2 → 40%, J2/J3/meta = 1 each → 20%
    expect(rows[0].j1Pct).toBe(40);
    expect(rows[0].j2Pct).toBe(20);
    expect(rows[0].j3Pct).toBe(20);
    expect(rows[0].metaPct).toBe(20);
  });

  it("falls back to jobClassificationDominant when window is empty", () => {
    const rows = computeJobMix(
      [project({ jobClassificationDominant: "J1_signal" })],
      [],
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(100);
    expect(rows[0].j2Pct).toBe(0);
  });

  it("renders unclassified (null shares) when both window and dominant are empty (D-41)", () => {
    // No classified activity + no jobClassificationDominant fallback → never
    // fabricate a class (e.g. "meta"); shares are null, not zero.
    const rows = computeJobMix([project()], [], { now: NOW });
    expect(rows[0]).toMatchObject({
      j1Pct: null,
      j2Pct: null,
      j3Pct: null,
      metaPct: null,
      dominantUnset: true,
      unclassifiedCount: 0,
    });
  });

  it("ignores activities for other projects (renders unclassified, not 0%)", () => {
    const rows = computeJobMix(
      [project()],
      [act("other", "J1_signal", 1), act("other", "J1_signal", 2)],
      { now: NOW },
    );
    // p-1 has no activities of its own and no dominant fallback → unclassified.
    expect(rows[0].j1Pct).toBeNull();
  });

  it("ignores activities with non-parseable timestamps", () => {
    const rows = computeJobMix(
      [project()],
      [act("p-1", "J1_signal", 1), { projectId: "p-1", jobClassification: "J1_signal", at: "not-a-date" }],
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(100); // only the valid one counts
  });

  it("respects custom windowDays", () => {
    const rows = computeJobMix(
      [project()],
      [act("p-1", "J1_signal", 10)], // outside 7d, inside 14d
      { now: NOW, windowDays: 14 },
    );
    expect(rows[0].j1Pct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. computeThresholdBreach — each clause exercised individually
// ---------------------------------------------------------------------------

describe("computeThresholdBreach — clause (a): pre-PMF only", () => {
  it("returns null for post-PMF phases (build/distribution/scale/maintenance)", () => {
    for (const phase of ["build", "distribution", "scale", "maintenance"] as const) {
      const breach = computeThresholdBreach({
        phase,
        currentJ1Pct: 10, // low J1
        priorJ1Pct: 20, // declining
        windowDays: 7,
      });
      expect(breach).toBeNull();
    }
  });

  it("returns null for null phase", () => {
    const breach = computeThresholdBreach({
      phase: null,
      currentJ1Pct: 10,
      priorJ1Pct: 20,
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });

  it("considers 'search' phase as pre-PMF (flag fires when other clauses hold)", () => {
    const breach = computeThresholdBreach({
      phase: "search",
      currentJ1Pct: 10,
      priorJ1Pct: 20,
      windowDays: 7,
    });
    expect(breach).not.toBeNull();
    expect(breach).toContain("10%");
  });

  it("considers 'validate' phase as pre-PMF", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 30,
      priorJ1Pct: 40,
      windowDays: 7,
    });
    expect(breach).not.toBeNull();
  });

  it("considers deprecated v1 aliases (exploration/validation) as pre-PMF", () => {
    expect(
      computeThresholdBreach({
        phase: "exploration",
        currentJ1Pct: 10,
        priorJ1Pct: 20,
        windowDays: 7,
      }),
    ).not.toBeNull();
    expect(
      computeThresholdBreach({
        phase: "validation",
        currentJ1Pct: 10,
        priorJ1Pct: 20,
        windowDays: 7,
      }),
    ).not.toBeNull();
  });
});

describe("computeThresholdBreach — clause (b): J1 share < 50%", () => {
  it("returns null when J1 share is exactly 50%", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 50,
      priorJ1Pct: 30,
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });

  it("returns null when J1 share is above 50%", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 60,
      priorJ1Pct: 30,
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });

  it("flags when J1 share is below 50% (and other clauses hold)", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 49,
      priorJ1Pct: 60,
      windowDays: 7,
    });
    expect(breach).not.toBeNull();
    expect(breach).toContain("49%");
  });
});

describe("computeThresholdBreach — clause (c): trend not recovering", () => {
  it("returns null when current J1 > prior J1 (recovering)", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 40,
      priorJ1Pct: 20, // current > prior → recovering
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });

  it("flags when current J1 = prior J1 (stagnant)", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 20,
      priorJ1Pct: 20,
      windowDays: 7,
    });
    expect(breach).not.toBeNull();
  });

  it("flags when current J1 < prior J1 (worsening)", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 10,
      priorJ1Pct: 30,
      windowDays: 7,
    });
    expect(breach).not.toBeNull();
    expect(breach).toContain("30%"); // prior pct mentioned
  });

  it("returns null when prior window is empty (no baseline)", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 10,
      priorJ1Pct: Number.NaN, // no prior activity → no baseline
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });
});

describe("computeThresholdBreach — all clauses combined", () => {
  it("requires ALL three clauses; missing any → null", () => {
    // Base: all three clauses hold → flag fires
    const baseFlag = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 20,
      priorJ1Pct: 40,
      windowDays: 7,
    });
    expect(baseFlag).not.toBeNull();

    // Drop clause (a)
    expect(
      computeThresholdBreach({ phase: "build", currentJ1Pct: 20, priorJ1Pct: 40, windowDays: 7 }),
    ).toBeNull();
    // Drop clause (b)
    expect(
      computeThresholdBreach({ phase: "validate", currentJ1Pct: 60, priorJ1Pct: 40, windowDays: 7 }),
    ).toBeNull();
    // Drop clause (c) (recovering)
    expect(
      computeThresholdBreach({ phase: "validate", currentJ1Pct: 30, priorJ1Pct: 10, windowDays: 7 }),
    ).toBeNull();
  });

  it("includes the window length in the breach message", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: 10,
      priorJ1Pct: 30,
      windowDays: 14,
    });
    expect(breach).toContain("14d");
  });
});

// ---------------------------------------------------------------------------
// 3. computeJobMix end-to-end — flag propagates correctly into rows
// ---------------------------------------------------------------------------

describe("computeJobMix — integration with three-clause guard", () => {
  it("flags a pre-PMF project with declining J1 over the two-window comparison", () => {
    // Prior 7d: 4 J1 + 0 others → 100% J1
    // Current 7d: 1 J1 + 4 J2 → 20% J1
    const activities: JobActivity[] = [
      // current 7d (days 0-7)
      act("p-1", "J1_signal", 1),
      act("p-1", "J2_distribution", 2),
      act("p-1", "J2_distribution", 3),
      act("p-1", "J2_distribution", 4),
      act("p-1", "J2_distribution", 5),
      // prior 7d (days 7-14)
      act("p-1", "J1_signal", 8),
      act("p-1", "J1_signal", 9),
      act("p-1", "J1_signal", 10),
      act("p-1", "J1_signal", 11),
    ];
    const rows = computeJobMix(
      [project({ phase: "validate" })],
      activities,
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(20);
    expect(rows[0].thresholdBreach).not.toBeNull();
    expect(rows[0].thresholdBreach).toContain("not recovering");
  });

  it("does NOT flag when J1 share is recovering even if still <50%", () => {
    // Prior 7d: 1 J1 + 4 J2 → 20% J1
    // Current 7d: 2 J1 + 3 J2 → 40% J1 (recovering, still <50%)
    const activities: JobActivity[] = [
      // current
      act("p-1", "J1_signal", 1),
      act("p-1", "J1_signal", 2),
      act("p-1", "J2_distribution", 3),
      act("p-1", "J2_distribution", 4),
      act("p-1", "J2_distribution", 5),
      // prior
      act("p-1", "J1_signal", 8),
      act("p-1", "J2_distribution", 9),
      act("p-1", "J2_distribution", 10),
      act("p-1", "J2_distribution", 11),
      act("p-1", "J2_distribution", 12),
    ];
    const rows = computeJobMix(
      [project({ phase: "validate" })],
      activities,
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(40);
    expect(rows[0].thresholdBreach).toBeNull(); // recovering
  });

  it("does NOT flag a post-PMF (build) project with low J1", () => {
    const activities: JobActivity[] = [
      act("p-1", "J3_product", 1),
      act("p-1", "J3_product", 2),
      act("p-1", "J3_product", 3),
      act("p-1", "J3_product", 8),
      act("p-1", "J3_product", 9),
    ];
    const rows = computeJobMix(
      [project({ phase: "build" })],
      activities,
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(0);
    expect(rows[0].thresholdBreach).toBeNull(); // post-PMF, no flag
  });

  it("does NOT flag a pre-PMF project with no prior baseline", () => {
    // Only current activity, no prior → can't establish trend
    const rows = computeJobMix(
      [project({ phase: "validate" })],
      [act("p-1", "J2_distribution", 1), act("p-1", "J2_distribution", 2)],
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBe(0);
    expect(rows[0].thresholdBreach).toBeNull(); // no baseline
  });

  it("preserves project name and phase in output rows", () => {
    const rows = computeJobMix(
      [project({ projectId: "circlo", projectName: "Circlo", phase: "validate" })],
      [],
      { now: NOW },
    );
    expect(rows[0]).toMatchObject({
      projectId: "circlo",
      projectName: "Circlo",
      phase: "validate",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. D-41 / T-3.13 — unclassified activity handling
// ---------------------------------------------------------------------------

describe("computeJobMix — unclassified activity (D-41)", () => {
  it("excludes unclassified activities from every class's percentage, reports them as a count", () => {
    const rows = computeJobMix(
      [project({ jobClassificationDominant: "J1_signal" })],
      [
        act("p-1", "J1_signal", 1),
        act("p-1", "J1_signal", 2),
        act("p-1", null, 3),
        act("p-1", null, 4),
      ],
      { now: NOW },
    );
    // 2 classified J1 out of 2 classified total → 100%, NOT diluted by the
    // 2 unclassified entries.
    expect(rows[0].j1Pct).toBe(100);
    expect(rows[0].j2Pct).toBe(0);
    expect(rows[0].unclassifiedCount).toBe(2);
  });

  it("cannot trigger a J1-breach on its own: a pre-PMF project with zero classified activity never flags", () => {
    const rows = computeJobMix(
      [project({ phase: "validate", jobClassificationDominant: null })],
      [act("p-1", null, 1), act("p-1", null, 2), act("p-1", null, 3)],
      { now: NOW },
    );
    expect(rows[0].j1Pct).toBeNull();
    expect(rows[0].unclassifiedCount).toBe(3);
    expect(rows[0].thresholdBreach).toBeNull();
    expect(rows[0].dominantUnset).toBe(true);
  });

  it("cannot mask a real J1-breach: unclassified activity in the window doesn't dilute the classified share", () => {
    // Prior 7d: 4 J1 → 100%. Current 7d: 1 J1 + 4 J2 (classified) + 10
    // unclassified → the unclassified noise must not change the 20% figure.
    const activities: JobActivity[] = [
      act("p-1", "J1_signal", 1),
      act("p-1", "J2_distribution", 2),
      act("p-1", "J2_distribution", 3),
      act("p-1", "J2_distribution", 4),
      act("p-1", "J2_distribution", 5),
      ...Array.from({ length: 10 }, (_, i) => act("p-1", null, 1 + (i % 6))),
      act("p-1", "J1_signal", 8),
      act("p-1", "J1_signal", 9),
      act("p-1", "J1_signal", 10),
      act("p-1", "J1_signal", 11),
    ];
    const rows = computeJobMix([project({ phase: "validate" })], activities, { now: NOW });
    expect(rows[0].j1Pct).toBe(20);
    expect(rows[0].unclassifiedCount).toBe(10);
    expect(rows[0].thresholdBreach).not.toBeNull();
    expect(rows[0].thresholdBreach).toContain("not recovering");
  });
});

describe("computeThresholdBreach — D-41: null share (unclassified) never breaches", () => {
  it("returns null when currentJ1Pct is null even if phase/priorJ1Pct would otherwise flag", () => {
    const breach = computeThresholdBreach({
      phase: "validate",
      currentJ1Pct: null,
      priorJ1Pct: 40,
      windowDays: 7,
    });
    expect(breach).toBeNull();
  });
});
