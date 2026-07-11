/**
 * Project directory — T-2.3's slug/folder/hub-note lookup, derived from
 * `portfolio-seed.json` (T-0.4).
 *
 * Pure domain logic per docs/substrate-firewall.md: this module accepts
 * already-parsed seed entries plus the vault root string, and never touches
 * the filesystem itself — reading `portfolio-seed.json` off disk is
 * `fs-deps.ts`'s job.
 */

import path from "node:path";

/** The subset of a `portfolio-seed.json` entry this module needs. */
export interface PortfolioSeedEntry {
  slug: string;
  name: string;
  obsidianFolder: string | null;
  visionRefs: string[];
}

export interface ProjectDef {
  slug: string;
  name: string;
  /**
   * Vault-relative folder path (e.g. "10_Builds/Circlo"), forward-slash
   * normalized. Null when the seed entry has no `obsidianFolder` (e.g.
   * "storycrafter", which is repo-only).
   */
  folderRelPath: string | null;
  /**
   * Hub-note names exactly as they appear inside `[[wikilinks]]` — i.e.
   * `visionRefs` with the `[[` `]]` wrapper stripped. These are the notes
   * PLAN's rule 3 calls "a known project hub note": principal-curated
   * vision/strategy notes for the project (T-0.4's `visionRefs` field is
   * the closest existing signal for "this note anchors the project").
   */
  hubNoteNames: string[];
}

const WIKILINK_WRAPPER = /^\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]$/;

function stripWikilinkWrapper(ref: string): string {
  const match = WIKILINK_WRAPPER.exec(ref.trim());
  return match ? match[1]!.trim() : ref.trim();
}

/** Vault-relative, forward-slash-normalized form of an absolute path under vaultRoot. */
function toVaultRelative(vaultRoot: string, absPath: string): string {
  const rel = path.relative(vaultRoot, absPath);
  return rel.split(path.sep).join("/");
}

export function buildProjectDirectory(
  entries: PortfolioSeedEntry[],
  vaultRoot: string,
): ProjectDef[] {
  return entries.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    folderRelPath: entry.obsidianFolder ? toVaultRelative(vaultRoot, entry.obsidianFolder) : null,
    hubNoteNames: entry.visionRefs.map(stripWikilinkWrapper).filter((n) => n.length > 0),
  }));
}
