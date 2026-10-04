/**
 * Job-class persistence + Jev wiring — T-jev.
 *
 * Records live as plugin entities (`job-class`, instance scope, externalId =
 * work item id). Modes, from PACC_JEV_JOBCLASS:
 *   off    (default) — nothing runs; job-mix keeps its dominant-class fallback.
 *   shadow — labels are computed and stored on every brief / review, but
 *            job-mix still gets no activities. Read them with `job-class-review`.
 *   on     — job-mix is fed the work-item activity stream.
 *
 * Plugin workers only receive PACC_* env (minimal-env policy), so the shared
 * client's JEV_* settings are supplied as PACC_JEV_API_KEY / PACC_JEV_MODEL /
 * PACC_JEV_API_URL and mapped here.
 */

import type { DecisionCtx } from "../decisions/decision-deps.js";
import type { JobActivity, JobClass } from "../briefer/job-mix.js";
import { callJev, type JevChoiceQuestion } from "../jev/jevClient.js";
import { makeLineDeps } from "../lines/lines-deps.js";
import { makeWorkItemDeps } from "../work-items/work-item-deps.js";
import {
  JOB_CLASS_CRITERIA,
  backlogSubjects,
  isJobClass,
  labelSubjects,
  labelWorkItems,
  workItemActivities,
  type ClassifyFn,
  type JobClassRecord,
  type LabelResult,
  type LineContext,
} from "./job-class.js";

export const JOB_CLASS_ENTITY_TYPE = "job-class";

export type JobClassMode = "off" | "shadow" | "on";

export interface JobClassConfig {
  mode: JobClassMode;
  minProbability: number;
  maxCalls: number;
  /** True when a Jev key is present; without one only rule labels are made. */
  jevConfigured: boolean;
}

type Env = Record<string, string | undefined>;

export function resolveJobClassConfig(env: Env = process.env): JobClassConfig {
  const raw = env.PACC_JEV_JOBCLASS?.trim().toLowerCase();
  const mode: JobClassMode = raw === "on" || raw === "shadow" ? raw : "off";
  const minP = Number(env.PACC_JEV_JOBCLASS_MIN_P);
  const maxCalls = Number(env.PACC_JEV_JOBCLASS_MAX_CALLS);
  return {
    mode,
    minProbability: Number.isFinite(minP) && minP > 0 && minP <= 1 ? minP : 0.6,
    maxCalls: Number.isInteger(maxCalls) && maxCalls >= 0 ? maxCalls : 40,
    jevConfigured: Boolean((env.PACC_JEV_API_KEY ?? env.JEV_API_KEY)?.trim()),
  };
}

/** Copy PACC_JEV_* onto the JEV_* names the shared client reads (never overrides an explicit JEV_*). */
export function applyPaccJevEnv(env: Env = process.env): void {
  for (const name of ["API_KEY", "MODEL", "API_URL"]) {
    const v = env[`PACC_JEV_${name}`]?.trim();
    if (v && !env[`JEV_${name}`]?.trim()) env[`JEV_${name}`] = v;
  }
}

const QUESTION: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "Which of the founder's jobs does this task serve? Judge by what the task's output is for, not by the kind of activity or the label it was filed under. A direct prerequisite (its very next step is a customer contact, or an asset or offer going out) takes the job it serves; anything further removed is build-and-think.",
  criteria: JOB_CLASS_CRITERIA,
};

export function makeJevClassify(timeoutMs = 15_000): ClassifyFn {
  applyPaccJevEnv();
  return async (state) => {
    const res = await callJev(state, { job: QUESTION }, { timeoutMs, retries: 1 });
    const answer = res.answers.job;
    if (!isJobClass(answer.choice)) throw new Error(`Jev chose an unknown class: ${answer.choice}`);
    const choice: JobClass = answer.choice;
    return { choice, probability: answer.probabilities[choice] ?? answer.confidence, model: res.model ?? null };
  };
}

export interface JobClassStore {
  list(): Promise<JobClassRecord[]>;
  put(rec: JobClassRecord): Promise<void>;
}

export function makeJobClassStore(ctx: DecisionCtx): JobClassStore {
  return {
    async list() {
      const rows = await ctx.entities.list({ entityType: JOB_CLASS_ENTITY_TYPE, scopeKind: "instance", limit: 5000 });
      return rows.map((r) => r.data as unknown as JobClassRecord);
    },
    async put(rec) {
      await ctx.entities.upsert({
        entityType: JOB_CLASS_ENTITY_TYPE,
        scopeKind: "instance",
        externalId: rec.itemId,
        title: `job-class ${rec.itemId}`,
        status: rec.principal?.jobClass ?? rec.rule ?? rec.jev?.choice ?? "unclassified",
        data: rec as unknown as Record<string, unknown>,
      });
    },
  };
}

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface RefreshedJobClasses extends LabelResult {
  activities: JobActivity[];
  config: JobClassConfig;
}

/**
 * One labelling pass over the floor: classify what's new, persist what
 * changed, and return job-mix activities (empty unless mode is `on`).
 * Never throws — a failure degrades to "no activities" and a warning.
 */
export async function refreshJobClasses(
  ctx: DecisionCtx,
  logger: Logger,
  opts: { now?: Date; config?: JobClassConfig; classify?: ClassifyFn } = {},
): Promise<RefreshedJobClasses> {
  const config = opts.config ?? resolveJobClassConfig();
  const empty: RefreshedJobClasses = { changed: [], records: new Map(), calls: 0, errors: 0, activities: [], config };
  if (config.mode === "off") return empty;
  try {
    const store = makeJobClassStore(ctx);
    const [items, lines, stored] = await Promise.all([
      makeWorkItemDeps(ctx).listItems(),
      makeLineDeps(ctx).listLines(),
      store.list(),
    ]);
    const lineCtx = new Map<string, LineContext>(
      lines.map((l) => [l.id, { id: l.id, name: l.name, phase: l.phase, intent: l.intent }]),
    );
    const classify = opts.classify ?? (config.jevConfigured ? makeJevClassify() : undefined);
    const result = await labelWorkItems(items, lineCtx, new Map(stored.map((r) => [r.itemId, r])), {
      now: opts.now ?? new Date(),
      maxCalls: config.maxCalls,
      classify,
    });
    for (const rec of result.changed) await store.put(rec);
    if (result.calls > 0 || result.errors > 0) {
      logger.info("job-class pass", { mode: config.mode, calls: result.calls, errors: result.errors, changed: result.changed.length });
    }
    const activities = config.mode === "on" ? workItemActivities(items, result.records, config.minProbability) : [];
    return { ...result, activities, config };
  } catch (err) {
    logger.warn("job-class pass failed; job-mix falls back to dominant classes", { error: (err as Error).message });
    return empty;
  }
}

/**
 * Backlog backtest: Jev labels live backlog tasks on every line so the
 * principal can build agreement data without waiting for floor work. Records
 * are `source: "backlog"` and never reach job-mix. Bounded per call (the
 * caller loops until `calls` is 0); throws on store failure — it's an
 * explicit action, not a brief step.
 */
export async function backtestBacklog(
  ctx: DecisionCtx,
  logger: Logger,
  opts: { maxCalls: number; now?: Date; classify?: ClassifyFn; config?: JobClassConfig },
): Promise<LabelResult & { subjects: number }> {
  const config = opts.config ?? resolveJobClassConfig();
  const classify = opts.classify ?? (config.jevConfigured ? makeJevClassify() : undefined);
  if (!classify) throw new Error("no PACC_JEV_API_KEY — a backlog backtest needs Jev");
  const store = makeJobClassStore(ctx);
  const [lines, stored] = await Promise.all([makeLineDeps(ctx).listLines(), store.list()]);
  const lineCtx = new Map<string, LineContext>(lines.map((l) => [l.id, { id: l.id, name: l.name, phase: l.phase, intent: l.intent }]));
  const subjects = backlogSubjects(lines, lineCtx);
  const result = await labelSubjects(subjects, new Map(stored.map((r) => [r.itemId, r])), {
    now: opts.now ?? new Date(),
    maxCalls: opts.maxCalls,
    classify,
  });
  for (const rec of result.changed) await store.put(rec);
  logger.info("job-class backlog backtest pass", { subjects: subjects.length, calls: result.calls, errors: result.errors, changed: result.changed.length });
  return { ...result, subjects: subjects.length };
}
