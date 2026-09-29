/**
 * Work-item + capacity-day persistence backed by `ctx.entities` — T-floor.
 *
 * Same pattern as decision-deps: plugin-owned entities, full record in `data`,
 * record id in `externalId`. Instance-scoped (projectId lives in `data`) so the
 * floor can list every line's items in one query.
 */

import { randomUUID } from "node:crypto";
import type { DecisionCtx } from "../decisions/decision-deps.js";
import type { CapacityDay, WorkItem } from "./work-items.js";

export const WORK_ITEM_ENTITY_TYPE = "work-item";
export const CAPACITY_DAY_ENTITY_TYPE = "capacity-day";

export interface WorkItemDeps {
  getItem(id: string): Promise<WorkItem | null>;
  listItems(): Promise<WorkItem[]>;
  putItem(item: WorkItem): Promise<void>;
  putCapacityDay(day: CapacityDay): Promise<void>;
  listCapacityDays(): Promise<CapacityDay[]>;
  newId(): string;
}

export function makeWorkItemDeps(ctx: DecisionCtx): WorkItemDeps {
  return {
    async getItem(id) {
      const rows = await ctx.entities.list({ entityType: WORK_ITEM_ENTITY_TYPE, externalId: id, limit: 1 });
      return rows[0] ? (rows[0].data as unknown as WorkItem) : null;
    },
    async listItems() {
      const rows = await ctx.entities.list({ entityType: WORK_ITEM_ENTITY_TYPE, scopeKind: "instance", limit: 5000 });
      return rows.map((r) => r.data as unknown as WorkItem);
    },
    async putItem(item) {
      await ctx.entities.upsert({
        entityType: WORK_ITEM_ENTITY_TYPE,
        scopeKind: "instance",
        externalId: item.id,
        title: item.title,
        status: item.stage,
        data: item as unknown as Record<string, unknown>,
      });
    },
    async putCapacityDay(day) {
      await ctx.entities.upsert({
        entityType: CAPACITY_DAY_ENTITY_TYPE,
        scopeKind: "instance",
        externalId: day.date,
        title: `capacity ${day.date}`,
        status: day.score === null ? "no-note" : String(day.score),
        data: day as unknown as Record<string, unknown>,
      });
    },
    async listCapacityDays() {
      const rows = await ctx.entities.list({ entityType: CAPACITY_DAY_ENTITY_TYPE, scopeKind: "instance", limit: 400 });
      return rows.map((r) => r.data as unknown as CapacityDay).sort((a, b) => a.date.localeCompare(b.date));
    },
    newId() {
      return randomUUID();
    },
  };
}
