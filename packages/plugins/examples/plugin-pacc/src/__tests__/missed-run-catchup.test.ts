/**
 * T-3.6 review fix — missed-run catch-up WIRING.
 *
 * Live-fire finding (2026-07-10): `checkMissedRun` existed and was tested,
 * but nothing called it — the service started at 12:26 on 2026-07-09 and no
 * brief was produced, which is the exact June failure mode T-3.6 was meant
 * to close. These tests cover the composition function that plugin startup
 * invokes; the runner is injected so the (already-tested) brief pipeline
 * isn't re-tested here.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  runMissedBriefCatchUp,
  type RunScheduledBriefOptions,
  type ScheduledBriefResult,
} from "../lib/briefer/scheduled-brief.js";

let baseDir: string;
let runnerCalls: RunScheduledBriefOptions[];

const stubRunner = async (options: RunScheduledBriefOptions): Promise<ScheduledBriefResult> => {
  runnerCalls.push(options);
  return { kind: "completed" } as unknown as ScheduledBriefResult;
};

const logs: Array<{ level: string; msg: string }> = [];
const logger = {
  info: (msg: string) => logs.push({ level: "info", msg }),
  warn: (msg: string) => logs.push({ level: "warn", msg }),
  error: (msg: string) => logs.push({ level: "error", msg }),
};

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "pacc-missed-run-"));
  runnerCalls = [];
  logs.length = 0;
});

describe("runMissedBriefCatchUp", () => {
  it("runs the brief when today's is missing and it is past the threshold hour", async () => {
    const now = new Date("2026-07-09T12:26:00");
    const outcome = await runMissedBriefCatchUp({
      now,
      obsidianBaseDir: baseDir,
      logger,
      runner: stubRunner,
    });
    expect(outcome.ran).toBe(true);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]?.obsidianBaseDir).toBe(baseDir);
    // The catch-up run must reuse the same pipeline options shape —
    // runId marks provenance so the audit trail shows WHY this run happened.
    expect(String(runnerCalls[0]?.runId)).toContain("missed-run");
  });

  it("does nothing when today's brief already exists", async () => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(path.join(baseDir, "Daily Brief - 2026-07-09.md"), "# exists\n");
    const outcome = await runMissedBriefCatchUp({
      now: new Date("2026-07-09T12:26:00"),
      obsidianBaseDir: baseDir,
      logger,
      runner: stubRunner,
    });
    expect(outcome.ran).toBe(false);
    if (outcome.ran === false) expect(outcome.reason).toBe("brief_already_exists");
    expect(runnerCalls).toHaveLength(0);
  });

  it("does nothing before the threshold hour", async () => {
    const outcome = await runMissedBriefCatchUp({
      now: new Date("2026-07-09T06:15:00"),
      obsidianBaseDir: baseDir,
      logger,
      runner: stubRunner,
    });
    expect(outcome.ran).toBe(false);
    if (outcome.ran === false) expect(outcome.reason).toBe("too_early");
    expect(runnerCalls).toHaveLength(0);
  });

  it("passes through extra runner options (guard, briefer options)", async () => {
    const guard = async () => ({ path: "x", kind: "wrote" as const, byteLength: 1 });
    await runMissedBriefCatchUp({
      now: new Date("2026-07-09T12:26:00"),
      obsidianBaseDir: baseDir,
      logger,
      runner: stubRunner,
      runnerOptions: { obsidianGuard: guard, brieferOptions: { skipModel: true } },
    });
    expect(runnerCalls[0]?.obsidianGuard).toBe(guard);
    expect((runnerCalls[0]?.brieferOptions as Record<string, unknown>)?.skipModel).toBe(true);
  });
});
