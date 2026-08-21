/**
 * T-4.8 — steward standing-prompt lockstep test.
 *
 * The runtime constant must carry the frontier-authored key clauses. If a
 * sync from ControlPlane/prompts/steward-standing.md drops one of these,
 * this test fails before the steward ever runs.
 */

import { describe, expect, it } from "vitest";
import { STEWARD_STANDING_PROMPT } from "../lib/steward/standing-prompt.js";

describe("STEWARD_STANDING_PROMPT (T-4.8)", () => {
  const KEY_CLAUSES: Array<[label: string, needle: string]> = [
    ["role definition", "of the principal's Personal AI Control Plane"],
    ["authority ceiling", "L0/L1 only"],
    ["propose-not-act", "You do not act."],
    ["never invent state", "Never invent state."],
    ["observed vs inferred", "Separate observed from inferred."],
    ["anchor citation format", "[[Note]] § Section @ hash8"],
    ["vague citation rule", "A values claim without a citation is worse than no values claim"],
    ["draft humility", "*.draft.md"],
    ["awaiting return fork rule", "don't pick"],
    ["JSON output contract", '"whatChanged"'],
    ["attention cap", "at most 3 entries, ranked"],
    ["degraded output fallback", "could not synthesise"],
  ];

  it.each(KEY_CLAUSES)("contains clause: %s", (_label, needle) => {
    expect(STEWARD_STANDING_PROMPT).toContain(needle);
  });

  it("is non-trivially long (not a stub)", () => {
    expect(STEWARD_STANDING_PROMPT.length).toBeGreaterThan(3000);
  });

  it("carries the output schema fields the parser validates", () => {
    for (const field of ["whatChanged", "attention", "drafts", "awaitingReturn", "dissent", "selfCheck", "warnings", "confidence"]) {
      expect(STEWARD_STANDING_PROMPT).toContain(`"${field}"`);
    }
  });
});
