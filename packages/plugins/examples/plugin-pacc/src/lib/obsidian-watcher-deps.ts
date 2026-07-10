/**
 * Real-fs / real-chokidar adapter for the obsidian-watcher engine — T-2.1.
 *
 * Per docs/substrate-firewall.md: this is the ONLY file where chokidar,
 * `node:fs`, and `WorkerCtx`/paperclip event emission are wired together.
 * `lib/obsidian-watcher.ts` stays pure and unit-testable.
 *
 * Polling: chokidar's default (inotify on Linux, FSEvents on macOS) is used
 * unless `PACC_WATCHER_POLL=1` is set — the vault lives on local disk on
 * the NUC (no network mount), so inotify is fine (PLAN v3 amendment,
 * 2026-07-09). Kept behind an explicit config flag rather than OS/mount
 * detection, per the same amendment.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { createVaultLoaderDeps } from "./value-anchor/fs-deps.js";
import { createValueAnchorService, type ValueAnchorService } from "./value-anchor/service.js";
import { resolveVaultRoot } from "./vault-root.js";
import {
  createObsidianWatcherEngine,
  ObsidianWatcherEngine,
  shouldIgnorePath,
  type ObsidianWatcherEvent,
} from "./obsidian-watcher.js";

export interface ObsidianWatcherEventEmitter {
  (event: ObsidianWatcherEvent): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// T-2.2b: forward watcher events to the source indexer
// ---------------------------------------------------------------------------

/**
 * Minimal surface of the T-2.2 indexer's event-consumption functions
 * (`applyNoteChanged` / `applyNoteRenamed` / `applyNoteDeleted` in
 * `source-index/indexer.ts`) that the watcher glue needs. Kept as a
 * structural type here (rather than importing `SourceIndexerDeps` and
 * binding these functions to it) so this adapter file doesn't need to know
 * how the indexer's deps are assembled — the caller (worker.ts) partially
 * applies the real functions against `makeSourceIndexerDeps(ctx)`.
 */
export interface SourceIndexForwarderDeps {
  applyNoteChanged(event: { path: string }): Promise<unknown>;
  applyNoteRenamed(event: { oldPath: string; newPath: string }): Promise<unknown>;
  applyNoteDeleted(event: { path: string }): Promise<unknown>;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

function isMarkdownPath(p: string): boolean {
  return p.toLowerCase().endsWith(".md");
}

/**
 * Wraps an `ObsidianWatcherEventEmitter` (in production, the closure that
 * forwards to `ctx.events.emit`) so every markdown watcher event is ALSO
 * applied to the T-2.2 source index, keeping it live after the initial scan.
 *
 * - Markdown-scoped: the watcher may observe non-`.md` files (e.g.
 *   attachments); those still reach the wrapped emitter but never the
 *   indexer, which only tracks notes. For a rename, `newPath` is the
 *   relevant path — a rename INTO `.md` scope is indexed, a rename OUT of
 *   it is not (the indexer never held a record keyed on a non-md path).
 * - Indexer failures never propagate: they're logged and the wrapped
 *   emitter's own delivery (already awaited before the indexer runs) is
 *   unaffected, so one broken note can't stop the watcher's event flow.
 */
export function withSourceIndexForwarding(
  emit: ObsidianWatcherEventEmitter,
  indexer: SourceIndexForwarderDeps,
): ObsidianWatcherEventEmitter {
  return async (event: ObsidianWatcherEvent) => {
    await emit(event);
    try {
      switch (event.type) {
        case "source.note.changed":
          if (isMarkdownPath(event.path)) {
            await indexer.applyNoteChanged({ path: event.path });
          }
          break;
        case "source.note.renamed":
          if (isMarkdownPath(event.newPath)) {
            await indexer.applyNoteRenamed({ oldPath: event.oldPath, newPath: event.newPath });
          } else if (isMarkdownPath(event.oldPath)) {
            // Renamed OUT of markdown scope (note.md -> note.txt): the index
            // held a record for oldPath; drop it or it goes permanently stale.
            await indexer.applyNoteDeleted({ path: event.oldPath });
          }
          break;
        case "source.note.deleted":
          if (isMarkdownPath(event.path)) {
            await indexer.applyNoteDeleted({ path: event.path });
          }
          break;
      }
    } catch (err) {
      indexer.logger?.warn("obsidian-watcher: source-index apply failed, continuing", {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export interface ObsidianWatcherHandle {
  vaultRoot: string;
  registryWarnings(): string[];
  /** Stop the chokidar watch + tick timer (tests / graceful shutdown). */
  stop(): Promise<void>;
}

export interface StartObsidianWatcherOptions {
  vaultRoot?: string;
  /** Called for every emitted event. */
  emit: ObsidianWatcherEventEmitter;
  /** Override the shared T-2.4 value-anchor service (tests). */
  registryService?: ValueAnchorService;
  /** Interval at which the debounce/rename/verify state machine is advanced. Default 50ms. */
  tickIntervalMs?: number;
  debounceMs?: number;
  verifyDelayMs?: number;
  renameWindowMs?: number;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Starts the watcher: reloads the T-2.4 registry once, opens a chokidar
 * watch on the vault root (ignoring dot-directories/temp files at the
 * chokidar layer too — belt and suspenders with the engine's own
 * `shouldIgnorePath`), and drives the engine's debounce/rename state
 * machine off a recurring tick.
 */
export async function startObsidianWatcher(
  options: StartObsidianWatcherOptions,
): Promise<ObsidianWatcherHandle> {
  const vaultRoot = options.vaultRoot ?? resolveVaultRoot();
  const registryService =
    options.registryService ?? createValueAnchorService({ vaultRoot });
  await registryService.reload();

  const engine: ObsidianWatcherEngine = createObsidianWatcherEngine({
    readFile: (p) => readFile(p, "utf8"),
    hash: sha256,
    getMtimeMs: async (p) => (await stat(p)).mtimeMs,
    registry: {
      reload: () => registryService.reload(),
      getProtectedPaths: () => registryService.getProtectedPaths(),
    },
    emit: options.emit,
    debounceMs: options.debounceMs,
    verifyDelayMs: options.verifyDelayMs,
    renameWindowMs: options.renameWindowMs,
    onError: (err, ctx) => {
      options.logger?.warn("obsidian-watcher: read failed, dropping pending change", {
        path: ctx.path,
        stage: ctx.stage,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const usePolling = process.env.PACC_WATCHER_POLL === "1";
  // `ignoreInitial: false` — chokidar's own initial directory walk emits an
  // `add` for every pre-existing file, which the engine processes exactly
  // like any other add: it warms `lastKnownHash` (required for rename
  // correlation to work on files that existed before the watcher started)
  // and emits `source.note.changed` for each, which doubles as the initial
  // scan the source-indexer (T-2.2) needs on cold start.
  const watcher: FSWatcher = chokidar.watch(vaultRoot, {
    ignoreInitial: false,
    usePolling,
    ignored: (p: string) => shouldIgnorePath(p),
  });

  watcher.on("add", (p: string) => engine.handleAdd(p));
  watcher.on("change", (p: string) => engine.handleChange(p));
  watcher.on("unlink", (p: string) => engine.handleUnlink(p));

  // Wait for chokidar's initial recursive scan/subscribe to finish before
  // returning — otherwise a caller that writes a file immediately after
  // `startObsidianWatcher()` resolves can race chokidar's own startup and
  // miss the event entirely.
  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

  const tickIntervalMs = options.tickIntervalMs ?? 50;
  const timer = setInterval(() => {
    void engine.tick();
  }, tickIntervalMs);
  // Don't hold the process open just for this timer.
  timer.unref?.();

  return {
    vaultRoot,
    registryWarnings: () => registryService.getWarnings(),
    async stop() {
      clearInterval(timer);
      await watcher.close();
    },
  };
}

/**
 * Initial vault scan: walks every markdown file under the vault root and
 * emits a `source.note.changed` for each (used at first startup so the
 * source index has a complete picture before incremental watch events take
 * over). Reuses the T-2.4 vault walker rather than re-implementing a file
 * walk.
 *
 * Returns wall-clock milliseconds taken, for `paperclip-dev-loop.md`
 * latency recording.
 */
export async function runInitialScan(
  vaultRoot: string,
  registryService: ValueAnchorService,
  emit: ObsidianWatcherEventEmitter,
): Promise<{ filesScanned: number; elapsedMs: number }> {
  const start = Date.now();
  const walker = createVaultLoaderDeps(vaultRoot);
  const files = await walker.listMarkdownFiles();
  const protectedPaths = await registryService.getProtectedPaths();
  const protectedSet = new Set(protectedPaths);

  let filesScanned = 0;
  for (const file of files) {
    if (shouldIgnorePath(file)) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue; // vanished mid-scan; incremental watch will pick it up if it reappears
    }
    const hash = sha256(content);
    let modifiedAt: string;
    try {
      modifiedAt = new Date((await stat(file)).mtimeMs).toISOString();
    } catch {
      modifiedAt = new Date().toISOString();
    }
    await emit({
      type: "source.note.changed",
      path: file,
      hash,
      modifiedAt,
      tier: protectedSet.has(file) ? "M1b" : "M1a",
    });
    filesScanned += 1;
  }

  return { filesScanned, elapsedMs: Date.now() - start };
}
