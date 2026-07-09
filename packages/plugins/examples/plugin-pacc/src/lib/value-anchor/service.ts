/**
 * Value-anchor registry service — T-2.4.
 *
 * Caches the loaded registry between reloads. `reload()` runs at plugin
 * startup and at every morning sweep (PRD § 9.6: "reads [[Value Anchors]]
 * at startup and at every morning sweep"), so a registry edit takes effect
 * no later than the next sweep — and immediately for consumers that call
 * `reload()` themselves.
 *
 * `getProtectedPaths()` feeds the write-mediator: the registry note itself
 * plus every RESOLVED anchor note. (An unresolved anchor has no file to
 * protect; the loader already surfaced it as a warning.)
 */

import path from "node:path";
import { createVaultLoaderDeps } from "./fs-deps.js";
import { loadValueAnchors, type ValueAnchor, type ValueAnchorLoaderDeps } from "./loader.js";

export interface ValueAnchorService {
  /** Re-read the registry from the vault. */
  reload(): Promise<void>;
  /** Anchors from the last reload (empty before first load). */
  getValueAnchors(): ValueAnchor[];
  /** Warnings from the last reload (unresolved links, missing registry…). */
  getWarnings(): string[];
  /** Registry note + resolved anchor paths. Lazily loads on first call. */
  getProtectedPaths(): Promise<string[]>;
}

export interface ValueAnchorServiceOptions {
  vaultRoot: string;
  /** Override loader deps (tests). Default: real fs walk of vaultRoot. */
  loaderDeps?: ValueAnchorLoaderDeps;
  registryRelPath?: string;
}

export function createValueAnchorService(options: ValueAnchorServiceOptions): ValueAnchorService {
  const deps: ValueAnchorLoaderDeps = {
    ...(options.loaderDeps ?? createVaultLoaderDeps(options.vaultRoot)),
    registryRelPath: options.registryRelPath,
  };
  // Fallback only — the loader reports the registry path it actually used
  // (discovery may find the note in a subfolder, per real T-0.7 placement).
  const fallbackRegistryPath = path.join(
    options.vaultRoot,
    options.registryRelPath ?? "Value Anchors.md",
  );

  let anchors: ValueAnchor[] = [];
  let warnings: string[] = [];
  let registryPath: string = fallbackRegistryPath;
  let loaded = false;

  const reload = async (): Promise<void> => {
    const result = await loadValueAnchors(deps);
    anchors = result.anchors;
    warnings = result.warnings;
    registryPath = result.registryPath ?? fallbackRegistryPath;
    loaded = true;
  };

  return {
    reload,
    getValueAnchors: () => anchors,
    getWarnings: () => warnings,
    // Methods close over module state (no `this`), so callers may freely
    // pass them as bare function references into writer deps.
    async getProtectedPaths() {
      if (!loaded) await reload();
      return [
        registryPath,
        ...anchors.filter((a) => a.resolved && a.path !== null).map((a) => a.path as string),
      ];
    },
  };
}
