/**
 * Project lines — the record for project state (ControlPlane ADR 0003).
 *
 * A project line is one project as the factory floor shows it: its grounding
 * (intent, kill criteria, doNotRethink, key question, plan piles), its standing
 * state (status, next action, blockers) and its evidence clock. The pacc store
 * holds the one live copy; `ControlPlane/seed/portfolio-seed.json` is only a
 * snapshot exported from it. Pure domain logic — persistence is injected.
 *
 * Curation split (CONTEXT.md): the principal may edit the coarse and fine
 * layers from the floor; the chief of staff may only touch the fine layer and
 * must cite sources when it does. Nobody but the principal changes intent,
 * kill criteria, doNotRethink or the key question.
 */

import { sourceRefSchema } from "@paperclipai/shared";

export interface GroundingRef {
  kind: string;
  path: string;
  anchor?: string | null;
  label?: string | null;
}

export interface LineEdit {
  at: string;
  by: string;
  fields: string[];
  note?: string | null;
}

export interface ProjectLine {
  /** Stable slug — work items reference it as their projectId. */
  id: string;
  name: string;
  portfolioState: string;
  /** Free-text phase label (never a stage machine — Validation focus). */
  phase: string | null;
  intent: string | null;
  killCriteria: string | null;
  doNotRethink: string | null;
  keyQuestion: string | null;
  keyQuestionCandidates: string[];
  currentStatus: string | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  lastMeaningfulOutput: string | null;
  groundingRefs: GroundingRef[];
  sourceRefs: Array<Record<string, unknown>>;
  visionRefs: string[];
  /** Home-relative (`~/Work/<repo>`) so the same record works on every machine. */
  repoPath: string | null;
  obsidianFolder: string | null;
  lastMeaningfulActivityAt: string | null;
  /** Evidence clock (CONTEXT.md: Aging clocks) — only evidence events move it. */
  lastEvidenceAt: string | null;
  /** The Paperclip project UUID this line replaced, for legacy per-project state. */
  legacyProjectId: string | null;
  /** Seed fields the record does not model, kept verbatim for the snapshot. */
  extra: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  edits: LineEdit[];
}

export class LineValidationError extends Error {}

const STRING_FIELDS = [
  "phase",
  "intent",
  "killCriteria",
  "doNotRethink",
  "keyQuestion",
  "currentStatus",
  "nextSmallestAction",
  "blockerSummary",
  "lastMeaningfulOutput",
  "repoPath",
] as const;

/** Fields the principal may set from the floor (portfolioState stays a deliberate seed-level act). */
export const PRINCIPAL_FIELDS = [...STRING_FIELDS, "keyQuestionCandidates", "groundingRefs"] as const;
/** Fine layer — what the chief of staff may maintain, with sources. */
export const COS_FIELDS = ["currentStatus", "nextSmallestAction", "blockerSummary", "keyQuestionCandidates"] as const;

const MAX_EDITS = 200;
const MAX_TEXT = 4000;

/** `/home/<user>/x` → `~/x`, so paths survive a move between machines/users. */
export function homeRelative(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  return p.trim().replace(/^\/home\/[^/]+\//, "~/");
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = str(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function groundingList(v: unknown): GroundingRef[] {
  if (!Array.isArray(v)) return [];
  const out: GroundingRef[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const p = homeRelative(r.path);
    if (!p) continue;
    out.push({
      kind: str(r.kind) ?? "doc",
      path: p,
      anchor: str(r.anchor),
      label: str(r.label),
    });
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const MODELLED_SEED_KEYS = new Set([
  "id",
  "slug",
  "name",
  "portfolioState",
  "phase",
  "intent",
  "killCriteria",
  "doNotRethink",
  "keyQuestion",
  "keyQuestionCandidates",
  "currentStatus",
  "nextSmallestAction",
  "blockerSummary",
  "lastMeaningfulOutput",
  "groundingRefs",
  "sourceRefs",
  "visionRefs",
  "repoPath",
  "obsidianFolder",
  "lastMeaningfulActivityAt",
  "lastEvidenceAt",
  "legacyProjectId",
]);

/** Build a line from one portfolio-seed entry (the one-time takeover, and tests). */
export function lineFromSeed(
  seed: Record<string, unknown>,
  opts: { now: Date; actor: string; legacyProjectId?: string | null },
): ProjectLine {
  const name = str(seed.name);
  if (!name) throw new LineValidationError("seed entry needs a name");
  const id = str(seed.id) ?? str(seed.slug) ?? slugify(name);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seed)) {
    if (!MODELLED_SEED_KEYS.has(k)) extra[k] = v;
  }
  const at = opts.now.toISOString();
  return {
    id,
    name,
    portfolioState: str(seed.portfolioState) ?? "parked",
    phase: str(seed.phase),
    intent: str(seed.intent),
    killCriteria: str(seed.killCriteria),
    doNotRethink: str(seed.doNotRethink),
    keyQuestion: str(seed.keyQuestion),
    keyQuestionCandidates: strList(seed.keyQuestionCandidates),
    currentStatus: str(seed.currentStatus),
    nextSmallestAction: str(seed.nextSmallestAction),
    blockerSummary: str(seed.blockerSummary),
    lastMeaningfulOutput: str(seed.lastMeaningfulOutput),
    groundingRefs: groundingList(seed.groundingRefs),
    sourceRefs: Array.isArray(seed.sourceRefs)
      ? (seed.sourceRefs as unknown[])
          .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
          .map((r) => ({ ...r, ...(typeof r.path === "string" ? { path: homeRelative(r.path) } : {}) }))
      : [],
    visionRefs: strList(seed.visionRefs),
    repoPath: homeRelative(seed.repoPath),
    obsidianFolder: homeRelative(seed.obsidianFolder),
    lastMeaningfulActivityAt: str(seed.lastMeaningfulActivityAt),
    lastEvidenceAt: str(seed.lastEvidenceAt) ?? str(seed.lastMeaningfulActivityAt),
    legacyProjectId: opts.legacyProjectId ?? str(seed.legacyProjectId),
    extra,
    updatedAt: at,
    updatedBy: opts.actor,
    edits: [{ at, by: opts.actor, fields: ["*"], note: "imported from portfolio seed" }],
  };
}

export type LinePatch = Partial<Record<(typeof PRINCIPAL_FIELDS)[number], unknown>> & {
  sourceRefs?: unknown;
  note?: unknown;
};

/**
 * Apply an edit under the curation split. Returns the new line and the fields
 * that actually changed (empty = a no-op the caller need not persist).
 */
export function applyLinePatch(
  line: ProjectLine,
  patch: LinePatch,
  opts: { now: Date; actor: string },
): { line: ProjectLine; changed: string[] } {
  const allowed: readonly string[] =
    opts.actor === "principal" ? PRINCIPAL_FIELDS : opts.actor === "cos" ? COS_FIELDS : [];
  if (allowed.length === 0) throw new LineValidationError(`actor ${opts.actor} may not edit project lines`);
  const requested = Object.keys(patch).filter((k) => k !== "sourceRefs" && k !== "note");
  const refused = requested.filter((k) => !allowed.includes(k));
  if (refused.length) {
    throw new LineValidationError(`${opts.actor} may not edit: ${refused.join(", ")}`);
  }
  if (opts.actor === "cos" && !(Array.isArray(patch.sourceRefs) && patch.sourceRefs.length > 0)) {
    throw new LineValidationError("chief-of-staff edits must cite sourceRefs (curation split)");
  }
  const next: ProjectLine = { ...line, edits: [...line.edits] };
  const changed: string[] = [];
  for (const k of requested) {
    const v = (patch as Record<string, unknown>)[k];
    let value: unknown;
    if (k === "keyQuestionCandidates") value = strList(v);
    else if (k === "groundingRefs") value = groundingList(v);
    else if (k === "repoPath") value = homeRelative(v);
    else value = str(v);
    if (JSON.stringify(value) !== JSON.stringify((line as unknown as Record<string, unknown>)[k])) {
      (next as unknown as Record<string, unknown>)[k] = value;
      changed.push(k);
    }
  }
  if (changed.length === 0) return { line, changed };
  const at = opts.now.toISOString();
  next.updatedAt = at;
  next.updatedBy = opts.actor;
  next.edits.push({ at, by: opts.actor, fields: changed, note: str(patch.note) });
  if (next.edits.length > MAX_EDITS) next.edits = next.edits.slice(-MAX_EDITS);
  return { line: next, changed };
}

/** An evidence event (CONTEXT.md: Aging clocks) — only the clock moves; authorship never does. */
export function recordEvidence(line: ProjectLine, at: Date): ProjectLine {
  const iso = at.toISOString();
  if (line.lastEvidenceAt && line.lastEvidenceAt >= iso) return line;
  return { ...line, lastEvidenceAt: iso };
}

/** Key order of a snapshot entry: modelled fields first (seed order), then extras sorted. */
const SNAPSHOT_ORDER = [
  "id",
  "slug",
  "name",
  "portfolioState",
  "phase",
  "intent",
  "killCriteria",
  "doNotRethink",
  "keyQuestion",
  "keyQuestionCandidates",
  "currentStatus",
  "nextSmallestAction",
  "blockerSummary",
  "lastMeaningfulOutput",
  "lastMeaningfulActivityAt",
  "lastEvidenceAt",
  "repoPath",
  "obsidianFolder",
  "groundingRefs",
  "sourceRefs",
  "visionRefs",
] as const;

/** One seed-snapshot entry for a line — deterministic for identical lines. */
export function lineToSnapshotEntry(line: ProjectLine): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const src = { ...line, slug: line.id } as unknown as Record<string, unknown>;
  for (const k of SNAPSHOT_ORDER) entry[k] = src[k] ?? null;
  for (const k of Object.keys(line.extra).sort()) {
    if (!(k in entry)) entry[k] = line.extra[k];
  }
  return entry;
}

/** The whole snapshot file body: lines in a stable order, trailing newline. */
export function renderSnapshot(lines: ProjectLine[]): string {
  const sorted = [...lines].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted.map(lineToSnapshotEntry), null, 2) + "\n";
}

/**
 * The control-plane-state shape the context card (and so the steward) reads.
 * Only well-formed M-layer source refs pass through; seed-era refs (folder
 * pointers) stay on the line for the surface but never pose as provenance.
 */
export function lineToControlPlaneState(line: ProjectLine): Record<string, unknown> {
  const sourceRefs = line.sourceRefs.filter((r) => sourceRefSchema.safeParse(r).success);
  return {
    portfolioState: line.portfolioState,
    currentPhase: null,
    constraintLane: null,
    nextSmallestAction: line.nextSmallestAction,
    blockerSummary: line.blockerSummary,
    latestEvidenceChanged: null,
    resumeBrief: null,
    doNotRethink: line.doNotRethink,
    killCriteria: line.killCriteria,
    lastMeaningfulOutput: null,
    intent: line.intent,
    currentStatus: line.currentStatus,
    sourceRefs,
    lastEvidenceAt: line.lastEvidenceAt,
    keyQuestion: line.keyQuestion,
  };
}
