/**
 * T-3.6 — overlap-guard tests.
 *
 * Verifies: clean acquire; skip-when-held; stale-lock overwrite;
 * release idempotence.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  releaseLock,
  type BriefInProgressLock,
  type OverlapGuardStore,
} from "../lib/briefer/overlap-guard.js";

class InMemoryStore implements OverlapGuardStore {
  state: BriefInProgressLock | null = null;
  async read() {
    return this.state;
  }
  async write(lock: BriefInProgressLock) {
    this.state = lock;
  }
  async clear() {
    this.state = null;
  }
}

let store: InMemoryStore;
beforeEach(() => {
  store = new InMemoryStore();
});

describe("acquireLock", () => {
  it("acquires when no prior lock exists", async () => {
    const now = new Date("2026-05-22T08:00:00.000Z");
    const r = await acquireLock(store, { now, runId: "run-1" });
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.reason).toBe("no_prior_lock");
      expect(r.lock.acquiredAt).toBe(now.toISOString());
      expect(r.lock.runId).toBe("run-1");
    }
    expect(store.state?.runId).toBe("run-1");
  });

  it("skips when a fresh lock is held", async () => {
    const now = new Date("2026-05-22T08:00:00.000Z");
    await acquireLock(store, { now, runId: "run-1" });
    // Second call 1 minute later
    const later = new Date(now.getTime() + 60_000);
    const r2 = await acquireLock(store, { now: later, runId: "run-2" });
    expect(r2.acquired).toBe(false);
    if (!r2.acquired) {
      expect(r2.existingLock.runId).toBe("run-1");
      expect(r2.ageMs).toBe(60_000);
    }
  });

  it("overwrites a stale lock (older than staleAfterMs)", async () => {
    const past = new Date("2026-05-22T07:00:00.000Z");
    await acquireLock(store, { now: past, runId: "old-run" });
    // 31 minutes later (default staleAfter is 30 min)
    const now = new Date(past.getTime() + 31 * 60 * 1000);
    const r = await acquireLock(store, { now, runId: "new-run" });
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.reason).toBe("stale_lock_overwritten");
      expect(r.lock.runId).toBe("new-run");
    }
    expect(store.state?.runId).toBe("new-run");
  });

  it("respects a custom staleAfterMs", async () => {
    const past = new Date("2026-05-22T08:00:00.000Z");
    await acquireLock(store, { now: past });
    // 5 minutes later
    const now = new Date(past.getTime() + 5 * 60 * 1000);
    // With staleAfterMs = 10 min, lock is still fresh → skip
    const fresh = await acquireLock(store, { now, staleAfterMs: 10 * 60 * 1000 });
    expect(fresh.acquired).toBe(false);
    // With staleAfterMs = 1 min, lock is stale → acquire
    const stale = await acquireLock(store, { now, staleAfterMs: 60 * 1000 });
    expect(stale.acquired).toBe(true);
  });

  it("treats lock at exactly staleAfterMs as stale (≥ → overwrite)", async () => {
    const past = new Date("2026-05-22T08:00:00.000Z");
    await acquireLock(store, { now: past, runId: "r1" });
    const now = new Date(past.getTime() + 30 * 60 * 1000); // exactly 30 min
    const r = await acquireLock(store, { now });
    // boundary convention: at exactly staleAfterMs, lock is considered stale.
    // Rationale: a lock "stale after 30 min" means "after 30 min passes, stale";
    // at the 30-min mark it's just crossed the threshold.
    expect(r.acquired).toBe(true);
  });

  it("treats lock just under staleAfterMs as fresh (< staleAfterMs → skip)", async () => {
    const past = new Date("2026-05-22T08:00:00.000Z");
    await acquireLock(store, { now: past, runId: "r1" });
    const now = new Date(past.getTime() + 30 * 60 * 1000 - 1); // 1ms before threshold
    const r = await acquireLock(store, { now });
    expect(r.acquired).toBe(false);
  });

  it("stamps null runId when not provided", async () => {
    const r = await acquireLock(store, { now: new Date() });
    if (!r.acquired) throw new Error("expected acquire");
    expect(r.lock.runId).toBeNull();
  });
});

describe("releaseLock", () => {
  it("clears the lock", async () => {
    await acquireLock(store, { now: new Date() });
    expect(store.state).not.toBeNull();
    await releaseLock(store);
    expect(store.state).toBeNull();
  });

  it("is idempotent (no error on already-released lock)", async () => {
    await releaseLock(store); // no prior lock
    await releaseLock(store); // again
    expect(store.state).toBeNull();
  });
});

describe("overlap-guard flow — typical happy path", () => {
  it("acquire → release → re-acquire works", async () => {
    const now1 = new Date("2026-05-22T08:00:00.000Z");
    const r1 = await acquireLock(store, { now: now1 });
    expect(r1.acquired).toBe(true);
    await releaseLock(store);

    const now2 = new Date(now1.getTime() + 5_000);
    const r2 = await acquireLock(store, { now: now2 });
    expect(r2.acquired).toBe(true);
    if (r2.acquired) {
      expect(r2.reason).toBe("no_prior_lock");
    }
  });
});
