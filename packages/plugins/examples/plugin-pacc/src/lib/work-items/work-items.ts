/**
 * Work items + capacity days — T-floor (ADR 0002, ControlPlane CONTEXT.md).
 *
 * A work item is one unit on the factory floor: it belongs to a project line,
 * moves through the flow stages (intake → triage → in-progress → needs-you →
 * done), and carries a work type and a size. Pure domain logic; persistence is
 * injected (the worker wires it to `ctx.entities`).
 *
 * Invariants:
 *  - "Intake is not priority": anything not created by the principal or the
 *    CoS lands in intake, whatever stage it asked for.
 *  - Only two sizes exist (bite / deep); bigger work is split before it can
 *    reach needs-you, so there is no third size to express it.
 *  - Dates never drive priority: items carry timestamps for history only.
 */

export const WORK_TYPES = ["build", "market-contact", "hypothesis-design"] as const;
export const SIZES = ["bite", "deep"] as const;
export const STAGES = ["intake", "triage", "in-progress", "needs-you", "done"] as const;

export type WorkType = (typeof WORK_TYPES)[number];
export type Size = (typeof SIZES)[number];
export type Stage = (typeof STAGES)[number];

/** Actors allowed to place an item directly into a stage other than intake. */
const TRIAGING_ACTORS = new Set(["principal", "cos"]);

export interface SourceRef {
  kind: string;
  path: string;
}

/** A deliverable awaiting the principal's one-pass approval (Agent C publish gate). */
export interface Draft {
  channel: string;
  text: string;
  status: "pending" | "approved" | "rejected";
  /** Principal's edited text, kept as a taste signal for J's monthly digest. */
  editedText?: string | null;
}

/**
 * A session that worked on the item (CONTEXT.md: Context carry). Items
 * accumulate sessions over their life, so any machine or device can pick the
 * item back up with its full context.
 */
export interface SessionLink {
  /** Harness session id (e.g. the Claude Code session uuid). */
  sessionId: string;
  /** Machine the session ran on (fabricd worker name). */
  machine: string | null;
  /** Harness: claude | hermes | zcode | codex. */
  tool: string | null;
  /** Worker role that staffed the hand (generic when no specialist owns it). */
  worker: string | null;
  cwd: string | null;
  title: string | null;
  linkedAt: string;
}

/** What a hand brought back (Context carry, return leg). */
export interface RunResult {
  ok: boolean;
  summary: string;
  /** Commits, files, drafts, URLs the run produced. */
  links: string[];
  /** True when the result changes the project's evidence base (moves the evidence clock). */
  evidence: boolean;
  sessionId: string | null;
  costUsd: number | null;
  at: string;
}

export interface StageMove {
  at: string;
  from: Stage | null;
  to: Stage;
  by: string;
  note?: string | null;
}

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  detail: string | null;
  workType: WorkType;
  size: Size;
  stage: Stage;
  /** The key question this item moves (copied at creation; lines can change theirs later). */
  keyQuestion: string | null;
  /** Worker role on the item: cos | c | j | t | hand. */
  worker: string | null;
  machine: string | null;
  /** Cockpit command id when dispatched to a hand/role. */
  dispatchId: string | null;
  draft: Draft | null;
  sourceRefs: SourceRef[];
  /** Sessions that worked on this item (absent on items created before L3). */
  sessions?: SessionLink[];
  /** Latest run result from a hand (absent/null until one returns). */
  result?: RunResult | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  history: StageMove[];
}

export class WorkItemValidationError extends Error {}

function oneOf<T extends string>(list: readonly T[], v: unknown, field: string): T {
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  throw new WorkItemValidationError(`${field} must be one of ${list.join(", ")}`);
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface NewWorkItemInput {
  projectId: string;
  title: string;
  workType: string;
  size: string;
  stage?: string;
  detail?: string | null;
  keyQuestion?: string | null;
  worker?: string | null;
  sourceRefs?: SourceRef[];
}

export function makeWorkItem(
  input: NewWorkItemInput,
  opts: { id: string; now: Date; actor: string },
): WorkItem {
  const projectId = optStr(input.projectId);
  const title = optStr(input.title);
  if (!projectId || !title) throw new WorkItemValidationError("projectId and title are required");
  const requested = input.stage ? oneOf(STAGES, input.stage, "stage") : "intake";
  const stage: Stage = TRIAGING_ACTORS.has(opts.actor) ? requested : "intake";
  const at = opts.now.toISOString();
  return {
    id: opts.id,
    projectId,
    title,
    detail: optStr(input.detail),
    workType: oneOf(WORK_TYPES, input.workType, "workType"),
    size: oneOf(SIZES, input.size, "size"),
    stage,
    keyQuestion: optStr(input.keyQuestion),
    worker: optStr(input.worker),
    machine: null,
    dispatchId: null,
    draft: null,
    sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
    sessions: [],
    result: null,
    createdBy: opts.actor,
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: stage, by: opts.actor }],
  };
}

export interface WorkItemPatch {
  stage?: string;
  title?: string;
  detail?: string | null;
  workType?: string;
  size?: string;
  worker?: string | null;
  machine?: string | null;
  dispatchId?: string | null;
  draft?: Draft | null;
  note?: string | null;
  /** Attach a session to the item (deduped by sessionId). */
  linkSession?: Partial<SessionLink> | null;
  /** Record what a hand brought back. */
  result?: Partial<RunResult> | null;
}

function sessionLink(v: Partial<SessionLink>, at: string): SessionLink {
  const sessionId = optStr(v.sessionId);
  if (!sessionId) throw new WorkItemValidationError("linkSession needs a sessionId");
  return {
    sessionId,
    machine: optStr(v.machine),
    tool: optStr(v.tool),
    worker: optStr(v.worker),
    cwd: optStr(v.cwd),
    title: optStr(v.title),
    linkedAt: optStr(v.linkedAt) ?? at,
  };
}

function runResult(v: Partial<RunResult>, at: string): RunResult {
  return {
    ok: v.ok !== false,
    summary: (optStr(v.summary) ?? "").slice(0, 4000),
    links: Array.isArray(v.links) ? v.links.map(optStr).filter((x): x is string => !!x).slice(0, 50) : [],
    evidence: v.evidence === true,
    sessionId: optStr(v.sessionId),
    costUsd: typeof v.costUsd === "number" && Number.isFinite(v.costUsd) ? v.costUsd : null,
    at: optStr(v.at) ?? at,
  };
}

/** Apply a patch; stage changes are appended to history. Returns a new object. */
export function applyPatch(item: WorkItem, patch: WorkItemPatch, opts: { now: Date; actor: string }): WorkItem {
  const at = opts.now.toISOString();
  const next: WorkItem = { ...item, history: [...item.history], updatedAt: at };
  if (patch.title !== undefined) {
    const t = optStr(patch.title);
    if (!t) throw new WorkItemValidationError("title cannot be empty");
    next.title = t;
  }
  if (patch.detail !== undefined) next.detail = optStr(patch.detail);
  if (patch.workType !== undefined) next.workType = oneOf(WORK_TYPES, patch.workType, "workType");
  if (patch.size !== undefined) next.size = oneOf(SIZES, patch.size, "size");
  if (patch.worker !== undefined) next.worker = optStr(patch.worker);
  if (patch.machine !== undefined) next.machine = optStr(patch.machine);
  if (patch.dispatchId !== undefined) next.dispatchId = optStr(patch.dispatchId);
  if (patch.draft !== undefined) next.draft = patch.draft;
  if (patch.linkSession) {
    const link = sessionLink(patch.linkSession, at);
    const sessions = [...(item.sessions ?? [])];
    const i = sessions.findIndex((x) => x.sessionId === link.sessionId);
    if (i === -1) sessions.push(link);
    else sessions[i] = { ...sessions[i], ...Object.fromEntries(Object.entries(link).filter(([, v]) => v !== null)) } as SessionLink;
    next.sessions = sessions;
  }
  if (patch.result !== undefined) next.result = patch.result === null ? null : runResult(patch.result, at);
  if (patch.stage !== undefined) {
    const to = oneOf(STAGES, patch.stage, "stage");
    if (to !== item.stage) {
      next.stage = to;
      next.history.push({ at, from: item.stage, to, by: opts.actor, note: optStr(patch.note) });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Capacity days (CONTEXT.md: Capacity score, Allocation & calibration)
// ---------------------------------------------------------------------------

export interface CapacityDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** 0–10 from the daily note's `Capacity: N/10` line; null = no daily note (= zero capacity). */
  score: number | null;
  /** J's one-line account of what else occupied the day. */
  occupiedBy: string | null;
  source: string | null;
  recordedAt: string;
}

export interface Allocation {
  deepBlocks: number;
  bites: number;
}

/**
 * Starting score → allocation table (principal-approved 2026-09-29). The CoS
 * calibrates it weekly from allocated-vs-done; this is only the default.
 */
export function defaultAllocation(score: number | null): Allocation {
  if (score === null || score <= 0) return { deepBlocks: 0, bites: 0 };
  if (score <= 3) return { deepBlocks: 0, bites: 2 };
  if (score <= 6) return { deepBlocks: 1, bites: 2 };
  if (score <= 8) return { deepBlocks: 2, bites: 1 };
  return { deepBlocks: 3, bites: 0 };
}

export function makeCapacityDay(
  input: { date: string; score?: number | null; occupiedBy?: string | null; source?: string | null },
  now: Date,
): CapacityDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) {
    throw new WorkItemValidationError("date must be YYYY-MM-DD");
  }
  let score: number | null = null;
  if (typeof input.score === "number") {
    if (!Number.isFinite(input.score) || input.score < 0 || input.score > 10) {
      throw new WorkItemValidationError("score must be 0–10");
    }
    score = Math.round(input.score);
  }
  return {
    date: input.date,
    score,
    occupiedBy: optStr(input.occupiedBy),
    source: optStr(input.source),
    recordedAt: now.toISOString(),
  };
}
