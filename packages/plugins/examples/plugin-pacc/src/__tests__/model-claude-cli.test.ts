/**
 * Model wiring tests — Claude CLI provider (subscription auth).
 *
 * Uses an injected fake `spawn` so no real CLI is invoked. Verifies the
 * happy path (parses `result`/`session_id`) and every degradation path
 * (non-zero exit, bad JSON, error result, spawn throw, timeout) returns
 * `{ text: null }` so the briefer falls back to deterministic offline.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { callModelViaClaudeCli } from "../lib/briefer/model-claude-cli.js";
import { resolveBrieferModelConfig } from "../lib/briefer/worker-deps.js";

/** Minimal fake child process. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
}

/** Build a fake spawn that emits the given stdout then closes with `code`. */
function fakeSpawn(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
  throwOnSpawn?: boolean;
  neverClose?: boolean;
  captureArgv?: (cmd: string, argv: string[]) => void;
}) {
  return ((cmd: string, argv: string[]) => {
    opts.captureArgv?.(cmd, argv);
    if (opts.throwOnSpawn) throw new Error("ENOENT: claude not found");
    const child = new FakeChild();
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      if (!opts.neverClose) child.emit("close", opts.code ?? 0);
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
}

const ARGS = { modelId: "claude-opus-4-8", prompt: "Summarise the portfolio." };

describe("callModelViaClaudeCli — happy path", () => {
  it("returns text + sessionId from a successful JSON result", async () => {
    const spawnFn = fakeSpawn({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Circlo is in validation; Hometrics paused.",
        session_id: "sess-123",
      }),
      code: 0,
    });
    const out = await callModelViaClaudeCli(ARGS, { spawnFn });
    expect(out.text).toBe("Circlo is in validation; Hometrics paused.");
    expect(out.sessionId).toBe("sess-123");
  });

  it("passes prompt + model as argv (no shell), adds system prompt when present", async () => {
    let capturedCmd = "";
    let capturedArgv: string[] = [];
    const spawnFn = fakeSpawn({
      stdout: JSON.stringify({ is_error: false, result: "ok", session_id: "s" }),
      captureArgv: (cmd, argv) => {
        capturedCmd = cmd;
        capturedArgv = argv;
      },
    });
    await callModelViaClaudeCli(
      { ...ARGS, systemPrompt: "You are the steward." },
      { spawnFn, binPath: "claude" },
    );
    expect(capturedCmd).toBe("claude");
    expect(capturedArgv).toContain("-p");
    expect(capturedArgv).toContain("Summarise the portfolio.");
    expect(capturedArgv).toContain("--model");
    expect(capturedArgv).toContain("claude-opus-4-8");
    expect(capturedArgv).toContain("--output-format");
    expect(capturedArgv).toContain("json");
    expect(capturedArgv).toContain("--append-system-prompt");
    expect(capturedArgv).toContain("You are the steward.");
  });

  it("omits the system-prompt flag when systemPrompt is blank", async () => {
    let capturedArgv: string[] = [];
    const spawnFn = fakeSpawn({
      stdout: JSON.stringify({ is_error: false, result: "ok" }),
      captureArgv: (_cmd, argv) => {
        capturedArgv = argv;
      },
    });
    await callModelViaClaudeCli({ ...ARGS, systemPrompt: "  " }, { spawnFn });
    expect(capturedArgv).not.toContain("--append-system-prompt");
  });
});

describe("callModelViaClaudeCli — graceful degradation", () => {
  it("returns null on non-zero exit", async () => {
    const out = await callModelViaClaudeCli(ARGS, {
      spawnFn: fakeSpawn({ stderr: "boom", code: 1 }),
    });
    expect(out.text).toBeNull();
  });

  it("returns null on unparseable stdout", async () => {
    const out = await callModelViaClaudeCli(ARGS, {
      spawnFn: fakeSpawn({ stdout: "not json", code: 0 }),
    });
    expect(out.text).toBeNull();
  });

  it("returns null when the CLI reports is_error", async () => {
    const out = await callModelViaClaudeCli(ARGS, {
      spawnFn: fakeSpawn({
        stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns" }),
        code: 0,
      }),
    });
    expect(out.text).toBeNull();
  });

  it("returns null when spawn throws (binary missing)", async () => {
    const out = await callModelViaClaudeCli(ARGS, {
      spawnFn: fakeSpawn({ throwOnSpawn: true }),
    });
    expect(out.text).toBeNull();
  });

  it("returns null on timeout", async () => {
    vi.useFakeTimers();
    const promise = callModelViaClaudeCli(ARGS, {
      spawnFn: fakeSpawn({ neverClose: true }),
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(60);
    const out = await promise;
    expect(out.text).toBeNull();
    vi.useRealTimers();
  });
});

describe("resolveBrieferModelConfig", () => {
  it("is disabled (offline) when PACC_BRIEFER_MODEL is unset", async () => {
    const cfg = resolveBrieferModelConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.modelId).toBeNull();
    expect(await cfg.callModel({ modelId: "x", prompt: "y" })).toEqual({
      text: null,
      sessionId: null,
    });
  });

  it("is enabled with an explicit model id", () => {
    const cfg = resolveBrieferModelConfig({
      PACC_BRIEFER_MODEL: "claude-opus-4-8",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.modelId).toBe("claude-opus-4-8");
    expect(typeof cfg.callModel).toBe("function");
  });

  it("enables with the default model (Sonnet 4.6) for an `on`-style switch", () => {
    for (const v of ["on", "true", "1", "default", "yes"]) {
      const cfg = resolveBrieferModelConfig({
        PACC_BRIEFER_MODEL: v,
      } as unknown as NodeJS.ProcessEnv);
      expect(cfg.enabled).toBe(true);
      expect(cfg.modelId).toBe("claude-sonnet-4-6");
    }
  });

  it("stays offline for an explicit off-style value", () => {
    for (const v of ["off", "false", "0", "none", "no"]) {
      const cfg = resolveBrieferModelConfig({
        PACC_BRIEFER_MODEL: v,
      } as unknown as NodeJS.ProcessEnv);
      expect(cfg.enabled).toBe(false);
      expect(cfg.modelId).toBeNull();
    }
  });
});
