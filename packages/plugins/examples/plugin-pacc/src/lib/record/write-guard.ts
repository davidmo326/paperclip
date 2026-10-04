/**
 * Record write guard — T-db.2.
 *
 * Every surface (cockpit, CLI, steward, Jev refresh, later Telegram / MCP)
 * writes the pacc record through this plugin worker, and every write is a
 * whole-record `ctx.entities.upsert` after a read. Two writers interleaving a
 * read-modify-write silently lose one update. This guard sits on
 * `ctx.entities.upsert` and gives the record three properties:
 *
 *  1. Optimistic concurrency. Records carry `rev`. A write whose `rev` no
 *     longer matches the stored one throws `RecordConflictError` instead of
 *     overwriting. Records without a `rev` key (freshly built, e.g. imports)
 *     are blind writes: allowed, and flagged in the event log.
 *  2. Provenance. Each write of a logged type appends a `pacc-event` entity:
 *     who (actor), from where (surface), which action, what changed.
 *  3. Idempotency. An action called with `_idempotencyKey` runs once; a replay
 *     returns the stored result (see `runAction`).
 *
 * Check-and-write is serialised per record inside this process, which is the
 * only writer (the bridge is the one front door), so the rev check is exact.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const EVENT_ENTITY_TYPE = "pacc-event";
export const IDEMPOTENCY_ENTITY_TYPE = "pacc-idem";

/** Types whose writes append an event. job-class is excluded: Jev refreshes rewrite hundreds of recomputable rows. */
export const LOGGED_ENTITY_TYPES = new Set(["project-line", "work-item", "decision", "authority-grant", "capacity-day"]);
/** Never rev-guarded or logged (the guard's own bookkeeping). */
const BOOKKEEPING_TYPES = new Set([EVENT_ENTITY_TYPE, IDEMPOTENCY_ENTITY_TYPE]);
/** Fields that change on every write and say nothing about intent. */
const NOISE_FIELDS = new Set(["rev", "updatedAt"]);
/** Append-only logs inside records: report how many entries were added. */
const APPEND_FIELDS = new Set(["edits", "history"]);
const MAX_INLINE_VALUE = 400;
const MAX_STORED_RESULT = 16_000;

/** Params keys the guard consumes; stripped before the action handler sees params. */
export const META_PARAM_KEYS = ["_surface", "_idempotencyKey", "_expectedRev"] as const;

export interface WriteMeta {
  actor: string | null;
  surface: string;
  action: string | null;
  idempotencyKey: string | null;
  expectedRev: number | null;
}

const DEFAULT_META: WriteMeta = { actor: "pacc", surface: "internal", action: null, idempotencyKey: null, expectedRev: null };

const store = new AsyncLocalStorage<WriteMeta>();

export function currentWriteMeta(): WriteMeta {
  return store.getStore() ?? DEFAULT_META;
}

export function withWriteMeta<T>(meta: Partial<WriteMeta>, fn: () => Promise<T>): Promise<T> {
  return store.run({ ...currentWriteMeta(), ...meta }, fn);
}

export class RecordConflictError extends Error {
  readonly code = "RECORD_CONFLICT";
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedRev: number,
    readonly storedRev: number,
  ) {
    super(
      `conflict: ${entityType} ${entityId} changed since it was read (have rev ${expectedRev}, stored rev ${storedRev}) — reload and retry`,
    );
    this.name = "RecordConflictError";
  }
}

/** Throw when a caller-supplied expected rev (from the UI it rendered) is stale. */
export function assertExpectedRev(entityType: string, record: { id?: string; rev?: unknown } | null, expected: number | null): void {
  if (expected === null || !record) return;
  const stored = revOf(record);
  if (stored !== expected) throw new RecordConflictError(entityType, String(record.id ?? "?"), expected, stored);
}

// ---------------------------------------------------------------------------
// Entities surface (structural subset of PluginContext.entities)
// ---------------------------------------------------------------------------

export interface GuardEntityUpsert {
  entityType: string;
  scopeKind: "instance" | "project" | string;
  scopeId?: string;
  externalId?: string;
  title?: string;
  status?: string;
  data: Record<string, unknown>;
}
export interface GuardEntityRecord {
  id: string;
  externalId: string | null;
  data: Record<string, unknown>;
  createdAt?: string;
}
export interface GuardEntityQuery {
  entityType?: string;
  scopeKind?: "instance" | "project" | string;
  scopeId?: string;
  externalId?: string;
  limit?: number;
  offset?: number;
}
export interface GuardEntities {
  upsert(input: GuardEntityUpsert): Promise<GuardEntityRecord>;
  list(query: GuardEntityQuery): Promise<GuardEntityRecord[]>;
}

export interface RecordEvent {
  id: string;
  at: string;
  actor: string | null;
  surface: string;
  action: string | null;
  idempotencyKey: string | null;
  entityType: string;
  entityId: string;
  op: "create" | "update";
  rev: number;
  /** True when the write carried no rev (built from scratch, not read-modify-write). */
  blind: boolean;
  changes: Record<string, unknown>;
}

function revOf(data: { rev?: unknown } | null | undefined): number {
  return typeof data?.rev === "number" && Number.isFinite(data.rev) ? data.rev : 0;
}

function summarise(v: unknown): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s !== undefined && s.length <= MAX_INLINE_VALUE ? v : { _truncated: s?.length ?? 0 };
}

/** Top-level field diff between two record versions. Pure. */
export function diffRecord(prev: Record<string, unknown> | null, next: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next)]);
  for (const k of keys) {
    if (NOISE_FIELDS.has(k)) continue;
    const a = prev?.[k];
    const b = next[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (APPEND_FIELDS.has(k) && Array.isArray(b) && (a === undefined || Array.isArray(a))) {
      const before = Array.isArray(a) ? a.length : 0;
      changes[k] = { appended: b.length - before };
      continue;
    }
    changes[k] = { from: summarise(a), to: summarise(b) };
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Per-record serialisation
// ---------------------------------------------------------------------------

const tails = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardOptions {
  now?: () => Date;
  newId?: () => string;
  onEventError?: (err: unknown, event: RecordEvent) => void;
}

/** Wrap an entities client so every upsert is rev-checked and (for logged types) audited. */
export function guardEntities<E extends GuardEntities>(inner: E, opts: GuardOptions = {}): E {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;

  const guarded: GuardEntities = {
    list: (q) => inner.list(q),
    async upsert(input) {
      const { entityType, externalId } = input;
      if (BOOKKEEPING_TYPES.has(entityType) || !externalId) return inner.upsert(input);

      return withKeyLock(`${entityType}:${externalId}`, async () => {
        const rows = await inner.list({ entityType, externalId, limit: 1 });
        const current = rows[0]?.data ?? null;
        const storedRev = revOf(current);
        const blind = !("rev" in input.data);
        if (!blind) {
          const incoming = revOf(input.data);
          if (incoming !== storedRev) throw new RecordConflictError(entityType, externalId, incoming, storedRev);
        }
        const rev = storedRev + 1;
        // Mutate the caller's object too, so a second put of the same object in one action isn't a false conflict.
        input.data.rev = rev;
        const written = await inner.upsert(input);

        if (LOGGED_ENTITY_TYPES.has(entityType)) {
          const meta = currentWriteMeta();
          const at = now().toISOString();
          const event: RecordEvent = {
            id: newId(),
            at,
            actor: meta.actor,
            surface: meta.surface,
            action: meta.action,
            idempotencyKey: meta.idempotencyKey,
            entityType,
            entityId: externalId,
            op: current ? "update" : "create",
            rev,
            blind,
            changes: diffRecord(current, input.data),
          };
          if (event.op === "create" || Object.keys(event.changes).length > 0) {
            try {
              await inner.upsert({
                entityType: EVENT_ENTITY_TYPE,
                scopeKind: "instance",
                externalId: `ev:${at}:${event.id}`,
                title: `${event.op} ${entityType}:${externalId}`,
                status: meta.surface,
                data: event as unknown as Record<string, unknown>,
              });
            } catch (err) {
              // The record write already landed; a missing audit row must not fail the action.
              opts.onEventError?.(err, event);
            }
          }
        }
        return written;
      });
    },
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "upsert") return guarded.upsert;
      if (prop === "list") return guarded.list;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// Action boundary: meta extraction, idempotency, conflict retry
// ---------------------------------------------------------------------------

/**
 * Actions that are a single read-patch-write of one record: on a rev conflict
 * the guard re-runs them against fresh state, which re-applies the caller's
 * field patch on top of the other writer's change — the correct merge.
 * Multi-record actions are not retried (a retry could repeat a side effect).
 */
export const RETRYABLE_ACTIONS = new Set([
  "update-work-item",
  "update-line",
  "update-backlog-entry",
  "set-job-class",
  "record-capacity-day",
  "review-decision",
  "revoke-grant",
]);
const MAX_CONFLICT_RETRIES = 2;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Split guard meta out of raw action params. Pure. */
export function extractMeta(action: string, raw: Record<string, unknown>): { meta: WriteMeta; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(META_PARAM_KEYS as readonly string[]).includes(k)) params[k] = v;
  }
  const expected = raw?._expectedRev;
  return {
    meta: {
      actor: str(raw?.actor),
      surface: str(raw?._surface) ?? "bridge",
      action,
      idempotencyKey: str(raw?._idempotencyKey),
      expectedRev: typeof expected === "number" && Number.isInteger(expected) ? expected : null,
    },
    params,
  };
}

function storable(result: unknown): unknown {
  const s = JSON.stringify(result ?? null);
  return s.length <= MAX_STORED_RESULT ? (result ?? null) : { _truncated: s.length, ok: true };
}

/**
 * Run one action invocation under the guard: meta in AsyncLocalStorage,
 * idempotent replay, bounded retry on rev conflicts.
 */
export async function runAction(
  entities: GuardEntities,
  action: string,
  raw: Record<string, unknown>,
  handler: (params: Record<string, unknown>) => Promise<unknown>,
  opts: { now?: () => Date } = {},
): Promise<unknown> {
  const { meta, params } = extractMeta(action, raw);
  const execute = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withWriteMeta(meta, () => handler(params));
      } catch (err) {
        const retry =
          err instanceof RecordConflictError &&
          meta.expectedRev === null &&
          RETRYABLE_ACTIONS.has(action) &&
          attempt < MAX_CONFLICT_RETRIES;
        if (!retry) throw err;
      }
    }
  };
  if (!meta.idempotencyKey) return execute();

  const key = meta.idempotencyKey;
  return withKeyLock(`${IDEMPOTENCY_ENTITY_TYPE}:${key}`, async () => {
    const seen = await entities.list({ entityType: IDEMPOTENCY_ENTITY_TYPE, externalId: key, limit: 1 });
    if (seen[0]) {
      const prior = seen[0].data as { action?: string; result?: unknown };
      if (prior.action && prior.action !== action) {
        throw new Error(`idempotency key ${key} was already used for action ${prior.action}`);
      }
      return prior.result ?? null;
    }
    const result = await execute();
    await entities.upsert({
      entityType: IDEMPOTENCY_ENTITY_TYPE,
      scopeKind: "instance",
      externalId: key,
      title: action,
      status: meta.surface,
      data: { action, at: (opts.now ?? (() => new Date()))().toISOString(), actor: meta.actor, surface: meta.surface, result: storable(result) },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

/**
 * Newest-first events, optionally for one record. Pages the whole log (the
 * entities API filters only by type/externalId and orders oldest-first);
 * fine at personal scale — revisit with a core query past ~50k events.
 */
export async function listEvents(
  entities: GuardEntities,
  filter: { entityType?: string; entityId?: string; surface?: string; limit?: number } = {},
): Promise<RecordEvent[]> {
  const page = 1000;
  const all: RecordEvent[] = [];
  for (let offset = 0; ; offset += page) {
    const rows = await entities.list({ entityType: EVENT_ENTITY_TYPE, scopeKind: "instance", limit: page, offset });
    for (const r of rows) {
      const e = r.data as unknown as RecordEvent;
      if (filter.entityType && e.entityType !== filter.entityType) continue;
      if (filter.entityId && e.entityId !== filter.entityId) continue;
      if (filter.surface && e.surface !== filter.surface) continue;
      all.push(e);
    }
    if (rows.length < page) break;
  }
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, Math.max(1, Math.min(filter.limit ?? 50, 1000)));
}
