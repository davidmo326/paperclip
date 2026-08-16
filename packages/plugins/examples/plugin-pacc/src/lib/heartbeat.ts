/**
 * Heartbeat — T-6.1 external dead-man's switch.
 *
 * The liveness witness must live OUTSIDE the failure domain it watches: the
 * brief duty cycle pings an external dead-man's-switch URL (e.g.
 * healthchecks.io) after each *successful* run. If the ping stops arriving,
 * the external service alerts the principal — catching every failure mode
 * in-band checks cannot: service dead, unit disabled, briefer self-paused
 * (a paused briefer IS an outage of the product — correctly alerted), NUC
 * off, power out, network out.
 *
 * Design guarantees:
 *   - **Never throws.** A heartbeat failure must never break the brief
 *     pipeline; it warn-logs only.
 *   - **Empty GET.** Zero content leaves the host — the URL itself is the
 *     only datum shared with the external service.
 *   - **Env-gated.** `PACC_HEARTBEAT_URL` unset → skip (single info log per
 *     process via the warn-once guard in the caller).
 *   - **Testable.** `fetchFn` injectable; unit tests never hit the network.
 *
 * Grill resolution Q4 (2026-08-16): the watched thing is the agent runtime's
 * duty-cycle completion, not the brief file. Ping ONLY on `completed`
 * scheduled-brief results.
 */

export interface SendHeartbeatOptions {
  /** Hard timeout for the ping. Default 10s. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Optional logger for the degradation path. */
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export type HeartbeatResult =
  | { kind: "sent"; status: number }
  | { kind: "skipped"; reason: "no_url" }
  | { kind: "failed"; error: string };

/** Resolve the heartbeat URL from an env (separated for testability). */
export function resolveHeartbeatUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PACC_HEARTBEAT_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Send one dead-man's-switch ping. Never throws.
 *
 * @param url the ping URL (from PACC_HEARTBEAT_URL)
 * @returns the outcome — callers log, they do not branch the pipeline on it
 */
export async function sendHeartbeat(
  url: string | null,
  options: SendHeartbeatOptions = {},
): Promise<HeartbeatResult> {
  if (url === null || url.length === 0) {
    return { kind: "skipped", reason: "no_url" };
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    // Dead-man's-switch services accept any response as a ping; non-2xx is
    // still worth surfacing (misconfigured URL).
    return { kind: "sent", status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.logger?.warn("heartbeat ping failed (never fatal)", { error: msg });
    return { kind: "failed", error: msg };
  } finally {
    clearTimeout(timer);
  }
}
