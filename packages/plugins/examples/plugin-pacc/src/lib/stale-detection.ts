/**
 * Stale / drift detection logic — T-2.6.
 *
 * Two PRD-driven detection modes:
 *
 *   1. **Hash drift (tripwire 2, weekly).** For every M2 row, re-hash the
 *      file each cited SourceRef points at. If the file's current hash
 *      differs from the SourceRef.hash captured at write time, the row is
 *      `stale_pending_re_grounding`.
 *
 *   2. **Source decay (tripwire 7, daily).** If a project's M1 sources have
 *      not been touched for more than its `staleThresholdDays` (default 30),
 *      emit `project.source_decay` so the next brief surfaces a "consider
 *      re-grounding" item.
 *
 * Pure functions. The job wrappers in src/jobs/ supply the filesystem and
 * the data sources; this file is unit-testable without paperclip or fs
 * mocks beyond the temp-dir conventions in the test file.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { SourceRef } from "@paperclipai/shared";

/** Compute SHA-256 hex of a file's UTF-8 contents. Returns null if the file is missing. */
export async function computeFileHash(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

/** Read the mtime of a file. Returns null if missing. */
export async function lastTouchedAt(path: string): Promise<Date | null> {
  try {
    const s = await stat(path);
    return s.mtime;
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/** Days elapsed between `ts` and `now` (positive when ts is older). Infinity for null. */
export function daysSince(ts: Date | null, now: Date = new Date()): number {
  if (ts === null) return Number.POSITIVE_INFINITY;
  return (now.getTime() - ts.getTime()) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Hash drift
// ---------------------------------------------------------------------------

export interface FreshResult {
  kind: "fresh";
  path: string;
  currentHash: string;
}
export interface StaleResult {
  kind: "stale";
  path: string;
  expectedHash: string;
  currentHash: string;
}
export interface OrphanedResult {
  kind: "orphaned";
  path: string;
  expectedHash: string;
}

export type HashCheckResult = FreshResult | StaleResult | OrphanedResult;

/**
 * Compare a single SourceRef's recorded hash with the file's current hash.
 * Returns `orphaned` if the file is missing, `stale` if hashes differ,
 * `fresh` otherwise. Hash comparison is case-insensitive (we store hex).
 */
export async function checkSourceRefFreshness(
  ref: SourceRef,
): Promise<HashCheckResult> {
  const currentHash = await computeFileHash(ref.path);
  if (currentHash === null) {
    return { kind: "orphaned", path: ref.path, expectedHash: ref.hash };
  }
  if (currentHash.toLowerCase() !== ref.hash.toLowerCase()) {
    return {
      kind: "stale",
      path: ref.path,
      expectedHash: ref.hash,
      currentHash,
    };
  }
  return { kind: "fresh", path: ref.path, currentHash };
}

/** Aggregate freshness across an array of SourceRefs. */
export interface FreshnessReport {
  totalRefs: number;
  fresh: FreshResult[];
  stale: StaleResult[];
  orphaned: OrphanedResult[];
  /** True iff at least one stale or orphaned ref is present. */
  hasDrift: boolean;
}

export async function checkSourceRefsFreshness(
  refs: readonly SourceRef[],
): Promise<FreshnessReport> {
  const results = await Promise.all(refs.map(checkSourceRefFreshness));
  const fresh: FreshResult[] = [];
  const stale: StaleResult[] = [];
  const orphaned: OrphanedResult[] = [];
  for (const r of results) {
    if (r.kind === "fresh") fresh.push(r);
    else if (r.kind === "stale") stale.push(r);
    else orphaned.push(r);
  }
  return {
    totalRefs: refs.length,
    fresh,
    stale,
    orphaned,
    hasDrift: stale.length > 0 || orphaned.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Source decay
// ---------------------------------------------------------------------------

export interface DecayCheckInput {
  projectId: string;
  sourceRefs: readonly SourceRef[];
  /** Default 30 per PRD § 15.2 tripwire 7. */
  thresholdDays: number;
}

export interface DecayCheckResult {
  projectId: string;
  decayed: boolean;
  /** `+Infinity` if no source was touchable (file missing OR no refs). */
  daysSinceLastTouch: number;
  lastTouchedPath: string | null;
  thresholdDays: number;
}

/**
 * Walk a project's SourceRefs, find the most recently touched file, and
 * compare against the threshold. Missing files are skipped (not treated as
 * "touched at 0"); if every ref is missing, returns +Infinity days and
 * `decayed: true`.
 */
export async function checkProjectDecay(
  input: DecayCheckInput,
  now: Date = new Date(),
): Promise<DecayCheckResult> {
  let mostRecent: { path: string; ts: Date } | null = null;
  for (const ref of input.sourceRefs) {
    const ts = await lastTouchedAt(ref.path);
    if (ts === null) continue;
    if (mostRecent === null || ts > mostRecent.ts) {
      mostRecent = { path: ref.path, ts };
    }
  }
  const days = daysSince(mostRecent?.ts ?? null, now);
  return {
    projectId: input.projectId,
    decayed: days > input.thresholdDays,
    daysSinceLastTouch: days,
    lastTouchedPath: mostRecent?.path ?? null,
    thresholdDays: input.thresholdDays,
  };
}

// ---------------------------------------------------------------------------
// SourceRef extraction
// ---------------------------------------------------------------------------

/**
 * Collect every SourceRef from a project's controlPlaneState JSON. Walks
 * top-level fields, plus the inner arrays added in T-1.3:
 * memoryIndexRefs, sourceRefs, assumptions[].sourceRefs,
 * hypotheses[].evidenceFor/evidenceAgainst, escalations[].sourceRefs.
 *
 * Returns deduplicated refs by `path` (the same file cited from multiple
 * fields only gets re-hashed once).
 */
export function collectSourceRefsFromControlPlaneState(
  state: unknown,
): SourceRef[] {
  if (!state || typeof state !== "object") return [];
  const s = state as Record<string, unknown>;
  const seen = new Set<string>();
  const out: SourceRef[] = [];

  const push = (ref: unknown) => {
    if (!isSourceRefShape(ref)) return;
    const key = ref.path;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  const pushArray = (arr: unknown) => {
    if (Array.isArray(arr)) for (const r of arr) push(r);
  };

  pushArray(s.memoryIndexRefs);
  pushArray(s.sourceRefs);

  if (Array.isArray(s.assumptions)) {
    for (const a of s.assumptions as Array<Record<string, unknown>>) {
      pushArray(a?.sourceRefs);
    }
  }
  if (Array.isArray(s.hypotheses)) {
    for (const h of s.hypotheses as Array<Record<string, unknown>>) {
      pushArray(h?.evidenceFor);
      pushArray(h?.evidenceAgainst);
    }
  }
  if (Array.isArray(s.escalations)) {
    for (const e of s.escalations as Array<Record<string, unknown>>) {
      pushArray(e?.sourceRefs);
    }
  }
  return out;
}

function isSourceRefShape(v: unknown): v is SourceRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.path === "string" && typeof r.hash === "string" && typeof r.kind === "string";
}
