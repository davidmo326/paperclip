/**
 * Real-filesystem deps for note association — T-2.3.
 *
 * Reads two files, both READ-ONLY (this module never writes either):
 *   - `portfolio-seed.json` (T-0.4) -> ProjectDef[] via project-directory.ts
 *   - `_pacc_overrides.json` (PLAN v3 amendment: NOT `_pacp_overrides.json`)
 *     -> path -> project-slug override map. Missing file is NOT an error
 *     (no overrides authored yet is the common case); malformed JSON is
 *     logged and treated as empty rather than crashing the association run.
 *
 * This file IS the filesystem boundary for T-2.3; associator-core.ts /
 * associate.ts / project-directory.ts stay pure per docs/substrate-firewall.md.
 */

import { readFile } from "node:fs/promises";
import { buildProjectDirectory, type PortfolioSeedEntry, type ProjectDef } from "./project-directory.js";

export interface NoteAssociationFsDeps {
  loadProjects(seedPath: string, vaultRoot: string): Promise<ProjectDef[]>;
  loadOverrides(overridesPath: string): Promise<Record<string, string>>;
}

interface RawSeedEntry {
  slug?: unknown;
  name?: unknown;
  obsidianFolder?: unknown;
  visionRefs?: unknown;
  spineNotes?: unknown;
}

function coercePortfolioSeedEntry(raw: RawSeedEntry): PortfolioSeedEntry | null {
  if (typeof raw.slug !== "string" || typeof raw.name !== "string") return null;
  return {
    slug: raw.slug,
    name: raw.name,
    obsidianFolder: typeof raw.obsidianFolder === "string" ? raw.obsidianFolder : null,
    visionRefs: Array.isArray(raw.visionRefs) ? raw.visionRefs.filter((v): v is string => typeof v === "string") : [],
    // T-6.7: strategy-ground fragments; absent in pre-T-6.7 seeds → [].
    spineNotes: Array.isArray(raw.spineNotes)
      ? raw.spineNotes.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
  };
}

export function createNoteAssociationFsDeps(logger?: {
  warn(msg: string, fields?: Record<string, unknown>): void;
}): NoteAssociationFsDeps {
  return {
    async loadProjects(seedPath, vaultRoot) {
      let raw: string;
      try {
        raw = await readFile(seedPath, "utf8");
      } catch (err) {
        logger?.warn("note-association: could not read portfolio-seed.json; project directory is empty", {
          seedPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        logger?.warn("note-association: portfolio-seed.json is not valid JSON; project directory is empty", {
          seedPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const entries = parsed
        .map((rawEntry) => coercePortfolioSeedEntry(rawEntry as RawSeedEntry))
        .filter((e): e is PortfolioSeedEntry => e !== null);
      return buildProjectDirectory(entries, vaultRoot);
    },

    async loadOverrides(overridesPath) {
      let raw: string;
      try {
        raw = await readFile(overridesPath, "utf8");
      } catch {
        // No overrides file authored yet — the common case, not an error.
        return {};
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [path, slug] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof slug === "string") out[path] = slug;
        }
        return out;
      } catch (err) {
        logger?.warn("note-association: _pacc_overrides.json is not valid JSON; ignoring overrides", {
          overridesPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return {};
      }
    },
  };
}
