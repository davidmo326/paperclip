/**
 * T-2.2 — real-vault scan measurement (acceptance: initial scan of the
 * principal's actual vault completes; wall-clock + file count recorded).
 *
 * READ-ONLY against the live vault, storage in-memory — never touches the
 * live DB or writes to the vault. Gated behind PACC_REAL_VAULT_SCAN=1 so CI
 * and normal test runs skip it; run manually:
 *
 *   PACC_REAL_VAULT_SCAN=1 pnpm vitest run src/__tests__/source-index-real-vault.test.ts
 */

import { describe, expect, it } from "vitest";
import { createSourceIndexerFs } from "../lib/source-index/fs-deps.js";
import { createSourceIndexStore, type SourceIndexKv } from "../lib/source-index/store.js";
import { runInitialScan } from "../lib/source-index/indexer.js";

const VAULT_ROOT = process.env.PACC_VAULT_ROOT ?? "/home/ubuntu/llm_shared/Obsidian";
const enabled = process.env.PACC_REAL_VAULT_SCAN === "1";

function memoryKv(): SourceIndexKv {
  const rows = new Map<string, unknown>();
  return {
    async get(k) {
      return rows.has(k) ? rows.get(k) : null;
    },
    async set(k, v) {
      rows.set(k, v);
    },
    async delete(k) {
      rows.delete(k);
    },
  };
}

describe.skipIf(!enabled)("real-vault initial scan (read-only, in-memory store)", () => {
  it("completes within 120s and indexes every markdown file", { timeout: 180_000 }, async () => {
    const store = createSourceIndexStore(memoryKv());
    const deps = {
      vaultRoot: VAULT_ROOT,
      fs: createSourceIndexerFs(VAULT_ROOT),
      store,
    };
    const result = await runInitialScan(deps);

    // eslint-disable-next-line no-console
    console.log(
      `[T-2.2 real-vault scan] vault=${VAULT_ROOT} files=${result.totalFiles} ` +
        `indexed=${result.filesIndexed} failed=${result.filesFailed} ` +
        `wallClockMs=${result.wallClockMs}`,
    );

    expect(result.completed).toBe(true);
    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.filesIndexed + result.filesFailed).toBe(result.totalFiles);
    expect(await store.count()).toBe(result.filesIndexed);
    expect(result.wallClockMs).toBeLessThan(120_000); // PRD § 9.2 acceptance
  });
});
