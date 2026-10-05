/**
 * Model call over an Anthropic-compatible Messages API (e.g. z.ai's GLM
 * endpoint at ANTHROPIC_BASE_URL), for models the Claude Code CLI refuses to
 * run by id in print mode (`unrecognized_model` for GLM ids). Same contract as
 * the CLI provider: never throws; any failure degrades to `{ text: null }` with
 * the reason logged. Credentials are read from the worker's env at call time.
 */

import type { CallModelArgs, CallModelResult } from "./model-claude-cli.js";

export interface MessagesApiOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export async function callModelViaMessagesApi(args: CallModelArgs, opts: MessagesApiOptions = {}): Promise<CallModelResult> {
  const base = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "");
  const token = opts.token ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "";
  const degrade = (why: string): CallModelResult => {
    opts.logger?.warn(`messages-api model call degraded to offline — ${why.slice(0, 300)}`, { model: args.modelId });
    return { text: null, sessionId: null };
  };
  if (!base || !token) return degrade("ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN not set in the worker env");
  try {
    const res = await (opts.fetchFn ?? fetch)(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${token}`,
        "x-api-key": token,
      },
      body: JSON.stringify({
        model: args.modelId,
        // reasoning models (GLM 5.x) spend part of the budget thinking before any text;
        // 8k ran out before the journal JSON began ("empty response", 2026-10-05/06)
        max_tokens: opts.maxTokens ?? (Number(process.env.PACC_STEWARD_MAX_TOKENS) || 32000),
        ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
        messages: [{ role: "user", content: args.prompt }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    });
    const body = (await res.json().catch(() => null)) as
      | {
          id?: string;
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          error?: { message?: string };
        }
      | null;
    if (!res.ok) return degrade(`HTTP ${res.status}: ${body?.error?.message ?? "no error body"}`);
    const text = (body?.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
    if (!text.trim()) {
      const blocks = (body?.content ?? []).map((c) => c.type ?? "?").join(",") || "none";
      return degrade(
        `empty response (stop_reason=${body?.stop_reason ?? "?"}; blocks=${blocks}; output_tokens=${body?.usage?.output_tokens ?? "?"})`,
      );
    }
    return { text, sessionId: body?.id ?? null };
  } catch (err) {
    return degrade(err instanceof Error ? err.message : String(err));
  }
}
