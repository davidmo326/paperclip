/**
 * T-3.5 — do-not-rethink surfacing tests.
 *
 * Layers:
 *   1. tokenize — stopword removal, case-insensitivity, edge cases.
 *   2. jaccardSimilarity — the math, including empty-set edge cases.
 *   3. splitDoNotRethinkEntries — newline parsing.
 *   4. checkDoNotRethink — end-to-end above/below threshold cases.
 *   5. checkProposalAgainstProjects — cross-project flattening.
 */

import { describe, expect, it } from "vitest";
import {
  DO_NOT_RETHINK_JACCARD_THRESHOLD,
  checkDoNotRethink,
  checkProposalAgainstProjects,
  jaccardSimilarity,
  splitDoNotRethinkEntries,
  tokenize,
} from "../lib/briefer/do-not-rethink.js";

// ---------------------------------------------------------------------------
// 1. tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    expect(tokenize("Database, Migration!")).toEqual(new Set(["database", "migration"]));
  });

  it("drops stopwords", () => {
    expect(tokenize("the database is the source")).toEqual(new Set(["database", "source"]));
  });

  it("drops tokens shorter than 2 chars", () => {
    expect(tokenize("a I X is")).toEqual(new Set(["x"]).has("x") ? new Set([]) : new Set([]));
    // explicit: single-char tokens dropped regardless of stopword status
    expect([...tokenize("a I X is")]).toEqual([]);
  });

  it("returns empty set for null / undefined / empty / whitespace", () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
    expect(tokenize("").size).toBe(0);
    expect(tokenize("   ").size).toBe(0);
  });

  it("preserves alphanumeric tokens (numbers count)", () => {
    expect(tokenize("v1 v2 build1")).toEqual(new Set(["v1", "v2", "build1"]));
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenize("database database database").size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. jaccardSimilarity
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("returns intersection / union for partial overlap", () => {
    // intersection = 1 (b), union = 3 (a, b, c) → 1/3
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 5);
  });

  it("returns 0.5 for two-thirds overlap", () => {
    // {a,b,c} vs {b,c,d} → intersection 2, union 4 → 0.5
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when one side is empty", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });

  it("is order-insensitive (sets are unordered)", () => {
    const a = jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["c", "b", "d"]));
    const b = jaccardSimilarity(new Set(["c", "b", "d"]), new Set(["a", "b", "c"]));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 3. splitDoNotRethinkEntries
// ---------------------------------------------------------------------------

describe("splitDoNotRethinkEntries", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(splitDoNotRethinkEntries(null)).toEqual([]);
    expect(splitDoNotRethinkEntries(undefined)).toEqual([]);
    expect(splitDoNotRethinkEntries("")).toEqual([]);
  });

  it("splits on newlines", () => {
    expect(splitDoNotRethinkEntries("line one\nline two")).toEqual(["line one", "line two"]);
  });

  it("handles \\r\\n line endings", () => {
    expect(splitDoNotRethinkEntries("a\r\nb")).toEqual(["a", "b"]);
  });

  it("drops empty lines and trims whitespace", () => {
    expect(splitDoNotRethinkEntries("a\n\n  b  \n   \nc")).toEqual(["a", "b", "c"]);
  });

  it("returns a single-element array for a single-line block", () => {
    expect(splitDoNotRethinkEntries("just one decision")).toEqual(["just one decision"]);
  });
});

// ---------------------------------------------------------------------------
// 4. checkDoNotRethink — above/below threshold
// ---------------------------------------------------------------------------

describe("checkDoNotRethink — threshold behavior", () => {
  it("flags when proposal text closely matches a settled decision", () => {
    // Proposal & decision share 4 of the meaningful tokens (postgres, database,
    // choice, sqlite). With small token sets, this clears 0.4 easily.
    const conflicts = checkDoNotRethink({
      proposalText: "Reconsider postgres database choice sqlite",
      doNotRethink: "Settled: postgres database choice over sqlite.",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].similarity).toBeGreaterThanOrEqual(DO_NOT_RETHINK_JACCARD_THRESHOLD);
    expect(conflicts[0].settledDecision).toContain("postgres");
  });

  it("does NOT flag a clearly unrelated proposal", () => {
    const conflicts = checkDoNotRethink({
      proposalText: "Email cohort A about beta access for the new landing page",
      doNotRethink: "We are sticking with embedded postgres as the local database choice.",
    });
    expect(conflicts).toHaveLength(0);
  });

  it("respects a custom threshold override", () => {
    // Same input but with a lower threshold to force a flag
    const proposalText = "Build user authentication module";
    const doNotRethink = "The authentication library is selected: auth0";
    const lowThresholdFlags = checkDoNotRethink({
      proposalText,
      doNotRethink,
      threshold: 0.1,
    });
    const highThresholdFlags = checkDoNotRethink({
      proposalText,
      doNotRethink,
      threshold: 0.9,
    });
    expect(lowThresholdFlags.length).toBeGreaterThan(highThresholdFlags.length);
  });

  it("flags ALL matching entries when doNotRethink has multiple lines", () => {
    // Two lines mention postgres+database+choice tightly; one is about logging.
    const conflicts = checkDoNotRethink({
      proposalText: "postgres database choice settled",
      doNotRethink: [
        "Settled: postgres database choice.",
        "Logging library pino chosen.",
        "Database backend postgres choice settled.",
      ].join("\n"),
    });
    expect(conflicts.length).toBe(2); // line 1 and line 3 both match
  });

  it("returns [] for empty proposal text", () => {
    expect(
      checkDoNotRethink({ proposalText: "", doNotRethink: "anything" }),
    ).toEqual([]);
  });

  it("returns [] for null / empty doNotRethink", () => {
    expect(
      checkDoNotRethink({ proposalText: "some proposal", doNotRethink: null }),
    ).toEqual([]);
    expect(
      checkDoNotRethink({ proposalText: "some proposal", doNotRethink: "" }),
    ).toEqual([]);
  });

  it("ignores doNotRethink lines that tokenize to nothing (all stopwords)", () => {
    const conflicts = checkDoNotRethink({
      proposalText: "Real proposal text here",
      doNotRethink: "and the it is\nReal proposal text here",
    });
    // First line tokenizes to empty → skipped; second line is identical → flags
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].similarity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. checkProposalAgainstProjects
// ---------------------------------------------------------------------------

describe("checkProposalAgainstProjects", () => {
  it("flattens conflicts across projects with project metadata attached", () => {
    const projects = [
      {
        projectId: "a",
        projectName: "Project A",
        doNotRethink: "Database is postgres.",
      },
      {
        projectId: "b",
        projectName: "Project B",
        doNotRethink: "Logging library is pino.",
      },
      {
        projectId: "c",
        projectName: "Project C",
        doNotRethink: null,
      },
    ];
    const conflicts = checkProposalAgainstProjects(
      "Reconsider postgres database choice",
      projects,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      projectId: "a",
      projectName: "Project A",
    });
  });

  it("returns [] when no project's doNotRethink overlaps the proposal", () => {
    const projects = [
      { projectId: "a", projectName: "A", doNotRethink: "Database is postgres." },
    ];
    expect(
      checkProposalAgainstProjects("Email cohort A about beta", projects),
    ).toEqual([]);
  });

  it("returns [] for an empty project list", () => {
    expect(checkProposalAgainstProjects("anything", [])).toEqual([]);
  });

  it("can flag the same proposal across multiple projects when both match", () => {
    const projects = [
      { projectId: "a", projectName: "A", doNotRethink: "postgres database choice" },
      { projectId: "b", projectName: "B", doNotRethink: "postgres database choice" },
    ];
    const conflicts = checkProposalAgainstProjects(
      "Reconsider postgres database choice",
      projects,
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((c) => c.projectId).sort()).toEqual(["a", "b"]);
  });
});
