/**
 * Value-anchor registry loader — T-2.4.
 *
 * The principal-authored `[[Value Anchors]]` note (vault root, T-0.7) is the
 * M1b registry: every `- [[wikilink]] — purpose` line in its `## Registry`
 * section marks a note as a value anchor — read-only to all agents, citable
 * as alignment criterion (PRD § 9.6).
 *
 * Parsing rules (PLAN v3 amendment, 2026-07-09):
 *   - ONLY the `## Registry` section is parsed. Wikilinks in "How to use
 *     this note" / "Notes for future-me" are prose, not registrations.
 *   - Wikilinks resolve vault-wide by note basename — anchor notes do not
 *     need to live in any particular folder.
 *   - An unresolvable wikilink is a warning, never a crash: the registry
 *     names what SHOULD be protected; a missing file must not take down
 *     the morning sweep. (The write-mediator only needs resolved paths —
 *     a note that doesn't exist can't be overwritten.)
 *
 * Pure domain logic per docs/substrate-firewall.md: filesystem access is
 * injected, no Paperclip imports.
 */

import { createHash } from "node:crypto";
import path from "node:path";

export interface ValueAnchor {
  /** Note name exactly as written inside the wikilink. */
  name: string;
  /** Purpose text after the dash on the registry line ("" if absent). */
  purpose: string;
  /** Absolute path of the resolved note, or null if unresolved. */
  path: string | null;
  resolved: boolean;
}

export interface ValueAnchorLoaderDeps {
  /** Absolute path of the vault root. */
  vaultRoot: string;
  /** Registry note path relative to vaultRoot. Default: "Value Anchors.md". */
  registryRelPath?: string;
  readFile(absPath: string): Promise<string>;
  /** Absolute paths of every markdown file in the vault. */
  listMarkdownFiles(): Promise<string[]>;
}

export interface ValueAnchorLoadResult {
  anchors: ValueAnchor[];
  warnings: string[];
  /**
   * Absolute path of the registry note actually used (null if not found).
   * The mediator protects THIS path — never a hardcoded guess.
   */
  registryPath: string | null;
}

const REGISTRY_HEADING = "registry";
/** `- [[Note Name]] — purpose` (dash variants: — – -; purpose optional). */
const REGISTRY_LINE = /^-\s*\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]\s*(?:[—–-]\s*(.*))?$/;

export async function loadValueAnchors(
  deps: ValueAnchorLoaderDeps,
): Promise<ValueAnchorLoadResult> {
  const warnings: string[] = [];
  const files = await deps.listMarkdownFiles();

  // basename (lowercased, no extension) → absolute paths
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    const key = path.basename(file, path.extname(file)).toLowerCase();
    const existing = byBasename.get(key);
    if (existing) existing.push(file);
    else byBasename.set(key, [file]);
  }

  // Registry discovery: explicit path first, then vault-wide by basename —
  // T-0.7 placed the real note under 10_Builds/, not the vault root, and
  // the principal may move it again. Shortest path wins for determinism.
  const explicitPath = path.join(deps.vaultRoot, deps.registryRelPath ?? "Value Anchors.md");
  const registryBasename = path
    .basename(deps.registryRelPath ?? "Value Anchors.md", ".md")
    .toLowerCase();
  const discovered = (byBasename.get(registryBasename) ?? [])
    .slice()
    .sort((a, b) => a.length - b.length);
  const candidates = [explicitPath, ...discovered.filter((p) => p !== explicitPath)];

  let registryContent: string | null = null;
  let registryPath: string | null = null;
  for (const candidate of candidates) {
    try {
      registryContent = await deps.readFile(candidate);
      registryPath = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
  if (registryContent === null || registryPath === null) {
    return {
      anchors: [],
      warnings: [`value-anchor registry note not found at ${explicitPath} or anywhere in the vault; M1b set is empty`],
      registryPath: null,
    };
  }

  const registrySection = extractSection(registryContent, REGISTRY_HEADING);
  if (registrySection === null) {
    return {
      anchors: [],
      warnings: [`registry note at ${registryPath} has no "## Registry" section; M1b set is empty`],
      registryPath,
    };
  }

  const anchors: ValueAnchor[] = [];
  for (const line of registrySection.split("\n")) {
    const match = REGISTRY_LINE.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    const purpose = (match[2] ?? "").trim();
    const candidates = byBasename.get(name.toLowerCase()) ?? [];
    if (candidates.length === 0) {
      warnings.push(`registry lists [[${name}]] but no matching note exists in the vault`);
      anchors.push({ name, purpose, path: null, resolved: false });
      continue;
    }
    if (candidates.length > 1) {
      warnings.push(
        `registry entry [[${name}]] matches ${candidates.length} notes; using ${candidates[0]}`,
      );
    }
    anchors.push({ name, purpose, path: candidates[0]!, resolved: true });
  }

  return { anchors, warnings, registryPath };
}

/**
 * § 9.6 citation: `[[Note]] § Section @ hash8` (format pinned in
 * ControlPlane/docs/value-anchor-citation-format.md). The hash covers the
 * section body — everything between the heading and the next
 * equal-or-higher heading — trimmed, so edits to OTHER sections don't
 * invalidate this citation.
 */
export function valueAnchorCite(
  noteName: string,
  noteContent: string,
  sectionHeading: string,
): string {
  const body = extractSection(noteContent, sectionHeading, { caseSensitive: true });
  if (body === null) {
    throw new Error(
      `section "${sectionHeading}" not found in note "${noteName}" — cannot cite`,
    );
  }
  const hash8 = createHash("sha256").update(body.trim(), "utf8").digest("hex").slice(0, 8);
  return `[[${noteName}]] § ${sectionHeading} @ ${hash8}`;
}

/**
 * Returns the body of the first heading whose text matches, or null.
 * Body = lines after the heading up to the next heading of equal or
 * higher level.
 */
function extractSection(
  content: string,
  headingText: string,
  opts: { caseSensitive?: boolean } = {},
): string | null {
  const lines = content.split("\n");
  const wanted = opts.caseSensitive ? headingText.trim() : headingText.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#+)\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const text = opts.caseSensitive ? m[2]!.trim() : m[2]!.trim().toLowerCase();
    if (start === -1) {
      if (text === wanted) {
        start = i + 1;
        level = m[1]!.length;
      }
    } else if (m[1]!.length <= level) {
      return lines.slice(start, i).join("\n");
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}
