/**
 * T-3.2 — briefer structured-output schema + validated synthesis tests.
 */
import { describe, expect, it } from "vitest";
import {
  parseBrieferModelOutput,
  extractJsonObject,
  synthesizeValidated,
} from "../lib/briefer/briefer-output.js";
import { BRIEFER_SYSTEM_PROMPT } from "../lib/briefer/system-prompt.js";
import type { BrieferDeps } from "../lib/briefer/types.js";

const VALID = JSON.stringify({
  summary: "Circlo in validation; Hometrics paused.",
  confidence: 0.6,
  observedFacts: ["Circlo phase=validate"],
  inferredConclusions: ["distribution is the constraint"],
  warnings: [],
});

const FENCE = "`" + "`" + "`";

function depsWithResponses(responses: Array<{ text: string | null } | Error>): {
  deps: BrieferDeps;
  calls: Array<{ prompt: string; systemPrompt?: string | null }>;
} {
  const calls: Array<{ prompt: string; systemPrompt?: string | null }> = [];
  let i = 0;
  const deps = {
    async listActiveProjectCards() {
      return [];
    },
    async proposeM2() {},
    async saveBrief() {
      return { id: "x" };
    },
    async callModel(args: { modelId: string; prompt: string; systemPrompt?: string | null }) {
      calls.push({ prompt: args.prompt, systemPrompt: args.systemPrompt });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return { text: r.text, sessionId: null };
    },
  } as unknown as BrieferDeps;
  return { deps, calls };
}

describe("parseBrieferModelOutput", () => {
  it("accepts a valid object", () => {
    const r = parseBrieferModelOutput(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toContain("Circlo");
      expect(r.value.confidence).toBe(0.6);
    }
  });

  it("extracts JSON wrapped in a code fence + prose", () => {
    const r = parseBrieferModelOutput("Here you go:\n" + FENCE + "json\n" + VALID + "\n" + FENCE + "\nDone.");
    expect(r.ok).toBe(true);
  });

  it("rejects empty summary", () => {
    const r = parseBrieferModelOutput(JSON.stringify({ summary: "", confidence: 0.5 }));
    expect(r.ok).toBe(false);
  });

  it("rejects confidence out of range", () => {
    const r = parseBrieferModelOutput(JSON.stringify({ summary: "x", confidence: 1.4 }));
    expect(r.ok).toBe(false);
  });

  it("rejects non-JSON", () => {
    expect(parseBrieferModelOutput("not json at all").ok).toBe(false);
  });

  it("defaults the optional arrays when omitted", () => {
    const r = parseBrieferModelOutput(JSON.stringify({ summary: "x", confidence: 0.5 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.observedFacts).toEqual([]);
      expect(r.value.warnings).toEqual([]);
    }
  });
});

describe("extractJsonObject", () => {
  it("handles nested braces and braces inside strings", () => {
    const text = 'prefix {"a": {"b": 1}, "c": "}{"} suffix';
    expect(extractJsonObject(text)).toBe('{"a": {"b": 1}, "c": "}{"}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no braces here")).toBeNull();
  });
});

describe("synthesizeValidated", () => {
  const args = { modelId: "claude-sonnet-4-6", dataPrompt: "context..." };

  it("returns output on a first valid response (1 attempt), passing the system prompt", async () => {
    const { deps, calls } = depsWithResponses([{ text: VALID }]);
    const r = await synthesizeValidated(deps, args);
    expect(r.output?.summary).toContain("Circlo");
    expect(r.attempts).toBe(1);
    expect(r.schemaViolation).toBe(false);
    expect(calls[0].systemPrompt).toBe(BRIEFER_SYSTEM_PROMPT);
  });

  it("retries once and succeeds (2 attempts)", async () => {
    const { deps, calls } = depsWithResponses([{ text: "garbage" }, { text: VALID }]);
    const r = await synthesizeValidated(deps, args);
    expect(r.output?.summary).toContain("Circlo");
    expect(r.attempts).toBe(2);
    expect(r.schemaViolation).toBe(false);
    expect(calls[1].prompt).toContain("was rejected");
  });

  it("flags schemaViolation after two invalid responses", async () => {
    const { deps } = depsWithResponses([{ text: "garbage" }, { text: "still bad" }]);
    const r = await synthesizeValidated(deps, args);
    expect(r.output).toBeNull();
    expect(r.schemaViolation).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.lastError).toBeTruthy();
  });

  it("treats a null/empty model response as offline (no violation)", async () => {
    const { deps } = depsWithResponses([{ text: null }]);
    const r = await synthesizeValidated(deps, args);
    expect(r.output).toBeNull();
    expect(r.schemaViolation).toBe(false);
  });

  it("treats a thrown callModel as offline (no violation)", async () => {
    const { deps } = depsWithResponses([new Error("spawn failed")]);
    const r = await synthesizeValidated(deps, args);
    expect(r.output).toBeNull();
    expect(r.schemaViolation).toBe(false);
  });
});

describe("BRIEFER_SYSTEM_PROMPT", () => {
  it("carries the key clauses (lockstep with ControlPlane/prompts/briefer-system.md)", () => {
    expect(BRIEFER_SYSTEM_PROMPT).toContain("Never invent state");
    expect(BRIEFER_SYSTEM_PROMPT).toContain("single JSON object");
    expect(BRIEFER_SYSTEM_PROMPT).toContain("confidence");
    expect(BRIEFER_SYSTEM_PROMPT).toContain("L1");
  });
});
