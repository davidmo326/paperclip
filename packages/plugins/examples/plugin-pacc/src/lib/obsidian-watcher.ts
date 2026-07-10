/**
 * Obsidian filesystem watcher — T-2.1 / PRD § 7.1, § 7.3.
 *
 * Pure domain logic per docs/substrate-firewall.md: no `@paperclipai/*`
 * imports, no direct `fs`/`chokidar` access. Filesystem reads, hashing, the
 * clock, and the fs-watch source itself are all injected so the state
 * machine (debounce, torn-write retry, rename correlation, ignore-list,
 * M1a/M1b tagging) is unit-testable without touching a real vault.
 *
 * Emits three event shapes (consumed by the adapter in
 * `obsidian-watcher-deps.ts`, which forwards them to `ctx.events.emit`):
 *   - `source.note.changed { path, hash, modifiedAt, tier }`
 *   - `source.note.renamed { oldPath, newPath, hash, tier }`
 *   - `source.note.deleted { path, tier }`
 *
 * State machine summary:
 *   - `add` / `change` events are debounced `debounceMs` (default 250ms).
 *     When the debounce fires, the file is read and hashed; a short
 *     `verifyDelayMs` later it is read again. If the hash changed (a torn
 *     write still in progress), the cycle retries exactly once before
 *     emitting whatever it last read.
 *   - `unlink` events are held for `renameWindowMs` (default 500ms) keyed by
 *     the last known content hash for that path. If an `add` arrives within
 *     that window with a matching hash, the pair collapses into ONE
 *     `source.note.renamed` — never a delete+create pair. Otherwise the
 *     hold expires into a `source.note.deleted`.
 *   - Tier tagging consults the injected value-anchor registry service
 *     (T-2.4) by exact resolved-path membership in `getProtectedPaths()`.
 *     When the event path IS the registry note itself (first entry of
 *     `getProtectedPaths()`), the registry is reloaded before tagging so a
 *     registry edit takes effect on its own change event, not just the next
 *     morning sweep.
 */

export type ObsidianTier = "M1a" | "M1b";

export type ObsidianWatcherEvent =
  | { type: "source.note.changed"; path: string; hash: string; modifiedAt: string; tier: ObsidianTier }
  | { type: "source.note.renamed"; oldPath: string; newPath: string; hash: string; tier: ObsidianTier }
  | { type: "source.note.deleted"; path: string; tier: ObsidianTier };

export interface ObsidianWatcherEngineDeps {
  /** Read file content for hashing. Must reject/throw if the file vanished. */
  readFile(absPath: string): Promise<string>;
  /** Hash file content deterministically (e.g. sha256 hex). */
  hash(content: string): string;
  /** Resolved mtime in ms since epoch. Falls back to the clock if omitted. */
  getMtimeMs?(absPath: string): Promise<number>;
  /**
   * T-2.4 registry service surface. `getProtectedPaths()[0]` is the
   * registry note's own resolved path (per `createValueAnchorService`).
   */
  registry: {
    reload(): Promise<void>;
    getProtectedPaths(): Promise<string[]>;
  };
  emit(event: ObsidianWatcherEvent): void | Promise<void>;
  /** Monotonic-ish wall clock in ms. Default `Date.now`. */
  clock?(): number;
  /** Debounce window for add/change before the first read. Default 250. */
  debounceMs?: number;
  /** Gap between the first read and the torn-write verification read. Default 60. */
  verifyDelayMs?: number;
  /** How long an unlink waits for a matching add before it's a real delete. Default 500. */
  renameWindowMs?: number;
  onError?(err: unknown, context: { path: string; stage: string }): void;
}

interface PendingChange {
  path: string;
  fireAt: number;
  stage: "debounce" | "verify";
  lastHash: string | null;
  retried: boolean;
}

interface PendingDelete {
  path: string;
  hash: string | null;
  deletedAt: number;
  expiresAt: number;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_VERIFY_DELAY_MS = 60;
const DEFAULT_RENAME_WINDOW_MS = 500;

/**
 * Ignore rules (PLAN T-2.1 spec + T-2.4's atomic-write temp files):
 *   `.obsidian/`, `.trash/`, `.git/`  — any path segment
 *   `*.tmp`, `*.tmp-*`                — plain temp files + mediator's
 *                                        atomic-write temp files
 *   `~$*`                             — Office-style lock files
 *   `*.swp`                           — vim swap files (covers Excalidraw's
 *                                        `*.excalidraw.md.swp` too)
 */
const IGNORED_DIR_SEGMENTS = new Set([".obsidian", ".trash", ".git"]);

export function shouldIgnorePath(relOrAbsPath: string): boolean {
  const normalized = relOrAbsPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (IGNORED_DIR_SEGMENTS.has(segment)) return true;
  }
  const basename = segments[segments.length - 1] ?? normalized;
  if (basename.startsWith("~$")) return true;
  if (basename.endsWith(".swp")) return true;
  if (basename.endsWith(".tmp")) return true;
  if (/\.tmp-/.test(basename)) return true;
  return false;
}

function tierFor(absPath: string, protectedPaths: string[]): ObsidianTier {
  return protectedPaths.includes(absPath) ? "M1b" : "M1a";
}

export class ObsidianWatcherEngine {
  private readonly deps: Required<
    Pick<ObsidianWatcherEngineDeps, "readFile" | "hash" | "registry" | "emit">
  > &
    ObsidianWatcherEngineDeps;
  private readonly debounceMs: number;
  private readonly verifyDelayMs: number;
  private readonly renameWindowMs: number;
  private readonly clock: () => number;

  private readonly pendingChanges = new Map<string, PendingChange>();
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private readonly lastKnownHash = new Map<string, string>();

  constructor(deps: ObsidianWatcherEngineDeps) {
    this.deps = deps as ObsidianWatcherEngine["deps"];
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.verifyDelayMs = deps.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
    this.renameWindowMs = deps.renameWindowMs ?? DEFAULT_RENAME_WINDOW_MS;
    this.clock = deps.clock ?? Date.now;
  }

  /** File created (or first seen). Ignored paths are dropped silently. */
  handleAdd(absPath: string, now: number = this.clock()): void {
    if (shouldIgnorePath(absPath)) return;
    this.scheduleChange(absPath, now);
  }

  /** File modified. Ignored paths are dropped silently. */
  handleChange(absPath: string, now: number = this.clock()): void {
    if (shouldIgnorePath(absPath)) return;
    this.scheduleChange(absPath, now);
  }

  /** File removed. Ignored paths are dropped silently. */
  handleUnlink(absPath: string, now: number = this.clock()): void {
    if (shouldIgnorePath(absPath)) return;
    // A delete cancels any in-flight debounce for the same path — nothing
    // left to read.
    this.pendingChanges.delete(absPath);
    const hash = this.lastKnownHash.get(absPath) ?? null;
    this.lastKnownHash.delete(absPath);
    this.pendingDeletes.set(absPath, {
      path: absPath,
      hash,
      deletedAt: now,
      expiresAt: now + this.renameWindowMs,
    });
  }

  private scheduleChange(absPath: string, now: number): void {
    const existing = this.pendingChanges.get(absPath);
    this.pendingChanges.set(absPath, {
      path: absPath,
      fireAt: now + this.debounceMs,
      stage: "debounce",
      lastHash: existing?.lastHash ?? null,
      retried: existing?.retried ?? false,
    });
  }

  /**
   * Advance time. Processes every pending change/delete whose deadline has
   * elapsed. Safe to call frequently (e.g. every 50ms from a real timer, or
   * directly with synthetic timestamps in tests).
   */
  async tick(now: number = this.clock()): Promise<void> {
    // Rename correlation must run before delete-expiry so an add that
    // arrives in the same tick as an expiring delete still gets a chance to
    // match (processed in handleAdd's own correlation check, which fires
    // synchronously before this tick — but a same-tick expiry could race a
    // slightly-later add in the same tick batch, so we resolve deletes last).
    await this.processDueChanges(now);
    await this.expireDueDeletes(now);
  }

  private async processDueChanges(now: number): Promise<void> {
    const due = [...this.pendingChanges.values()].filter((p) => p.fireAt <= now);
    for (const pending of due) {
      await this.processPendingChange(pending, now);
    }
  }

  private async processPendingChange(pending: PendingChange, now: number): Promise<void> {
    const { path: absPath } = pending;
    let content: string;
    try {
      content = await this.deps.readFile(absPath);
    } catch (err) {
      // File vanished between the event and our read (e.g. rapid
      // delete-after-write). Drop the pending change; the unlink handler
      // (if it fires) will take over.
      this.pendingChanges.delete(absPath);
      this.deps.onError?.(err, { path: absPath, stage: "read" });
      return;
    }
    const hash = this.deps.hash(content);

    // A moved/renamed file isn't being actively written — no torn-write
    // concern — so rename correlation is checked as soon as ANY hash is
    // available (debounce stage), before the verify/retry cycle, to keep
    // the effective latency close to `debounceMs` and stay well inside the
    // `renameWindowMs` budget measured from the original unlink.
    const rename = this.matchPendingDelete(hash, now);
    if (rename) {
      this.pendingChanges.delete(absPath);
      this.pendingDeletes.delete(rename.path);
      this.lastKnownHash.delete(rename.path);
      this.lastKnownHash.set(absPath, hash);
      const tier = await this.tierFor(absPath);
      await this.deps.emit({
        type: "source.note.renamed",
        oldPath: rename.path,
        newPath: absPath,
        hash,
        tier,
      });
      return;
    }

    if (pending.stage === "debounce") {
      // First read at debounce-fire time. Schedule the torn-write
      // verification read shortly after.
      this.pendingChanges.set(absPath, {
        ...pending,
        stage: "verify",
        lastHash: hash,
        fireAt: now + this.verifyDelayMs,
      });
      return;
    }

    // stage === "verify": compare against the debounce-time hash.
    if (pending.lastHash !== null && hash !== pending.lastHash && !pending.retried) {
      // Torn write: hash moved between the two reads. Retry exactly once —
      // wait one more verify cycle before deciding.
      this.pendingChanges.set(absPath, {
        ...pending,
        stage: "verify",
        lastHash: hash,
        fireAt: now + this.verifyDelayMs,
        retried: true,
      });
      return;
    }

    // Stable (or already retried once) — emit the change.
    this.pendingChanges.delete(absPath);
    this.lastKnownHash.set(absPath, hash);
    const tier = await this.tierFor(absPath);
    const modifiedAt = await this.resolveModifiedAt(absPath, now);
    await this.deps.emit({ type: "source.note.changed", path: absPath, hash, modifiedAt, tier });
  }

  private matchPendingDelete(hash: string, now: number): PendingDelete | null {
    for (const del of this.pendingDeletes.values()) {
      if (del.hash === null) continue;
      if (del.hash !== hash) continue;
      if (now - del.deletedAt > this.renameWindowMs) continue;
      return del;
    }
    return null;
  }

  private async expireDueDeletes(now: number): Promise<void> {
    const due = [...this.pendingDeletes.values()].filter((d) => now >= d.expiresAt);
    for (const del of due) {
      this.pendingDeletes.delete(del.path);
      await this.emitDelete(del.path);
    }
  }

  private async emitDelete(absPath: string): Promise<void> {
    const tier = await this.tierFor(absPath);
    await this.deps.emit({ type: "source.note.deleted", path: absPath, tier });
  }

  private async resolveModifiedAt(absPath: string, fallbackNow: number): Promise<string> {
    if (this.deps.getMtimeMs) {
      try {
        const mtimeMs = await this.deps.getMtimeMs(absPath);
        return new Date(mtimeMs).toISOString();
      } catch {
        // fall through to the clock-based fallback
      }
    }
    return new Date(fallbackNow).toISOString();
  }

  private async tierFor(absPath: string): Promise<ObsidianTier> {
    let protectedPaths = await this.deps.registry.getProtectedPaths();
    // T-2.4: reload when the registry note itself changed, so the new
    // membership set is used for tagging on the very same event.
    if (protectedPaths[0] === absPath) {
      await this.deps.registry.reload();
      protectedPaths = await this.deps.registry.getProtectedPaths();
    }
    return tierFor(absPath, protectedPaths);
  }

  /** Number of in-flight debounced changes (diagnostics/tests only). */
  get pendingChangeCount(): number {
    return this.pendingChanges.size;
  }

  /** Number of in-flight rename-candidate deletes (diagnostics/tests only). */
  get pendingDeleteCount(): number {
    return this.pendingDeletes.size;
  }
}

export function createObsidianWatcherEngine(deps: ObsidianWatcherEngineDeps): ObsidianWatcherEngine {
  return new ObsidianWatcherEngine(deps);
}
