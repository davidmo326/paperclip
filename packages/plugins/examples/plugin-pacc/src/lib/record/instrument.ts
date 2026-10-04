/**
 * Wire the record write guard into the plugin context — T-db.2.
 *
 * One call at the top of `setup()` routes every surface through the guard:
 * `ctx.entities.upsert` is rev-checked and audited, `ctx.actions.register`
 * handlers run under `runAction` (meta, idempotency, conflict retry), and
 * `ctx.jobs.register` handlers run with surface `job:<key>`.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { guardEntities, runAction, withWriteMeta, type RecordEvent } from "./write-guard.js";

export function instrumentContext(ctx: PluginContext): PluginContext {
  const entities = guardEntities(ctx.entities, {
    onEventError: (err: unknown, event: RecordEvent) =>
      ctx.logger.warn("pacc: record event not written", {
        entity: `${event.entityType}:${event.entityId}`,
        rev: event.rev,
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  const actions: PluginContext["actions"] = {
    register(key, handler) {
      ctx.actions.register(key, (params) => runAction(entities, key, params ?? {}, handler));
    },
  };
  const jobs: PluginContext["jobs"] = {
    register(key, fn) {
      ctx.jobs.register(key, (job) => withWriteMeta({ actor: "pacc", surface: `job:${key}`, action: key }, () => fn(job)));
    },
  };
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === "entities") return entities;
      if (prop === "actions") return actions;
      if (prop === "jobs") return jobs;
      return Reflect.get(target, prop, receiver);
    },
  });
}
