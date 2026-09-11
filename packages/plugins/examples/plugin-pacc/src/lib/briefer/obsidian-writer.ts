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
  /**
   * What happened: `wrote` (created or overwrote), `unchanged` (skipped,
   * byte-identical), `skipped_edited` (T-6.7b: the existing file carries
   * principal annotations in the Human Feedback footer and the new render
   * differs — regeneration would destroy them, so the write is refused;
   * delete the file to force a regeneration).
   */
  kind: "wrote" | "unchanged" | "skipped_edited";
  /** Bytes written / would have been written. */
  byteLength: number;
}

/**
 * True iff the Human Feedback footer of an existing brief has principal
 * content on any line. The unfilled footer is deterministic (`- Useful: ` …
 * with nothing after the colon), so any non-whitespace after a colon means
 * the principal wrote it.
 */
export function briefHasPrincipalEdits(existingMarkdown: string): boolean {
  const idx = existingMarkdown.indexOf("## Human Feedback");
  if (idx === -1) return false;
  const footer = existingMarkdown.slice(idx);
  return /^- (?:Useful|Wrong|Changed priority|Today's next action|Approved actions):[ \t]*\S/m.test(footer);
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
  /**
   * T-2.4 M1b mediator (`createObsidianFileWriter`). When provided, the
   * disk write is delegated to it — protection check, audit event, and the
   * idempotent atomic write all happen inside the mediator. When absent,
   * the legacy direct write below runs (the brief path is fixed-format
   * under 00_Daily, safe by construction).
   */
  guard?: (targetPath: string, content: string) => Promise<ObsidianBriefWriteResult>;
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

  // T-6.7b no-clobber guard, checked on both the guarded and legacy paths:
  // a differing render over an annotated brief is a Syncthing-conflict bomb
  // (the principal annotates the file; another device holds the last sync).
  try {
    const existing = await readFile(targetPath, "utf8");
    if (existing === markdown) {
      return { path: targetPath, kind: "unchanged", byteLength };
    }
    if (briefHasPrincipalEdits(existing)) {
      return { path: targetPath, kind: "skipped_edited", byteLength };
    }
  } catch (err) {
    if (!isMissingFile(err)) throw err;
  }

  if (options.guard) {
    return options.guard(targetPath, markdown);
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
