/**
 * Note-association storage — T-2.3.
 *
 * plugin_state rows, NOT a core table (same rationale as T-2.2's source
 * index: cross-plugin demand is hypothetical and only one plugin exists):
 *   - one row per associated file: stateKey `note-association.v1:<sha256(path)>`
 *   - one catalog row (`note-association-catalog.v1`) mapping path ->
 *     { projectId, confidence, method } so summary counts (per-project /
 *     unassociated bucket) don't require enumerating every per-file key
 *     (same trick as T-2.2's catalog and T-3.10's kill-criterion map).
 *
 * Pure domain logic per docs/substrate-firewall.md: persistence is injected
 * as a string-keyed KV port; the Paperclip `ctx.state` mapping lives in
 * worker-deps.ts.
 */

import { createHash } from "node:crypto";
import type { AssociationMethod, AssociationRecord } from "./associator-core.js";

export const NOTE_ASSOCIATION_RECORD_KEY_PREFIX = "note-association.v1:";
export const NOTE_ASSOCIATION_CATALOG_KEY = "note-association-catalog.v1";

export function recordKeyForPath(path: string): string {
  const pathHash = createHash("sha256").update(path, "utf8").digest("hex");
  return `${NOTE_ASSOCIATION_RECORD_KEY_PREFIX}${pathHash}`;
}

/** Minimal string-keyed KV port over plugin_state (instance scope). */
export interface NoteAssociationKv {
  get(stateKey: string): Promise<unknown>;
  set(stateKey: string, value: unknown): Promise<void>;
  delete(stateKey: string): Promise<void>;
}

export interface CatalogEntry {
  projectId: string | null;
  confidence: number;
  method: AssociationMethod;
}

/** path -> catalog entry, for every associated file. */
export type NoteAssociationCatalog = Record<string, CatalogEntry>;

export interface AssociationSummary {
  totalNotes: number;
  unassociatedCount: number;
  /** Count of associated notes per project slug. */
  byProject: Record<string, number>;
}

export interface NoteAssociationStore {
  getByPath(path: string): Promise<AssociationRecord | null>;
  put(record: AssociationRecord): Promise<void>;
  remove(path: string): Promise<void>;
  listCatalog(): Promise<NoteAssociationCatalog>;
  summary(): Promise<AssociationSummary>;
}

export function createNoteAssociationStore(kv: NoteAssociationKv): NoteAssociationStore {
  const readCatalog = async (): Promise<NoteAssociationCatalog> =>
    ((await kv.get(NOTE_ASSOCIATION_CATALOG_KEY)) as NoteAssociationCatalog | null) ?? {};

  return {
    async getByPath(path) {
      const v = await kv.get(recordKeyForPath(path));
      return (v as AssociationRecord | null) ?? null;
    },

    async put(record) {
      await kv.set(recordKeyForPath(record.path), record);
      const catalog = await readCatalog();
      catalog[record.path] = {
        projectId: record.projectId,
        confidence: record.confidence,
        method: record.method,
      };
      await kv.set(NOTE_ASSOCIATION_CATALOG_KEY, catalog);
    },

    async remove(path) {
      await kv.delete(recordKeyForPath(path));
      const catalog = await readCatalog();
      if (path in catalog) {
        delete catalog[path];
        await kv.set(NOTE_ASSOCIATION_CATALOG_KEY, catalog);
      }
    },

    async listCatalog() {
      return readCatalog();
    },

    async summary() {
      const catalog = await readCatalog();
      const byProject: Record<string, number> = {};
      let unassociatedCount = 0;
      let totalNotes = 0;
      for (const entry of Object.values(catalog)) {
        totalNotes++;
        if (entry.projectId === null) {
          unassociatedCount++;
        } else {
          byProject[entry.projectId] = (byProject[entry.projectId] ?? 0) + 1;
        }
      }
      return { totalNotes, unassociatedCount, byProject };
    },
  };
}
