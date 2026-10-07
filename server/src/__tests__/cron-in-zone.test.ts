import { describe, expect, it } from "vitest";
import { nextCronTick, nextCronTickInZone, parseCron } from "../services/cron.js";

// Plugin jobs are scheduled as local wall-clock time (plugin-job-scheduler's
// PLUGIN_JOB_TZ). Sydney DST starts 2026-10-04 02:00 AEST -> 03:00 AEDT.
const SYD = "Australia/Sydney";

describe("nextCronTickInZone", () => {
  it("reads the schedule as local wall-clock time (AEST, +10)", () => {
    const next = nextCronTickInZone(parseCron("20 8 * * *"), SYD, new Date("2026-09-30T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-30T22:20:00.000Z"); // 1 Oct 08:20 AEST
  });

  it("follows the DST switch (AEDT, +11)", () => {
    const next = nextCronTickInZone(parseCron("20 8 * * *"), SYD, new Date("2026-10-04T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-10-04T21:20:00.000Z"); // 5 Oct 08:20 AEDT
  });

  it("skips a wall-clock time that does not exist on the spring-forward day", () => {
    // 4 Oct 02:30 local never happens; the next 02:30 is on 5 Oct (AEDT).
    const next = nextCronTickInZone(parseCron("30 2 * * *"), SYD, new Date("2026-10-03T15:00:00Z"));
    expect(next?.toISOString()).toBe("2026-10-04T15:30:00.000Z");
  });

  it("honours day-of-week in the local zone, not UTC", () => {
    // Mondays 07:00 Sydney = Sunday 21:00 UTC (AEST).
    const next = nextCronTickInZone(parseCron("0 7 * * 1"), SYD, new Date("2026-09-23T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-27T21:00:00.000Z");
  });

  it("matches nextCronTick when the zone is UTC", () => {
    const cron = parseCron("*/15 9-17 * * 1-5");
    const after = new Date("2026-09-30T08:07:00Z");
    expect(nextCronTickInZone(cron, "UTC", after)?.toISOString()).toBe(nextCronTick(cron, after)?.toISOString());
  });
});
