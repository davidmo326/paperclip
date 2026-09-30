/**
 * A line's backlog — the reconciled pile behind the floor (ControlPlane
 * CONTEXT.md: Backlog, Plan pile).
 *
 * The questions a project must answer, the hypotheses downstream of each, and
 * the tasks downstream of those, reconciled from the project's repo and vault
 * (canvases, boards, plan docs) with a source ref on every entry. The backlog is
 * an index, not the flow: nothing in it is a work item until the principal
 * promotes it (a task → Triage, a question → key question or candidate).
 * Pure domain logic.
 */

import { makeWorkItem, SIZES, WORK_TYPES, type WorkItem } from "../work-items/work-items.js";
import type { ProjectLine } from "./lines.js";

export type BacklogKind = "question" | "hypothesis" | "task";

export const BACKLOG_STATUSES: Record<BacklogKind, readonly string[]> = {
  question: ["open", "investigating", "answered", "parked"],
  hypothesis: ["untested", "testing", "supported", "refuted", "parked"],
  task: ["todo", "doing", "done", "dropped"],
};

export interface BacklogRef {
  path: string;
  anchor?: string | null;
}

export interface BacklogEntry {
  id: string;
  kind: BacklogKind;
  parent: string | null;
  text: string;
  status: string;
  /** hypothesis: how we'd know */
  test?: string | null;
  /** question: the evidence so far */
  evidence?: string | null;
  workType?: string | null;
  size?: string | null;
  sourceRefs: BacklogRef[];
  /** Set when promoted: the floor item it became, or "kq"/"candidate". */
  promotedTo?: string | null;
  /** Who last set the status: the reconciler's read, or the principal's word. */
  statusBy: "reconciler" | "principal";
  updatedAt: string;
}

export interface Backlog {
  entries: BacklogEntry[];
  conflicts: string[];
  notes: string | null;
  sources: Array<{ path: string; kind: string; why: string }>;
  reconciledAt: string;
  reconciledBy: string;
}

export interface BacklogSummary {
  questions: number;
  hypotheses: number;
  tasks: number;
  openTasks: number;
  reconciledAt: string | null;
}

export class BacklogValidationError extends Error {}

const s = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function refs(v: unknown): BacklogRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ path: s(r.path, 500).replace(/^\/home\/[^/]+\//, "~/"), anchor: s(r.anchor, 200) || null }))
    .filter((r) => r.path)
    .slice(0, 8);
}

/**
 * Normalise a reconciler's output into a backlog, carrying over what the
 * principal already decided: an entry with the same kind and text keeps the
 * principal's status and its promotion.
 */
export function reconcileBacklog(
  prior: Backlog | null | undefined,
  input: Record<string, unknown>,
  opts: { now: Date; by: string },
): Backlog {
  const at = opts.now.toISOString();
  const kept = new Map<string, BacklogEntry>();
  for (const e of prior?.entries ?? []) {
    if (e.statusBy === "principal" || e.promotedTo) kept.set(`${e.kind}:${norm(e.text)}`, e);
  }
  const entries: BacklogEntry[] = [];
  const ids = new Set<string>();
  const add = (kind: BacklogKind, raw: Record<string, unknown>, prefix: string) => {
    const text = s(raw.text, 300);
    if (!text) return;
    let id = s(raw.id, 40) || `${prefix}${entries.length + 1}`;
    if (ids.has(id)) id = `${id}-${entries.length + 1}`;
    ids.add(id);
    const statuses = BACKLOG_STATUSES[kind];
    const status = statuses.includes(s(raw.status)) ? s(raw.status) : statuses[0]!;
    const prev = kept.get(`${kind}:${norm(text)}`);
    entries.push({
      id,
      kind,
      parent: s(raw.parent, 40) || null,
      text,
      status: prev ? prev.status : status,
      test: kind === "hypothesis" ? s(raw.test, 300) || null : null,
      evidence: kind === "question" ? s(raw.evidence, 300) || null : null,
      workType: kind === "task" ? ((WORK_TYPES as readonly string[]).includes(s(raw.workType)) ? s(raw.workType) : "build") : null,
      size: kind === "task" ? ((SIZES as readonly string[]).includes(s(raw.size)) ? s(raw.size) : "bite") : null,
      sourceRefs: refs(raw.sourceRefs),
      promotedTo: prev?.promotedTo ?? (raw.alreadyOnFloor === true ? "floor" : null),
      statusBy: prev ? prev.statusBy : "reconciler",
      updatedAt: prev?.updatedAt ?? at,
    });
  };
  const list = (k: string) => (Array.isArray(input[k]) ? (input[k] as Array<Record<string, unknown>>) : []);
  for (const q of list("questions").slice(0, 20)) add("question", q, "q");
  for (const h of list("hypotheses").slice(0, 40)) add("hypothesis", h, "h");
  for (const t of list("tasks").slice(0, 60)) add("task", t, "t");
  // drop dangling parents rather than invent structure
  const known = new Set(entries.map((e) => e.id));
  for (const e of entries) if (e.parent && !known.has(e.parent)) e.parent = null;
  return {
    entries,
    conflicts: (Array.isArray(input.conflicts) ? input.conflicts : []).map((c) => s(c, 400)).filter(Boolean).slice(0, 15),
    notes: s(input.notes, 1500) || null,
    sources: (Array.isArray(input.sourcesRead) ? (input.sourcesRead as Array<Record<string, unknown>>) : [])
      .map((x) => ({ path: s(x.path, 500).replace(/^\/home\/[^/]+\//, "~/"), kind: s(x.kind, 30) || "note", why: s(x.why, 200) }))
      .filter((x) => x.path)
      .slice(0, 80),
    reconciledAt: at,
    reconciledBy: opts.by,
  };
}

export function summarizeBacklog(b: Backlog | null | undefined): BacklogSummary {
  const e = b?.entries ?? [];
  return {
    questions: e.filter((x) => x.kind === "question").length,
    hypotheses: e.filter((x) => x.kind === "hypothesis").length,
    tasks: e.filter((x) => x.kind === "task").length,
    openTasks: e.filter((x) => x.kind === "task" && (x.status === "todo" || x.status === "doing") && !x.promotedTo).length,
    reconciledAt: b?.reconciledAt ?? null,
  };
}

/** The principal sets an entry's status or text. */
export function updateBacklogEntry(b: Backlog, entryId: string, patch: { status?: unknown; text?: unknown }, now: Date): Backlog {
  const i = b.entries.findIndex((e) => e.id === entryId);
  if (i < 0) throw new BacklogValidationError(`no backlog entry ${entryId}`);
  const e = { ...b.entries[i]! };
  if (patch.status !== undefined) {
    if (!BACKLOG_STATUSES[e.kind].includes(s(patch.status))) {
      throw new BacklogValidationError(`status must be one of ${BACKLOG_STATUSES[e.kind].join(", ")}`);
    }
    e.status = s(patch.status);
    e.statusBy = "principal";
  }
  if (patch.text !== undefined && s(patch.text, 300)) e.text = s(patch.text, 300);
  e.updatedAt = now.toISOString();
  const entries = [...b.entries];
  entries[i] = e;
  return { ...b, entries };
}

/** The chain above an entry (task → hypothesis → question), for the item's detail. */
export function lineage(b: Backlog, entry: BacklogEntry): BacklogEntry[] {
  const out: BacklogEntry[] = [];
  let cur: BacklogEntry | undefined = entry;
  const seen = new Set<string>();
  while (cur?.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    cur = b.entries.find((x) => x.id === cur!.parent);
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Promote an entry: a task becomes a Triage item on the line (the principal
 * is promoting, so it may land in Triage); a question becomes the key question
 * (the old one joins the candidates) or a candidate.
 */
export function promoteEntry(
  line: ProjectLine,
  b: Backlog,
  entryId: string,
  to: "triage" | "kq" | "candidate",
  opts: { now: Date; newId: () => string },
): { backlog: Backlog; line: ProjectLine; item: WorkItem | null } {
  const entry = b.entries.find((e) => e.id === entryId);
  if (!entry) throw new BacklogValidationError(`no backlog entry ${entryId}`);
  let item: WorkItem | null = null;
  let nextLine = line;
  let promotedTo: string;
  if (to === "triage") {
    if (entry.kind === "question") throw new BacklogValidationError("promote a question to kq or candidate");
    const chain = lineage(b, entry);
    const q = [entry, ...chain].find((x) => x.kind === "question");
    item = makeWorkItem(
      {
        projectId: line.id,
        title: entry.text.slice(0, 200),
        workType: entry.workType ?? "hypothesis-design",
        size: entry.size ?? "bite",
        stage: "triage",
        keyQuestion: q?.text ?? line.keyQuestion,
        detail: [
          entry.kind === "hypothesis" ? `Hypothesis to test: ${entry.text}${entry.test ? `\nWe'll know when: ${entry.test}` : ""}` : null,
          ...chain.map((c) => `${c.kind === "question" ? "Question" : "Hypothesis"}: ${c.text}`),
          entry.sourceRefs.length ? `Sources: ${entry.sourceRefs.map((r) => r.path + (r.anchor ? ` → ${r.anchor}` : "")).join("; ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        sourceRefs: [{ kind: "backlog", path: `${line.id}#${entry.id}` }, ...entry.sourceRefs.map((r) => ({ kind: "source", path: r.path }))],
      },
      { id: opts.newId(), now: opts.now, actor: "principal" },
    );
    promotedTo = item.id;
  } else {
    if (entry.kind !== "question") throw new BacklogValidationError("only questions become key questions");
    const cands = line.keyQuestionCandidates.filter((c) => c !== entry.text);
    if (to === "kq") {
      nextLine = {
        ...line,
        keyQuestion: entry.text,
        keyQuestionCandidates: line.keyQuestion ? [line.keyQuestion, ...cands] : cands,
      };
    } else {
      nextLine = { ...line, keyQuestionCandidates: [...cands, entry.text] };
    }
    promotedTo = to;
  }
  const at = opts.now.toISOString();
  const entries = b.entries.map((e) =>
    e.id === entryId
      ? {
          ...e,
          promotedTo,
          status: e.kind === "task" ? "doing" : e.kind === "question" ? "investigating" : "testing",
          statusBy: "principal" as const,
          updatedAt: at,
        }
      : e,
  );
  if (nextLine !== line) {
    nextLine = {
      ...nextLine,
      updatedAt: at,
      updatedBy: "principal",
      edits: [...line.edits, { at, by: "principal", fields: to === "kq" ? ["keyQuestion", "keyQuestionCandidates"] : ["keyQuestionCandidates"], note: "promoted from the backlog" }],
    };
  }
  return { backlog: { ...b, entries }, line: nextLine, item };
}
