/**
 * Shared vault-walk helper — extracted from T-2.4's `value-anchor/fs-deps.ts`
 * so T-2.2's source indexer doesn't duplicate the same recursive-walk +
 * dot-directory exclusion logic (PLAN T-2.2 "Read first" item 3).
 *
 * Excludes any directory whose name starts with `.` (`.obsidian`, `.trash`,
 * `.git`, sync-tool dirs, …) — those are Obsidian/sync internals, never
 * content notes. Unreadable directories are skipped rather than aborting
 * the whole walk.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { isPromptDeniedPath } from "./prompt-scrub.js";

/**
 * Recursively lists every `.md` file under `root` (absolute paths),
 * skipping dot-directories. Order is not guaranteed — callers that need
 * determinism (e.g. resumable scans) should sort the result themselves.
 */
export async function walkMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await walk(root, results);
  return results;
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
    // Data policy (2026-10-07): never index Secrets/ (or *.env / *.key), so
    // nothing there can reach a summary, a card or a model prompt.
    if (entry.isDirectory() && entry.name.toLowerCase() === "secrets") continue;
    if (entry.isFile() && isPromptDeniedPath(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}
