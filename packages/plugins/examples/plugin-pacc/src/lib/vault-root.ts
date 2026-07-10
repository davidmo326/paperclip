/**
 * Obsidian vault root resolution — shared by every adapter that needs to
 * locate the vault on disk (T-2.4 write-mediator, T-2.1 filesystem watcher,
 * scheduled-brief writers, …).
 *
 * Extracted from `lib/briefer/worker-deps.ts` (T-2.1 amendment, PLAN v3,
 * 2026-07-09: "reuse/extract that helper rather than duplicating").
 *
 * Resolution order: `PACC_VAULT_ROOT` wins; else the parent of
 * `PACC_OBSIDIAN_DIR` (which points at `00_Daily`); else the standard
 * location under `$HOME`.
 */

import path from "node:path";

export function resolveVaultRoot(): string {
  const override = process.env.PACC_VAULT_ROOT?.trim();
  if (override) return override;
  const dailyDir = process.env.PACC_OBSIDIAN_DIR?.trim();
  if (dailyDir) return path.dirname(dailyDir);
  const home = process.env.HOME?.trim();
  return home ? `${home}/llm_shared/Obsidian` : "/home/ubuntu/llm_shared/Obsidian";
}
