import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

// Review 2026-10-07 F3: plugin data/actions/bridge/install routes must reject a
// board user who is not an instance admin (e.g. a self-registered account),
// before any plugin or DB work happens.
function appWithActor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", pluginRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const nonAdmin = { type: "board", userId: "u1", companyIds: [], isInstanceAdmin: false, source: "session" };

describe("plugin routes require instance admin", () => {
  for (const [method, path] of [
    ["post", "/api/plugins/paperclip-pacc/actions/record-grant"],
    ["post", "/api/plugins/paperclip-pacc/data/overview"],
    ["post", "/api/plugins/paperclip-pacc/bridge/action"],
    ["post", "/api/plugins/install"],
    ["get", "/api/plugins"],
  ] as const) {
    it(`${method.toUpperCase()} ${path} -> 403 for a non-admin board user`, async () => {
      const res = await (request(appWithActor(nonAdmin)) as any)[method](path).send({ params: {} });
      expect(res.status).toBe(403);
    });
  }

  it("rejects unauthenticated callers", async () => {
    const res = await request(appWithActor({ type: "none", source: "none" }))
      .post("/api/plugins/paperclip-pacc/actions/record-grant")
      .send({});
    expect(res.status).toBe(403);
  });
});
