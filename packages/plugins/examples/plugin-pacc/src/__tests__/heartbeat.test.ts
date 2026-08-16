/**
 * T-6.1 heartbeat tests — external dead-man's switch.
 *
 * Verifies: never throws; skip when URL unset; ping succeeds on 2xx;
 * failure + timeout degrade to { kind: "failed" } without throwing;
 * non-2xx still counts as sent (surface the status, caller logs).
 */

import { describe, expect, it, vi } from "vitest";
import { resolveHeartbeatUrl, sendHeartbeat } from "../lib/heartbeat.js";

function okResponse(status = 200): Response {
  return new Response(null, { status });
}

describe("resolveHeartbeatUrl", () => {
  it("reads a trimmed URL from env", () => {
    expect(resolveHeartbeatUrl({ PACC_HEARTBEAT_URL: "  https://hc.example/abc  " } as NodeJS.ProcessEnv)).toBe(
      "https://hc.example/abc",
    );
  });

  it("returns null when unset or blank", () => {
    expect(resolveHeartbeatUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveHeartbeatUrl({ PACC_HEARTBEAT_URL: "   " } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("sendHeartbeat", () => {
  it("skips with no_url when url is null", async () => {
    const fetchFn = vi.fn();
    const result = await sendHeartbeat(null, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toEqual({ kind: "skipped", reason: "no_url" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends an empty GET and reports the status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse(200));
    const result = await sendHeartbeat("https://hc.example/abc", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "sent", status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://hc.example/abc");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("reports non-2xx as sent (misconfigured URL is visible, not fatal)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse(404));
    const result = await sendHeartbeat("https://hc.example/abc", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "sent", status: 404 });
  });

  it("never throws on network failure — returns failed + warns", async () => {
    const warn = vi.fn();
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await sendHeartbeat("https://hc.example/abc", {
      fetchFn: fetchFn as unknown as typeof fetch,
      logger: { warn },
    });
    expect(result).toEqual({ kind: "failed", error: "ECONNREFUSED" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never throws on timeout", async () => {
    const warn = vi.fn();
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      });
    const result = await sendHeartbeat("https://hc.example/abc", {
      timeoutMs: 25,
      fetchFn: fetchFn as unknown as typeof fetch,
      logger: { warn },
    });
    expect(result.kind).toBe("failed");
    expect(warn).toHaveBeenCalledOnce();
  }, 10_000);
});
