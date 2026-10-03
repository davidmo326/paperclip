/**
 * Job classification of floor work — T-jev.
 *
 * Feeds job-mix (PRD § 0.5, § 13.1) with real activity: each work item that is
 * being worked (in-progress / needs-you / done) counts once, at the moment it
 * last moved into one of those stages, under its effective job class.
 *
 * Effective class, in precedence order:
 *   1. the principal's label (`principal`) — always wins;
 *   2. the rule label from workType (`market-contact` is J1 by definition);
 *   3. Jev's choice, only when its probability clears `minProbability`.
 * Anything else is `null` (D-41: never fabricated; job-mix counts it as
 * unclassified).
 *
 * Classification runs once per item content (`contentKey`) and is stored, so
 * briefs read stored labels and stay byte-identical on identical inputs.
 * Pure logic — the Jev call is injected as `ClassifyFn`.
 */

import { createHash } from "node:crypto";
import type { JobActivity, JobClass } from "../briefer/job-mix.js";
import type { Stage, WorkItem, WorkType } from "../work-items/work-items.js";

export const JOB_CLASSES: readonly JobClass[] = ["J1_signal", "J2_distribution", "J3_product", "meta"];

/** Jev choice criteria — the PRD § 0.5 definitions, phrased for a single work item. */
export const JOB_CLASS_CRITERIA: Record<JobClass, string> = {
  J1_signal:
    "Customer signal: talking to prospects or users, discovery calls, outreach that asks for a reply, LOIs, deposits, pricing tests, or designing and running a test of whether a real customer has the problem or will pay.",
  J2_distribution:
    "Distribution: reaching more of the right people for something that already exists — content, landing pages, channels, SEO, listings, partnerships, launch and marketing work.",
  J3_product:
    "Product: building, fixing, designing or shipping the project's own product or service — features, code, data, infrastructure for that product.",
  meta:
    "Meta: work on the principal's own tooling, control plane, agents, machines, automation or planning system rather than on a project's customers, distribution or product.",
};

/** Stages where an item counts as worked on (intake/triage are proposals, not activity). */
export const ACTIVE_STAGES: ReadonlySet<Stage> = new Set<Stage>(["in-progress", "needs-you", "done"]);

/** The principal's own control-plane line: its work is `meta` by definition (PRD § 0.5 point 3). */
export const META_LINE_IDS: ReadonlySet<string> = new Set(["personal-ai-control-plane"]);

export interface JevLabel {
  choice: JobClass;
  probability: number;
  model: string | null;
  at: string;
}

/** Stored per work item (entity `job-class`, externalId = itemId). */
export interface JobClassRecord {
  itemId: string;
  projectId: string;
  /** Hash of the classified content — a changed title/detail/workType/line re-classifies. */
  contentKey: string;
  rule: JobClass | null;
  jev: JevLabel | null;
  /** Last Jev failure for this content, so a broken call isn't retried every brief. */
  jevError: string | null;
  principal: { jobClass: JobClass; at: string } | null;
}

export interface LineContext {
  id: string;
  name: string;
  phase: string | null;
  intent: string | null;
}

export type ClassifyFn = (state: string) => Promise<{ choice: JobClass; probability: number; model: string | null }>;

// ---------------------------------------------------------------------------
// Rules + state
// ---------------------------------------------------------------------------

export function ruleJobClass(item: Pick<WorkItem, "workType" | "projectId">): JobClass | null {
  if (META_LINE_IDS.has(item.projectId)) return "meta";
  const byType: Partial<Record<WorkType, JobClass>> = { "market-contact": "J1_signal" };
  return byType[item.workType] ?? null;
}

export function contentKeyOf(item: Pick<WorkItem, "projectId" | "title" | "detail" | "workType">): string {
  return createHash("sha256")
    .update(JSON.stringify([item.projectId, item.title, item.detail ?? "", item.workType]))
    .digest("hex")
    .slice(0, 16);
}

/** What Jev sees: the item and its line. No session prompts, sources or people's names beyond the text itself. */
export function buildJobClassState(item: WorkItem, line: LineContext | undefined): string {
  const out = ["A work item from a solo founder's portfolio of small projects."];
  out.push(`Project: ${line?.name ?? item.projectId}`);
  if (line?.phase) out.push(`Project phase: ${line.phase}`);
  if (line?.intent) out.push(`Project intent: ${line.intent}`);
  out.push(`Work type (as filed): ${item.workType}`);
  out.push(`Title: ${item.title}`);
  if (item.detail) out.push(`Detail: ${item.detail.slice(0, 1200)}`);
  if (item.keyQuestion) out.push(`Key question it moves: ${item.keyQuestion}`);
  return out.join("\n");
}

export function effectiveJobClass(rec: JobClassRecord, minProbability: number): JobClass | null {
  if (rec.principal) return rec.principal.jobClass;
  if (rec.rule) return rec.rule;
  if (rec.jev && rec.jev.probability >= minProbability) return rec.jev.choice;
  return null;
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

export interface LabelOptions {
  now: Date;
  /** Max Jev calls this pass (bounds latency/cost of a brief). */
  maxCalls: number;
  /** Absent → rule labels only (Jev off). */
  classify?: ClassifyFn;
}

export interface LabelResult {
  /** Records that are new or changed — the caller persists these. */
  changed: JobClassRecord[];
  /** Every active item's record after this pass, keyed by itemId. */
  records: Map<string, JobClassRecord>;
  calls: number;
  errors: number;
}

/**
 * Bring every active item's record up to date. Changed content starts a fresh
 * record — rule, Jev and principal labels all describe the old text. Jev is
 * asked only when no rule applies, nothing (label or error) is stored for this
 * content, and the call budget allows.
 */
export async function labelWorkItems(
  items: readonly WorkItem[],
  lines: ReadonlyMap<string, LineContext>,
  existing: ReadonlyMap<string, JobClassRecord>,
  opts: LabelOptions,
): Promise<LabelResult> {
  const records = new Map<string, JobClassRecord>();
  const changed: JobClassRecord[] = [];
  let calls = 0;
  let errors = 0;

  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!ACTIVE_STAGES.has(item.stage)) continue;
    const contentKey = contentKeyOf(item);
    const prior = existing.get(item.id);
    const same = prior?.contentKey === contentKey;
    let rec: JobClassRecord = same
      ? { ...prior! }
      : { itemId: item.id, projectId: item.projectId, contentKey, rule: null, jev: null, jevError: null, principal: null };
    let dirty = !same;

    const rule = ruleJobClass(item);
    if (rec.rule !== rule) {
      rec = { ...rec, rule };
      dirty = true;
    }

    // Asked even when the principal has labelled the item: that pair is the agreement data.
    const needsJev = rule === null && rec.jev === null && rec.jevError === null;
    if (needsJev && opts.classify && calls < opts.maxCalls) {
      calls += 1;
      try {
        const r = await opts.classify(buildJobClassState(item, lines.get(item.projectId)));
        rec = { ...rec, jev: { ...r, at: opts.now.toISOString() } };
      } catch (err) {
        errors += 1;
        rec = { ...rec, jevError: (err as Error).message.slice(0, 200) };
      }
      dirty = true;
    }

    records.set(item.id, rec);
    if (dirty) changed.push(rec);
  }
  return { changed, records, calls, errors };
}

// ---------------------------------------------------------------------------
// Activities + agreement
// ---------------------------------------------------------------------------

/** When the item last moved into an active stage (falls back to updatedAt). */
export function activeAt(item: WorkItem): string {
  for (let i = item.history.length - 1; i >= 0; i--) {
    const move = item.history[i]!;
    if (ACTIVE_STAGES.has(move.to)) return move.at;
  }
  return item.updatedAt;
}

export function workItemActivities(
  items: readonly WorkItem[],
  records: ReadonlyMap<string, JobClassRecord>,
  minProbability: number,
): JobActivity[] {
  const out: JobActivity[] = [];
  for (const item of items) {
    if (!ACTIVE_STAGES.has(item.stage)) continue;
    const rec = records.get(item.id);
    out.push({
      projectId: item.projectId,
      jobClassification: rec ? effectiveJobClass(rec, minProbability) : null,
      at: activeAt(item),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.projectId.localeCompare(b.projectId));
}

export interface JobClassAgreement {
  /** Items carrying both a principal label and a Jev label. */
  compared: number;
  /** Exact class agreement over `compared` (null when nothing to compare). */
  exact: number | null;
  /** J1-vs-not agreement — the split job-mix's breach guard depends on. */
  j1: number | null;
  /** Of the compared, how many Jev labels cleared the threshold, and their exact agreement. */
  confidentCompared: number;
  confidentExact: number | null;
}

export function jobClassAgreement(records: Iterable<JobClassRecord>, minProbability: number): JobClassAgreement {
  let compared = 0;
  let exact = 0;
  let j1 = 0;
  let confidentCompared = 0;
  let confidentExact = 0;
  for (const r of records) {
    if (!r.principal || !r.jev) continue;
    compared += 1;
    const same = r.principal.jobClass === r.jev.choice;
    if (same) exact += 1;
    if ((r.principal.jobClass === "J1_signal") === (r.jev.choice === "J1_signal")) j1 += 1;
    if (r.jev.probability >= minProbability) {
      confidentCompared += 1;
      if (same) confidentExact += 1;
    }
  }
  const share = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 100) / 100);
  return {
    compared,
    exact: share(exact, compared),
    j1: share(j1, compared),
    confidentCompared,
    confidentExact: share(confidentExact, confidentCompared),
  };
}

export function isJobClass(v: unknown): v is JobClass {
  return typeof v === "string" && (JOB_CLASSES as readonly string[]).includes(v);
}
