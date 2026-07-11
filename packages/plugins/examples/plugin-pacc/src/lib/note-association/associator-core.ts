/**
 * Note-to-project association — pure core (T-2.3, PLAN + v3 amendment).
 *
 * Confidence formula, exactly as spec'd (highest applicable rule wins;
 * checked in this fixed order since the rule confidences are already
 * strictly descending):
 *   1. Explicit frontmatter `project: <slug>` -> 1.0
 *   2. Path prefix `10_Builds/<Project folder>/...` -> 0.85
 *   3. Wikilink FROM this note TO a known project hub note, 1 hop -> 0.6
 *      ("hub note" = one of the project's `visionRefs`, see
 *      project-directory.ts)
 *   4. Title fuzzy match (Jaro-Winkler >= 0.9 against the project's name
 *      or slug) -> 0.4
 *   No match -> `projectId: null` (unassociated bucket).
 *
 * The manual override file (`_pacc_overrides.json`) beats every heuristic
 * above, INCLUDING frontmatter's 1.0 — it is read and applied by the
 * caller (associate.ts), not this module, but is checked first here too so
 * a single call site (computeAssociation) is the one source of truth for
 * precedence.
 *
 * Pure domain logic per docs/substrate-firewall.md: no filesystem, no
 * Paperclip imports. Takes an already-built ProjectDef[] and an
 * already-parsed overrides map.
 */

import { jaroWinklerSimilarity } from "./jaro-winkler.js";
import type { ProjectDef } from "./project-directory.js";

export type AssociationMethod =
  | "override"
  | "frontmatter"
  | "path-prefix"
  | "wikilink-hub"
  | "title-fuzzy"
  | "none";

export interface AssociationRecord {
  /** Vault-relative path of the associated note. */
  path: string;
  /** Project slug, or null for the unassociated bucket. */
  projectId: string | null;
  confidence: number;
  method: AssociationMethod;
  /** ISO-8601 timestamp of when this association was computed. */
  associatedAt: string;
}

/** The subset of a source-index record this module needs. */
export interface AssociationNoteInput {
  /** Vault-relative path. */
  path: string;
  frontmatter: Record<string, string | string[]> | null;
  /** Outbound `[[wikilink]]` targets, as extracted by source-index. */
  wikilinks: string[];
}

const TITLE_FUZZY_THRESHOLD = 0.9;

/** Note title: basename without extension. */
export function titleFromPath(notePath: string): string {
  const base = notePath.split("/").pop() ?? notePath;
  return base.replace(/\.md$/i, "");
}

function normalizedFolderMatch(notePath: string, folderRelPath: string): boolean {
  const normalizedFolder = folderRelPath.replace(/\/+$/, "");
  return notePath === normalizedFolder || notePath.startsWith(`${normalizedFolder}/`);
}

export function computeAssociation(
  note: AssociationNoteInput,
  projects: ProjectDef[],
  overrides: Record<string, string>,
  now: Date = new Date(),
): AssociationRecord {
  const associatedAt = now.toISOString();

  // 0. Manual override — beats every heuristic, including frontmatter's 1.0.
  const overrideSlug = overrides[note.path];
  if (typeof overrideSlug === "string" && overrideSlug.trim().length > 0) {
    return { path: note.path, projectId: overrideSlug.trim(), confidence: 1.0, method: "override", associatedAt };
  }

  // 1. Frontmatter `project: <slug>` -> 1.0
  const fmProject = note.frontmatter?.project;
  if (typeof fmProject === "string" && fmProject.trim().length > 0) {
    const slug = fmProject.trim();
    if (projects.some((p) => p.slug === slug)) {
      return { path: note.path, projectId: slug, confidence: 1.0, method: "frontmatter", associatedAt };
    }
  }

  // 2. Path prefix `10_Builds/<Project folder>/...` -> 0.85
  for (const project of projects) {
    if (project.folderRelPath && normalizedFolderMatch(note.path, project.folderRelPath)) {
      return { path: note.path, projectId: project.slug, confidence: 0.85, method: "path-prefix", associatedAt };
    }
  }

  // 3. Wikilink from this note to a known project hub note (1 hop) -> 0.6
  const lowerLinks = new Set(note.wikilinks.map((w) => w.toLowerCase()));
  for (const project of projects) {
    if (project.hubNoteNames.some((hub) => lowerLinks.has(hub.toLowerCase()))) {
      return { path: note.path, projectId: project.slug, confidence: 0.6, method: "wikilink-hub", associatedAt };
    }
  }

  // 4. Title fuzzy match (Jaro-Winkler >= 0.9) -> 0.4
  const title = titleFromPath(note.path).toLowerCase();
  let best: { slug: string; score: number } | null = null;
  for (const project of projects) {
    const score = Math.max(
      jaroWinklerSimilarity(title, project.name.toLowerCase()),
      jaroWinklerSimilarity(title, project.slug.toLowerCase()),
    );
    if (score >= TITLE_FUZZY_THRESHOLD && (best === null || score > best.score)) {
      best = { slug: project.slug, score };
    }
  }
  if (best) {
    return { path: note.path, projectId: best.slug, confidence: 0.4, method: "title-fuzzy", associatedAt };
  }

  // No match -> unassociated bucket.
  return { path: note.path, projectId: null, confidence: 0, method: "none", associatedAt };
}
