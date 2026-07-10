/**
 * Real-filesystem deps for the value-anchor loader — T-2.4.
 *
 * Walks the vault recursively for markdown files, skipping dot-directories
 * (`.obsidian`, `.trash`, `.git`, …) — those are Obsidian/sync internals,
 * never registry-resolvable notes.
 *
 * The walk itself lives in `../vault-walk.js` — extracted (T-2.2) so the
 * source indexer can reuse the exact same exclusions without duplicating
 * this logic.
 */

import { readFile } from "node:fs/promises";
import type { ValueAnchorLoaderDeps } from "./loader.js";
import { walkMarkdownFiles } from "../vault-walk.js";

export function createVaultLoaderDeps(vaultRoot: string): ValueAnchorLoaderDeps {
  return {
    vaultRoot,
    readFile: (absPath) => readFile(absPath, "utf8"),
    listMarkdownFiles: () => walkMarkdownFiles(vaultRoot),
  };
}
