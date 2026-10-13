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
/**
 * The runtime (cockpit) relays a live session that is waiting on the principal.
 * That is attention, not new work, so it may land straight in Needs you — and
 * nowhere else outside Intake (CONTEXT.md: Needs you, the one attention primitive).
 * `ops-signals` relays the Project Dashboard's exposure findings on the same
 * terms (T-dash): an estate alarm, not a task to triage.
 */
const RUNTIME_ACTOR = "runtime";
const ATTENTION_ACTORS = new Set([RUNTIME_ACTOR, "ops-signals"]);

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

/**
 * What the CoS proposed, frozen at creation (ADR 0004: H1 counts proposals the
 * principal accepts *without rewriting*). Compared with the live item to tell
 * an accepted proposal from an edited one. Absent on non-CoS items.
 */
export interface ProposalSnapshot {
  projectId: string;
  title: string;
  detail: string | null;
  size: Size;
  workType: WorkType;
  /** Steward journal the proposal came from (YYYY-MM-DD). */
  journalDate: string | null;
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
  /** The CoS's original proposal (absent on items the CoS did not propose). */
  proposed?: ProposalSnapshot | null;
  /** Mail about this item, append-only (FABRIC_SPEC D.5; ADR 0007). Absent until the first message. */
  mail?: MailEntry[];
}

export const MAIL_STATUSES = ["queued", "claimed", "delivered", "answered", "dropped"] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

/**
 * One message from one role to another, about this item (CONTEXT.md: Mail).
 * `from` is the writing actor, never a payload field: the cockpit derives the
 * actor at its door (ADR 0007 rule 7). A message to an agent starts `queued`
 * and the cockpit wakes the agent; a reply to the principal is `delivered` on
 * arrival, because it is read on the item, never pushed (Needs you stays the
 * one attention primitive).
 */
export interface MailEntry {
  id: string;
  from: string;
  to: string;
  body: string;
  status: MailStatus;
  ts: string;
  /** The message this one answers (the first message of a thread has none). */
  replyTo: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  surface: string | null;
}

/** Messages written by agents on one item before only a Needs-you item may follow (D.5 bounds). */
export const MAX_AGENT_MAIL = 4;
export const MAX_MAIL_BODY = 4000;
const MAIL_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAIL_ADDRESS = /^(principal|agent:[A-Za-z0-9._:@-]+)$/;
/** Actors that may move a message's status: the cockpit (claims, delivery) and the principal. */
const MAIL_STATUS_ACTORS = new Set([RUNTIME_ACTOR, "principal"]);
const MAIL_MOVES: Record<MailStatus, readonly MailStatus[]> = {
  queued: ["claimed", "dropped"],
  claimed: ["queued", "delivered", "dropped"],
  delivered: ["answered"],
  answered: [],
  dropped: [],
};

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
  /** Journal date of the CoS proposal this item carries (CoS only). */
  proposedFrom?: string | null;
}

export function makeWorkItem(
  input: NewWorkItemInput,
  opts: { id: string; now: Date; actor: string },
): WorkItem {
  const projectId = optStr(input.projectId);
  const title = optStr(input.title);
  if (!projectId || !title) throw new WorkItemValidationError("projectId and title are required");
  const requested = input.stage ? oneOf(STAGES, input.stage, "stage") : "intake";
  const stage: Stage = TRIAGING_ACTORS.has(opts.actor)
    ? requested
    : ATTENTION_ACTORS.has(opts.actor) && requested === "needs-you"
      ? "needs-you"
      : "intake";
  const at = opts.now.toISOString();
  const detail = optStr(input.detail);
  const workType = oneOf(WORK_TYPES, input.workType, "workType");
  const size = oneOf(SIZES, input.size, "size");
  return {
    id: opts.id,
    projectId,
    title,
    detail,
    workType,
    size,
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
    ...(opts.actor === "cos"
      ? { proposed: { projectId, title, detail, size, workType, journalDate: optStr(input.proposedFrom) } }
      : {}),
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
  /** Re-home the item on another line (triaging actors only). */
  projectId?: string;
  /** Attach a session to the item (deduped by sessionId). */
  linkSession?: Partial<SessionLink> | null;
  /** Record what a hand brought back. */
  result?: Partial<RunResult> | null;
  /** Append one message (deduped by id; `from` is the actor). */
  message?: { id?: string; to?: string; body?: string; replyTo?: string | null; surface?: string | null } | null;
  /** Move one message's status (the cockpit's claim and delivery; the principal may drop). */
  mailStatus?: { id?: string; status?: string; claimedBy?: string | null } | null;
}

function appendMessage(item: WorkItem, m: NonNullable<WorkItemPatch["message"]>, actor: string, at: string): MailEntry[] {
  const mail = [...(item.mail ?? [])];
  const id = optStr(m.id);
  if (!id || !MAIL_ID.test(id)) throw new WorkItemValidationError("message needs an id of 6–64 letters, digits, _ or -");
  if (mail.some((x) => x.id === id)) return mail; // a replay of the same message
  if (!MAIL_ADDRESS.test(actor)) throw new WorkItemValidationError(`${actor} may not write mail`);
  const to = optStr(m.to);
  if (!to || !MAIL_ADDRESS.test(to)) throw new WorkItemValidationError("message.to must be principal or agent:<role>");
  if (to === actor) throw new WorkItemValidationError("a message cannot be addressed to its sender");
  const body = optStr(m.body);
  if (!body) throw new WorkItemValidationError("message.body cannot be empty");
  if (body.length > MAX_MAIL_BODY) throw new WorkItemValidationError(`message.body is over ${MAX_MAIL_BODY} characters`);
  const replyTo = optStr(m.replyTo);
  const parent = replyTo ? mail.find((x) => x.id === replyTo) : undefined;
  if (replyTo && !parent) throw new WorkItemValidationError(`message.replyTo ${replyTo} is not on this item`);
  if (actor !== "principal") {
    // an agent may write only a reply to a message addressed to it, back to its sender
    if (!parent || parent.to !== actor || parent.from !== to) {
      throw new WorkItemValidationError("an agent may only reply to a message sent to it, to its sender");
    }
    // claimed: the wake is reading it now (the cockpit settles it to delivered only after the run ends)
    if (parent.status !== "claimed" && parent.status !== "delivered") {
      throw new WorkItemValidationError(`message ${parent.id} is ${parent.status}; an agent replies once, to a message delivered to it`);
    }
    if (mail.filter((x) => x.from !== "principal").length >= MAX_AGENT_MAIL) {
      throw new WorkItemValidationError(`${MAX_AGENT_MAIL} agent messages on this item already; raise a Needs-you item instead`);
    }
  }
  if (parent && (parent.status === "claimed" || parent.status === "delivered")) {
    mail[mail.indexOf(parent)] = { ...parent, status: "answered" };
  }
  mail.push({
    id,
    from: actor,
    to,
    body,
    status: to === "principal" ? "delivered" : "queued",
    ts: at,
    replyTo,
    claimedBy: null,
    claimedAt: null,
    surface: optStr(m.surface),
  });
  return mail;
}

function moveMail(item: WorkItem, s: NonNullable<WorkItemPatch["mailStatus"]>, actor: string, at: string): MailEntry[] {
  if (!MAIL_STATUS_ACTORS.has(actor)) throw new WorkItemValidationError(`${actor} may not move mail`);
  const mail = [...(item.mail ?? [])];
  const i = mail.findIndex((x) => x.id === optStr(s.id));
  if (i === -1) throw new WorkItemValidationError(`message ${String(s.id)} is not on this item`);
  const to = oneOf(MAIL_STATUSES, s.status, "mailStatus.status");
  const cur = mail[i];
  if (to === cur.status) return mail;
  if (!MAIL_MOVES[cur.status].includes(to)) throw new WorkItemValidationError(`message ${cur.id}: ${cur.status} → ${to} is not a move`);
  mail[i] =
    to === "claimed"
      ? { ...cur, status: to, claimedBy: optStr(s.claimedBy), claimedAt: at }
      : to === "queued"
        ? { ...cur, status: to, claimedBy: null, claimedAt: null }
        : { ...cur, status: to };
  return mail;
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
  if (patch.projectId !== undefined) {
    const pid = optStr(patch.projectId);
    if (!pid) throw new WorkItemValidationError("projectId cannot be empty");
    if (pid !== item.projectId && !TRIAGING_ACTORS.has(opts.actor)) {
      throw new WorkItemValidationError("only the principal or the CoS may move an item between lines");
    }
    next.projectId = pid;
  }
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
  if (patch.message) next.mail = appendMessage(next, patch.message, opts.actor, at);
  if (patch.mailStatus) next.mail = moveMail(next, patch.mailStatus, opts.actor, at);
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
