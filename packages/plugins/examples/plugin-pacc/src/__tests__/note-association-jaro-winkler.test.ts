/**
 * T-2.3 — Jaro-Winkler similarity, used by the title-fuzzy-match rule
 * (>= 0.9 -> confidence 0.4).
 */

import { describe, expect, it } from "vitest";
import { jaroSimilarity, jaroWinklerSimilarity } from "../lib/note-association/jaro-winkler.js";

describe("jaroSimilarity", () => {
  it("is 1 for identical strings", () => {
    expect(jaroSimilarity("hometrics", "hometrics")).toBe(1);
  });

  it("is 0 when either string is empty", () => {
    expect(jaroSimilarity("", "hometrics")).toBe(0);
    expect(jaroSimilarity("hometrics", "")).toBe(0);
  });

  it("matches the canonical MARTHA/MARHTA example (~0.944)", () => {
    expect(jaroSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 3);
  });

  it("is 0 for completely disjoint strings", () => {
    expect(jaroSimilarity("abc", "xyz")).toBe(0);
  });
});

describe("jaroWinklerSimilarity", () => {
  it("is 1 for identical strings", () => {
    expect(jaroWinklerSimilarity("circlo", "circlo")).toBe(1);
  });

  it("boosts scores for strings sharing a common prefix", () => {
    const withPrefix = jaroWinklerSimilarity("ndis overview", "ndis");
    const jaro = jaroSimilarity("ndis overview", "ndis");
    expect(withPrefix).toBeGreaterThanOrEqual(jaro);
  });

  it("scores a near-identical title above the 0.9 threshold", () => {
    // Real T-2.3 use case: note titled "Hometrics Overview" vs project name "Hometrics".
    expect(jaroWinklerSimilarity("hometrics", "hometrics overview")).toBeGreaterThanOrEqual(0.9);
  });

  it("scores unrelated titles well below the 0.9 threshold", () => {
    expect(jaroWinklerSimilarity("circlo", "tax-manager")).toBeLessThan(0.9);
  });

  it("is symmetric-ish for the canonical DWAYNE/DUANE example (~0.84)", () => {
    expect(jaroWinklerSimilarity("dwayne", "duane")).toBeCloseTo(0.84, 1);
  });
});
