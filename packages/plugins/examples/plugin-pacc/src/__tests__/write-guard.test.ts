import { describe, expect, it } from "vitest";
import {
  EVENT_ENTITY_TYPE,
  RecordConflictError,
  diffRecord,
  extractMeta,
  guardEntities,
  listEvents,
  runAction,
  withWriteMeta,
  type GuardEntities,
  type GuardEntityRecord,
  type GuardEntityUpsert,
  type RecordEvent,
} from "../lib/record/write-guard.js";

/** In-memory entities with an await between read and write, so interleavings are real. */
function memEntities(): GuardEntities & { rows: Map<string, GuardEntityRecord & { entityType: string }> } {
  const rows = new Map<string, GuardEntityRecord & { entityType: string }>();
  let seq = 0;
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    rows,
    async upsert(input: GuardEntityUpsert) {
      await tick();
      const key = `${input.entityType}:${input.externalId}`;
      const prior = rows.get(key);
      const rec = {
        id: prior?.id ?? `id-${++seq}`,
        entityType: input.entityType,
        externalId: input.externalId ?? null,
        data: structuredClone(input.data),
        createdAt: prior?.createdAt ?? new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      };
      rows.set(key, rec);
      return rec;
    },
    async list(q) {
      await tick();
      const out = [...rows.values()].filter(
        (r) => (!q.entityType || r.entityType === q.entityType) && (!q.externalId || r.externalId === q.externalId),
      );
      out.sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
      return out.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100)).map((r) => ({ ...r, data: structuredClone(r.data) }));
    },
  };
}

const line = (extra: Record<string, unknown> = {}) => ({ id: "hometrics", name: "Hometrics", keyQuestion: "who pays?", edits: [], ...extra });

async function getData(e: GuardEntities, type: string, id: string) {
  return (await e.list({ entityType: type, externalId: id, limit: 1 }))[0]?.data ?? null;
}

async function events(e: GuardEntities): Promise<RecordEvent[]> {
  return (await e.list({ entityType: EVENT_ENTITY_TYPE, limit: 1000 })).map((r) => r.data as unknown as RecordEvent);
}

describe("guardEntities — optimistic concurrency", () => {
  it("bumps rev on each write and stamps it on the caller's object", async () => {
    const e = guardEntities(memEntities());
    const data: Record<string, unknown> = line();
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data });
    expect(data.rev).toBe(1);
    // A second put of the same object in one action is not a false conflict.
    data.keyQuestion = "who pays first?";
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data });
    expect((await getData(e, "project-line", "hometrics"))?.rev).toBe(2);
  });

  it("rejects a write whose rev is stale", async () => {
    const e = guardEntities(memEntities());
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { id: "w1", title: "a" } });
    const readA = await getData(e, "work-item", "w1");
    const readB = await getData(e, "work-item", "w1");
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { ...readA!, title: "A" } });
    await expect(
      e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { ...readB!, title: "B" } }),
    ).rejects.toBeInstanceOf(RecordConflictError);
    expect((await getData(e, "work-item", "w1"))?.title).toBe("A");
  });

  it("allows blind writes (no rev key) and flags them in the event", async () => {
    const e = guardEntities(memEntities());
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: line() });
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: line({ keyQuestion: "x" }) });
    const evs = await events(e);
    expect(evs.map((ev) => [ev.op, ev.rev, ev.blind])).toEqual([
      ["create", 1, true],
      ["update", 2, true],
    ]);
  });

  it("leaves untyped bookkeeping and id-less writes unguarded", async () => {
    const inner = memEntities();
    const e = guardEntities(inner);
    await e.upsert({ entityType: "anything", scopeKind: "instance", data: { a: 1 } });
    expect([...inner.rows.values()][0].data.rev).toBeUndefined();
  });
});

describe("guardEntities — event log", () => {
  it("records actor, surface, action and the field diff", async () => {
    const e = guardEntities(memEntities(), { now: () => new Date("2026-10-04T05:00:00Z"), newId: () => "e1" });
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: line() });
    const read = await getData(e, "project-line", "hometrics");
    await withWriteMeta({ actor: "principal", surface: "cockpit", action: "update-line" }, () =>
      e.upsert({
        entityType: "project-line",
        scopeKind: "instance",
        externalId: "hometrics",
        data: { ...read!, keyQuestion: "who pays first?", edits: [{ at: "t" }], updatedAt: "t" },
      }),
    );
    const update = (await events(e)).find((ev) => ev.op === "update")!;
    expect(update).toMatchObject({ actor: "principal", surface: "cockpit", action: "update-line", rev: 2, blind: false });
    expect(update.changes).toEqual({ keyQuestion: { from: "who pays?", to: "who pays first?" }, edits: { appended: 1 } });
  });

  it("skips the event when nothing but rev/updatedAt changed, and never logs job-class", async () => {
    const e = guardEntities(memEntities());
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { id: "w1" } });
    const read = await getData(e, "work-item", "w1");
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { ...read!, updatedAt: "later" } });
    await e.upsert({ entityType: "job-class", scopeKind: "instance", externalId: "j1", data: { id: "j1" } });
    expect((await events(e)).map((ev) => `${ev.op}:${ev.entityType}`)).toEqual(["create:work-item"]);
  });

  it("does not fail the write when the event cannot be stored", async () => {
    const inner = memEntities();
    const realUpsert = inner.upsert.bind(inner);
    inner.upsert = async (input) => {
      if (input.entityType === EVENT_ENTITY_TYPE) throw new Error("disk full");
      return realUpsert(input);
    };
    const errors: unknown[] = [];
    const e = guardEntities(inner, { onEventError: (err) => errors.push(err) });
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { id: "w1" } });
    expect(await getData(e, "work-item", "w1")).toMatchObject({ id: "w1", rev: 1 });
    expect(errors).toHaveLength(1);
  });

  it("diffRecord truncates large values", () => {
    const big = "x".repeat(1000);
    expect(diffRecord({ a: 1, body: "short" }, { a: 1, body: big })).toEqual({ body: { from: "short", to: { _truncated: 1002 } } });
  });
});

describe("runAction", () => {
  const patchLine = (e: GuardEntities) => async (params: Record<string, unknown>) => {
    const read = await getData(e, "project-line", "hometrics");
    const next = { ...read!, ...(params.patch as Record<string, unknown>) };
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: next });
    return { line: next };
  };

  it("concurrent patches to one record both land (retry re-applies on fresh state)", async () => {
    const e = guardEntities(memEntities());
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: line() });
    await getData(e, "project-line", "hometrics").then((d) =>
      e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: d! }),
    );
    await Promise.all([
      runAction(e, "update-line", { patch: { keyQuestion: "Q2" }, _surface: "cockpit" }, patchLine(e)),
      runAction(e, "update-line", { patch: { nextAction: "call Sam" }, _surface: "job:steward" }, patchLine(e)),
    ]);
    expect(await getData(e, "project-line", "hometrics")).toMatchObject({ keyQuestion: "Q2", nextAction: "call Sam", rev: 4 });
  });

  it("does not retry multi-record actions", async () => {
    const e = guardEntities(memEntities());
    await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: { id: "hometrics", rev: undefined } });
    const stale = { id: "hometrics", rev: 0 };
    let runs = 0;
    await expect(
      runAction(e, "promote-backlog-entry", {}, async () => {
        runs++;
        await e.upsert({ entityType: "project-line", scopeKind: "instance", externalId: "hometrics", data: { ...stale } });
      }),
    ).rejects.toBeInstanceOf(RecordConflictError);
    expect(runs).toBe(1);
  });

  it("strips guard params and exposes meta to the handler", async () => {
    const e = guardEntities(memEntities());
    let seen: Record<string, unknown> = {};
    await runAction(e, "update-line", { id: "x", actor: "principal", _surface: "telegram", _expectedRev: 3 }, async (p) => {
      seen = p;
    });
    expect(seen).toEqual({ id: "x", actor: "principal" });
    expect(extractMeta("a", { _surface: " cli ", _expectedRev: 2.5 }).meta).toMatchObject({ surface: "cli", expectedRev: null, actor: null });
  });

  it("replays an idempotent call without re-running it", async () => {
    const e = guardEntities(memEntities());
    let runs = 0;
    const handler = async () => ({ n: ++runs });
    const first = await runAction(e, "create-work-item", { _idempotencyKey: "tg:123" }, handler);
    const again = await runAction(e, "create-work-item", { _idempotencyKey: "tg:123" }, handler);
    expect(first).toEqual({ n: 1 });
    expect(again).toEqual({ n: 1 });
    expect(runs).toBe(1);
    await expect(runAction(e, "update-line", { _idempotencyKey: "tg:123" }, handler)).rejects.toThrow(/already used/);
  });

  it("parallel duplicates of one idempotency key run once", async () => {
    const e = guardEntities(memEntities());
    let runs = 0;
    const handler = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true };
    };
    await Promise.all([1, 2, 3].map(() => runAction(e, "record-run-result", { _idempotencyKey: "k" }, handler)));
    expect(runs).toBe(1);
  });

  it("does not record an idempotency key when the action fails", async () => {
    const e = guardEntities(memEntities());
    await expect(runAction(e, "a", { _idempotencyKey: "k2" }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await runAction(e, "a", { _idempotencyKey: "k2" }, async () => "ok")).toBe("ok");
  });
});

describe("listEvents", () => {
  it("filters by record and returns newest first", async () => {
    let t = 0;
    const e = guardEntities(memEntities(), { now: () => new Date(Date.UTC(2026, 9, 4, 0, 0, t++)) });
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { id: "w1" } });
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w2", data: { id: "w2" } });
    const w1 = await getData(e, "work-item", "w1");
    await e.upsert({ entityType: "work-item", scopeKind: "instance", externalId: "w1", data: { ...w1!, title: "t" } });
    const got = await listEvents(e, { entityId: "w1" });
    expect(got.map((ev) => `${ev.op}:${ev.rev}`)).toEqual(["update:2", "create:1"]);
    expect(await listEvents(e, { limit: 1 })).toHaveLength(1);
  });
});
