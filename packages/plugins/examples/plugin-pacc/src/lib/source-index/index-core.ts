/**
 * Source index — pure core (T-2.2, PRD § 9.2).
 *
 * Given a note's path + raw content, produces an index record: content hash,
 * frontmatter, outbound wikilinks, a summary, and a confidence score.
 *
 * Deliberately tier-agnostic (PLAN v3 amendment, 2026-07-09): no M1a/M1b
 * field here. Tier is a property of the value-anchor registry (T-2.4) and
 * is joined at query time by consumers — this module has zero dependency on
 * that registry landing first.
 *
 * Pure domain logic per docs/substrate-firewall.md: no filesystem, no
 * Paperclip imports. Frontmatter parsing is a small hand-rolled subset of
 * YAML (scalars + one-level string lists) rather than a new dependency —
 * the workspace ships no YAML parser today (checked: no `yaml`/`js-yaml`/
 * `gray-matter` in any package.json or the lockfile) and real vault
 * frontmatter (sampled from `10_Builds/`) only uses that subset: bare/quoted
 * scalars and `key:\n  - item` lists, some of which are quoted wikilinks
 * (`"[[Note Name]]"`). Nested maps are NOT supported and are left as the
 * raw string value.
 */

import { createHash } from "node:crypto";

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface SourceIndexRecord {
  /** Vault-relative or absolute path, as supplied by the caller (kept as-is — the caller decides). */
  path: string;
  /** sha256 of the full raw file content, hex-encoded. */
  contentHash: string;
  /** ISO-8601 timestamp of the file's last modification (from fs stat). */
  modifiedAt: string;
  /** Parsed YAML frontmatter block, or null if the file has none / it failed to parse. */
  frontmatter: Frontmatter | null;
  /** Outbound `[[wikilink]]` targets (note names, deduped, first-seen order). Alias piped/anchor text stripped. */
  wikilinks: string[];
  /** frontmatter.description if present, else the first non-empty body paragraph (trimmed, capped). Null if neither exists. */
  summary: string | null;
  /** Extraction-confidence score in [0, 1] — see computeConfidence(). */
  confidence: number;
  /** ISO-8601 timestamp of when this record was produced. */
  lastIndexedAt: string;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal YAML subset)
// ---------------------------------------------------------------------------

export interface ParsedNote {
  frontmatter: Frontmatter | null;
  /** Content with the frontmatter block stripped (or the full content if there was none). */
  body: string;
}

/**
 * Strips a leading `---\n...\n---` block and parses it as a flat map of
 * scalars and one-level string lists. Any parse failure (malformed block)
 * yields `frontmatter: null` rather than throwing — a single bad note must
 * not crash a vault-wide scan.
 */
export function parseFrontmatter(content: string): ParsedNote {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  const block = match[1] ?? "";
  const body = content.slice(match[0].length);

  try {
    const frontmatter = parseFlatYamlBlock(block);
    return { frontmatter, body };
  } catch {
    return { frontmatter: null, body: content };
  }
}

function parseFlatYamlBlock(block: string): Frontmatter {
  const lines = block.split(/\r?\n/);
  const result: Frontmatter = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const flushList = () => {
    if (currentKey && currentList) {
      result[currentKey] = currentList;
    }
    currentKey = null;
    currentList = null;
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === "") continue;

    const listItemMatch = /^\s*-\s*(.*)$/.exec(rawLine);
    if (listItemMatch && currentList !== null) {
      currentList.push(unquote(listItemMatch[1]!.trim()));
      continue;
    }

    const kvMatch = /^([^\s:][^:]*):\s*(.*)$/.exec(rawLine);
    if (!kvMatch) continue; // skip lines we don't understand rather than throw

    flushList();
    const key = kvMatch[1]!.trim();
    const rest = kvMatch[2]!.trim();

    if (rest === "") {
      // Could be the start of a list on following lines, or an empty scalar.
      currentKey = key;
      currentList = [];
    } else {
      result[key] = unquote(rest);
    }
  }
  flushList();

  return result;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/** Outbound `[[wikilink]]` targets, deduped, first-seen order preserved. */
export function extractWikilinks(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const name = m[1]!.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function firstParagraph(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed === "") continue;
      started = true;
    } else if (trimmed === "") {
      break; // blank line ends the paragraph
    }
    // Strip a leading heading marker / blockquote marker so summaries read as prose.
    collected.push(trimmed.replace(/^#+\s*/, "").replace(/^>\s*/, ""));
  }
  if (collected.length === 0) return null;
  const joined = collected.join(" ").trim();
  if (joined.length === 0) return null;
  return joined.length > MAX_SUMMARY_LENGTH ? `${joined.slice(0, MAX_SUMMARY_LENGTH)}…` : joined;
}

export function extractSummary(frontmatter: Frontmatter | null, body: string): string | null {
  const description = frontmatter?.description;
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim();
  }
  return firstParagraph(body);
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Extraction-confidence heuristic (this module's own scale — distinct from
 * T-2.3's note-to-project association confidence):
 *   1.0  — frontmatter parsed AND an explicit `description` was used as summary.
 *   0.8  — frontmatter parsed, but summary fell back to the first paragraph.
 *   0.6  — no frontmatter block at all; summary (if any) is first-paragraph.
 *   0.3  — nothing usable extracted (no frontmatter, no summary text).
 */
export function computeConfidence(
  frontmatter: Frontmatter | null,
  summary: string | null,
  usedDescription: boolean,
): number {
  if (summary === null) return 0.3;
  if (frontmatter !== null && usedDescription) return 1.0;
  if (frontmatter !== null) return 0.8;
  return 0.6;
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

export function buildIndexRecord(
  path: string,
  content: string,
  modifiedAt: string,
  now: Date = new Date(),
): SourceIndexRecord {
  const { frontmatter, body } = parseFrontmatter(content);
  const description = frontmatter?.description;
  const usedDescription = typeof description === "string" && description.trim().length > 0;
  const summary = extractSummary(frontmatter, body);
  const wikilinks = extractWikilinks(content);
  const confidence = computeConfidence(frontmatter, summary, usedDescription);

  return {
    path,
    contentHash: hashContent(content),
    modifiedAt,
    frontmatter,
    wikilinks,
    summary,
    confidence,
    lastIndexedAt: now.toISOString(),
  };
}
