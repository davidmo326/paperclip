/**
 * Do-not-rethink surfacing — T-3.5 / PRD § 15.2 tripwire 6.
 *
 * When the briefer is about to include a proposed task / decision in the
 * brief, we check it against each project's `doNotRethink` list (a settled-
 * decisions register the steward must not relitigate).
 *
 * Similarity check: Jaccard on token sets (lowercase + stopword-removed)
 * with threshold 0.4. Deterministic — no LLM-judged path (Phase 6+).
 *
 * Pure logic only. The caller (briefer.ts) plumbs the events.emit + brief
 * decoration.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Jaccard threshold — per PLAN T-3.5. */
export const DO_NOT_RETHINK_JACCARD_THRESHOLD = 0.4;

/**
 * Compact English stopword set. Tuned to remove words that inflate Jaccard
 * scores without carrying semantic weight (articles, prepositions, common
 * verbs, pronouns). Avoids removing decision-relevant terms.
 */
const STOPWORDS = new Set<string>([
  "a", "an", "the",
  "and", "or", "but", "nor", "so", "if", "as", "than", "while",
  "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done", "doing",
  "has", "have", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "in", "on", "at", "of", "for", "to", "with", "by", "from", "into", "onto", "out",
  "this", "that", "these", "those", "it", "its",
  "i", "we", "you", "they", "he", "she", "me", "us", "them",
  "my", "our", "your", "their", "his", "her",
  "not", "no", "yes", "any", "all", "some", "more", "most", "less", "least",
  "very", "just", "only", "also", "too",
  "here", "there", "when", "where", "why", "how", "what", "which", "who", "whom",
  "about", "over", "under", "again", "further", "once",
  "now", "then", "still", "yet", "even",
  "such", "same", "other", "another",
]);

// ---------------------------------------------------------------------------
// Tokenization + Jaccard
// ---------------------------------------------------------------------------

/**
 * Tokenize text into a set of meaningful tokens:
 *   - lowercase
 *   - split on non-alphanumeric
 *   - drop tokens < 2 chars
 *   - drop stopwords
 * Returns an empty set for null/undefined/whitespace-only input.
 */
export function tokenize(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);
  const out = new Set<string>();
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 for two empty sets
 * (treats "no signal" as "no overlap", not as undefined).
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Do-not-rethink check
// ---------------------------------------------------------------------------

/**
 * Split a project's `doNotRethink` block into individual settled-decision
 * entries. The schema field is `string | null` (T-1.3); we treat each
 * newline as an entry separator, dropping empty lines.
 */
export function splitDoNotRethinkEntries(block: string | null | undefined): string[] {
  if (!block) return [];
  return block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface RethinkConflict {
  /** The settled decision the proposal overlaps with. */
  settledDecision: string;
  /** The proposal text that triggered the flag. */
  proposalText: string;
  /** Jaccard score (≥ threshold). */
  similarity: number;
}

export interface CheckDoNotRethinkInput {
  /** The text of the proposed task / decision. */
  proposalText: string;
  /** Verbatim contents of the project's `doNotRethink` field (newline-separated). */
  doNotRethink: string | null | undefined;
  /** Override the Jaccard threshold. Default 0.4. */
  threshold?: number;
}

/**
 * Check a single proposal against a project's `doNotRethink` list.
 * Returns ALL settled-decision entries that exceed the threshold (not
 * just the first), so the brief can show every conflicting line.
 */
export function checkDoNotRethink(input: CheckDoNotRethinkInput): RethinkConflict[] {
  const threshold = input.threshold ?? DO_NOT_RETHINK_JACCARD_THRESHOLD;
  const proposalTokens = tokenize(input.proposalText);
  if (proposalTokens.size === 0) return [];

  const conflicts: RethinkConflict[] = [];
  for (const entry of splitDoNotRethinkEntries(input.doNotRethink)) {
    const entryTokens = tokenize(entry);
    if (entryTokens.size === 0) continue;
    const sim = jaccardSimilarity(proposalTokens, entryTokens);
    if (sim >= threshold) {
      conflicts.push({
        settledDecision: entry,
        proposalText: input.proposalText,
        similarity: sim,
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Convenience: check across a list of proposals
// ---------------------------------------------------------------------------

export interface RethinkConflictForProject extends RethinkConflict {
  projectId: string;
  projectName: string;
}

export interface ProjectDoNotRethinkInput {
  projectId: string;
  projectName: string;
  doNotRethink: string | null | undefined;
}

/**
 * Run `checkDoNotRethink` for one proposal across many projects' doNotRethink
 * lists. Returns conflicts flattened with project id/name attached, so the
 * caller can both surface in the brief AND emit one event per conflict.
 */
export function checkProposalAgainstProjects(
  proposalText: string,
  projects: readonly ProjectDoNotRethinkInput[],
  threshold = DO_NOT_RETHINK_JACCARD_THRESHOLD,
): RethinkConflictForProject[] {
  const out: RethinkConflictForProject[] = [];
  for (const p of projects) {
    const conflicts = checkDoNotRethink({
      proposalText,
      doNotRethink: p.doNotRethink,
      threshold,
    });
    for (const c of conflicts) {
      out.push({ ...c, projectId: p.projectId, projectName: p.projectName });
    }
  }
  return out;
}
