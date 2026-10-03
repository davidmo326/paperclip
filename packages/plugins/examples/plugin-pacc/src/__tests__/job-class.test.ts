/**
 * T-jev — job classification of floor work.
 *
 * Pure-logic tests: rule labels, Jev labelling (injected), precedence,
 * re-classification on content change, the activity stream fed to job-mix,
 * agreement, and config/env mapping.
 */

import { describe, expect, it, vi } from "vitest";
import {
  activeAt,
  buildJobClassState,
  contentKeyOf,
  effectiveJobClass,
  jobClassAgreement,
  labelWorkItems,
  ruleJobClass,
  workItemActivities,
  type ClassifyFn,
  type JobClassRecord,
  type LineContext,
} from "../lib/job-class/job-class.js";
import { applyPaccJevEnv, resolveJobClassConfig } from "../lib/job-class/job-class-deps.js";
import type { WorkItem } from "../lib/work-items/work-items.js";

const NOW = new Date("2026-10-03T00:00:00.000Z");

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w-1",
    projectId: "hometrics",
    title: "Add PDF export",
    detail: null,
    workType: "build",
    size: "bite",
    stage: "in-progress",
    keyQuestion: null,
    worker: null,
    machine: null,
    dispatchId: null,
    draft: null,
    sourceRefs: [],
    createdBy: "principal",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    history: [
      { at: "2026-09-30T00:00:00.000Z", from: null, to: "intake", by: "principal" },
      { at: "2026-09-30T06:00:00.000Z", from: "intake", to: "in-progress", by: "principal" },
    ],
    ...over,
  };
}

const LINES = new Map<string, LineContext>([
  ["hometrics", { id: "hometrics", name: "Hometrics", phase: "distribution", intent: "Defect reports for home buyers" }],
]);

const jev = (choice: ClassifyFn extends (s: string) => Promise<infer R> ? R : never): ClassifyFn =>
  vi.fn(async () => choice);

describe("ruleJobClass", () => {
  it("market-contact is J1; control-plane line is meta; build has no rule", () => {
    expect(ruleJobClass({ workType: "market-contact", projectId: "hometrics" })).toBe("J1_signal");
    expect(ruleJobClass({ workType: "build", projectId: "personal-ai-control-plane" })).toBe("meta");
    expect(ruleJobClass({ workType: "build", projectId: "hometrics" })).toBeNull();
    expect(ruleJobClass({ workType: "hypothesis-design", projectId: "hometrics" })).toBeNull();
  });
});

describe("buildJobClassState", () => {
  it("includes the line context and the item text, and nothing about sessions", () => {
    const s = buildJobClassState(item({ detail: "for buyers' agents", keyQuestion: "Will agents pay?" }), LINES.get("hometrics"));
    expect(s).toContain("Project: Hometrics");
    expect(s).toContain("Project phase: distribution");
    expect(s).toContain("Title: Add PDF export");
    expect(s).toContain("Key question it moves: Will agents pay?");
  });
});

describe("labelWorkItems", () => {
  it("asks Jev only for active items with no rule, and only once per content", async () => {
    const classify = jev({ choice: "J3_product", probability: 0.82, model: "jev-1.13.0" });
    const items = [
      item({ id: "a" }),
      item({ id: "b", workType: "market-contact" }),
      item({ id: "c", stage: "intake" }),
    ];
    const first = await labelWorkItems(items, LINES, new Map(), { now: NOW, maxCalls: 10, classify });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(first.records.get("a")!.jev).toEqual({ choice: "J3_product", probability: 0.82, model: "jev-1.13.0", at: NOW.toISOString() });
    expect(first.records.get("b")!.rule).toBe("J1_signal");
    expect(first.records.has("c")).toBe(false);
    expect(first.changed.map((r) => r.itemId)).toEqual(["a", "b"]);

    const second = await labelWorkItems(items, LINES, first.records, { now: NOW, maxCalls: 10, classify });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(second.changed).toEqual([]);
  });

  it("re-classifies when the content changes, dropping the old principal label", async () => {
    const classify = jev({ choice: "J2_distribution", probability: 0.7, model: null });
    const prior: JobClassRecord = {
      itemId: "a",
      projectId: "hometrics",
      contentKey: "stale",
      rule: null,
      jev: { choice: "J3_product", probability: 0.9, model: null, at: "x" },
      jevError: null,
      principal: { jobClass: "J3_product", at: "x" },
    };
    const r = await labelWorkItems([item({ id: "a" })], LINES, new Map([["a", prior]]), { now: NOW, maxCalls: 5, classify });
    const rec = r.records.get("a")!;
    expect(rec.contentKey).toBe(contentKeyOf(item({ id: "a" })));
    expect(rec.principal).toBeNull();
    expect(rec.jev!.choice).toBe("J2_distribution");
  });

  it("still asks Jev for a principal-labelled item (that pair is the agreement data)", async () => {
    const classify = jev({ choice: "J1_signal", probability: 0.9, model: null });
    const it0 = item({ id: "a" });
    const prior: JobClassRecord = {
      itemId: "a", projectId: "hometrics", contentKey: contentKeyOf(it0),
      rule: null, jev: null, jevError: null, principal: { jobClass: "J1_signal", at: "x" },
    };
    const r = await labelWorkItems([it0], LINES, new Map([["a", prior]]), { now: NOW, maxCalls: 5, classify });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.records.get("a")!.principal).toEqual({ jobClass: "J1_signal", at: "x" });
  });

  it("records a Jev failure instead of throwing, and doesn't retry it next pass", async () => {
    const classify: ClassifyFn = vi.fn(async () => {
      throw new Error("Jev request failed (500)");
    });
    const r = await labelWorkItems([item({ id: "a" })], LINES, new Map(), { now: NOW, maxCalls: 5, classify });
    expect(r.errors).toBe(1);
    expect(r.records.get("a")!.jevError).toContain("500");
    await labelWorkItems([item({ id: "a" })], LINES, r.records, { now: NOW, maxCalls: 5, classify });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("respects the call budget and works without Jev (rule labels only)", async () => {
    const classify = jev({ choice: "J3_product", probability: 0.9, model: null });
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    const r = await labelWorkItems(items, LINES, new Map(), { now: NOW, maxCalls: 2, classify });
    expect(r.calls).toBe(2);
    expect(r.records.get("c")!.jev).toBeNull();
    const noJev = await labelWorkItems(items, LINES, new Map(), { now: NOW, maxCalls: 2 });
    expect(noJev.calls).toBe(0);
  });
});

describe("effectiveJobClass", () => {
  const base: JobClassRecord = {
    itemId: "a", projectId: "p", contentKey: "k", rule: null,
    jev: { choice: "J3_product", probability: 0.55, model: null, at: "x" }, jevError: null, principal: null,
  };
  it("principal > rule > confident Jev > null (D-41)", () => {
    expect(effectiveJobClass(base, 0.6)).toBeNull();
    expect(effectiveJobClass(base, 0.5)).toBe("J3_product");
    expect(effectiveJobClass({ ...base, rule: "J1_signal" }, 0.5)).toBe("J1_signal");
    expect(effectiveJobClass({ ...base, rule: "J1_signal", principal: { jobClass: "meta", at: "x" } }, 0.5)).toBe("meta");
  });
});

describe("workItemActivities", () => {
  it("one activity per active item, at its last move into an active stage, deterministic order", () => {
    const items = [
      item({ id: "b", projectId: "hometrics" }),
      item({ id: "a", projectId: "hometrics", workType: "market-contact" }),
      item({ id: "c", stage: "triage" }),
    ];
    const records = new Map<string, JobClassRecord>([
      ["a", { itemId: "a", projectId: "hometrics", contentKey: "k", rule: "J1_signal", jev: null, jevError: null, principal: null }],
    ]);
    const acts = workItemActivities(items, records, 0.6);
    expect(acts).toHaveLength(2);
    expect(acts.every((a) => a.at === "2026-09-30T06:00:00.000Z")).toBe(true);
    expect(acts.map((a) => a.jobClassification).sort()).toEqual(["J1_signal", null].sort());
  });

  it("activeAt falls back to updatedAt with no active move in history", () => {
    expect(activeAt(item({ history: [] }))).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("jobClassAgreement", () => {
  it("exact, J1-vs-not and confident-only agreement over principal+Jev pairs", () => {
    const rec = (principal: string, choice: string, p: number): JobClassRecord => ({
      itemId: `${principal}-${choice}-${p}`, projectId: "p", contentKey: "k", rule: null, jevError: null,
      jev: { choice: choice as never, probability: p, model: null, at: "x" },
      principal: { jobClass: principal as never, at: "x" },
    });
    const a = jobClassAgreement(
      [rec("J1_signal", "J1_signal", 0.9), rec("J3_product", "J2_distribution", 0.4), rec("J3_product", "J3_product", 0.7), rec("meta", "J1_signal", 0.8)],
      0.6,
    );
    expect(a).toEqual({ compared: 4, exact: 0.5, j1: 0.75, confidentCompared: 3, confidentExact: 0.67 });
  });
});

describe("config", () => {
  it("defaults to off, 0.6, 40 calls", () => {
    expect(resolveJobClassConfig({})).toEqual({ mode: "off", minProbability: 0.6, maxCalls: 40, jevConfigured: false });
  });
  it("reads PACC_JEV_* knobs", () => {
    const c = resolveJobClassConfig({ PACC_JEV_JOBCLASS: "Shadow", PACC_JEV_JOBCLASS_MIN_P: "0.75", PACC_JEV_JOBCLASS_MAX_CALLS: "5", PACC_JEV_API_KEY: "k" });
    expect(c).toEqual({ mode: "shadow", minProbability: 0.75, maxCalls: 5, jevConfigured: true });
  });
  it("maps PACC_JEV_* onto JEV_* without overriding explicit values", () => {
    const env: Record<string, string | undefined> = { PACC_JEV_API_KEY: "pk", PACC_JEV_MODEL: "jev-latest", JEV_MODEL: "explicit" };
    applyPaccJevEnv(env);
    expect(env.JEV_API_KEY).toBe("pk");
    expect(env.JEV_MODEL).toBe("explicit");
    expect(env.JEV_API_URL).toBeUndefined();
  });
});
