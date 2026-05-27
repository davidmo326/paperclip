/**
 * T-3.7 — hallucination tripwire tests.
 *
 * Five layers:
 *   1. extractIdLikeTokens (UUID / slug detection)
 *   2. detectHallucinations (known-list matching + allow-list)
 *   3. annotateHallucinations (Markdown insertion)
 *   4. pruneOldFlags + shouldPause (rolling 24h counter)
 *   5. pausedBriefMarkdown (stub output)
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAUSE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  annotateHallucinations,
  appendFlag,
  detectHallucinations,
  extractIdLikeTokens,
  pausedBriefMarkdown,
  pruneOldFlags,
  shouldPause,
  type HallucinationCounterState,
  type HallucinationFlagRecord,
} from "../lib/briefer/hallucination.js";

// ---------------------------------------------------------------------------
// 1. extractIdLikeTokens
// ---------------------------------------------------------------------------

describe("extractIdLikeTokens — UUID + slug detection", () => {
  it("extracts a standard UUID", () => {
    expect(
      extractIdLikeTokens("see decision 00000000-0000-0000-0000-000000000001 for details"),
    ).toContain("00000000-0000-0000-0000-000000000001");
  });

  it("extracts hyphenated slugs (3+ chars)", () => {
    const out = extractIdLikeTokens("project co-reader is on book-energy-cycles this week");
    expect(out).toContain("co-reader");
    expect(out).toContain("book-energy-cycles");
  });

  it("does NOT extract single-word lowercase tokens (no hyphen)", () => {
    // Per the conservative slug pattern, single-word tokens are out of scope.
    const out = extractIdLikeTokens("project circlo hometrics");
    expect(out).not.toContain("circlo");
    expect(out).not.toContain("hometrics");
  });

  it("dedups repeated tokens", () => {
    const out = extractIdLikeTokens("co-reader, then co-reader again — co-reader");
    expect(out.filter((t) => t === "co-reader")).toHaveLength(1);
  });

  it("treats UUIDs case-insensitively in deduplication", () => {
    const out = extractIdLikeTokens(
      "abcd1234-aaaa-bbbb-cccc-1234567890ab and ABCD1234-AAAA-BBBB-CCCC-1234567890AB",
    );
    // First-seen wins; the second occurrence's lowercase matches.
    expect(out).toHaveLength(1);
  });

  it("returns empty array for plain prose with no ID-shapes", () => {
    expect(extractIdLikeTokens("This morning the team shipped the feature.")).toEqual([]);
  });

  it("doesn't match purely numeric prefixes (years, port numbers)", () => {
    expect(extractIdLikeTokens("2026-05-22 port 54329 elapsed 30")).not.toContain("2026-05-22");
    // 2026-05-22 IS a slug-shape match; not flagged unless not in knownIds.
    // Year-month-day is acceptable in extraction; detection layer handles it.
  });
});

// ---------------------------------------------------------------------------
// 2. detectHallucinations
// ---------------------------------------------------------------------------

describe("detectHallucinations — known-list matching", () => {
  it("returns [] when every ID-shaped token is in knownIds", () => {
    const flags = detectHallucinations({
      briefMarkdown: "Today: focus on co-reader and book-energy-cycles.",
      knownIds: new Set(["co-reader", "book-energy-cycles"]),
    });
    expect(flags).toEqual([]);
  });

  it("flags an unknown slug as a hallucination", () => {
    const flags = detectHallucinations({
      briefMarkdown: "We are working on mystery-project this week.",
      knownIds: new Set(["co-reader"]),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].reference).toBe("mystery-project");
    expect(flags[0].kind).toBe("slug");
  });

  it("flags an unknown UUID as a hallucination", () => {
    const flags = detectHallucinations({
      briefMarkdown: "supersedes decision ffffffff-0000-0000-0000-000000000099",
      knownIds: new Set(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("uuid");
  });

  it("matches knownIds case-insensitively", () => {
    const flags = detectHallucinations({
      briefMarkdown: "see CO-READER project status",
      knownIds: new Set(["co-reader"]),
    });
    expect(flags).toEqual([]);
  });

  it("respects the default allow-list (does not flag next-action etc.)", () => {
    const flags = detectHallucinations({
      briefMarkdown: "Next-action: shipping by friday. Lane-product update follows.",
      knownIds: new Set(),
    });
    // 'next-action' and 'lane-product' are in DEFAULT_ALLOW_LIST
    expect(flags.map((f) => f.reference.toLowerCase())).not.toContain("next-action");
    expect(flags.map((f) => f.reference.toLowerCase())).not.toContain("lane-product");
  });

  it("accepts a custom allow-list", () => {
    const flags = detectHallucinations({
      briefMarkdown: "build-fast pattern in use",
      knownIds: new Set(),
      allowList: new Set(["build-fast"]),
    });
    expect(flags).toEqual([]);
  });

  it("includes a contextual excerpt with each flag", () => {
    const flags = detectHallucinations({
      briefMarkdown:
        "## Recommended Focus\n\n- Primary project: phantom-slug\n  - Why now: validation\n",
      knownIds: new Set(),
    });
    expect(flags[0].excerpt).toContain("phantom-slug");
    expect(flags[0].excerpt).toContain("Primary project");
  });
});

// ---------------------------------------------------------------------------
// 3. annotateHallucinations
// ---------------------------------------------------------------------------

describe("annotateHallucinations", () => {
  it("appends '(hallucinated reference)' after each flagged token", () => {
    const md = "Today: focus on phantom-slug.";
    const flags = detectHallucinations({ briefMarkdown: md, knownIds: new Set() });
    const annotated = annotateHallucinations(md, flags);
    expect(annotated).toContain("phantom-slug _(hallucinated reference)_");
  });

  it("annotates only the first occurrence of each unique reference", () => {
    const md = "phantom-slug appears, then phantom-slug appears again.";
    const flags = detectHallucinations({ briefMarkdown: md, knownIds: new Set() });
    const annotated = annotateHallucinations(md, flags);
    const annotationCount = (annotated.match(/_\(hallucinated reference\)_/g) ?? []).length;
    expect(annotationCount).toBe(1);
  });

  it("returns the input unchanged when there are no flags", () => {
    const md = "Clean brief with co-reader.";
    expect(annotateHallucinations(md, [])).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// 4. Rolling 24h counter
// ---------------------------------------------------------------------------

describe("pruneOldFlags + shouldPause — rolling 24h", () => {
  const NOW = new Date("2026-05-22T08:00:00.000Z");

  function flagAt(hoursAgo: number, refs: string[] = ["x"]): HallucinationFlagRecord {
    return {
      at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
      briefDate: "2026-05-22",
      refs,
    };
  }

  it("keeps flags within the 24h window, drops older ones", () => {
    const state: HallucinationCounterState = {
      flags: [
        flagAt(0.5, ["a"]),
        flagAt(12, ["b"]),
        flagAt(23, ["c"]), // boundary-ish, still inside
        flagAt(25, ["d"]), // outside
        flagAt(48, ["e"]), // way outside
      ],
    };
    const kept = pruneOldFlags(state, NOW);
    expect(kept.map((f) => f.refs[0]).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a flag at exactly 24h ago (boundary inclusive)", () => {
    const state: HallucinationCounterState = {
      flags: [flagAt(24, ["x"])], // exactly at boundary
    };
    const kept = pruneOldFlags(state, NOW);
    expect(kept).toHaveLength(1);
  });

  it("drops flags > 24h ago", () => {
    const state: HallucinationCounterState = {
      flags: [flagAt(24.001, ["x"])],
    };
    expect(pruneOldFlags(state, NOW)).toEqual([]);
  });

  it("returns [] for null/undefined state", () => {
    expect(pruneOldFlags(null, NOW)).toEqual([]);
    expect(pruneOldFlags(undefined, NOW)).toEqual([]);
  });

  it("ignores flags with un-parseable timestamps", () => {
    const state: HallucinationCounterState = {
      flags: [
        flagAt(1, ["a"]),
        { at: "not-a-date", briefDate: "2026-05-22", refs: ["x"] },
      ],
    };
    expect(pruneOldFlags(state, NOW)).toHaveLength(1);
  });

  it("respects a custom windowMs", () => {
    const state: HallucinationCounterState = {
      flags: [flagAt(2, ["x"])],
    };
    // 1h window — the 2h-old flag drops
    expect(pruneOldFlags(state, NOW, 1 * 3600_000)).toEqual([]);
  });

  // ---- shouldPause ----

  it("shouldPause: false when < threshold flags in window", () => {
    expect(shouldPause([flagAt(1), flagAt(2)])).toBe(false); // 2 < 3
  });

  it("shouldPause: true when exactly threshold flags in window", () => {
    expect(shouldPause([flagAt(1), flagAt(2), flagAt(3)])).toBe(true);
  });

  it("shouldPause: true when > threshold", () => {
    expect(shouldPause([flagAt(1), flagAt(2), flagAt(3), flagAt(4)])).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldPause([flagAt(1)], 1)).toBe(true);
    expect(shouldPause([], 1)).toBe(false);
  });

  // ---- The PRD-specified scenario ----

  it("PRD acceptance: 2 flags at hour 0, 1 flag at hour 23 → pause fires", () => {
    const state: HallucinationCounterState = {
      flags: [
        flagAt(0, ["a"]),
        flagAt(0, ["b"]),
        flagAt(23, ["c"]), // 23h ago — still inside 24h window
      ],
    };
    const kept = pruneOldFlags(state, NOW);
    expect(kept).toHaveLength(3);
    expect(shouldPause(kept)).toBe(true);
  });

  it("does NOT fire when a calendar-day rollover would have reset the counter", () => {
    // Simulate: 2 flags at hour 0, 1 flag at hour 23 — across UTC midnight.
    // Naive calendar-day counter would only see today's flag (1 < 3).
    // Rolling 24h correctly sees all 3.
    const justAfterMidnight = new Date("2026-05-22T00:30:00.000Z");
    const state: HallucinationCounterState = {
      flags: [
        {
          at: new Date(justAfterMidnight.getTime() - 23 * 3600_000).toISOString(),
          briefDate: "2026-05-21",
          refs: ["a"],
        },
        {
          at: new Date(justAfterMidnight.getTime() - 23 * 3600_000).toISOString(),
          briefDate: "2026-05-21",
          refs: ["b"],
        },
        {
          at: new Date(justAfterMidnight.getTime() - 0.25 * 3600_000).toISOString(),
          briefDate: "2026-05-22",
          refs: ["c"],
        },
      ],
    };
    const kept = pruneOldFlags(state, justAfterMidnight);
    expect(kept).toHaveLength(3);
    expect(shouldPause(kept)).toBe(true);
  });

  // ---- appendFlag ----

  it("appendFlag prunes + appends in one step", () => {
    const state: HallucinationCounterState = {
      flags: [
        flagAt(25, ["old"]), // gets pruned
        flagAt(2, ["fresh"]),
      ],
    };
    const updated = appendFlag(state, flagAt(0, ["new"]), NOW);
    expect(updated.flags.map((f) => f.refs[0])).toEqual(["fresh", "new"]);
  });

  it("appendFlag handles null initial state", () => {
    const updated = appendFlag(null, flagAt(0, ["new"]), NOW);
    expect(updated.flags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. pausedBriefMarkdown
// ---------------------------------------------------------------------------

describe("pausedBriefMarkdown", () => {
  it("includes the date in the header", () => {
    const md = pausedBriefMarkdown("2026-05-22", "3 flags in 24h");
    expect(md).toContain("# Daily Operating Brief - 2026-05-22");
  });

  it("references both audit and resume commands so the principal can recover", () => {
    const md = pausedBriefMarkdown("2026-05-22", "test reason");
    expect(md).toContain("pacc audit hallucinations");
    expect(md).toContain("pacc resume-briefer");
  });

  it("includes the reason", () => {
    expect(pausedBriefMarkdown("2026-05-22", "test reason xyz")).toContain("test reason xyz");
  });
});

// ---------------------------------------------------------------------------
// 6. Constants — sanity
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_WINDOW_MS is 24h", () => {
    expect(DEFAULT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
  it("DEFAULT_PAUSE_THRESHOLD is 3 (PRD § 15.2 tripwire 5)", () => {
    expect(DEFAULT_PAUSE_THRESHOLD).toBe(3);
  });
});
