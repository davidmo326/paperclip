/**
 * Paperclip adapter for the source indexer — T-2.2.
 *
 * Assembles `SourceIndexerDeps` from a minimal `WorkerCtx` (the briefer's
 * worker-deps pattern): plugin_state rows become the string-keyed KV port,
 * the real filesystem becomes the fs port, vault root comes from the same
 * PACC_VAULT_ROOT / PACC_OBSIDIAN_DIR resolution the T-2.4 guard uses.
 *
 * Storage shape (instance scope, namespace = PLUGIN_NAMESPACE):
 *   - one row per file:    stateKey `source-index.v1:<sha256(relPath)>`
 *   - catalog row:         stateKey `source-index-catalog.v1`
 *   - scan checkpoint row: stateKey `source-index-scan.v1`
 *
 * This file is a named substrate-firewall touchpoint (docs/substrate-firewall.md
 * inventory) — Paperclip's ctx.state is used here and nowhere else in T-2.2 code.
 */

import { PLUGIN_NAMESPACE } from "../../constants.js";
import type { WorkerCtx } from "../briefer/worker-deps.js";
import { resolveVaultRoot } from "../vault-root.js";
import { createSourceIndexerFs } from "./fs-deps.js";
import type { SourceIndexerDeps } from "./indexer.js";
import { createSourceIndexStore, type SourceIndexKv, type SourceIndexStore } from "./store.js";

/** Minimal ctx surface the source-index adapter needs. */
export type SourceIndexCtx = Pick<WorkerCtx, "state" | "logger">;

export function makeSourceIndexKv(ctx: SourceIndexCtx): SourceIndexKv {
  const key = (stateKey: string) => ({
    scopeKind: "instance" as const,
    namespace: PLUGIN_NAMESPACE,
    stateKey,
  });
  return {
    get: (stateKey) => ctx.state.get(key(stateKey)),
    set: (stateKey, value) => ctx.state.set(key(stateKey), value),
    async delete(stateKey) {
      if (ctx.state.delete) {
        await ctx.state.delete(key(stateKey));
      } else {
        await ctx.state.set(key(stateKey), null);
      }
    },
  };
}

export function makeSourceIndexStore(ctx: SourceIndexCtx): SourceIndexStore {
  return createSourceIndexStore(makeSourceIndexKv(ctx));
}

export function makeSourceIndexerDeps(
  ctx: SourceIndexCtx,
  options: { vaultRoot?: string } = {},
): SourceIndexerDeps {
  const vaultRoot = options.vaultRoot ?? resolveVaultRoot();
  return {
    vaultRoot,
    fs: createSourceIndexerFs(vaultRoot),
    store: makeSourceIndexStore(ctx),
    logger: ctx.logger,
  };
}
