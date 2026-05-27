/**
 * Hallucination tripwire — T-3.7 / PRD § 15.2 tripwire 5.
 *
 * Scans rendered brief Markdown for ID-shaped tokens, validates each
 * against the set of known canonical IDs (project slugs + decision/task
 * UUIDs the briefer was given), and flags anything that doesn't match.
 *
 * Counts flags over a rolling 24h window (NOT calendar day — midnight
 * rollover must not reset). At ≥ 3 flags within the window, the briefer
 * self-pauses by writing a plugin_state flag; the scheduled-brief
 * orchestrator checks this before each run.
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

  const flags: HallucinationFlag[] = [];
  const tokens = extractIdLikeTokens(input.briefMarkdown);

  for (const ref of tokens) {
    const lc = ref.toLowerCase();
    if (knownLc.has(lc) || allowLc.has(lc)) continue;
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
// Rolling 24h counter
// ---------------------------------------------------------------------------

export interface HallucinationFlagRecord {
  /** ISO-8601 timestamp. */
  at: string;
  /** YYYY-MM-DD of the brief this came from. */
  briefDate: string;
  /** Verbatim references that triggered this flag (1+ per call). */
  refs: string[];
}

export interface HallucinationCounterState {
  flags: HallucinationFlagRecord[];
}

/** Default window — PRD § 15.2 tripwire 5. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default threshold — 3 flags in window triggers self-pause. */
export const DEFAULT_PAUSE_THRESHOLD = 3;

/** Return only the flags that fall within `windowMs` of `now` (inclusive). */
export function pruneOldFlags(
  state: HallucinationCounterState | null | undefined,
  now: Date,
  windowMs: number = DEFAULT_WINDOW_MS,
): HallucinationFlagRecord[] {
  if (!state?.flags) return [];
  const cutoffMs = now.getTime() - windowMs;
  return state.flags.filter((f) => {
    const t = Date.parse(f.at);
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

/**
 * Decide whether the briefer should self-pause based on the count of
 * flags in the rolling window. `flags` is expected to already be pruned.
 */
export function shouldPause(
  flagsInWindow: readonly HallucinationFlagRecord[],
  threshold: number = DEFAULT_PAUSE_THRESHOLD,
): boolean {
  return flagsInWindow.length >= threshold;
}

/**
 * Append a new flag-record to existing state (after pruning). Returns the
 * full updated state for the caller to persist.
 */
export function appendFlag(
  state: HallucinationCounterState | null | undefined,
  newFlag: HallucinationFlagRecord,
  now: Date = new Date(),
  windowMs: number = DEFAULT_WINDOW_MS,
): HallucinationCounterState {
  const pruned = pruneOldFlags(state, now, windowMs);
  return { flags: [...pruned, newFlag] };
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
