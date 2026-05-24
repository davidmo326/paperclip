/**
 * Obsidian-side brief writer — T-3.6.
 *
 * Writes a rendered Markdown brief to the principal's Obsidian vault,
 * idempotently: if the target file exists with byte-identical content,
 * the writer **does not touch the file at all** — no mtime bump, no
 * write syscall, no diff. This prevents:
 *
 *   - Obsidian's file-watcher firing for nothing
 *   - iCloud/Syncthing/Dropbox uploading an unchanged file
 *   - The principal seeing spurious "modified today" timestamps
 *
 * Atomic-rename for non-empty writes: writes to a tmp sibling first then
 * renames to the target, so a crashed process can't leave a half-written
 * brief.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ObsidianBriefWriteResult {
  /** Absolute path of the brief file (existed or written). */
  path: string;
  /** What happened: `wrote` (created or overwrote), `unchanged` (skipped). */
  kind: "wrote" | "unchanged";
  /** Bytes written / would have been written. */
  byteLength: number;
}

export interface WriteObsidianBriefOptions {
  /**
   * Base directory under the vault where daily briefs live. The writer
   * creates the directory if it doesn't exist.
   *
   * Default: `<vaultRoot>/00_Daily` per PRD § 13.1 + PLAN T-3.3.
   */
  baseDir: string;
  /** Date string in YYYY-MM-DD form. Used as the filename suffix. */
  briefDate: string;
  /** Filename prefix. Default `Daily Brief - `. */
  filenamePrefix?: string;
}

/**
 * Idempotent write. Returns `unchanged` when the file already exists with
 * byte-identical content, `wrote` otherwise.
 */
export async function writeObsidianBrief(
  markdown: string,
  options: WriteObsidianBriefOptions,
): Promise<ObsidianBriefWriteResult> {
  const prefix = options.filenamePrefix ?? "Daily Brief - ";
  const filename = `${prefix}${options.briefDate}.md`;
  const targetPath = path.join(options.baseDir, filename);
  const byteLength = Buffer.byteLength(markdown, "utf8");

  // Fast path: file exists + bytes match → no-op.
  try {
    const existing = await readFile(targetPath, "utf8");
    if (existing === markdown) {
      return { path: targetPath, kind: "unchanged", byteLength };
    }
  } catch (err) {
    if (!isMissingFile(err)) throw err;
  }

  // Ensure directory exists, then atomic-rename write.
  await mkdir(options.baseDir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, markdown, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup; rename succeeded then this won't error.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return { path: targetPath, kind: "wrote", byteLength };
}

/**
 * Returns the absolute path the writer would target for a given date.
 * Useful for callers that want to check existence before calling write.
 */
export function obsidianBriefPath(options: WriteObsidianBriefOptions): string {
  const prefix = options.filenamePrefix ?? "Daily Brief - ";
  return path.join(options.baseDir, `${prefix}${options.briefDate}.md`);
}

/**
 * True iff a brief file already exists for the given date. Read-only check;
 * does not touch the file.
 */
export async function obsidianBriefExists(options: WriteObsidianBriefOptions): Promise<boolean> {
  try {
    const s = await stat(obsidianBriefPath(options));
    return s.isFile();
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
