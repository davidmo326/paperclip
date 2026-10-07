import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db/test-embedded-postgres";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";
import type { Config } from "../config.js";

// Review 2026-10-07 F5: better-auth was bumped 1.4.18 -> 1.6.x while the fork
// stays on drizzle-orm 0.38 (better-auth's drizzle adapter declares a ^0.45
// peer). This exercises the real email/password flow through the drizzle
// adapter against the fork's migrated schema, plus the sign-up kill switch.

const support = await getEmbeddedPostgresTestSupport();
const describeIfPostgres = support.supported ? describe : describe.skip;

const ORIGIN = "http://127.0.0.1";

function authApp(db: ReturnType<typeof createDb>, disableSignUp: boolean) {
  const config = {
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: disableSignUp,
  } as unknown as Config;
  const auth = createBetterAuthInstance(db, config, [ORIGIN]);
  const app = express();
  app.all("/api/auth/*authPath", createBetterAuthHandler(auth));
  return { app, auth };
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split(";")[0]).join("; ");
}

describeIfPostgres("better-auth email/password flow (drizzle adapter)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof createDb>;
  const prevSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-better-auth-flow-0123456789";
    const started = await startEmbeddedPostgresTestDatabase("pc-auth-flow-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = prevSecret;
    await cleanup?.();
  });

  it("signs up, signs in, resolves the session, signs out", async () => {
    const { app, auth } = authApp(db, false);
    const creds = { email: "flow@example.com", password: "correct-horse-battery-9", name: "Flow" };

    const signUp = await request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN).send(creds);
    expect(signUp.status).toBe(200);

    const bad = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: creds.email, password: "wrong-password-123" });
    expect(bad.status).toBe(401);

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: creds.email, password: creds.password });
    expect(signIn.status).toBe(200);
    const cookie = cookieHeader(signIn);
    expect(cookie).toContain("session_token");

    const session = await resolveBetterAuthSessionFromHeaders(auth, new Headers({ cookie }));
    expect(session?.user?.email).toBe(creds.email);

    const signOut = await request(app).post("/api/auth/sign-out").set("origin", ORIGIN).set("cookie", cookie).send({});
    expect(signOut.status).toBe(200);
    const after = await resolveBetterAuthSessionFromHeaders(auth, new Headers({ cookie }));
    expect(after?.user ?? null).toBeNull();
  }, 60_000);

  it("rejects sign-up when disableSignUp is set, but still allows sign-in", async () => {
    const { app } = authApp(db, true);
    const res = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "blocked@example.com", password: "another-password-77", name: "Blocked" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: "flow@example.com", password: "correct-horse-battery-9" });
    expect(signIn.status).toBe(200);
  }, 60_000);
});
