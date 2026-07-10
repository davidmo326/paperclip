/**
 * Source indexer — T-2.2 (PRD § 9.2).
 *
 * Two entry surfaces:
 *
 *   1. `runInitialScan` — full-vault scan on startup / on demand. Walks every
 *      `.md` file (dot-dirs excluded via the shared vault-walk), indexes each,
 *      and checkpoints progress (`last_scanned_path`) after every file so a
 *      restart resumes without re-reading already-indexed files. Scan order
 *      is the sorted path list, which is what makes the checkpoint a valid
 *      resume point.
 *
 *   2. `applyNoteChanged` / `applyNoteRenamed` / `applyNoteDeleted` — the
 *      event-consumption surface T-2.1's watcher calls. Designed against the
 *      T-2.1 payload shapes (`source.note.changed {path, hash, modifiedAt}`,
 *      `source.note.renamed {oldPath, newPath, hash}`, `source.note.deleted
 *      {path}`) but deliberately NOT importing from obsidian-watcher.ts —
 *      T-2.1 is built in parallel and wires itself to these functions.
 *
 * Records are stored under vault-relative paths (portable across vault
 * moves, stable event identity); all three apply* functions accept either
 * absolute or vault-relative paths and normalize.
 *
 * Tier-agnostic by design (PLAN v3 amendment): no M1a/M1b field anywhere in
 * this module — consumers join tier at query time against T-2.4's registry.
 *
 * Pure domain logic per docs/substrate-firewall.md: filesystem + store are
 * injected; no Paperclip imports.
 */

import path from "node:path";
import { buildIndexRecord, type SourceIndexRecord } from "./index-core.js";
import type { SourceIndexStore } from "./store.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SourceIndexerFs {
  /** Absolute paths of every markdown file in the vault (dot-dirs excluded). */
  listMarkdownFiles(): Promise<string[]>;
  readFile(absPath: string): Promise<string>;
  /** File mtime as ISO-8601. */
  statModifiedAt(absPath: string): Promise<string>;
}

export interface SourceIndexerDeps {
  /** Absolute path of the vault root. */
  vaultRoot: string;
  fs: SourceIndexerFs;
  store: SourceIndexStore;
  logger?: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
  };
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/** Vault-relative form of `p` (absolute or already-relative). */
export function toVaultRelative(vaultRoot: string, p: string): string {
  if (!path.isAbsolute(p)) return path.normalize(p);
  return path.relative(vaultRoot, p);
}

function toAbsolute(vaultRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(vaultRoot, p);
}

// ---------------------------------------------------------------------------
// Single-note indexing (shared by scan + change events)
// ---------------------------------------------------------------------------

async function indexOne(
  deps: SourceIndexerDeps,
  relPath: string,
): Promise<SourceIndexRecord> {
  const absPath = toAbsolute(deps.vaultRoot, relPath);
  const [content, modifiedAt] = await Promise.all([
    deps.fs.readFile(absPath),
    deps.fs.statModifiedAt(absPath),
  ]);
  const record = buildIndexRecord(relPath, content, modifiedAt, deps.now?.() ?? new Date());
  await deps.store.put(record);
  return record;
}

// ---------------------------------------------------------------------------
// Initial full-vault scan (interruptible / resumable)
// ---------------------------------------------------------------------------

export interface InitialScanOptions {
  /**
   * Cooperative-stop hook, checked before each file. Returning false stops
   * the scan cleanly with the checkpoint intact — this is also how tests
   * simulate a mid-scan kill.
   */
  shouldContinue?: () => boolean;
}

export interface InitialScanResult {
  /** True when every file was processed and the checkpoint was cleared. */
  completed: boolean;
  /** Files indexed in THIS run (resumed runs exclude previously-scanned files). */
  filesIndexed: number;
  /** Files skipped because the checkpoint says a previous run already indexed them. */
  filesSkipped: number;
  /** Files that failed to read/index (logged, scan continues). */
  filesFailed: number;
  totalFiles: number;
  /** True when this run resumed from an existing checkpoint. */
  resumed: boolean;
  wallClockMs: number;
}

export async function runInitialScan(
  deps: SourceIndexerDeps,
  options: InitialScanOptions = {},
): Promise<InitialScanResult> {
  const startedMs = Date.now();
  const shouldContinue = options.shouldContinue ?? (() => true);

  const absPaths = await deps.fs.listMarkdownFiles();
  const relPaths = absPaths.map((p) => toVaultRelative(deps.vaultRoot, p)).sort();

  const checkpoint = await deps.store.getCheckpoint();
  const resumed = checkpoint !== null;
  const resumeAfter = checkpoint?.lastScannedPath ?? null;
  const startedAt = checkpoint?.startedAt ?? (deps.now?.() ?? new Date()).toISOString();

  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesFailed = 0;

  for (const relPath of relPaths) {
    // Resume: everything at-or-before the checkpoint was indexed by a
    // previous run — skip without reading.
    if (resumeAfter !== null && relPath <= resumeAfter) {
      filesSkipped += 1;
      continue;
    }

    if (!shouldContinue()) {
      const wallClockMs = Date.now() - startedMs;
      deps.logger?.info("source-index scan stopped mid-run; checkpoint retained", {
        filesIndexed,
        filesSkipped,
        totalFiles: relPaths.length,
      });
      return {
        completed: false,
        filesIndexed,
        filesSkipped,
        filesFailed,
        totalFiles: relPaths.length,
        resumed,
        wallClockMs,
      };
    }

    try {
      await indexOne(deps, relPath);
      filesIndexed += 1;
    } catch (err) {
      filesFailed += 1;
      deps.logger?.warn("source-index scan: failed to index file", {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
      // A failed file still advances the checkpoint — retrying it on every
      // resume would wedge the scan on a permanently unreadable file.
    }

    await deps.store.setCheckpoint({
      lastScannedPath: relPath,
      startedAt,
      filesIndexed: (checkpoint?.filesIndexed ?? 0) + filesIndexed,
    });
  }

  await deps.store.clearCheckpoint();
  const wallClockMs = Date.now() - startedMs;
  deps.logger?.info("source-index scan complete", {
    filesIndexed,
    filesSkipped,
    filesFailed,
    totalFiles: relPaths.length,
    resumed,
    wallClockMs,
  });
  return {
    completed: true,
    filesIndexed,
    filesSkipped,
    filesFailed,
    totalFiles: relPaths.length,
    resumed,
    wallClockMs,
  };
}

// ---------------------------------------------------------------------------
// Event-consumption surface (T-2.1 watcher calls these)
// ---------------------------------------------------------------------------

/**
 * `source.note.changed { path, hash, modifiedAt }` — re-reads the file and
 * replaces its index record. The event's own hash/modifiedAt are advisory;
 * the file is re-read so the record always reflects what's actually on disk
 * (torn-write debouncing is the watcher's job).
 */
export async function applyNoteChanged(
  deps: SourceIndexerDeps,
  event: { path: string },
): Promise<SourceIndexRecord> {
  const relPath = toVaultRelative(deps.vaultRoot, event.path);
  return indexOne(deps, relPath);
}

/**
 * `source.note.renamed { oldPath, newPath, hash }` — moves the record:
 * old key removed, new key present, content hash preserved (no re-read).
 * If oldPath was never indexed (e.g. rename raced the initial scan), falls
 * back to indexing newPath from disk.
 */
export async function applyNoteRenamed(
  deps: SourceIndexerDeps,
  event: { oldPath: string; newPath: string },
): Promise<SourceIndexRecord> {
  const relOld = toVaultRelative(deps.vaultRoot, event.oldPath);
  const relNew = toVaultRelative(deps.vaultRoot, event.newPath);
  const moved = await deps.store.rename(relOld, relNew);
  if (moved) return moved;
  deps.logger?.warn("source-index rename: oldPath not indexed; indexing newPath from disk", {
    oldPath: relOld,
    newPath: relNew,
  });
  return indexOne(deps, relNew);
}

/** `source.note.deleted { path }` — removes the record and catalog entry. */
export async function applyNoteDeleted(
  deps: SourceIndexerDeps,
  event: { path: string },
): Promise<void> {
  const relPath = toVaultRelative(deps.vaultRoot, event.path);
  await deps.store.remove(relPath);
}
