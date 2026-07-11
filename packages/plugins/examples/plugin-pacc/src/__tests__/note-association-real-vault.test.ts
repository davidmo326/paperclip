/**
 * T-2.3 — real-vault association measurement (acceptance: unassociated
 * bucket < 30% of indexed notes, OR the higher figure is reported honestly).
 *
 * READ-ONLY against the live vault and the real portfolio-seed.json;
 * storage is in-memory. Never touches the live DB, never writes to the
 * vault, and never creates/edits `_pacc_overrides.json`. Gated behind
 * PACC_REAL_VAULT_SCAN=1 so CI and normal test runs skip it; run manually:
 *
 *   PACC_REAL_VAULT_SCAN=1 pnpm vitest run src/__tests__/note-association-real-vault.test.ts
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceIndexerFs } from "../lib/source-index/fs-deps.js";
import { createSourceIndexStore, type SourceIndexKv } from "../lib/source-index/store.js";
import { runInitialScan } from "../lib/source-index/indexer.js";
import { runAssociation } from "../lib/note-association/associate.js";
import { createNoteAssociationFsDeps } from "../lib/note-association/fs-deps.js";
import { createNoteAssociationStore, type NoteAssociationKv } from "../lib/note-association/store.js";

const VAULT_ROOT = process.env.PACC_VAULT_ROOT ?? "/home/ubuntu/llm_shared/Obsidian";
const SEED_PATH =
  process.env.PACC_PORTFOLIO_SEED_PATH ??
  path.join(VAULT_ROOT, "..", "ControlPlane", "seed", "portfolio-seed.json");
const OVERRIDES_PATH = process.env.PACC_OVERRIDES_PATH ?? path.join(VAULT_ROOT, "_pacc_overrides.json");
const enabled = process.env.PACC_REAL_VAULT_SCAN === "1";

function memoryKv<T>(): T {
  const rows = new Map<string, unknown>();
  return {
    async get(k: string) {
      return rows.has(k) ? rows.get(k) : null;
    },
    async set(k: string, v: unknown) {
      rows.set(k, v);
    },
    async delete(k: string) {
      rows.delete(k);
    },
  } as T;
}

describe.skipIf(!enabled)("real-vault note association (read-only, in-memory store)", () => {
  it(
    "associates every indexed note and reports the unassociated-bucket percentage",
    { timeout: 180_000 },
    async () => {
      // Step 1: index the vault (T-2.2), same as source-index's own real-vault test.
      const sourceIndexStore = createSourceIndexStore(memoryKv<SourceIndexKv>());
      const scanResult = await runInitialScan({
        vaultRoot: VAULT_ROOT,
        fs: createSourceIndexerFs(VAULT_ROOT),
        store: sourceIndexStore,
      });
      expect(scanResult.completed).toBe(true);

      // Step 2: associate on top of the index (T-2.3) — no vault walk here.
      const fsDeps = createNoteAssociationFsDeps();
      const [projects, overrides] = await Promise.all([
        fsDeps.loadProjects(SEED_PATH, VAULT_ROOT),
        fsDeps.loadOverrides(OVERRIDES_PATH),
      ]);
      expect(projects.length).toBeGreaterThan(0); // sanity: seed file was found and parsed

      const assocStore = createNoteAssociationStore(memoryKv<NoteAssociationKv>());
      const result = await runAssociation({
        sourceIndex: sourceIndexStore,
        store: assocStore,
        projects,
        overrides,
      });

      const summary = await assocStore.summary();
      const unassociatedPct = (summary.unassociatedCount / summary.totalNotes) * 100;

      // eslint-disable-next-line no-console
      console.log(
        `[T-2.3 real-vault association] totalNotes=${summary.totalNotes} ` +
          `unassociated=${summary.unassociatedCount} (${unassociatedPct.toFixed(1)}%) ` +
          `byProject=${JSON.stringify(summary.byProject)} byMethod=${JSON.stringify(result.byMethod)} ` +
          `projects=${projects.length} overridesLoaded=${Object.keys(overrides).length}`,
      );

      expect(result.notesProcessed).toBe(summary.totalNotes);
      // Acceptance: unassociated bucket < 30% OR the principal accepts a
      // higher bucket via overrides. This test reports the real figure
      // honestly rather than asserting it — see T23-NOTES.md for the run
      // recorded against the actual vault.
      expect(summary.totalNotes).toBeGreaterThan(0);
    },
  );
});
