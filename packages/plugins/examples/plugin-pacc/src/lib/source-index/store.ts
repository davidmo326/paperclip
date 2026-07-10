/**
 * Source-index storage — T-2.2 (PLAN v2 storage decision + v3 amendment).
 *
 * plugin_state rows, NOT a core table:
 *   - one row per indexed file, keyed `source-index.v1:<sha256(path)>`
 *     (hashing the path gives a fixed-length, separator-free state key);
 *   - one catalog row (`source-index-catalog.v1`) mapping path → contentHash,
 *     because the plugin_state API has no list-by-prefix — the catalog is what
 *     makes list-all-paths+hashes (stale detection) and count() possible
 *     without key enumeration (same trick as T-3.10's kill-criterion map);
 *   - one scan-checkpoint row (`source-index-scan.v1`) so an interrupted
 *     initial scan resumes where it left off (see scan.ts).
 *
 * Pure domain logic per docs/substrate-firewall.md: persistence is injected
 * as a string-keyed KV port; the Paperclip `ctx.state` mapping lives in
 * worker-deps.ts.
 */

import { createHash } from "node:crypto";
import type { SourceIndexRecord } from "./index-core.js";

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

export const SOURCE_INDEX_RECORD_KEY_PREFIX = "source-index.v1:";
export const SOURCE_INDEX_CATALOG_KEY = "source-index-catalog.v1";
export const SOURCE_INDEX_SCAN_CHECKPOINT_KEY = "source-index-scan.v1";

/** Fixed-length, separator-free state key for a note path. */
export function recordKeyForPath(path: string): string {
  const pathHash = createHash("sha256").update(path, "utf8").digest("hex");
  return `${SOURCE_INDEX_RECORD_KEY_PREFIX}${pathHash}`;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Minimal string-keyed KV port over plugin_state (instance scope). */
export interface SourceIndexKv {
  get(stateKey: string): Promise<unknown>;
  set(stateKey: string, value: unknown): Promise<void>;
  delete(stateKey: string): Promise<void>;
}

/** path → contentHash for every indexed file. */
export type SourceIndexCatalog = Record<string, string>;

export interface ScanCheckpoint {
  /** Last path fully indexed by the in-flight initial scan (scan order = sorted paths). */
  lastScannedPath: string;
  startedAt: string;
  filesIndexed: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SourceIndexStore {
  getByPath(path: string): Promise<SourceIndexRecord | null>;
  put(record: SourceIndexRecord): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Moves a record from oldPath to newPath: old key removed, new key written
   * with `path` updated and everything else (hash included) preserved.
   * Returns the moved record, or null if oldPath wasn't indexed.
   */
  rename(oldPath: string, newPath: string): Promise<SourceIndexRecord | null>;
  /** Every indexed path + content hash — the stale-detection surface. */
  listPathsAndHashes(): Promise<SourceIndexCatalog>;
  count(): Promise<number>;
  getCheckpoint(): Promise<ScanCheckpoint | null>;
  setCheckpoint(checkpoint: ScanCheckpoint): Promise<void>;
  clearCheckpoint(): Promise<void>;
}

export function createSourceIndexStore(kv: SourceIndexKv): SourceIndexStore {
  const readCatalog = async (): Promise<SourceIndexCatalog> =>
    ((await kv.get(SOURCE_INDEX_CATALOG_KEY)) as SourceIndexCatalog | null) ?? {};

  return {
    async getByPath(path) {
      const v = await kv.get(recordKeyForPath(path));
      return (v as SourceIndexRecord | null) ?? null;
    },

    async put(record) {
      await kv.set(recordKeyForPath(record.path), record);
      const catalog = await readCatalog();
      catalog[record.path] = record.contentHash;
      await kv.set(SOURCE_INDEX_CATALOG_KEY, catalog);
    },

    async remove(path) {
      await kv.delete(recordKeyForPath(path));
      const catalog = await readCatalog();
      if (path in catalog) {
        delete catalog[path];
        await kv.set(SOURCE_INDEX_CATALOG_KEY, catalog);
      }
    },

    async rename(oldPath, newPath) {
      const existing = (await kv.get(recordKeyForPath(oldPath))) as SourceIndexRecord | null;
      if (!existing) return null;
      const moved: SourceIndexRecord = { ...existing, path: newPath };
      await kv.set(recordKeyForPath(newPath), moved);
      await kv.delete(recordKeyForPath(oldPath));
      const catalog = await readCatalog();
      delete catalog[oldPath];
      catalog[newPath] = moved.contentHash;
      await kv.set(SOURCE_INDEX_CATALOG_KEY, catalog);
      return moved;
    },

    async listPathsAndHashes() {
      return readCatalog();
    },

    async count() {
      return Object.keys(await readCatalog()).length;
    },

    async getCheckpoint() {
      const v = await kv.get(SOURCE_INDEX_SCAN_CHECKPOINT_KEY);
      return (v as ScanCheckpoint | null) ?? null;
    },

    async setCheckpoint(checkpoint) {
      await kv.set(SOURCE_INDEX_SCAN_CHECKPOINT_KEY, checkpoint);
    },

    async clearCheckpoint() {
      await kv.delete(SOURCE_INDEX_SCAN_CHECKPOINT_KEY);
    },
  };
}
