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
import type { BacklogEntry } from "../lines/backlog.js";
import type { Stage, WorkItem, WorkType } from "../work-items/work-items.js";

export const JOB_CLASSES: readonly JobClass[] = ["J1_signal", "J2_distribution", "J3_product", "meta"];

/**
 * Jev choice criteria. v2 (2026-10-04, principal's rubric): classify by what
 * the task's output is for, not by the kind of activity. J1 is the contact act
 * only; desk work splits into targeting/reach (J2) and build/think (J3); meta is
 * the principal's own operating system. J3 deliberately broadens the PRD's
 * "product" to all project desk work, so analysis never inflates J1.
 */
export const JOB_CLASS_CRITERIA_VERSION = 2;

export const JOB_CLASS_CRITERIA: Record<JobClass, string> = {
  J1_signal:
    "Signal: the customer contact act itself — sending outreach, booking or holding a call or meeting, following up, asking for a reply, LOI, deposit or payment, logging what the person said right after the contact, and harvesting prospects' own words from where they talk (social listening for verbatims). Other desk work before or after contact is not J1.",
  J2_distribution:
    "Distribution: reaching and targeting people — choosing the segment, geography, channel or who goes on the list, positioning and messaging, pitch and one-pager wording, landing pages and their intake forms, content and fact-checking it, and setting up the outreach (lists, tracking sheets) that the contact will use.",
  J3_product:
    "Build and think: desk work on the project itself — building, fixing or specifying the product or service, its plumbing (code, webhooks, workflows, merges, test runs), research, analysis, and synthesising evidence into the ICP or plan.",
  meta:
    "Meta: the founder's own operating system rather than any one project — their control plane, agents, machines and personal tooling, and portfolio admin such as moving key questions between projects or grooming backlogs.",
};

/** Stages where an item counts as worked on (intake/triage are proposals, not activity). */
export const ACTIVE_STAGES: ReadonlySet<Stage> = new Set<Stage>(["in-progress", "needs-you", "done"]);

/**
 * Lines whose work is `meta` by definition: the control plane (PRD § 0.5
 * point 3) and the principal's personal tooling (tax-manager, 2026-10-04).
 */
export const META_LINE_IDS: ReadonlySet<string> = new Set(["personal-ai-control-plane", "tax-manager"]);

export interface JevLabel {
  choice: JobClass;
  probability: number;
  model: string | null;
  at: string;
  /** JOB_CLASS_CRITERIA_VERSION it was asked under (absent = v1). A stale label is re-asked; the principal's label is kept. */
  criteria?: number;
}

/**
 * Stored per classified subject (entity `job-class`, externalId = itemId).
 * Floor items use the work item id; backlog tasks use `bl:<lineId>:<entryId>`
 * and never feed job-mix — they are trial data for the agreement gate.
 */
export interface JobClassRecord {
  itemId: string;
  projectId: string;
  /** Absent on records written before backlog backtests (= floor). */
  source?: "floor" | "backlog";
  /** Backlog records carry their text (there is no work item to join to). */
  title?: string;
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

export function ruleJobClass(item: { workType?: string | null; projectId: string }): JobClass | null {
  if (META_LINE_IDS.has(item.projectId)) return "meta";
  const byType: Partial<Record<WorkType, JobClass>> = { "market-contact": "J1_signal" };
  return item.workType ? (byType[item.workType as WorkType] ?? null) : null;
}

export function contentKeyOf(item: { projectId: string; title: string; detail?: string | null; workType?: string | null }): string {
  return createHash("sha256")
    .update(JSON.stringify([item.projectId, item.title, item.detail ?? "", item.workType ?? ""]))
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

/** A backlog task as Jev sees it: the task, the hypothesis/question chain above it, and its line. */
export function buildBacklogTaskState(
  task: Pick<BacklogEntry, "text" | "workType">,
  ancestors: readonly Pick<BacklogEntry, "kind" | "text">[],
  line: LineContext | undefined,
  projectId: string,
): string {
  const out = ["A planned task from a solo founder's project backlog."];
  out.push(`Project: ${line?.name ?? projectId}`);
  if (line?.phase) out.push(`Project phase: ${line.phase}`);
  if (line?.intent) out.push(`Project intent: ${line.intent}`);
  if (task.workType) out.push(`Work type (as filed): ${task.workType}`);
  out.push(`Task: ${task.text}`);
  for (const a of ancestors) out.push(`It serves the ${a.kind}: ${a.text}`);
  return out.join("\n");
}

export function effectiveJobClass(rec: JobClassRecord, minProbability: number): JobClass | null {
  if (rec.principal) return rec.principal.jobClass;
  if (rec.rule) return rec.rule;
  if (rec.jev && (rec.jev.criteria ?? 1) === JOB_CLASS_CRITERIA_VERSION && rec.jev.probability >= minProbability) return rec.jev.choice;
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
  /** Every subject's record after this pass, keyed by itemId. */
  records: Map<string, JobClassRecord>;
  calls: number;
  errors: number;
}

/** One thing to classify — a floor item or a backlog task. */
export interface LabelSubject {
  id: string;
  projectId: string;
  source: "floor" | "backlog";
  title: string;
  contentKey: string;
  rule: JobClass | null;
  state(): string;
}

/**
 * Bring each subject's record up to date. Changed content starts a fresh
 * record — rule, Jev and principal labels all describe the old text. Jev is
 * asked only when no rule applies, nothing (label or error) is stored for this
 * content, and the call budget allows. Subjects are processed in id order.
 */
export async function labelSubjects(
  subjects: readonly LabelSubject[],
  existing: ReadonlyMap<string, JobClassRecord>,
  opts: LabelOptions,
): Promise<LabelResult> {
  const records = new Map<string, JobClassRecord>();
  const changed: JobClassRecord[] = [];
  let calls = 0;
  let errors = 0;

  for (const sub of [...subjects].sort((a, b) => a.id.localeCompare(b.id))) {
    const prior = existing.get(sub.id);
    const same = prior?.contentKey === sub.contentKey;
    const fresh: JobClassRecord = {
      itemId: sub.id,
      projectId: sub.projectId,
      source: sub.source,
      ...(sub.source === "backlog" ? { title: sub.title } : {}),
      contentKey: sub.contentKey,
      rule: null,
      jev: null,
      jevError: null,
      principal: null,
    };
    let rec: JobClassRecord = same ? { ...prior! } : fresh;
    let dirty = !same;

    if (rec.rule !== sub.rule) {
      rec = { ...rec, rule: sub.rule };
      dirty = true;
    }

    // Asked even when the principal has labelled the subject: that pair is the agreement data.
    const staleJev = rec.jev !== null && (rec.jev.criteria ?? 1) !== JOB_CLASS_CRITERIA_VERSION;
    const needsJev = sub.rule === null && (rec.jev === null || staleJev) && rec.jevError === null;
    if (needsJev && opts.classify && calls < opts.maxCalls) {
      calls += 1;
      try {
        const r = await opts.classify(sub.state());
        rec = { ...rec, jev: { ...r, at: opts.now.toISOString(), criteria: JOB_CLASS_CRITERIA_VERSION } };
      } catch (err) {
        errors += 1;
        rec = { ...rec, jevError: (err as Error).message.slice(0, 200) };
      }
      dirty = true;
    }

    records.set(sub.id, rec);
    if (dirty) changed.push(rec);
  }
  return { changed, records, calls, errors };
}

/** Floor items being worked (in-progress / needs-you / done). */
export async function labelWorkItems(
  items: readonly WorkItem[],
  lines: ReadonlyMap<string, LineContext>,
  existing: ReadonlyMap<string, JobClassRecord>,
  opts: LabelOptions,
): Promise<LabelResult> {
  const subjects: LabelSubject[] = items
    .filter((item) => ACTIVE_STAGES.has(item.stage))
    .map((item) => ({
      id: item.id,
      projectId: item.projectId,
      source: "floor",
      title: item.title,
      contentKey: contentKeyOf(item),
      rule: ruleJobClass(item),
      state: () => buildJobClassState(item, lines.get(item.projectId)),
    }));
  return labelSubjects(subjects, existing, opts);
}

/** Backlog record id — namespaced so it can never collide with a work item id. */
export const backlogRecordId = (lineId: string, entryId: string): string => `bl:${lineId}:${entryId}`;

/** Live backlog tasks (not done/dropped, not yet promoted to the floor) on every line. */
export function backlogSubjects(
  lines: readonly { id: string; backlog?: { entries: BacklogEntry[] } | null }[],
  lineCtx: ReadonlyMap<string, LineContext>,
): LabelSubject[] {
  const out: LabelSubject[] = [];
  for (const line of lines) {
    const entries = line.backlog?.entries ?? [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const e of entries) {
      if (e.kind !== "task" || e.status === "dropped" || e.promotedTo) continue;
      const ancestors: BacklogEntry[] = [];
      const seen = new Set<string>([e.id]);
      let cur = e.parent ? byId.get(e.parent) : undefined;
      while (cur && !seen.has(cur.id) && ancestors.length < 3) {
        ancestors.push(cur);
        seen.add(cur.id);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
      out.push({
        id: backlogRecordId(line.id, e.id),
        projectId: line.id,
        source: "backlog",
        title: e.text,
        contentKey: contentKeyOf({ projectId: line.id, title: e.text, detail: ancestors.map((a) => a.text).join(" | "), workType: e.workType ?? null }),
        rule: ruleJobClass({ workType: e.workType ?? null, projectId: line.id }),
        state: () => buildBacklogTaskState(e, ancestors, lineCtx.get(line.id), line.id),
      });
    }
  }
  return out;
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
    // Rule-labelled subjects aren't Jev's call; stale-criteria labels don't measure today's Jev.
    if (!r.principal || !r.jev || r.rule !== null) continue;
    if ((r.jev.criteria ?? 1) !== JOB_CLASS_CRITERIA_VERSION) continue;
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
