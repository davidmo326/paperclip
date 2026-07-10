/**
 * Real-filesystem deps for the source indexer — T-2.2.
 *
 * Reuses the shared vault-walk (same dot-directory exclusions as T-2.4's
 * registry loader). This module IS the filesystem boundary; everything in
 * indexer.ts / index-core.ts stays pure.
 */

import { readFile, stat } from "node:fs/promises";
import { walkMarkdownFiles } from "../vault-walk.js";
import type { SourceIndexerFs } from "./indexer.js";

export function createSourceIndexerFs(vaultRoot: string): SourceIndexerFs {
  return {
    listMarkdownFiles: () => walkMarkdownFiles(vaultRoot),
    readFile: (absPath) => readFile(absPath, "utf8"),
    async statModifiedAt(absPath) {
      const s = await stat(absPath);
      return s.mtime.toISOString();
    },
  };
}
