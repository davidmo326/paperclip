/**
 * Decision deps backed by `ctx.entities` — T-4.4.
 *
 * The pacc plugin has no SDK access to the core `decisions` table, so decisions
 * are persisted as plugin-owned entities (entityType "decision", scoped to the
 * project). The full DecisionRecord is stored in the entity `data` blob; the
 * record id is the entity `externalId` (globally unique uuid).
 */

import { randomUUID } from "node:crypto";
import type { CaptureDecisionDeps } from "./capture-decision.js";
import type { DecisionRecord } from "./decision-log.js";

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
  id: string;
  externalId: string | null;
  data: Record<string, unknown>;
}
interface EntityQuery {
  entityType?: string;
  scopeKind?: "instance" | "project";
  scopeId?: string;
  externalId?: string;
  limit?: number;
}

/** Minimal entities surface (subset of PluginContext.entities). */
export interface DecisionCtx {
  entities: {
    upsert(input: EntityUpsert): Promise<EntityRecord>;
    list(query: EntityQuery): Promise<EntityRecord[]>;
  };
}

export const DECISION_ENTITY_TYPE = "decision";

function toEntity(r: DecisionRecord): EntityUpsert {
  return {
    entityType: DECISION_ENTITY_TYPE,
    scopeKind: "project",
    scopeId: r.projectId,
    externalId: r.id,
    title: r.summary,
    status: r.status,
    data: r as unknown as Record<string, unknown>,
  };
}

function toRecord(e: EntityRecord): DecisionRecord {
  return e.data as unknown as DecisionRecord;
}

export function makeDecisionDeps(ctx: DecisionCtx): CaptureDecisionDeps {
  return {
    async getDecision(id) {
      const rows = await ctx.entities.list({ entityType: DECISION_ENTITY_TYPE, externalId: id, limit: 1 });
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listProjectDecisions(projectId) {
      const rows = await ctx.entities.list({
        entityType: DECISION_ENTITY_TYPE,
        scopeKind: "project",
        scopeId: projectId,
        limit: 1000,
      });
      return rows.map(toRecord);
    },
    async putDecision(record) {
      await ctx.entities.upsert(toEntity(record));
    },
    newId() {
      return randomUUID();
    },
  };
}
