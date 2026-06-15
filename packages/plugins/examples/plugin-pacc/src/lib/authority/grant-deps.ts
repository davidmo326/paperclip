/**
 * Authority-grant deps backed by `ctx.entities` — T-4.6.
 *
 * All grants live under a single instance scope (entityType "authority-grant"),
 * with projectId stored as a data field (null = portfolio-wide), so `--list`
 * needs no per-project enumeration. The grant id is the entity externalId.
 */

import { randomUUID } from "node:crypto";
import type { GrantDeps } from "./capture-grant.js";
import type { GrantRecord } from "./authority-grant.js";

interface EntityUpsert {
  entityType: string;
  scopeKind: "instance" | "project";
  scopeId?: string;
  externalId?: string;
  title?: string;
  status?: string;
  data: Record<string, unknown>;
}
interface EntityRecord {
  externalId: string | null;
  data: Record<string, unknown>;
}
interface EntityQuery {
  entityType?: string;
  scopeKind?: "instance" | "project";
  externalId?: string;
  limit?: number;
}

export interface GrantCtx {
  entities: {
    upsert(input: EntityUpsert): Promise<EntityRecord>;
    list(query: EntityQuery): Promise<EntityRecord[]>;
  };
}

export const GRANT_ENTITY_TYPE = "authority-grant";

function toEntity(g: GrantRecord): EntityUpsert {
  const where = g.projectId ?? "portfolio";
  return {
    entityType: GRANT_ENTITY_TYPE,
    scopeKind: "instance",
    externalId: g.id,
    title: `${g.ceiling} ${g.actionClass} @ ${where}`,
    status: g.status,
    data: g as unknown as Record<string, unknown>,
  };
}

function toRecord(e: EntityRecord): GrantRecord {
  return e.data as unknown as GrantRecord;
}

export function makeGrantDeps(ctx: GrantCtx): GrantDeps {
  return {
    async getGrant(id) {
      const rows = await ctx.entities.list({ entityType: GRANT_ENTITY_TYPE, externalId: id, limit: 1 });
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listGrants() {
      const rows = await ctx.entities.list({ entityType: GRANT_ENTITY_TYPE, scopeKind: "instance", limit: 2000 });
      return rows.map(toRecord);
    },
    async putGrant(record) {
      await ctx.entities.upsert(toEntity(record));
    },
    newId() {
      return randomUUID();
    },
  };
}
