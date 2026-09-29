/**
 * Project-line persistence backed by `ctx.entities` (ADR 0003: the pacc store
 * is the record). Same pattern as work items: instance-scoped, full record in
 * `data`, the line id (slug) in `externalId`.
 */

import type { DecisionCtx } from "../decisions/decision-deps.js";
import type { ProjectLine } from "./lines.js";

export const PROJECT_LINE_ENTITY_TYPE = "project-line";

export interface LineDeps {
  getLine(id: string): Promise<ProjectLine | null>;
  listLines(): Promise<ProjectLine[]>;
  putLine(line: ProjectLine): Promise<void>;
}

export function makeLineDeps(ctx: DecisionCtx): LineDeps {
  return {
    async getLine(id) {
      const rows = await ctx.entities.list({ entityType: PROJECT_LINE_ENTITY_TYPE, externalId: id, limit: 1 });
      return rows[0] ? (rows[0].data as unknown as ProjectLine) : null;
    },
    async listLines() {
      const rows = await ctx.entities.list({
        entityType: PROJECT_LINE_ENTITY_TYPE,
        scopeKind: "instance",
        limit: 1000,
      });
      return rows.map((r) => r.data as unknown as ProjectLine).sort((a, b) => a.id.localeCompare(b.id));
    },
    async putLine(line) {
      await ctx.entities.upsert({
        entityType: PROJECT_LINE_ENTITY_TYPE,
        scopeKind: "instance",
        externalId: line.id,
        title: line.name,
        status: line.portfolioState,
        data: line as unknown as Record<string, unknown>,
      });
    },
  };
}
