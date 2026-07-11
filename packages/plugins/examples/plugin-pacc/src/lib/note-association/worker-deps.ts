/**
 * Paperclip adapter for note association — T-2.3.
 *
 * Assembles `NoteAssociationDeps` from a minimal `WorkerCtx` (same pattern
 * as T-2.2's `source-index/worker-deps.ts`): plugin_state rows become the
 * KV port, the real filesystem (via fs-deps.ts) supplies portfolio-seed.json
 * + `_pacc_overrides.json`, and the source index's own store (T-2.2) is the
 * read-only input — this adapter never walks the vault itself.
 *
 * This file is a named substrate-firewall touchpoint (docs/substrate-firewall.md
 * inventory) — Paperclip's ctx.state is used here and nowhere else in T-2.3
 * code.
 */

import path from "node:path";
import { PLUGIN_NAMESPACE } from "../../constants.js";
import type { WorkerCtx } from "../briefer/worker-deps.js";
import { resolveVaultRoot } from "../vault-root.js";
import type { NoteAssociationDeps, SourceIndexReader } from "./associate.js";
import { createNoteAssociationFsDeps } from "./fs-deps.js";
import { createNoteAssociationStore, type NoteAssociationKv, type NoteAssociationStore } from "./store.js";

/** Minimal ctx surface the note-association adapter needs. */
export type NoteAssociationCtx = Pick<WorkerCtx, "state" | "logger">;

export function makeNoteAssociationKv(ctx: NoteAssociationCtx): NoteAssociationKv {
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

export function makeNoteAssociationStore(ctx: NoteAssociationCtx): NoteAssociationStore {
  return createNoteAssociationStore(makeNoteAssociationKv(ctx));
}

/** Default location of the seed file: sibling ControlPlane checkout's seed/portfolio-seed.json. */
function defaultPortfolioSeedPath(): string {
  const home = process.env.HOME?.trim();
  const root = home ? `${home}/llm_shared` : "/home/ubuntu/llm_shared";
  return path.join(root, "ControlPlane", "seed", "portfolio-seed.json");
}

/** Default location of the manual override file: vault root's `_pacc_overrides.json`. */
function defaultOverridesPath(vaultRoot: string): string {
  return path.join(vaultRoot, "_pacc_overrides.json");
}

export async function makeNoteAssociationDeps(
  ctx: NoteAssociationCtx,
  sourceIndex: SourceIndexReader,
  options: { vaultRoot?: string; seedPath?: string; overridesPath?: string } = {},
): Promise<NoteAssociationDeps> {
  const vaultRoot = options.vaultRoot ?? resolveVaultRoot();
  const seedPath = options.seedPath ?? process.env.PACC_PORTFOLIO_SEED_PATH?.trim() ?? defaultPortfolioSeedPath();
  const overridesPath =
    options.overridesPath ?? process.env.PACC_OVERRIDES_PATH?.trim() ?? defaultOverridesPath(vaultRoot);

  const fs = createNoteAssociationFsDeps(ctx.logger);
  const [projects, overrides] = await Promise.all([
    fs.loadProjects(seedPath, vaultRoot),
    fs.loadOverrides(overridesPath),
  ]);

  return {
    sourceIndex,
    store: makeNoteAssociationStore(ctx),
    projects,
    overrides,
    logger: ctx.logger,
  };
}
