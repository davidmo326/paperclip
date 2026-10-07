import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotatingLogFile } from "../middleware/rotating-log-file.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-log-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("RotatingLogFile", () => {
  it("creates the file 0600 even under a permissive umask", () => {
    const prev = process.umask(0o002);
    try {
      const file = path.join(dir, "a.log");
      const sink = new RotatingLogFile({ file, maxBytes: 1024, maxFiles: 2 });
      sink.write("hello\n");
      sink.close();
      expect(mode(file)).toBe(0o600);
    } finally {
      process.umask(prev);
    }
  });

  it("tightens an existing file to 0600", () => {
    const file = path.join(dir, "b.log");
    fs.writeFileSync(file, "old\n", { mode: 0o664 });
    fs.chmodSync(file, 0o664);
    new RotatingLogFile({ file, maxBytes: 1024, maxFiles: 2 }).close();
    expect(mode(file)).toBe(0o600);
  });

  it("rotates by size and keeps at most maxFiles rotated copies", () => {
    const file = path.join(dir, "c.log");
    const sink = new RotatingLogFile({ file, maxBytes: 10, maxFiles: 2 });
    for (const line of ["111111\n", "222222\n", "333333\n", "444444\n"]) sink.write(line);
    sink.close();
    expect(fs.readFileSync(file, "utf8")).toBe("444444\n");
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("333333\n");
    expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("222222\n");
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    for (const p of [file, `${file}.1`, `${file}.2`]) expect(mode(p)).toBe(0o600);
  });

  it("never touches other files in the directory", () => {
    const legacy = path.join(dir, "server.log");
    fs.writeFileSync(legacy, "legacy\n");
    const sink = new RotatingLogFile({ file: path.join(dir, "new.log"), maxBytes: 5, maxFiles: 1 });
    for (let i = 0; i < 5; i++) sink.write("xxxxxx\n");
    sink.close();
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy\n");
  });
});

describe("server httpLogger (file sink)", () => {
  it("writes redacted, 0600 output to paperclip-server.log", async () => {
    vi.stubEnv("PAPERCLIP_LOG_DIR", dir);
    vi.resetModules();
    const { httpLogger } = await import("../middleware/logger.js");
    const app = express();
    app.use(express.json());
    app.use(httpLogger);
    app.post("/api/auth/sign-in/email", (_req, res) => {
      res.status(401).json({ error: "nope" });
    });

    await request(app)
      .post("/api/auth/sign-in/email?t=query-canary-77")
      .set("authorization", "Bearer pcp_board_canary-board-key")
      .set("cookie", "better-auth.session_token=cookie-canary-42")
      .send({ email: "a@example.com", password: "password-canary-9" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const file = path.join(dir, "paperclip-server.log");
    const output = fs.readFileSync(file, "utf8");
    expect(output).toContain("/api/auth/sign-in/email");
    expect(output).not.toMatch(/canary-board-key|pcp_board_|cookie-canary|password-canary|query-canary/);
    expect(mode(file)).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "server.log"))).toBe(false);
  });
});
