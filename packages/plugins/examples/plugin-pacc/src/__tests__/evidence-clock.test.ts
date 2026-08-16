/**
 * T-6.2 evidence-clock tests — dual clocks, evidence-keyed decay.
 *
 * The invariant under test (grill 2026-08-16): author identity never resets
 * a clock; only event type does. Concretely: a state-write (whosever) must
 * NOT reset decay; a decision, an M1a source change, or a hypotheses patch
 * MUST.
 */

import { describe, expect, it } from "vitest";
import {
  STALE_THRESHOLDS_MS,
  agingFromEvidenceDays,
  evidenceAgeDays,
  patchTouchesEvidence,
  withEvidenceStamp,
} from "../lib/evidence-clock.js";

const NOW = new Date("2026-08-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("patchTouchesEvidence / withEvidenceStamp", () => {
  it("hypotheses patches are evidence events and get stamped", () => {
    const patch = { hypotheses: [] };
    const stamped = withEvidenceStamp(patch, daysAgo(0));
    expect(stamped.lastEvidenceAt).toBe(daysAgo(0));
    expect(patch).not.toHaveProperty("lastEvidenceAt"); // original untouched
  });

  it("plain state-field edits are NOT evidence events — no stamp, no reset", () => {
    const patch = { nextSmallestAction: "call Frida", blockerSummary: null };
    const stamped = withEvidenceStamp(patch, daysAgo(0));
    expect(stamped).toBe(patch); // same reference — nothing added
    expect(patchTouchesEvidence(patch)).toBe(false);
  });

  it("never moves an existing later stamp backwards", () => {
    const patch = { hypotheses: [], lastEvidenceAt: daysAgo(-1) }; // "tomorrow"
    const stamped = withEvidenceStamp(patch, daysAgo(0));
    expect(stamped.lastEvidenceAt).toBe(daysAgo(-1));
  });
});

describe("evidenceAgeDays reducer", () => {
  it("takes the most recent signal (min age)", () => {
    expect(
      evidenceAgeDays(
        { sourceDecayDaysSinceTouch: 12, lastEvidenceAt: daysAgo(3), latestDecisionAt: daysAgo(7) },
        NOW,
      ),
    ).toBeCloseTo(3, 5);
  });

  it("works with partial signals", () => {
    expect(evidenceAgeDays({ sourceDecayDaysSinceTouch: null, lastEvidenceAt: null, latestDecisionAt: daysAgo(5) }, NOW)).toBeCloseTo(5, 5);
    expect(evidenceAgeDays({ sourceDecayDaysSinceTouch: 9, lastEvidenceAt: null, latestDecisionAt: null }, NOW)).toBeCloseTo(9, 5);
  });

  it("returns null when no signal exists (legacy row)", () => {
    expect(evidenceAgeDays({ sourceDecayDaysSinceTouch: null, lastEvidenceAt: null, latestDecisionAt: null }, NOW)).toBeNull();
  });

  it("ignores unparseable timestamps", () => {
    expect(evidenceAgeDays({ sourceDecayDaysSinceTouch: null, lastEvidenceAt: "not-a-date", latestDecisionAt: daysAgo(2) }, NOW)).toBeCloseTo(2, 5);
  });
});

describe("agingFromEvidenceDays", () => {
  it("uses the per-portfolioState thresholds", () => {
    // primary: aging 2d, stale 4d
    expect(agingFromEvidenceDays("primary", 1)).toBe("fresh");
    expect(agingFromEvidenceDays("primary", 2.5)).toBe("aging");
    expect(agingFromEvidenceDays("primary", 5)).toBe("stale");
    // active: aging 5d, stale 10d
    expect(agingFromEvidenceDays("active", 4)).toBe("fresh");
    expect(agingFromEvidenceDays("active", 7)).toBe("aging");
    expect(agingFromEvidenceDays("active", 11)).toBe("stale");
  });

  it("threshold-less states and null ages are fresh (no opinion)", () => {
    expect(agingFromEvidenceDays("paused", 30)).toBe("fresh");
    expect(agingFromEvidenceDays(null, 30)).toBe("fresh");
    expect(agingFromEvidenceDays("active", null)).toBe("fresh");
  });
});

describe("the laundering case (the reason T-6.2 exists)", () => {
  it("a stale project stays stale after a state-only write — evidence age unchanged", () => {
    // Project primary, last evidence 6d ago. Someone edits nextSmallestAction
    // now. Evidence inputs contain NO new event, so:
    const age = evidenceAgeDays(
      { sourceDecayDaysSinceTouch: 6, lastEvidenceAt: daysAgo(6), latestDecisionAt: daysAgo(20) },
      NOW,
    );
    expect(agingFromEvidenceDays("primary", age)).toBe("stale"); // still stale
  });

  it("a decision resets the evidence clock regardless of author", () => {
    const age = evidenceAgeDays(
      { sourceDecayDaysSinceTouch: 6, lastEvidenceAt: daysAgo(6), latestDecisionAt: daysAgo(0.5) },
      NOW,
    );
    expect(age).toBeCloseTo(0.5, 5);
    expect(agingFromEvidenceDays("primary", age)).toBe("fresh");
  });

  it("thresholds match the previous single source of truth", () => {
    expect(STALE_THRESHOLDS_MS.primary).toEqual({ aging: 2 * 86_400_000, stale: 4 * 86_400_000 });
    expect(STALE_THRESHOLDS_MS.blocked).toEqual({ aging: 3 * 86_400_000, stale: 7 * 86_400_000 });
    expect(STALE_THRESHOLDS_MS.paused).toBeNull();
  });
});
