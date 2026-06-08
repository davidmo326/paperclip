/**
 * Claude-CLI model provider — model wiring for the briefer's `callModel` seam.
 *
 * The plugin SDK exposes no LLM surface, and the principal prefers using their
 * Claude **subscription** rather than an API key. The local Claude Code CLI in
 * headless mode (`claude -p … --output-format json`) authenticates with the
 * subscription already present on the machine — no `ANTHROPIC_API_KEY` needed.
 * pacc runs on the principal's NUC where that login lives, so the briefer
 * shells out to it.
 *
 * Design guarantees:
 *   - **Graceful degradation.** Any failure (binary missing, non-zero exit,
 *     timeout, unparseable output, error result) returns `{ text: null }` so
 *     the briefer falls back to its deterministic offline summary. A model
 *     hiccup never breaks the daily brief.
 *   - **No shell injection.** The prompt + system prompt are passed as argv
 *     (spawn with an args array, no shell), so brief content can't escape into
 *     a command.
 *   - **Testable.** `spawnFn` is injectable; unit tests never spawn a real CLI.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";

export interface ClaudeCliModelOptions {
  /** Path/name of the Claude Code binary. Default: `claude` (on PATH). */
  binPath?: string;
  /** Hard timeout for the call. Default: 120_000ms. */
  timeoutMs?: number;
  /** Working directory for the spawned process. */
  cwd?: string;
  /**
   * Injectable spawn (tests). Signature-compatible with node's `spawn`.
   * Defaults to `node:child_process` spawn.
   */
  spawnFn?: typeof nodeSpawn;
  /** Optional logger for diagnostics on the degradation path. */
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export interface CallModelArgs {
  modelId: string;
  prompt: string;
  systemPrompt?: string | null;
}

export interface CallModelResult {
  text: string | null;
  sessionId: string | null;
}

/** Shape of `claude -p --output-format json` stdout (subset we rely on). */
interface ClaudeCliJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

export async function callModelViaClaudeCli(
  args: CallModelArgs,
  opts: ClaudeCliModelOptions = {},
): Promise<CallModelResult> {
  const bin = opts.binPath ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  const argv = ["-p", args.prompt, "--model", args.modelId, "--output-format", "json"];
  if (args.systemPrompt && args.systemPrompt.trim().length > 0) {
    argv.push("--append-system-prompt", args.systemPrompt);
  }

  const spawnOpts: SpawnOptionsWithoutStdio = {
    cwd: opts.cwd,
    // Never use a shell — prompt is argv, not an interpolated string.
    shell: false,
    env: process.env,
  };

  return await new Promise<CallModelResult>((resolve) => {
    let settled = false;
    const done = (r: CallModelResult, why?: string) => {
      if (settled) return;
      settled = true;
      if (r.text === null && why) {
        opts.logger?.warn("claude-cli model call degraded to offline", { reason: why });
      }
      resolve(r);
    };

    let child;
    try {
      child = spawnFn(bin, argv, spawnOpts);
    } catch (err) {
      done({ text: null, sessionId: null }, `spawn threw: ${errMsg(err)}`);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ text: null, sessionId: null }, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (err: unknown) => {
      clearTimeout(timer);
      done({ text: null, sessionId: null }, `process error: ${errMsg(err)}`);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(
          { text: null, sessionId: null },
          `exit ${code}: ${stderr.slice(0, 200) || "(no stderr)"}`,
        );
        return;
      }
      let parsed: ClaudeCliJson;
      try {
        parsed = JSON.parse(stdout) as ClaudeCliJson;
      } catch {
        done({ text: null, sessionId: null }, "stdout not valid JSON");
        return;
      }
      if (parsed.is_error === true || typeof parsed.result !== "string") {
        done({ text: null, sessionId: null }, `cli error result (subtype=${parsed.subtype ?? "?"})`);
        return;
      }
      done({ text: parsed.result, sessionId: parsed.session_id ?? null });
    });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
