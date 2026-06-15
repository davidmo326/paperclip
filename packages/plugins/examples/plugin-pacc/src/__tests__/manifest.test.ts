/**
 * Manifest job schedules — guards the cron expressions the host scheduler fires.
 */
import { describe, expect, it } from "vitest";
import manifest from "../manifest.js";
import { JOB_KEYS } from "../constants.js";

function scheduleFor(jobKey: string): string | undefined {
  return manifest.jobs?.find((j) => j.jobKey === jobKey)?.schedule;
}

describe("manifest job schedules", () => {
  it("daily brief at 08:00", () => {
    expect(scheduleFor(JOB_KEYS.briefDaily)).toBe("0 8 * * *");
  });

  it("weekly review on Monday 09:00 (T-3.11 / PRD § 13.2)", () => {
    expect(scheduleFor(JOB_KEYS.weeklyReview)).toBe("0 9 * * 1");
  });

  it("weekend prep on Friday 16:00 (T-3.11 / PRD § 13.4)", () => {
    expect(scheduleFor(JOB_KEYS.weekendPrep)).toBe("0 16 * * 5");
  });

  it("every declared job has a unique key", () => {
    const keys = (manifest.jobs ?? []).map((j) => j.jobKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
