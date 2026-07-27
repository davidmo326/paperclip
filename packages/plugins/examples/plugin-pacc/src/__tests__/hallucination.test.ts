/**
 * T-3.7 — hallucination tripwire tests. T-3.12 — D-39 fix (pause scope +
 * unique-reference counting) + resume path.
 *
 * Layers:
 *   1. extractIdLikeTokens (UUID / slug detection)
 *   2. detectHallucinations (known-list matching + allow-list)
 *   3. annotateHallucinations (Markdown insertion)
 *   4. normalizeReference (D-39 dedup key)
 *   5. pruneOldSightings + shouldPause + countUniqueModelRefs (rolling 24h, unique refs, model-only pause)
 *   6. auditRowsFromSightings (`pacc audit hallucinations`)
 *   7. resumeBriefer (`pacc resume-briefer`)
 *   8. pausedBriefMarkdown (stub output)
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAUSE_THRESHOLD,
  DEFAULT_WINDOW_MS,
  annotateHallucinations,
  appendSightings,
  auditRowsFromSightings,
  countUniqueModelRefs,
  detectHallucinations,
  extractIdLikeTokens,
  normalizeReference,
  pausedBriefMarkdown,
  pruneOldSightings,
  resumeBriefer,
  shouldPause,
  type HallucinationCounterState,
  type HallucinationSighting,
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

  it("does not flag slug tokens that occur inside a cited source path (T-3.7-sourcerefs)", () => {
    const path = "10_Builds/Circlo/custodian-log.md";
    const flags = detectHallucinations({
      briefMarkdown: `## Source Notes\n\n- **Circlo**: \`${path}\`\n`,
      knownIds: new Set(),
      sourcePaths: [path],
    });
    expect(flags).toEqual([]);
  });

  it("grounds the trailing-hyphen date token from dated filenames (T-3.7-sourcerefs)", () => {
    const path = "10_Builds/Hometrics/2026-04-21-Grants-inventory-table.md";
    const flags = detectHallucinations({
      briefMarkdown: `- **Hometrics**: \`${path}\`\n`,
      knownIds: new Set(),
      sourcePaths: [path],
    });
    // Without sourcePaths this path yields "2026-04-21-" and "inventory-table".
    expect(flags).toEqual([]);
  });

  it("still flags unknown slugs outside the source paths", () => {
    const flags = detectHallucinations({
      briefMarkdown:
        "See `10_Builds/Circlo/custodian-log.md` — also phantom-project needs review.",
      knownIds: new Set(),
      sourcePaths: ["10_Builds/Circlo/custodian-log.md"],
    });
    expect(flags.map((f) => f.reference)).toEqual(["phantom-project"]);
  });

  it("matches source-path tokens case-insensitively", () => {
    const flags = detectHallucinations({
      briefMarkdown: "grounded by custodian-log evidence",
      knownIds: new Set(),
      sourcePaths: ["10_Builds/Circlo/CUSTODIAN-LOG.md"],
    });
    expect(flags).toEqual([]);
  });

  it("T-2.10 Part B: grounds slug tokens inside value-anchor names + purposes (groundingPhrases)", () => {
    // "Zone-2-entrepreneurship" / "three-jobs" would otherwise be slug-shaped flags.
    const flags = detectHallucinations({
      briefMarkdown:
        "## Value Anchors\n\n- [[Zone 2 entrepreneurship]] — operating discipline\n- [[The three jobs of a solo entrepreneur]] — priority hierarchy",
      knownIds: new Set(),
      groundingPhrases: ["Zone 2 entrepreneurship", "The three jobs of a solo entrepreneur"],
    });
    expect(flags).toEqual([]);
  });

  it("still flags an unknown slug even when groundingPhrases are present", () => {
    const flags = detectHallucinations({
      briefMarkdown: "## Value Anchors\n\n- [[Zone 2 entrepreneurship]] — see also phantom-project",
      knownIds: new Set(),
      groundingPhrases: ["Zone 2 entrepreneurship"],
    });
    expect(flags.map((f) => f.reference)).toEqual(["phantom-project"]);
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
// 4. normalizeReference (D-39)
// ---------------------------------------------------------------------------

describe("normalizeReference — D-39 dedup key", () => {
  it("trims, lowercases, and strips trailing punctuation", () => {
    expect(normalizeReference("  Phantom-Slug.  ")).toBe("phantom-slug");
    expect(normalizeReference("phantom-slug,")).toBe("phantom-slug");
    expect(normalizeReference("PHANTOM-SLUG")).toBe("phantom-slug");
  });

  it("treats differently-punctuated mentions as the same reference", () => {
    expect(normalizeReference("phantom-slug.")).toBe(normalizeReference("phantom-slug"));
    expect(normalizeReference("Phantom-Slug,")).toBe(normalizeReference("phantom-slug"));
  });
});

// ---------------------------------------------------------------------------
// 5. Rolling 24h counter — unique references (D-39)
// ---------------------------------------------------------------------------

describe("pruneOldSightings + shouldPause — rolling 24h, unique refs", () => {
  const NOW = new Date("2026-05-22T08:00:00.000Z");

  function sightingAt(
    hoursAgo: number,
    ref: string,
    modelGenerated = true,
  ): HallucinationSighting {
    return {
      at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
      briefDate: "2026-05-22",
      ref,
      rawRef: ref,
      modelGenerated,
    };
  }

  it("keeps sightings within the 24h window, drops older ones", () => {
    const state: HallucinationCounterState = {
      sightings: [
        sightingAt(0.5, "a"),
        sightingAt(12, "b"),
        sightingAt(23, "c"), // boundary-ish, still inside
        sightingAt(25, "d"), // outside
        sightingAt(48, "e"), // way outside
      ],
    };
    const kept = pruneOldSightings(state, NOW);
    expect(kept.map((s) => s.ref).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a sighting at exactly 24h ago (boundary inclusive)", () => {
    const state: HallucinationCounterState = { sightings: [sightingAt(24, "x")] };
    expect(pruneOldSightings(state, NOW)).toHaveLength(1);
  });

  it("drops sightings > 24h ago", () => {
    const state: HallucinationCounterState = { sightings: [sightingAt(24.001, "x")] };
    expect(pruneOldSightings(state, NOW)).toEqual([]);
  });

  it("returns [] for null/undefined state", () => {
    expect(pruneOldSightings(null, NOW)).toEqual([]);
    expect(pruneOldSightings(undefined, NOW)).toEqual([]);
  });

  it("ignores sightings with un-parseable timestamps", () => {
    const state: HallucinationCounterState = {
      sightings: [
        sightingAt(1, "a"),
        { at: "not-a-date", briefDate: "2026-05-22", ref: "x", rawRef: "x", modelGenerated: true },
      ],
    };
    expect(pruneOldSightings(state, NOW)).toHaveLength(1);
  });

  it("respects a custom windowMs", () => {
    const state: HallucinationCounterState = { sightings: [sightingAt(2, "x")] };
    // 1h window — the 2h-old sighting drops
    expect(pruneOldSightings(state, NOW, 1 * 3600_000)).toEqual([]);
  });

  // ---- countUniqueModelRefs ----

  it("counts each unique ref once even if it repeats across runs", () => {
    // Same ref on 3 consecutive model briefs — counts once (D-39 acceptance).
    expect(countUniqueModelRefs([sightingAt(2, "x"), sightingAt(1, "x"), sightingAt(0, "x")])).toBe(1);
  });

  it("excludes deterministic/offline sightings from the count", () => {
    expect(
      countUniqueModelRefs([
        sightingAt(2, "a", false),
        sightingAt(1, "b", false),
        sightingAt(0, "c", false),
      ]),
    ).toBe(0);
  });

  it("counts unique refs across mixed origins, deterministic excluded", () => {
    expect(
      countUniqueModelRefs([sightingAt(2, "a", true), sightingAt(1, "b", false), sightingAt(0, "c", true)]),
    ).toBe(2);
  });

  // ---- shouldPause ----

  it("shouldPause: false when < threshold unique model refs in window", () => {
    expect(shouldPause([sightingAt(1, "a"), sightingAt(2, "b")])).toBe(false); // 2 < 3
  });

  it("shouldPause: true when exactly threshold unique model refs in window", () => {
    expect(shouldPause([sightingAt(1, "a"), sightingAt(2, "b"), sightingAt(3, "c")])).toBe(true);
  });

  it("shouldPause: true when > threshold", () => {
    expect(
      shouldPause([sightingAt(1, "a"), sightingAt(2, "b"), sightingAt(3, "c"), sightingAt(4, "d")]),
    ).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldPause([sightingAt(1, "a")], 1)).toBe(true);
    expect(shouldPause([], 1)).toBe(false);
  });

  // ---- D-39 acceptance scenarios ----

  it("D-39: 3 flagged deterministic briefs in 24h → zero pause", () => {
    const sightings = [sightingAt(2, "a", false), sightingAt(1, "b", false), sightingAt(0, "c", false)];
    expect(shouldPause(sightings)).toBe(false);
  });

  it("D-39: same ref on 3 consecutive model briefs → counts once → no pause", () => {
    const sightings = [sightingAt(2, "phantom-slug"), sightingAt(1, "phantom-slug"), sightingAt(0, "phantom-slug")];
    expect(countUniqueModelRefs(sightings)).toBe(1);
    expect(shouldPause(sightings)).toBe(false);
  });

  it("D-39: 3 unique refs on model briefs in 24h → pause fires", () => {
    const sightings = [sightingAt(2, "a"), sightingAt(1, "b"), sightingAt(0, "c")];
    expect(countUniqueModelRefs(sightings)).toBe(3);
    expect(shouldPause(sightings)).toBe(true);
  });

  it("PRD acceptance: 2 unique refs at hour 0, 1 at hour 23 → pause fires (rolling window)", () => {
    const state: HallucinationCounterState = {
      sightings: [sightingAt(0, "a"), sightingAt(0, "b"), sightingAt(23, "c")],
    };
    const kept = pruneOldSightings(state, NOW);
    expect(kept).toHaveLength(3);
    expect(shouldPause(kept)).toBe(true);
  });

  it("does NOT fire when a calendar-day rollover would have reset the counter", () => {
    // Simulate: 2 unique refs at hour 0, 1 at hour 23 — across UTC midnight.
    // Naive calendar-day counter would only see today's ref (1 < 3).
    // Rolling 24h correctly sees all 3.
    const justAfterMidnight = new Date("2026-05-22T00:30:00.000Z");
    const state: HallucinationCounterState = {
      sightings: [
        {
          at: new Date(justAfterMidnight.getTime() - 23 * 3600_000).toISOString(),
          briefDate: "2026-05-21",
          ref: "a",
          rawRef: "a",
          modelGenerated: true,
        },
        {
          at: new Date(justAfterMidnight.getTime() - 23 * 3600_000).toISOString(),
          briefDate: "2026-05-21",
          ref: "b",
          rawRef: "b",
          modelGenerated: true,
        },
        {
          at: new Date(justAfterMidnight.getTime() - 0.25 * 3600_000).toISOString(),
          briefDate: "2026-05-22",
          ref: "c",
          rawRef: "c",
          modelGenerated: true,
        },
      ],
    };
    const kept = pruneOldSightings(state, justAfterMidnight);
    expect(kept).toHaveLength(3);
    expect(shouldPause(kept)).toBe(true);
  });

  // ---- appendSightings ----

  it("appendSightings prunes + appends in one step", () => {
    const state: HallucinationCounterState = {
      sightings: [sightingAt(25, "old"), sightingAt(2, "fresh")],
    };
    const updated = appendSightings(state, [sightingAt(0, "new")], NOW);
    expect(updated.sightings.map((s) => s.ref)).toEqual(["fresh", "new"]);
  });

  it("appendSightings handles null initial state", () => {
    const updated = appendSightings(null, [sightingAt(0, "new")], NOW);
    expect(updated.sightings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. auditRowsFromSightings — `pacc audit hallucinations`
// ---------------------------------------------------------------------------

describe("auditRowsFromSightings", () => {
  it("collapses repeated refs to one row keyed on first-seen", () => {
    const rows = auditRowsFromSightings([
      { at: "2026-05-22T01:00:00.000Z", briefDate: "2026-05-22", ref: "a", rawRef: "A.", modelGenerated: true },
      { at: "2026-05-22T03:00:00.000Z", briefDate: "2026-05-22", ref: "a", rawRef: "a", modelGenerated: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref: "a", firstSeenAt: "2026-05-22T01:00:00.000Z", briefDate: "2026-05-22" });
  });

  it("preserves origin (model vs deterministic) per row", () => {
    const rows = auditRowsFromSightings([
      { at: "2026-05-22T01:00:00.000Z", briefDate: "2026-05-22", ref: "a", rawRef: "a", modelGenerated: true },
      { at: "2026-05-22T02:00:00.000Z", briefDate: "2026-05-22", ref: "b", rawRef: "b", modelGenerated: false },
    ]);
    expect(rows.find((r) => r.ref === "a")?.modelGenerated).toBe(true);
    expect(rows.find((r) => r.ref === "b")?.modelGenerated).toBe(false);
  });

  it("returns [] for an empty window", () => {
    expect(auditRowsFromSightings([])).toEqual([]);
  });

  it("matches a fixture window", () => {
    const rows = auditRowsFromSightings([
      { at: "2026-05-22T06:00:00.000Z", briefDate: "2026-05-22", ref: "co-reader-x", rawRef: "co-reader-x", modelGenerated: true },
      { at: "2026-05-22T07:00:00.000Z", briefDate: "2026-05-22", ref: "phantom-decision", rawRef: "phantom-decision.", modelGenerated: true },
      { at: "2026-05-21T09:00:00.000Z", briefDate: "2026-05-21", ref: "offline-glitch", rawRef: "offline-glitch", modelGenerated: false },
    ]);
    expect(rows).toEqual([
      { ref: "offline-glitch", firstSeenAt: "2026-05-21T09:00:00.000Z", briefDate: "2026-05-21", modelGenerated: false },
      { ref: "co-reader-x", firstSeenAt: "2026-05-22T06:00:00.000Z", briefDate: "2026-05-22", modelGenerated: true },
      { ref: "phantom-decision", firstSeenAt: "2026-05-22T07:00:00.000Z", briefDate: "2026-05-22", modelGenerated: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. resumeBriefer — `pacc resume-briefer`
// ---------------------------------------------------------------------------

describe("resumeBriefer", () => {
  const NOW = new Date("2026-05-22T08:00:00.000Z");

  it("clears an active pause and writes a principal audit row", () => {
    const result = resumeBriefer({
      pauseState: { paused: true, reason: "3 unique refs" },
      actor: "principal",
      now: NOW,
    });
    expect(result.kind).toBe("resumed");
    if (result.kind === "resumed") {
      expect(result.auditRow.actor).toBe("principal");
      expect(result.auditRow.clearedReason).toBe("3 unique refs");
      expect(result.auditRow.at).toBe(NOW.toISOString());
    }
  });

  it("errors clearly when no pause is active", () => {
    expect(resumeBriefer({ pauseState: null, actor: "principal", now: NOW })).toEqual({ kind: "not_paused" });
    expect(
      resumeBriefer({ pauseState: { paused: false, reason: null }, actor: "principal", now: NOW }),
    ).toEqual({ kind: "not_paused" });
  });
});

// ---------------------------------------------------------------------------
// 8. pausedBriefMarkdown
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
// 9. Constants — sanity
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_WINDOW_MS is 24h", () => {
    expect(DEFAULT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
  it("DEFAULT_PAUSE_THRESHOLD is 3 (PRD § 15.2 tripwire 5)", () => {
    expect(DEFAULT_PAUSE_THRESHOLD).toBe(3);
  });
});
