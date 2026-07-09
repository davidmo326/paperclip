/**
 * Real-filesystem deps for the value-anchor loader — T-2.4.
 *
 * Walks the vault recursively for markdown files, skipping dot-directories
 * (`.obsidian`, `.trash`, `.git`, …) — those are Obsidian/sync internals,
 * never registry-resolvable notes.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ValueAnchorLoaderDeps } from "./loader.js";

export function createVaultLoaderDeps(vaultRoot: string): ValueAnchorLoaderDeps {
  return {
    vaultRoot,
    readFile: (absPath) => readFile(absPath, "utf8"),
    async listMarkdownFiles() {
      const results: string[] = [];
      await walk(vaultRoot, results);
      return results;
    },
  };
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip rather than kill the sweep
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}
