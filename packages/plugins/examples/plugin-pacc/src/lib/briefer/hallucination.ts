/**
 * Hallucination tripwire — T-3.7 / PRD § 15.2 tripwire 5.
 * D-39 fix (T-3.12): pause scope + unique-reference counting.
 *
 * Scans rendered brief Markdown for ID-shaped tokens, validates each
 * against the set of known canonical IDs (project slugs + decision/task
 * UUIDs the briefer was given), and flags anything that doesn't match.
 *
 * Counts **unique normalized references** over a rolling 24h window (NOT
 * calendar day — midnight rollover must not reset; NOT flagged runs — the
 * same false-positive token repeating across runs counts once). At ≥ 3
 * unique references within the window, the briefer self-pauses by writing
 * a plugin_state flag; the scheduled-brief orchestrator checks this before
 * each run.
 *
 * D-39: the self-pause fires **only** when the flagged brief was
 * model-generated (`skipModel === false`). Flags raised on
 * deterministic/offline briefs are detector/pipeline bugs, not evidence of
 * model hallucination — they render a warning line + an audit row, and
 * never pause. Deterministic sightings are still recorded (for
 * `pacc audit hallucinations`) but excluded from the pause count.
 *
 * Pure logic only. Caller plumbs the plugin_state read/write via the
 * `HallucinationFlagStore` and `PauseStore` interfaces.
 *
 * ID extraction is deliberately narrow:
 *   - UUIDs: standard 8-4-4-4-12 hex with dashes
 *   - Slugs: 3+ chars, lowercase letters/digits/hyphens, word-boundary
 * Free-text proper-noun matching is a fuzzier problem (Phase 6+).
 */

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/**
 * Slug pattern: 3+ chars, lowercase letters/digits with internal hyphens.
 * Must contain at least one hyphen OR be a multi-segment lowercase word
 * with no spaces. Matched at word boundaries so prose words don't trigger.
 *
 * Captures: 'circlo' won't match (no hyphen, ambiguous with prose word);
 * 'hometrics' won't match either. 'co-reader', 'book-energy-cycles',
 * 'smb-assistant' will match. UUIDs are caught by the prior pattern so
 * this can be slug-shape only.
 *
 * This is intentionally conservative: false-positives in slug detection
 * would flood the brief with spurious hallucination markers. Slug IDs
 * with no hyphen are out of scope; the principal will mostly use
 * hyphenated slugs anyway (seed-portfolio.ts confirms this).
 */
const SLUG_PATTERN = /\b[a-z0-9]+-[a-z0-9-]+\b/g;

/**
 * Extract ID-shaped tokens from text. Returns unique tokens (dedup'd by
 * lowercase) so each token gets counted only once per scan.
 */
/** ISO calendar dates (YYYY-MM-DD) are slug-shaped but never IDs — excluded. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function extractIdLikeTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (raw: string) => {
    // Dates look like slugs but are never project/decision IDs.
    if (DATE_PATTERN.test(raw)) return;
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };

  for (const m of text.matchAll(UUID_PATTERN)) push(m[0]);
  for (const m of text.matchAll(SLUG_PATTERN)) push(m[0]);
  return out;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface HallucinationFlag {
  /** The exact token found in the brief. */
  reference: string;
  /** Classification heuristic. */
  kind: "uuid" | "slug";
  /** Up to ~80 chars of surrounding text for context (helps the audit log). */
  excerpt: string;
}

export interface DetectHallucinationsInput {
  briefMarkdown: string;
  /**
   * Canonical IDs the briefer knew about. Compared case-insensitively.
   * Include project slugs/UUIDs, decision UUIDs, task UUIDs, etc.
   */
  knownIds: ReadonlySet<string>;
  /**
   * Optional allow-list of tokens that look like IDs but are common false
   * positives in prose (e.g. URL fragments, common library names).
   * Compared case-insensitively.
   */
  allowList?: ReadonlySet<string>;
  /**
   * Vault paths the brief legitimately cites (T-2.10 Source Notes /
   * sourceRefs). Any ID-shaped token that occurs inside one of these paths
   * is grounded by construction — hyphenated filenames like
   * `custodian-log.md` or `2026-04-21-Grants-inventory-table.md` are slug-
   * shaped but are real M1a references, not hallucinations
   * (T-3.7-sourcerefs).
   */
  sourcePaths?: readonly string[];
  /**
   * Authoritative M1b phrases (T-2.10 Part B): value-anchor names + purposes
   * rendered in the brief's Value Anchors section. Any ID-shaped token that
   * occurs verbatim inside one of these is grounded — anchor prose legitimately
   * contains slug-shaped hyphenated terms (e.g. "Zone 2 entrepreneurship") that
   * are real references, not hallucinations. Same substring semantics as
   * {@link sourcePaths}.
   */
  groundingPhrases?: readonly string[];
}

const DEFAULT_ALLOW_LIST = new Set<string>([
  // Common slug-shaped phrases that aren't IDs
  "next-step",
  "next-action",
  "do-not-rethink",
  "lane-product",
  "lane-customer",
  "lane-distribution",
  "no-entries",
  "json-build-object",
  // T-3.10 self-check section structural markers
  "control-plane",
  "self-check",
  "kill-criterion",
  // common hyphenated words in the brief's own prose (not references)
  "re-grounding",
  "pre-pmf",
]);

/**
 * Scan brief Markdown and return one flag per unknown ID-shaped token.
 * Tokens in `knownIds` or `allowList` pass through silently.
 */
export function detectHallucinations(
  input: DetectHallucinationsInput,
): HallucinationFlag[] {
  const allowList = input.allowList ?? DEFAULT_ALLOW_LIST;
  const knownLc = new Set([...input.knownIds].map((s) => s.toLowerCase()));
  const allowLc = new Set([...allowList].map((s) => s.toLowerCase()));
  // A token is grounded when it occurs verbatim (case-insensitive) inside a
  // real cited path — hyphenated filename fragments, dated prefixes, etc.
  const sourcePathsLc = (input.sourcePaths ?? []).map((p) => p.toLowerCase());
  // T-2.10 Part B: same for authoritative M1b phrases (value-anchor names +
  // purposes) so anchor prose doesn't false-trigger the detector.
  const groundingPhrasesLc = (input.groundingPhrases ?? []).map((p) => p.toLowerCase());

  const flags: HallucinationFlag[] = [];
  const tokens = extractIdLikeTokens(input.briefMarkdown);

  for (const ref of tokens) {
    const lc = ref.toLowerCase();
    if (knownLc.has(lc) || allowLc.has(lc)) continue;
    if (sourcePathsLc.some((p) => p.includes(lc))) continue;
    if (groundingPhrasesLc.some((p) => p.includes(lc))) continue;
    flags.push({
      reference: ref,
      kind: looksLikeUuid(ref) ? "uuid" : "slug",
      excerpt: extractExcerpt(input.briefMarkdown, ref),
    });
  }

  return flags;
}

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function extractExcerpt(text: string, ref: string, padding = 40): string {
  const idx = text.toLowerCase().indexOf(ref.toLowerCase());
  if (idx < 0) return ref;
  const start = Math.max(0, idx - padding);
  const end = Math.min(text.length, idx + ref.length + padding);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ") + suffix;
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

const ANNOTATION = " _(hallucinated reference)_";

/**
 * Insert `(hallucinated reference)` annotations after each flagged token
 * in the Markdown. Replaces only the first occurrence of each unique
 * reference to avoid duplicating annotations on repeated references.
 */
export function annotateHallucinations(
  markdown: string,
  flags: readonly HallucinationFlag[],
): string {
  let out = markdown;
  const seen = new Set<string>();
  for (const flag of flags) {
    const key = flag.reference.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Replace the first occurrence only (preserve subsequent ones plain).
    const idx = out.toLowerCase().indexOf(key);
    if (idx < 0) continue;
    out =
      out.slice(0, idx + flag.reference.length) +
      ANNOTATION +
      out.slice(idx + flag.reference.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference normalization (D-39)
// ---------------------------------------------------------------------------

/** Trailing punctuation commonly attached to a reference inside prose. */
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

/**
 * Normalize a reference for dedup purposes: trim, lowercase, strip trailing
 * punctuation. Two mentions of the same token that differ only in case or a
 * trailing period/comma count as the same unique reference (D-39).
 */
export function normalizeReference(raw: string): string {
  return raw.trim().toLowerCase().replace(TRAILING_PUNCT, "");
}

// ---------------------------------------------------------------------------
// Rolling 24h counter — unique references (D-39)
// ---------------------------------------------------------------------------

/** One detected reference, recorded once per (run, reference) pair. */
export interface HallucinationSighting {
  /** ISO-8601 timestamp of the run that produced this sighting. */
  at: string;
  /** YYYY-MM-DD of the brief this came from. */
  briefDate: string;
  /** Normalized reference (trim/lowercase/strip trailing punctuation) — the dedup key. */
  ref: string;
  /** Verbatim token as it appeared in the brief (for display/audit). */
  rawRef: string;
  /**
   * Whether the originating brief was model-generated (`skipModel === false`).
   * Deterministic/offline sightings are recorded for audit but never count
   * toward the self-pause threshold (D-39).
   */
  modelGenerated: boolean;
}

export interface HallucinationCounterState {
  sightings: HallucinationSighting[];
}

/** Default window — PRD § 15.2 tripwire 5. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default threshold — 3 unique references in window triggers self-pause. */
export const DEFAULT_PAUSE_THRESHOLD = 3;

/** Return only the sightings that fall within `windowMs` of `now` (inclusive). */
export function pruneOldSightings(
  state: HallucinationCounterState | null | undefined,
  now: Date,
  windowMs: number = DEFAULT_WINDOW_MS,
): HallucinationSighting[] {
  if (!state?.sightings) return [];
  const cutoffMs = now.getTime() - windowMs;
  return state.sightings.filter((s) => {
    const t = Date.parse(s.at);
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

/**
 * Count of unique normalized references among **model-generated** sightings
 * only. Deterministic/offline sightings never contribute (D-39).
 */
export function countUniqueModelRefs(
  sightings: readonly HallucinationSighting[],
): number {
  const set = new Set(
    sightings.filter((s) => s.modelGenerated).map((s) => s.ref),
  );
  return set.size;
}

/**
 * Decide whether the briefer should self-pause based on the count of
 * **unique model-generated** references in the rolling window. `sightings`
 * is expected to already be pruned to the window.
 */
export function shouldPause(
  sightingsInWindow: readonly HallucinationSighting[],
  threshold: number = DEFAULT_PAUSE_THRESHOLD,
): boolean {
  return countUniqueModelRefs(sightingsInWindow) >= threshold;
}

/**
 * Append new sightings to existing state (after pruning). Returns the full
 * updated state for the caller to persist.
 */
export function appendSightings(
  state: HallucinationCounterState | null | undefined,
  newSightings: readonly HallucinationSighting[],
  now: Date = new Date(),
  windowMs: number = DEFAULT_WINDOW_MS,
): HallucinationCounterState {
  const pruned = pruneOldSightings(state, now, windowMs);
  return { sightings: [...pruned, ...newSightings] };
}

// ---------------------------------------------------------------------------
// Audit rows — `pacc audit hallucinations` (T-3.12)
// ---------------------------------------------------------------------------

export interface HallucinationAuditRow {
  /** Normalized reference. */
  ref: string;
  /** ISO-8601 timestamp of the earliest sighting of this ref in the window. */
  firstSeenAt: string;
  /** Brief date the first sighting came from. */
  briefDate: string;
  /** Origin of the first sighting: model-generated or deterministic/offline. */
  modelGenerated: boolean;
}

/**
 * Reduce a window of sightings to one audit row per unique reference,
 * keyed on first-seen order. Multiple runs re-mentioning the same reference
 * collapse to a single row (D-39: counts unique references, not runs).
 */
export function auditRowsFromSightings(
  sightingsInWindow: readonly HallucinationSighting[],
): HallucinationAuditRow[] {
  const sorted = [...sightingsInWindow].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const byRef = new Map<string, HallucinationAuditRow>();
  for (const s of sorted) {
    if (byRef.has(s.ref)) continue;
    byRef.set(s.ref, {
      ref: s.ref,
      firstSeenAt: s.at,
      briefDate: s.briefDate,
      modelGenerated: s.modelGenerated,
    });
  }
  return [...byRef.values()];
}

// ---------------------------------------------------------------------------
// Resume path (T-3.12) — `pacc resume-briefer`
// ---------------------------------------------------------------------------

export interface PauseAuditRow {
  /** ISO-8601 timestamp. */
  at: string;
  /** Who cleared the pause. Always `principal` for the CLI path. */
  actor: string;
  /** The reason the pause carried at the moment it was cleared. */
  clearedReason: string | null;
}

export interface ResumeBrieferInput {
  pauseState: { paused: boolean; reason: string | null } | null;
  actor: string;
  now: Date;
}

export type ResumeBrieferResult =
  | { kind: "resumed"; auditRow: PauseAuditRow }
  | { kind: "not_paused" };

/**
 * Pure decision logic for `pacc resume-briefer`: clears the pause only if
 * one is active, and always produces an audit row when it does. Errors
 * clearly (via the `not_paused` result) when there is nothing to resume —
 * the caller surfaces this as a CLI error.
 */
export function resumeBriefer(input: ResumeBrieferInput): ResumeBrieferResult {
  if (!input.pauseState?.paused) return { kind: "not_paused" };
  return {
    kind: "resumed",
    auditRow: {
      at: input.now.toISOString(),
      actor: input.actor,
      clearedReason: input.pauseState.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Stub-brief content for the paused state
// ---------------------------------------------------------------------------

/**
 * When the briefer is paused, the scheduled-brief writes this stub to
 * Obsidian instead of running the briefer. The principal sees a clear
 * pointer to the audit/resume commands.
 */
export function pausedBriefMarkdown(briefDate: string, reason: string): string {
  return [
    `# Daily Operating Brief - ${briefDate}`,
    "",
    "## ⚠ BRIEFER PAUSED",
    "",
    `Reason: ${reason}`,
    "",
    "The briefer detected ≥ 3 hallucination flags within the last 24 hours and self-paused (PRD § 15.2 tripwire 5).",
    "",
    "**To investigate:** `pacc audit hallucinations` lists the flagged references and the briefs they came from.",
    "",
    "**To resume:** `pacc resume-briefer` clears the pause flag. The next cron tick will produce a real brief.",
    "",
  ].join("\n");
}
