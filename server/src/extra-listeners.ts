import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { Server as HttpServer } from "node:http";

// Extra bind addresses for the one HTTP server (review follow-up 2026-10-07).
//
// Production binds HOST=127.0.0.1 (cockpit, pacc CLI and scripts call
// localhost:3100) and also the tailnet IP, never 0.0.0.0, so the LAN can't
// reach :3100. A single http.Server can listen on one address, so each extra
// address gets a plain TCP relay that hands accepted sockets to the same
// server ("connection" event). Routing, WebSocket upgrades, timeouts and
// shutdown all stay on the one server.
//
// An address that is not up yet (tailscaled starting after us at boot) is
// retried with backoff instead of crashing the server: loopback keeps working
// meanwhile.

export interface ExtraListenerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export function parseExtraListenHosts(raw: string | undefined, mainHost: string): string[] {
  const main = mainHost.trim().toLowerCase();
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0 && h.toLowerCase() !== main),
    ),
  ];
}

export function startExtraListeners(
  server: HttpServer,
  hosts: readonly string[],
  port: number,
  logger: ExtraListenerLogger,
  opts: { retryBaseMs?: number; retryMaxMs?: number } = {},
): NetServer[] {
  const base = opts.retryBaseMs ?? 5_000;
  const max = opts.retryMaxMs ?? 60_000;
  const relays: NetServer[] = [];
  let stopped = false;

  const start = (host: string, attempt: number) => {
    if (stopped) return;
    const relay = createNetServer((socket) => {
      server.emit("connection", socket);
    });
    relays.push(relay);
    const onStartError = (err: Error) => {
      relay.close(() => {});
      const delay = Math.min(max, base * (attempt + 1));
      logger.warn({ err: (err as NodeJS.ErrnoException).code ?? err.message, host, port, retryInMs: delay }, "extra listen address unavailable; retrying");
      setTimeout(() => start(host, attempt + 1), delay).unref();
    };
    relay.once("error", onStartError);
    relay.listen(port, host, () => {
      relay.off("error", onStartError);
      relay.on("error", (err) => logger.warn({ err: err.message, host, port }, "extra listener error"));
      logger.info({ host, port }, `Server also listening on ${host}:${port}`);
    });
  };

  for (const host of hosts) start(host, 0);
  server.once("close", () => {
    stopped = true;
    for (const r of relays) r.close(() => {});
  });
  return relays;
}
