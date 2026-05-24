/**
 * Brief-run overlap guard — T-3.6.
 *
 * Two cron firings of the briefer can race when one run is still in
 * flight (paperclip restart, clock skew, manual trigger overlapping the
 * scheduled fire). We use an advisory lock stored in plugin_state to
 * detect overlap and skip the duplicate run.
 *
 * The lock has a built-in expiry: if the lock timestamp is older than
 * `staleAfterMs` (default 30 minutes), it's treated as orphaned and
 * acquirable. This prevents a crashed worker from permanently blocking
 * future runs.
 *
 * Pure-ish: the caller plumbs the plugin_state read/write via the
 * `OverlapGuardStore` interface so this file is testable without a real
 * paperclip ctx.
 */

export interface BriefInProgressLock {
  /** ISO-8601 timestamp when the lock was acquired. */
  acquiredAt: string;
  /** Optional run-correlation id (e.g. plugin job runId). */
  runId: string | null;
}

export interface OverlapGuardStore {
  /** Read the current lock, or `null` if absent. */
  read(): Promise<BriefInProgressLock | null>;
  /** Write the lock atomically. The caller is expected to have already verified there's no conflicting holder. */
  write(lock: BriefInProgressLock): Promise<void>;
  /** Clear the lock. */
  clear(): Promise<void>;
}

export interface AcquireLockOptions {
  /**
   * Lock TTL in ms. After this duration, an existing lock is treated as
   * stale (probably a crashed worker) and overwritable.
   *
   * Default 30 min, longer than any reasonable brief run.
   */
  staleAfterMs?: number;
  /** Override "now" for tests. */
  now?: Date;
  /** Optional run id to stamp into the lock. */
  runId?: string | null;
}

export type AcquireLockResult =
  | { acquired: true; lock: BriefInProgressLock; reason: "no_prior_lock" | "stale_lock_overwritten" }
  | { acquired: false; existingLock: BriefInProgressLock; ageMs: number };

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Try to acquire the brief-in-progress lock.
 *   - If no lock exists → acquire.
 *   - If lock exists but is older than `staleAfterMs` → overwrite (stale).
 *   - If lock exists and fresh → skip (return existing).
 *
 * Caller MUST call `releaseLock` in a finally block on the acquire path.
 */
export async function acquireLock(
  store: OverlapGuardStore,
  options: AcquireLockOptions = {},
): Promise<AcquireLockResult> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const existing = await store.read();
  if (existing) {
    const ageMs = now.getTime() - new Date(existing.acquiredAt).getTime();
    if (ageMs < staleAfterMs) {
      // Lock is held and fresh — skip.
      return { acquired: false, existingLock: existing, ageMs };
    }
    // Stale lock — overwrite.
    const newLock: BriefInProgressLock = {
      acquiredAt: now.toISOString(),
      runId: options.runId ?? null,
    };
    await store.write(newLock);
    return { acquired: true, lock: newLock, reason: "stale_lock_overwritten" };
  }

  const newLock: BriefInProgressLock = {
    acquiredAt: now.toISOString(),
    runId: options.runId ?? null,
  };
  await store.write(newLock);
  return { acquired: true, lock: newLock, reason: "no_prior_lock" };
}

/** Release the lock unconditionally. Idempotent. */
export async function releaseLock(store: OverlapGuardStore): Promise<void> {
  await store.clear();
}
