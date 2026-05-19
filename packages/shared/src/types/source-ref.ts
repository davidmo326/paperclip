/**
 * SourceRef — a citation pointer into the principal's memory tiers.
 *
 * Per PRD § 9.6 (M1a/M1b mutation rules) and § 9.7 (provenance enforcement),
 * any agent-written canonical-state field that asserts a fact MUST cite the
 * source as a `SourceRef`. Vague citations ("matches the principal's values")
 * are rejected — the rationale is in § 9.6 "Why the citation distinction
 * matters for M1b".
 *
 * Memory tier kinds (PRD § 7.3):
 *   M1a — project artefacts (PRDs, blog drafts, code, research notes); editable under gate
 *   M1b — value anchors (always read-only to agents); cited as alignment criterion
 *   M2  — canonical state (the row this SourceRef is being written into; for chained cites)
 *   M3  — episodic memory (briefs, conversation logs)
 *   M4  — decision log
 *   M5  — task ledger
 *   M6  — retrieved context packs
 */
export type SourceRefKind = "M1a" | "M1b" | "M2" | "M3" | "M4" | "M5" | "M6";

export interface SourceRef {
  /** Which memory tier the source lives in. */
  kind: SourceRefKind;
  /** File path (for M1a/M1b) or canonical URL (for external M3+) or row id (for M2/M4/M5). */
  path: string;
  /** Optional section / header / line range, e.g. "§ 8.1" or "L42-L58". */
  section?: string;
  /** SHA-256 hex of the source content at cite time. Used to detect drift since citation. */
  hash: string;
  /** ISO-8601 timestamp the citation was captured. */
  capturedAt: string;
}
