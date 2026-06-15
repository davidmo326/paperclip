/**
 * T-4.6 — authority grant tests (pure core + orchestration).
 */
import { describe, expect, it } from "vitest";
import {
  makeGrantRecord,
  applyRevoke,
  isActiveAt,
  checkAuthority,
  parseExpiresIn,
  selectExpiringGrants,
  type GrantInput,
  type GrantRecord,
} from "../lib/authority/authority-grant.js";
import {
  recordGrant,
  revokeGrant,
  listActiveGrants,
  evaluateAuthority,
  type GrantDeps,
} from "../lib/authority/capture-grant.js";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function input(over: Partial<GrantInput> = {}): GrantInput {
  return {
    projectId: "circlo",
    agentId: null,
    actionClass: "state",
    ceiling: "L2",
    expiresAt: parseExpiresIn("30d", NOW),
    notes: null,
    ...over,
  };
}

describe("parseExpiresIn", () => {
  it("parses d/h/w", () => {
    expect(parseExpiresIn("30d", NOW)).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
    expect(parseExpiresIn("12h", NOW)).toBe(new Date(NOW.getTime() + 12 * 3_600_000).toISOString());
    expect(parseExpiresIn("2w", NOW)).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());
  });
  it("rejects garbage", () => {
    expect(() => parseExpiresIn("soon", NOW)).toThrow();
  });
});

describe("makeGrantRecord", () => {
  it("creates an active grant by the principal", () => {
    const g = makeGrantRecord(input(), { id: "g1", now: NOW, grantedBy: "principal" });
    expect(g.status).toBe("active");
    expect(g.grantedBy).toBe("principal");
    expect(g.revokedAt).toBeNull();
  });
  it("refuses non-principal grantor (authority is never auto-granted)", () => {
    expect(() => makeGrantRecord(input(), { id: "g1", now: NOW, grantedBy: "agent:steward" })).toThrowError(/principal/);
  });
  it("rejects bad ceiling / action class / past expiry", () => {
    expect(() => makeGrantRecord(input({ ceiling: "L9" as never }), { id: "g", now: NOW, grantedBy: "principal" })).toThrow();
    expect(() => makeGrantRecord(input({ actionClass: "nope" as never }), { id: "g", now: NOW, grantedBy: "principal" })).toThrow();
    expect(() =>
      makeGrantRecord(input({ expiresAt: "2020-01-01T00:00:00.000Z" }), { id: "g", now: NOW, grantedBy: "principal" }),
    ).toThrow();
  });
});

describe("applyRevoke + isActiveAt", () => {
  it("revokes without deleting; rejects double revoke", () => {
    const g = makeGrantRecord(input(), { id: "g1", now: NOW, grantedBy: "principal" });
    const r = applyRevoke(g, NOW);
    expect(r.status).toBe("revoked");
    expect(r.revokedAt).toBe(NOW.toISOString());
    expect(() => applyRevoke(r, NOW)).toThrow();
  });
  it("isActiveAt false once expired", () => {
    const g = makeGrantRecord(input({ expiresAt: parseExpiresIn("1d", NOW) }), { id: "g1", now: NOW, grantedBy: "principal" });
    expect(isActiveAt(g, NOW)).toBe(true);
    expect(isActiveAt(g, new Date(NOW.getTime() + 2 * 86_400_000))).toBe(false);
  });
});

describe("checkAuthority", () => {
  const grant = (over: Partial<GrantRecord> = {}): GrantRecord => ({
    ...makeGrantRecord(input(), { id: "g", now: NOW, grantedBy: "principal" }),
    ...over,
  });

  it("allows when a live grant covers project+class at or above the level", () => {
    expect(checkAuthority([grant()], { projectId: "circlo", actionClass: "state", level: "L2", now: NOW })).toBe(true);
    // higher ceiling covers a lower request
    expect(checkAuthority([grant({ ceiling: "L3" })], { projectId: "circlo", actionClass: "state", level: "L2", now: NOW })).toBe(true);
  });
  it("denies when level exceeds the ceiling, wrong class, or wrong project", () => {
    expect(checkAuthority([grant()], { projectId: "circlo", actionClass: "state", level: "L3", now: NOW })).toBe(false);
    expect(checkAuthority([grant()], { projectId: "circlo", actionClass: "material", level: "L2", now: NOW })).toBe(false);
    expect(checkAuthority([grant()], { projectId: "other", actionClass: "state", level: "L2", now: NOW })).toBe(false);
  });
  it("portfolio-wide grant (projectId null) covers any project", () => {
    expect(checkAuthority([grant({ projectId: null })], { projectId: "anything", actionClass: "state", level: "L2", now: NOW })).toBe(true);
  });
  it("denies once revoked", () => {
    expect(checkAuthority([applyRevoke(grant(), NOW)], { projectId: "circlo", actionClass: "state", level: "L2", now: NOW })).toBe(false);
  });
});

describe("selectExpiringGrants", () => {
  it("returns active grants within the horizon", () => {
    const soon = makeGrantRecord(input({ expiresAt: parseExpiresIn("3d", NOW) }), { id: "soon", now: NOW, grantedBy: "principal" });
    const later = makeGrantRecord(input({ expiresAt: parseExpiresIn("30d", NOW) }), { id: "later", now: NOW, grantedBy: "principal" });
    expect(selectExpiringGrants([soon, later], NOW, 7).map((g) => g.id)).toEqual(["soon"]);
  });
});

class InMemoryGrants implements GrantDeps {
  store = new Map<string, GrantRecord>();
  seq = 0;
  async getGrant(id: string) {
    return this.store.get(id) ?? null;
  }
  async listGrants() {
    return [...this.store.values()];
  }
  async putGrant(record: GrantRecord) {
    this.store.set(record.id, record);
  }
  newId() {
    this.seq += 1;
    return `g-${this.seq}`;
  }
}

describe("grant orchestration — the M-L2 round-trip", () => {
  it("denied before grant, allowed after, denied after revoke", async () => {
    const deps = new InMemoryGrants();
    const req = { projectId: "circlo", actionClass: "state" as const, level: "L2" as const, now: NOW };

    expect(await evaluateAuthority(deps, req)).toBe(false); // before

    const g = await recordGrant(deps, input(), { now: NOW, grantedBy: "principal" });
    expect(await evaluateAuthority(deps, req)).toBe(true); // after grant
    expect((await listActiveGrants(deps, NOW)).map((x) => x.id)).toEqual([g.id]);

    await revokeGrant(deps, g.id, NOW);
    expect(await evaluateAuthority(deps, req)).toBe(false); // after revoke
    expect(await listActiveGrants(deps, NOW)).toEqual([]);
    // not deleted — still in the store, just revoked
    expect((await deps.getGrant(g.id))?.status).toBe("revoked");
  });
});
