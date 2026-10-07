import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseExtraListenHosts, startExtraListeners } from "../extra-listeners.js";

const servers: Array<{ close: (cb?: () => void) => void }> = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function get(host: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: "/ping" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const quiet = { info() {}, warn() {} };

describe("parseExtraListenHosts", () => {
  it("splits, trims, dedupes and drops the main host", () => {
    expect(parseExtraListenHosts(" 100.76.153.85, 127.0.0.1 ,100.76.153.85,", "127.0.0.1")).toEqual(["100.76.153.85"]);
    expect(parseExtraListenHosts(undefined, "127.0.0.1")).toEqual([]);
  });
});

describe("startExtraListeners", () => {
  it("serves the same app on an extra address (Linux loopback 127.0.0.2)", async () => {
    const server = createServer((_req, res) => res.end("pong"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const relays = startExtraListeners(server, ["127.0.0.2"], port, quiet);
    await new Promise<void>((r) => (relays[0]!.listening ? r() : relays[0]!.once("listening", () => r())));

    expect(await get("127.0.0.1", port)).toEqual({ status: 200, body: "pong" });
    expect(await get("127.0.0.2", port)).toEqual({ status: 200, body: "pong" });
  });

  it("routes HTTP upgrades on the extra address to the server's upgrade handler", async () => {
    const server = createServer((_req, res) => res.end("pong"));
    server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const relays = startExtraListeners(server, ["127.0.0.2"], port, quiet);
    await new Promise<void>((r) => (relays[0]!.listening ? r() : relays[0]!.once("listening", () => r())));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.2", port, path: "/live", headers: { connection: "Upgrade", upgrade: "test" } });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(101);
  });

  it("retries an address that is not available instead of throwing", async () => {
    const server = createServer((_req, res) => res.end("pong"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const warnings: unknown[] = [];
    // 192.0.2.1 (TEST-NET-1) is not assigned locally: bind fails EADDRNOTAVAIL.
    startExtraListeners(server, ["192.0.2.1"], port, { info() {}, warn: (o) => warnings.push(o) }, { retryBaseMs: 20, retryMaxMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(await get("127.0.0.1", port)).toEqual({ status: 200, body: "pong" });
  });
});
