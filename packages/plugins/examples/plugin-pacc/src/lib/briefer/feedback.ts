/**
 * Brief feedback capture — T-3.9.
 *
 * The brief renderer (T-3.3) emits two principal-writable surfaces:
 *   1. `## AI-Proposed Tasks` — each action is a `- [ ] **summary** — …`
 *      checkbox the principal can toggle to `- [x]` in Obsidian.
 *   2. `## Human Feedback` footer — Useful / Wrong / Changed priority /
 *      Approved actions lines.
 *
 * This module parses those surfaces back out of an edited brief file (pure
 * string → data), reconciles the two approval signals, and derives the
 * downstream outcomes (task creation vs escalation resolution) per the
 * PRD § 13.1 feedback loop.
 *
 * Pure logic only — persistence (`brief_feedback` plugin_state) and issue
 * creation are I/O concerns wired by the worker/CLI layer. The
 * `BriefFeedbackRow` shape is the persisted contract.
 */

import type { Brief } from "./types.js";

// ---------------------------------------------------------------------------
// Parsed shape
// ---------------------------------------------------------------------------

/**
 * T-3.14: did the principal act on today's next action FROM pacc, or bypass
 * pacc for the CLI/vault? The H2 signal that arms the § 0.5 freeze on the real
 * anti-pattern (building a control plane that displaces, rather than drives,
 * portfolio work) — not just brief usefulness.
 */
export type ReachOrBypass = "acted-from-pacc" | "bypassed-to-cli";

export interface ParsedBriefFeedback {
  /** yes → true, no → false, blank/unrecognised → null. */
  useful: boolean | null;
  /** Free-text "what was wrong", or null when blank. */
  wrong: string | null;
  /** Free-text "changed priority" note, or null when blank. */
  changedPriority: string | null;
  /** T-3.14: today's next action — acted from pacc, bypassed to CLI, or null. */
  reachOrBypass: ReachOrBypass | null;
  /**
   * Union of (a) action summaries with a checked checkbox in AI-Proposed
   * Tasks and (b) summaries listed inline on the footer "Approved actions"
   * line. Deduplicated, sorted for stability.
   */
  approvedActions: string[];
}

/** Persisted feedback row (plugin_state, keyed by briefDate). */
export interface BriefFeedbackRow {
  briefDate: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  useful: boolean | null;
  wrong: string | null;
  changedPriority: string | null;
  /** T-3.14. */
  reachOrBypass: ReachOrBypass | null;
  approvedActions: string[];
  /** Convenience mirror of approvedActions.length — read by the kill-criterion meter (T-3.10). */
  acceptedCount: number;
}

// ---------------------------------------------------------------------------
// Outcomes (per PRD § 13.1: accepted action → task OR escalation resolution)
// ---------------------------------------------------------------------------

export interface TaskCreationIntent {
  kind: "task";
  /** Project the task belongs to (from the matched ProposedAction). */
  projectId: string;
  title: string;
  /** Provenance tag so T-3.10 can attribute completed work back to a brief. */
  createdFrom: string; // `brief:<briefDate>`
}

export interface EscalationResolutionIntent {
  kind: "escalation_resolution";
  projectId: string;
  /** The escalation question the principal approved a recommendation for. */
  question: string;
}

export type FeedbackOutcome = TaskCreationIntent | EscalationResolutionIntent;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SECTION_RE = /^##\s+(.*)$/;
const CHECKBOX_RE = /^-\s+\[([ xX])\]\s+\*\*(.+?)\*\*/;
const FOOTER_USEFUL_RE = /^-\s+Useful:\s*(.*)$/i;
const FOOTER_WRONG_RE = /^-\s+Wrong:\s*(.*)$/i;
const FOOTER_PRIORITY_RE = /^-\s+Changed priority:\s*(.*)$/i;
const FOOTER_APPROVED_RE = /^-\s+Approved actions:\s*(.*)$/i;
const FOOTER_REACH_RE = /^-\s+Today's next action:\s*(.*)$/i;

function normaliseUseful(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (["yes", "y", "true", "✅", "[x]", "useful"].includes(v)) return true;
  if (["no", "n", "false", "❌", "[ ]", "not useful"].includes(v)) return false;
  return null;
}

/**
 * T-3.14: tolerate the principal writing either the canonical token or a
 * short form (pacc / acted vs cli / bypassed). Unrecognised → null (no signal).
 */
function normaliseReachOrBypass(raw: string): ReachOrBypass | null {
  const v = raw.trim().toLowerCase().replace(/^-\s+/, "").trim();
  if (v === "") return null;
  if (["acted-from-pacc", "pacc", "acted", "from-pacc", "yes"].includes(v)) return "acted-from-pacc";
  if (["bypassed-to-cli", "bypassed", "cli", "bypass", "no"].includes(v)) return "bypassed-to-cli";
  return null;
}

function blankToNull(raw: string): string | null {
  const v = raw.trim();
  // Treat renderer placeholders / dashes as blank.
  if (v === "" || v === "—" || v === "-" || v === "_none_") return null;
  return v;
}

/**
 * Parse principal feedback out of an edited brief Markdown file.
 *
 * Tolerant of common edit shapes:
 *   - checkbox toggles in AI-Proposed Tasks (`- [x] **summary** …`)
 *   - inline footer edits (Useful: yes, Wrong: <text>, etc.)
 *   - an explicit footer "Approved actions: a, b" list
 *
 * The two approval signals (checked checkboxes + footer list) are unioned —
 * the principal can use either.
 */
export function parseBriefFeedback(markdown: string): ParsedBriefFeedback {
  const lines = markdown.split(/\r?\n/);

  let currentSection: string | null = null;
  const checkedActions = new Set<string>();
  const footerApproved = new Set<string>();
  let useful: boolean | null = null;
  let wrong: string | null = null;
  let changedPriority: string | null = null;
  let reachOrBypass: ReachOrBypass | null = null;

  for (const line of lines) {
    const sectionMatch = SECTION_RE.exec(line.trim());
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    // Checkbox toggles — only count checked boxes inside AI-Proposed Tasks.
    if (currentSection === "ai-proposed tasks") {
      const cb = CHECKBOX_RE.exec(line.trim());
      if (cb) {
        const checked = cb[1].toLowerCase() === "x";
        if (checked) checkedActions.add(cb[2].trim());
        continue;
      }
    }

    // Footer fields — only inside Human Feedback.
    if (currentSection === "human feedback") {
      const u = FOOTER_USEFUL_RE.exec(line.trim());
      if (u) {
        useful = normaliseUseful(u[1]);
        continue;
      }
      const w = FOOTER_WRONG_RE.exec(line.trim());
      if (w) {
        wrong = blankToNull(w[1]);
        continue;
      }
      const p = FOOTER_PRIORITY_RE.exec(line.trim());
      if (p) {
        changedPriority = blankToNull(p[1]);
        continue;
      }
      const reach = FOOTER_REACH_RE.exec(line.trim());
      if (reach) {
        reachOrBypass = normaliseReachOrBypass(reach[1]);
        continue;
      }
      const a = FOOTER_APPROVED_RE.exec(line.trim());
      if (a) {
        const list = blankToNull(a[1]);
        if (list) {
          for (const item of list.split(",")) {
            const s = item.trim();
            if (s) footerApproved.add(s);
          }
        }
        continue;
      }
    }
  }

  const approvedActions = [...new Set([...checkedActions, ...footerApproved])].sort();

  return { useful, wrong, changedPriority, reachOrBypass, approvedActions };
}

// ---------------------------------------------------------------------------
// Row builder + outcomes
// ---------------------------------------------------------------------------

export function makeFeedbackRow(
  briefDate: string,
  parsed: ParsedBriefFeedback,
  now: Date,
): BriefFeedbackRow {
  return {
    briefDate,
    capturedAt: now.toISOString(),
    useful: parsed.useful,
    wrong: parsed.wrong,
    changedPriority: parsed.changedPriority,
    reachOrBypass: parsed.reachOrBypass,
    approvedActions: parsed.approvedActions,
    acceptedCount: parsed.approvedActions.length,
  };
}

/**
 * Derive outcomes for each approved action.
 *
 * Per PRD § 13.1: "Each accepted action becomes an Escalation row resolution
 * OR a Task creation depending on whether the brief item was an action or a
 * task." We resolve by matching the approved summary against the brief:
 *   - matches an escalation question → escalation resolution
 *   - matches a proposed action summary → task creation (createdFrom=brief:<date>)
 *   - matches neither → skipped (returned in `unmatched` for surfacing)
 */
export function deriveFeedbackOutcomes(
  parsed: ParsedBriefFeedback,
  brief: Brief,
): { outcomes: FeedbackOutcome[]; unmatched: string[] } {
  const outcomes: FeedbackOutcome[] = [];
  const unmatched: string[] = [];

  const actionsBySummary = new Map<string, { projectId: string; summary: string }>();
  for (const a of [...brief.highLeverageActions, ...brief.backlogCandidates]) {
    actionsBySummary.set(a.summary.trim(), { projectId: a.projectId, summary: a.summary });
  }

  for (const approved of parsed.approvedActions) {
    // Escalation match first (a question the principal approved).
    const esc = brief.escalations.find((e) => e.question.trim() === approved);
    if (esc) {
      outcomes.push({
        kind: "escalation_resolution",
        projectId: esc.projectId,
        question: esc.question,
      });
      continue;
    }

    const action = actionsBySummary.get(approved);
    if (action) {
      outcomes.push({
        kind: "task",
        projectId: action.projectId,
        title: action.summary,
        createdFrom: `brief:${brief.briefDate}`,
      });
      continue;
    }

    unmatched.push(approved);
  }

  return { outcomes, unmatched };
}
