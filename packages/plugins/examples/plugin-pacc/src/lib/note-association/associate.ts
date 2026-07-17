/**
 * Note-association orchestration — T-2.3.
 *
 * Input is T-2.2's source-index records, not the vault: this module never
 * walks the filesystem, it reads whatever `SourceIndexReader` port the
 * caller supplies (the real one is T-2.2's `SourceIndexStore`, but tests
 * supply fixtures directly).
 *
 * Pure domain logic per docs/substrate-firewall.md: filesystem, overrides
 * file, and portfolio-seed.json are all read by fs-deps.ts / worker-deps.ts
 * before calling in here — this module receives already-parsed data.
 */

import { computeAssociation, type AssociationRecord } from "./associator-core.js";
import type { ProjectDef } from "./project-directory.js";
import type { NoteAssociationStore } from "./store.js";

/** The subset of T-2.2's SourceIndexStore this module needs. */
export interface SourceIndexReader {
  listPathsAndHashes(): Promise<Record<string, string>>;
  getByPath(path: string): Promise<{
    path: string;
    frontmatter: Record<string, string | string[]> | null;
    wikilinks: string[];
  } | null>;
}

/**
 * Normalised note tags (T-2.3-tag) from frontmatter `tags`. Obsidian permits
 * a YAML list (`tags:\n  - x`), a scalar (`tags: x`), or an inline bracket
 * form (`tags: [x, y]`); the source-index's flat-YAML parser handles the list
 * and scalar but leaves inline brackets as a literal string, so split those
 * here. Lowercased + trimmed to match `ProjectDef.matchTags`.
 *
 * Inline body `#tag`s are NOT captured here — the stored source-index record
 * has no body. Surfacing those needs a source-index change (persist body or
 * extract hashtags at index time); filed as a deferred follow-up.
 */
export function extractNoteTags(frontmatter: Record<string, string | string[]> | null): string[] {
  const raw = frontmatter?.tags;
  if (raw == null) return [];
  const asList: string[] = Array.isArray(raw)
    ? raw
    : String(raw)
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((part) => part.trim());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of asList) {
    const normalised = tag.toLowerCase().trim();
    if (normalised.length === 0 || seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

export interface NoteAssociationDeps {
  sourceIndex: SourceIndexReader;
  store: NoteAssociationStore;
  projects: ProjectDef[];
  /** Manual override map: vault-relative path -> project slug. */
  overrides: Record<string, string>;
  now?: () => Date;
  logger?: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
  };
}

export interface AssociationRunResult {
  notesProcessed: number;
  associatedCount: number;
  unassociatedCount: number;
  byMethod: Record<string, number>;
}

/** Recomputes and stores associations for every note in the source index. */
export async function runAssociation(deps: NoteAssociationDeps): Promise<AssociationRunResult> {
  const now = deps.now?.() ?? new Date();
  const catalog = await deps.sourceIndex.listPathsAndHashes();
  const paths = Object.keys(catalog).sort();

  let associatedCount = 0;
  let unassociatedCount = 0;
  const byMethod: Record<string, number> = {};

  for (const path of paths) {
    const indexed = await deps.sourceIndex.getByPath(path);
    if (!indexed) {
      deps.logger?.warn("note-association: source-index catalog entry has no record; skipping", { path });
      continue;
    }
    const record = computeAssociation(
      { path: indexed.path, frontmatter: indexed.frontmatter, wikilinks: indexed.wikilinks, tags: extractNoteTags(indexed.frontmatter) },
      deps.projects,
      deps.overrides,
      now,
    );
    await deps.store.put(record);
    byMethod[record.method] = (byMethod[record.method] ?? 0) + 1;
    if (record.projectId === null) unassociatedCount++;
    else associatedCount++;
  }

  deps.logger?.info("note-association run complete", {
    notesProcessed: paths.length,
    associatedCount,
    unassociatedCount,
  });

  return { notesProcessed: paths.length, associatedCount, unassociatedCount, byMethod };
}

/** Recomputes and stores the association for a single note (e.g. after a source-index update). */
export async function applyNoteAssociation(
  deps: NoteAssociationDeps,
  path: string,
): Promise<AssociationRecord | null> {
  const indexed = await deps.sourceIndex.getByPath(path);
  if (!indexed) return null;
  const record = computeAssociation(
    { path: indexed.path, frontmatter: indexed.frontmatter, wikilinks: indexed.wikilinks, tags: extractNoteTags(indexed.frontmatter) },
    deps.projects,
    deps.overrides,
    deps.now?.() ?? new Date(),
  );
  await deps.store.put(record);
  return record;
}
