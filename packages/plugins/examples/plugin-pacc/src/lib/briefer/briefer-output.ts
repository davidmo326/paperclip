/**
 * Briefer structured-output schema + validated synthesis — T-3.2.
 *
 * The briefer asks the model for a JSON object (shape defined by the system
 * prompt) and validates it with Zod. On a schema violation it retries once with
 * the violation fed back into the prompt; a second failure escalates (the caller
 * emits `briefer.schema_violation`) and the briefer falls back to its
 * deterministic offline summary — the brief still renders.
 *
 * Architecture note (deviation from the literal T-3.2 acceptance): in the v2
 * design the *structure* of the brief (recommendations, escalations, etc.) is
 * assembled deterministically from canonical state by `runBriefer` (T-3.1), each
 * carrying real sourceRefs. The model's job here is narration only — it does NOT
 * emit recommendations or sourceRefs, so it cannot produce an unsourced
 * recommendation (provenance is guaranteed by construction). Consequently a
 * persistent schema violation degrades the *narrative slot* to offline rather
 * than blocking the whole brief, consistent with the graceful-degradation design
 * used everywhere else (model outage must never break the daily brief).
 */

import type { BrieferDeps } from "./types.js";
import { BRIEFER_SYSTEM_PROMPT } from "./system-prompt.js";

export interface BrieferModelOutput {
  summary: string;
  confidence: number;
  observedFacts: string[];
  inferredConclusions: string[];
  warnings: string[];
}

export type ParseResult =
  | { ok: true; value: BrieferModelOutput }
  | { ok: false; error: string };

function asStringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

/**
 * Parse + validate model text into the briefer output. Tolerates a leading/
 * trailing code fence or stray prose by extracting the first balanced top-level
 * JSON object. Hand-rolled validation (the plugin doesn't depend on zod).
 */
export function parseBrieferModelOutput(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (json === null) return { ok: false, error: "no JSON object found in model output" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "model output is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.summary !== "string" || o.summary.trim() === "") {
    return { ok: false, error: "summary: must be a non-empty string" };
  }
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    return { ok: false, error: "confidence: must be a number in [0, 1]" };
  }
  const observedFacts = asStringArray(o.observedFacts);
  const inferredConclusions = asStringArray(o.inferredConclusions);
  const warnings = asStringArray(o.warnings);
  if (observedFacts === null) return { ok: false, error: "observedFacts: must be an array of strings" };
  if (inferredConclusions === null) return { ok: false, error: "inferredConclusions: must be an array of strings" };
  if (warnings === null) return { ok: false, error: "warnings: must be an array of strings" };

  return {
    ok: true,
    value: { summary: o.summary, confidence: o.confidence, observedFacts, inferredConclusions, warnings },
  };
}

/** Extract the first balanced `{...}` block (handles strings + escapes). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface ValidatedSynthesisResult {
  /** Validated model output, or null when offline/escalated. */
  output: BrieferModelOutput | null;
  /** True when the model never returned schema-valid JSON (after one retry). */
  schemaViolation: boolean;
  /** Number of model calls made (0 when projects empty / no model). */
  attempts: number;
  /** Last validation error (for the schema_violation event / warning). */
  lastError: string | null;
}

/**
 * Call the model for a structured synthesis, validating + retrying once.
 *
 * - First call: system prompt + the data prompt.
 * - On schema violation: one retry with the violation appended to the prompt.
 * - On a null/empty model response at any point: treated as offline (no
 *   violation — the model simply isn't available).
 */
export async function synthesizeValidated(
  deps: BrieferDeps,
  args: { modelId: string; dataPrompt: string },
): Promise<ValidatedSynthesisResult> {
  const first = await callOnce(deps, args.modelId, args.dataPrompt);
  if (first.kind === "offline") {
    return { output: null, schemaViolation: false, attempts: first.called ? 1 : 0, lastError: null };
  }
  if (first.kind === "ok") {
    return { output: first.value, schemaViolation: false, attempts: 1, lastError: null };
  }

  // Schema violation → retry once with the error fed back.
  const retryPrompt =
    `${args.dataPrompt}\n\nYour previous response was rejected: ${first.error}\n` +
    `Return ONLY a single valid JSON object matching the required shape.`;
  const second = await callOnce(deps, args.modelId, retryPrompt);
  if (second.kind === "ok") {
    return { output: second.value, schemaViolation: false, attempts: 2, lastError: null };
  }
  if (second.kind === "offline") {
    return { output: null, schemaViolation: false, attempts: 1, lastError: first.error };
  }
  return { output: null, schemaViolation: true, attempts: 2, lastError: second.error };
}

type CallOnce =
  | { kind: "ok"; value: BrieferModelOutput }
  | { kind: "violation"; error: string }
  | { kind: "offline"; called: boolean };

async function callOnce(deps: BrieferDeps, modelId: string, prompt: string): Promise<CallOnce> {
  let response: { text: string | null };
  try {
    response = await deps.callModel({ modelId, prompt, systemPrompt: BRIEFER_SYSTEM_PROMPT });
  } catch {
    return { kind: "offline", called: true };
  }
  if (!response.text || response.text.trim() === "") {
    return { kind: "offline", called: true };
  }
  const parsed = parseBrieferModelOutput(response.text);
  if (parsed.ok) return { kind: "ok", value: parsed.value };
  return { kind: "violation", error: parsed.error };
}
