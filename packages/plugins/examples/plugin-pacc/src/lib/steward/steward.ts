/**
 * Steward worker core — T-4.8 (D-45 Track 2).
 *
 * Runs the L0/L1 async steward: assembles a rehydration pack (value anchors,
 * context cards, open ledgers, yesterday's journal, last brief + feedback),
 * hands it + the standing prompt to the model (or falls back to a
 * deterministic state-diff journal with the model off), validates the
 * structured output — including value-anchor citations (PRD § 9.6: a vague
 * citation drops the proposal with a warning) — and returns a StewardJournal.
 *
 * Authority ceiling: the deps interface exposes reads, proposeM2 (candidate
 * memory), the journal writer and a draft writer. writeM2 / task creation /
 * approvals are structurally absent (same pattern as BrieferDeps); the
 * proposeM2 wrapper additionally throws on any L2+ level at runtime.
 */

import { createHash } from "node:crypto";
import type { AuthorityLevel } from "@paperclipai/shared";
import type { BrieferProjectInput, ValueAnchorSummary } from "../briefer/types.js";
import { validateValueAnchorCitation } from "../value-anchor/loader.js";
import { STEWARD_FLOOR_ADDENDUM, STEWARD_STANDING_PROMPT } from "./standing-prompt.js";
import { isPromptDeniedPath, scrubForPrompt } from "../prompt-scrub.js";

/** Default model for the steward (judgment-heavy role → Opus default). */
export const STEWARD_DEFAULT_MODEL = "claude-opus-4-8";

/** The steward's actor identifier. Threaded into every write/propose. */
export const STEWARD_ACTOR = "agent:steward";

export type StewardJobClassification = "J1_signal" | "J2_distribution" | "J3_product" | "meta";

export interface StewardAttentionProposal {
  project: string;
  proposal: string;
  /** Floor item size (CONTEXT.md: Allocation & calibration) — bite unless the model says deep. */
  size?: "bite" | "deep";
  whyNow: string;
  jobClassification: StewardJobClassification;
  requiredAuthority: string;
  sourceRefs: string[];
  anchorCitations: string[];
  confidence: number;
  riskIfIgnored: string;
}

export interface StewardJournalDraft {
  path: string;
  purpose: string;
  /** Optional draft content — when present the orchestrator writes the file. */
  content?: string;
}

export interface StewardJournal {
  journalDate: string;
  generatedAt: string;
  /** False when the deterministic state-diff path produced this journal. */
  modelGenerated: boolean;
  whatChanged: string[];
  attention: StewardAttentionProposal[];
  drafts: StewardJournalDraft[];
  awaitingReturn: Array<{ item: string; authority: string; recommendation: string }>;
  dissent: string[];
  selfCheck: string[];
  warnings: string[];
  confidence: number;
  /** Stable cache key over the pack inputs (mirrors the briefer). */
  inputsCacheKey: string;
}

export interface StewardLedgerInput {
  decisionsDue: Array<{ projectName: string; summary: string; reviewDate: string | null }>;
  expiringGrants: Array<{ label: string; expiresAt: string }>;
}

/** Yesterday's journal record (plugin_state) for the "what changed" diff. */
export interface StewardJournalDelta {
  journalDate: string;
  projectCardKeys: Record<string, string>;
}

/** Today's floor as the CoS sees it: capacity and each line's forward stack. */
export interface StewardFloorInput {
  capacity: { date: string; score: number | null; deepBlocks: number; bites: number; occupiedBy: string | null; recorded: boolean };
  lines: Array<{
    id: string;
    name: string;
    keyQuestion: string | null;
    open: { intake: number; triage: number; inProgress: number; needsYou: number };
    needsYouTitles: string[];
    doneLast7Days: number;
  }>;
}

export interface StewardDeps {
  /** Read-only: the factory floor (capacity + forward stacks). Optional for older wiring. */
  readFloor?(): Promise<StewardFloorInput | null>;
  /** Read-only: active projects + context cards (T-2.8). */
  listActiveProjectCards(): Promise<BrieferProjectInput[]>;
  /** Read-only: value-anchor registry (M1b) — objective function, citable. */
  listValueAnchors(): Promise<ValueAnchorSummary[]>;
  /** Read-only: open ledgers (decisions due, expiring grants). */
  readOpenLedgers(): Promise<StewardLedgerInput>;
  /** Read-only: yesterday's journal delta (card keys per project). */
  readLastJournalDelta(): Promise<StewardJournalDelta | null>;
  /** Read-only: last brief + principal feedback (rehydration). */
  readLastBrief(): Promise<{ briefDate: string; markdown: string } | null>;
  readBriefFeedback(): Promise<string | null>;
  /**
   * L1 propose-only. Wraps the candidate-memory path with a hard ceiling —
   * any `requiredAuthority` above L1 throws `StewardAuthorityViolation`.
   * (writeM2 accepted-state is NOT on this interface — structurally absent.)
   */
  proposeM2(args: {
    kind: "projectState" | "decision" | "authorityProfile";
    projectId?: string;
    patch?: Record<string, unknown>;
    data?: Record<string, unknown>;
    sourceRefs: Array<{ kind: string; path: string; hash: string; capturedAt: string; section?: string }>;
    confidence: number;
    actor: string;
    jobClassification: StewardJobClassification;
    requiredAuthority?: AuthorityLevel;
  }): Promise<void>;
  /** Journal storage — the steward's own write surface. */
  saveJournal(journal: StewardJournal): Promise<{ id: string }>;
  /**
   * Draft writer (L1 per PRD § 9.6). Paths must end `.draft.md`; the write
   * routes through the T-2.4 mediator (vault containment + protected paths).
   */
  writeDraft(path: string, content: string): Promise<{ path: string; kind: "wrote" | "unchanged" }>;
  /** Model call for the narrative sections. */
  callModel(args: {
    modelId: string;
    prompt: string;
    systemPrompt?: string | null;
  }): Promise<{ text: string | null; sessionId: string | null }>;
}

export interface RunStewardOptions {
  modelId?: string;
  now?: Date;
  /** Skip the LLM call entirely — deterministic state-diff journal. */
  skipModel?: boolean;
  /** Called when the model returns schema-invalid output (caller emits event). */
  onSchemaViolation?: (error: string) => void;
}

export class StewardAuthorityViolation extends Error {
  constructor(attemptedLevel: string, context: string) {
    super(
      `Steward is L0/L1-only — attempted ${attemptedLevel} write in ${context}. ` +
        `Queue it in awaitingReturn instead; L2+ is the principal's (or the approval queue's) call.`,
    );
    this.name = "StewardAuthorityViolation";
  }
}

/** Hard authority ceiling for steward code (mirrors assertBrieferL1). */
export function assertStewardL1(level: AuthorityLevel | string, context: string): void {
  if (level === "L0" || level === "L1") return;
  throw new StewardAuthorityViolation(String(level), context);
}

// ---------------------------------------------------------------------------
// Model output parsing + validation
// ---------------------------------------------------------------------------

const JOB_CLASSES: readonly string[] = ["J1_signal", "J2_distribution", "J3_product", "meta"];
/** T-6.7: max note summaries per project in the rehydration pack. */
const STEWARD_PACK_SOURCE_NOTES_PER_PROJECT = 4;

export type StewardParseResult =
  | { ok: true; value: Omit<StewardJournal, "journalDate" | "generatedAt" | "modelGenerated" | "inputsCacheKey"> }
  | { ok: false; error: string };

function asStringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

/** Extract the first balanced top-level JSON object from model text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + validate model text into the steward journal body. Tolerates code
 * fences / stray prose via extractJsonObject. Hand-rolled validation (no zod
 * dependency, same approach as briefer-output.ts).
 */
export function parseStewardModelOutput(text: string): StewardParseResult {
  const json = extractJsonObject(text);
  if (json === null) return { ok: false, error: "no JSON object found in model output" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "model output is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;

  const whatChanged = asStringArray(o.whatChanged);
  const dissent = asStringArray(o.dissent);
  const selfCheck = asStringArray(o.selfCheck);
  const warnings = asStringArray(o.warnings);
  if (whatChanged === null) return { ok: false, error: "whatChanged: must be an array of strings" };
  if (dissent === null) return { ok: false, error: "dissent: must be an array of strings" };
  if (selfCheck === null) return { ok: false, error: "selfCheck: must be an array of strings" };
  if (warnings === null) return { ok: false, error: "warnings: must be an array of strings" };
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    return { ok: false, error: "confidence: must be a number in [0, 1]" };
  }

  if (!Array.isArray(o.attention)) return { ok: false, error: "attention: must be an array" };
  if (o.attention.length > 3) return { ok: false, error: "attention: at most 3 entries" };
  const attention: StewardAttentionProposal[] = [];
  for (const [i, entry] of o.attention.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `attention[${i}]: must be an object` };
    }
    const a = entry as Record<string, unknown>;
    const str = (k: string): string | null => (typeof a[k] === "string" ? (a[k] as string) : null);
    const project = str("project");
    const proposal = str("proposal");
    const whyNow = str("whyNow") ?? "";
    const riskIfIgnored = str("riskIfIgnored") ?? "";
    if (project === null || project.trim() === "" || proposal === null || proposal.trim() === "") {
      return { ok: false, error: `attention[${i}]: project and proposal are required strings` };
    }
    const jobClassification = str("jobClassification");
    if (jobClassification === null || !JOB_CLASSES.includes(jobClassification)) {
      return { ok: false, error: `attention[${i}]: jobClassification must be one of ${JOB_CLASSES.join("|")}` };
    }
    const requiredAuthority = str("requiredAuthority");
    if (requiredAuthority === null || !/^L[0-5]$/.test(requiredAuthority)) {
      return { ok: false, error: `attention[${i}]: requiredAuthority must be L0..L5` };
    }
    const sourceRefs = asStringArray(a.sourceRefs);
    const anchorCitations = asStringArray(a.anchorCitations);
    if (sourceRefs === null) return { ok: false, error: `attention[${i}]: sourceRefs must be an array of strings` };
    if (anchorCitations === null) return { ok: false, error: `attention[${i}]: anchorCitations must be an array of strings` };
    if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
      return { ok: false, error: `attention[${i}]: confidence must be a number in [0, 1]` };
    }
    attention.push({
      project,
      proposal,
      size: str("size") === "deep" ? "deep" : "bite",
      whyNow,
      jobClassification: jobClassification as StewardJobClassification,
      requiredAuthority,
      sourceRefs,
      anchorCitations,
      confidence: a.confidence,
      riskIfIgnored,
    });
  }

  if (!Array.isArray(o.drafts)) return { ok: false, error: "drafts: must be an array" };
  const drafts: StewardJournalDraft[] = [];
  for (const [i, entry] of o.drafts.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `drafts[${i}]: must be an object` };
    }
    const d = entry as Record<string, unknown>;
    if (typeof d.path !== "string" || typeof d.purpose !== "string") {
      return { ok: false, error: `drafts[${i}]: path and purpose are required strings` };
    }
    if (!d.path.endsWith(".draft.md")) {
      return { ok: false, error: `drafts[${i}]: path must end with .draft.md` };
    }
    drafts.push({
      path: d.path,
      purpose: d.purpose,
      ...(typeof d.content === "string" ? { content: d.content } : {}),
    });
  }

  if (!Array.isArray(o.awaitingReturn)) return { ok: false, error: "awaitingReturn: must be an array" };
  const awaitingReturn: Array<{ item: string; authority: string; recommendation: string }> = [];
  for (const [i, entry] of o.awaitingReturn.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `awaitingReturn[${i}]: must be an object` };
    }
    const a = entry as Record<string, unknown>;
    if (typeof a.item !== "string" || typeof a.authority !== "string" || typeof a.recommendation !== "string") {
      return { ok: false, error: `awaitingReturn[${i}]: item, authority, recommendation are required strings` };
    }
    awaitingReturn.push({ item: a.item, authority: a.authority, recommendation: a.recommendation });
  }

  return {
    ok: true,
    value: { whatChanged, attention, drafts, awaitingReturn, dissent, selfCheck, warnings, confidence: o.confidence },
  };
}

// ---------------------------------------------------------------------------
// Rehydration pack
// ---------------------------------------------------------------------------

export interface StewardRehydrationPack {
  journalDate: string;
  valueAnchors: ValueAnchorSummary[];
  projects: Array<{
    projectId: string;
    projectName: string;
    portfolioState: string | null;
    currentPhase: string | null;
    staleStatus: string | null;
    nextAction: string | null;
    blockers: string | null;
    cardKey: string;
    /**
     * T-6.7: note substance for this project's grounding notes (source-index
     * summaries, capped) — the steward judges with content, not card UUIDs.
     */
    sourceNotes: Array<{ path: string; summary: string | null }>;
  }>;
  ledgers: StewardLedgerInput;
  yesterdaysJournal: StewardJournalDelta | null;
  lastBrief: { briefDate: string; markdown: string } | null;
  briefFeedback: string | null;
  /** The factory floor today (absent when not wired). */
  floor?: StewardFloorInput | null;
}

/**
 * PRD § 9.6 citation enforcement: every anchorCitation on every proposal must
 * be `[[Name]] § Section @ hash8` AND name a registered anchor. A proposal
 * carrying an invalid citation is dropped entirely — a vague values claim is
 * worse than no values claim — and the drop is recorded as a warning.
 */
export function enforceAnchorCitations(
  attention: StewardAttentionProposal[],
  anchorNames: ReadonlySet<string>,
): { kept: StewardAttentionProposal[]; warnings: string[] } {
  // Membership is case-insensitive (validateValueAnchorCitation lowercases).
  const lowerNames = new Set([...anchorNames].map((n) => n.toLowerCase()));
  const kept: StewardAttentionProposal[] = [];
  const warnings: string[] = [];
  for (const proposal of attention) {
    const invalid = proposal.anchorCitations.find(
      (c) => !validateValueAnchorCitation(c, lowerNames).valid,
    );
    if (invalid === undefined) {
      kept.push(proposal);
    } else {
      warnings.push(
        `dropped proposal for "${proposal.project}": invalid value-anchor citation "${invalid}" (PRD § 9.6 — vague citation fails validation)`,
      );
    }
  }
  return { kept, warnings };
}

/**
 * Data policy (2026-10-07): the copy of the pack that goes to the model.
 * Only free text that comes from journal / vault notes is scrubbed: note
 * summaries, the daily note's Occupied line, the last brief and the
 * principal's brief feedback. Structured fields (ids, card keys, paths,
 * names, counts, line/item text) are left exactly as they are, and the ids
 * and paths are also exempt inside the scrubbed text, so the hallucination
 * tripwire still grounds what the model echoes back. The original pack still
 * drives the deterministic journal and the cache key.
 */
export function scrubStewardPackForPrompt(pack: StewardRehydrationPack): StewardRehydrationPack {
  const keep: string[] = [];
  for (const p of pack.projects) {
    keep.push(p.projectId, p.cardKey);
    for (const n of p.sourceNotes) keep.push(n.path);
  }
  for (const l of pack.floor?.lines ?? []) keep.push(l.id);
  for (const k of Object.values(pack.yesterdaysJournal?.projectCardKeys ?? {})) keep.push(k);
  const scrub = (t: string | null): string | null => (t === null ? null : scrubForPrompt(t, { keep }));
  return {
    ...pack,
    projects: pack.projects.map((p) => ({
      ...p,
      sourceNotes: p.sourceNotes
        .filter((n) => !isPromptDeniedPath(n.path))
        .map((n) => ({ path: n.path, summary: scrub(n.summary) })),
    })),
    lastBrief: pack.lastBrief ? { ...pack.lastBrief, markdown: scrub(pack.lastBrief.markdown) ?? "" } : null,
    briefFeedback: scrub(pack.briefFeedback),
    ...(pack.floor
      ? { floor: { ...pack.floor, capacity: { ...pack.floor.capacity, occupiedBy: scrub(pack.floor.capacity.occupiedBy) } } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Model-off journal: a state-diff over the pack (what changed vs yesterday's
 * card keys) + top-3 attention derived from staleness/blocked-ness, each
 * carrying the card's own next action. No narrative — silence is valid output.
 */
export function deterministicJournal(pack: StewardRehydrationPack): Omit<StewardJournal, "journalDate" | "generatedAt" | "modelGenerated" | "inputsCacheKey"> {
  const whatChanged: string[] = [];
  const priorKeys = pack.yesterdaysJournal?.projectCardKeys ?? null;
  for (const p of pack.projects) {
    const prior = priorKeys?.[p.projectId];
    if (prior === undefined) {
      whatChanged.push(`${p.projectName}: new to the steward's view (no prior journal)`);
    } else if (prior !== p.cardKey) {
      whatChanged.push(`${p.projectName}: context changed since yesterday's journal`);
    }
  }
  if (priorKeys === null && pack.projects.length > 0) {
    whatChanged.unshift("first steward run — no prior journal to diff against");
  }
  for (const d of pack.ledgers.decisionsDue) {
    whatChanged.push(`decision due: ${d.projectName} — ${d.summary} (review ${d.reviewDate ?? "n/a"})`);
  }
  for (const g of pack.ledgers.expiringGrants) {
    whatChanged.push(`authority grant expiring: ${g.label} @ ${g.expiresAt}`);
  }

  const attention: StewardAttentionProposal[] = [...pack.projects]
    .sort((a, b) => rankScore(b) - rankScore(a))
    .slice(0, 3)
    .filter((p) => p.nextAction !== null)
    .map((p) => ({
      project: p.projectName,
      proposal: p.nextAction!,
      whyNow: p.staleStatus ? `attention rank: stale (${p.staleStatus})` : "ranked highest for attention today",
      jobClassification: "meta" as const,
      requiredAuthority: "L1",
      sourceRefs: [`card:${p.projectId}`],
      anchorCitations: [],
      confidence: 0.3,
      riskIfIgnored: p.blockers ? `blocked: ${p.blockers}` : "momentum decay",
    }));

  return {
    whatChanged,
    attention,
    drafts: [],
    awaitingReturn: [],
    dissent: [],
    selfCheck: [
      "deterministic mode (model off): no narrative, proposals are the cards' recorded next actions",
    ],
    warnings: pack.valueAnchors.length === 0 ? ["value-anchor registry empty or unreadable"] : [],
    confidence: 0.2,
  };
}

function rankScore(p: StewardRehydrationPack["projects"][number]): number {
  let score = 0;
  if (p.staleStatus === "stale" || p.staleStatus === "critical") score += 2;
  if (p.blockers && p.blockers.trim() !== "") score += 2;
  if (p.portfolioState === "primary") score += 1;
  if (p.staleStatus === "aging") score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function runSteward(
  deps: StewardDeps,
  options: RunStewardOptions = {},
): Promise<StewardJournal> {
  const now = options.now ?? new Date();
  const modelId = options.modelId ?? STEWARD_DEFAULT_MODEL;
  // Calendar date in the runtime's local timezone (TZ env) — the journal is
  // a local-morning artifact; toISOString would date it a day behind in
  // anything east of UTC (e.g. Australia/Sydney).
  const journalDate = formatLocalDate(now);

  const [projects, anchors, ledgers, yesterdays, lastBrief, feedback, floor] = await Promise.all([
    deps.listActiveProjectCards(),
    deps.listValueAnchors(),
    deps.readOpenLedgers(),
    deps.readLastJournalDelta(),
    deps.readLastBrief(),
    deps.readBriefFeedback(),
    deps.readFloor ? deps.readFloor().catch(() => null) : Promise.resolve(null),
  ]);

  const pack: StewardRehydrationPack = {
    journalDate,
    valueAnchors: anchors,
    projects: projects.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      portfolioState: (p.card.portfolioState as string | null) ?? null,
      currentPhase: (p.card.currentPhase as string | null) ?? null,
      staleStatus: (p.card.staleStatus as string | null) ?? null,
      nextAction: p.card.nextActions.answer,
      blockers: p.card.blockers.answer,
      cardKey: p.card.cacheKey,
      // T-6.7: cap the substance so a 3-project pack stays prompt-sized.
      // Data policy: Secrets/, *.env and *.key never enter the pack.
      sourceNotes: p.card.associatedNotes
        .filter((n) => !isPromptDeniedPath(n.path))
        .slice(0, STEWARD_PACK_SOURCE_NOTES_PER_PROJECT)
        .map((n) => ({ path: n.path, summary: n.summary })),
    })),
    ledgers,
    yesterdaysJournal: yesterdays,
    lastBrief,
    briefFeedback: feedback,
    ...(floor ? { floor } : {}),
  };

  const inputsCacheKey = createHash("sha256")
    .update(
      journalDate +
        "|" +
        pack.projects.map((p) => `${p.projectId}:${p.cardKey}`).join("|") +
        "|" +
        anchors.map((a) => a.name).join("|") +
        "|" +
        JSON.stringify(ledgers),
    )
    .digest("hex");

  let body: Omit<StewardJournal, "journalDate" | "generatedAt" | "modelGenerated" | "inputsCacheKey">;
  let modelGenerated = false;

  if (!options.skipModel) {
    const prompt = [
      STEWARD_STANDING_PROMPT,
      ...(pack.floor ? ["", STEWARD_FLOOR_ADDENDUM] : []),
      "",
      "## Rehydration pack (today)",
      "",
      "```json",
      JSON.stringify(scrubStewardPackForPrompt(pack), null, 2),
      "```",
      "",
      "Produce the journal JSON now.",
    ].join("\n");
    const result = await deps.callModel({ modelId, prompt, systemPrompt: null });
    const parsed = result.text !== null ? parseStewardModelOutput(result.text) : null;
    if (parsed !== null && parsed.ok) {
      modelGenerated = true;
      body = parsed.value;
      if (body.selfCheck.length === 0) body.selfCheck.push("model run produced no self-check");
    } else {
      const error = parsed === null ? "model returned no text (offline)" : parsed.error;
      options.onSchemaViolation?.(error);
      body = deterministicJournal(pack);
    }
  } else {
    body = deterministicJournal(pack);
  }

  // PRD § 9.6 citation enforcement (both origins — deterministic output
  // carries empty citations by construction, model output is the real target).
  const anchorNames = new Set(anchors.map((a) => a.name));
  const enforced = enforceAnchorCitations(body.attention, anchorNames);
  if (enforced.warnings.length > 0) {
    body = {
      ...body,
      attention: enforced.kept,
      warnings: [...body.warnings, ...enforced.warnings],
    };
  }

  return {
    ...body,
    journalDate,
    generatedAt: now.toISOString(),
    modelGenerated,
    inputsCacheKey,
  };
}
