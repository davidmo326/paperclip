/**
 * Brief Markdown renderer — T-3.3.
 *
 * Pure function: `Brief` → Markdown string. Byte-identical for the same
 * input on the same calendar day (the only time-dependent field is
 * `briefDate` (YYYY-MM-DD); `generatedAt` is intentionally NOT rendered).
 *
 * Section order mirrors PRD v0.3 § 13.1's literal template. The
 * documented template lives at `ControlPlane/templates/daily-brief.md`;
 * the two are kept in lock-step by tests in `__tests__/brief-render.test.ts`.
 *
 * Empty sections render their heading + a placeholder line so re-running
 * the brief with no state change produces zero diff (cron idempotence).
 */

import type { Brief, JobMixRow, ProposedAction, StaleRollupRow } from "./types.js";
import {
  renderSelfCheckSection,
  type KillCriterionMetric,
} from "./kill-criterion.js";

export interface RenderBriefOptions {
  /**
   * When true, the renderer omits the empty-section placeholders (e.g.
   * "_no entries_"). Default false. Useful when the principal wants a
   * leaner brief preview.
   */
  omitEmptySectionPlaceholders?: boolean;
  /**
   * T-3.10 kill-criterion meter inputs. When provided, the "Control-plane
   * self-check" section shows 7-day rolling totals + the red-flag line.
   * When omitted, the section still renders (with a pending-wiring note) so
   * it's present in every brief.
   */
  selfCheck?: { metrics: KillCriterionMetric[]; now: Date };
}

const EMPTY_PLACEHOLDER = "_no entries_";

export function renderBriefMarkdown(
  brief: Brief,
  options: RenderBriefOptions = {},
): string {
  const out: string[] = [];

  out.push(`# Daily Operating Brief - ${brief.briefDate}`);
  out.push("");
  out.push(
    "> **How to give feedback:** focus on the **Lead Question** + **Decisions** below — " +
      "that's your plane. The **Agent task queue** is the agent's work (visibility, not your attention). " +
      "Fill the **Human Feedback** footer (Useful / Wrong / Changed priority / Today's next action / Lead override). " +
      "Then run `pacc brief --feedback`.",
  );
  out.push("");

  // -- Portfolio Summary -----------------------------------------------------
  out.push("## Portfolio Summary");
  out.push("");
  out.push(brief.portfolioSummary.answer ?? "_No portfolio summary._");
  if (brief.portfolioSummary.confidence === "low") {
    out.push("");
    out.push("> _(low confidence)_");
  } else if (brief.portfolioSummary.confidence === "unknown") {
    out.push("");
    out.push("> _(unknown — no synthesis available)_");
  }
  out.push("");

  // -- Value Anchors (M1b, T-2.10 Part B) ------------------------------------
  // Portfolio-level context: the principal's value anchors, cited via
  // [[Name]] § Section @ hash8 (docs/value-anchor-citation-format.md). Rendered
  // only when non-empty; sorted by name for deterministic output.
  const anchors = [...(brief.valueAnchors ?? [])].sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0,
  );
  if (anchors.length > 0) {
    out.push("## Value Anchors");
    out.push("");
    for (const a of anchors) {
      const purpose = a.purpose ? ` — ${a.purpose}` : "";
      const mark = a.resolved ? "" : " _(unresolved)_";
      out.push(`- [[${a.name}]]${purpose}${mark}`);
    }
    out.push("");
  }

  // -- Job Mix ---------------------------------------------------------------
  out.push("## Job Mix");
  out.push("");
  out.push("| Project | Phase | J1 | J2 | J3 | Meta | Threshold Breach |");
  out.push("|---|---|---:|---:|---:|---:|---|");
  const jobMix = [...brief.jobMix].sort(byProjectName);
  for (const row of jobMix) {
    out.push(renderJobMixRow(row));
  }
  if (jobMix.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`| ${EMPTY_PLACEHOLDER} | | | | | | |`);
  }
  out.push("");

  // -- Lead Question (T-3.15: question-led brief) ---------------------------
  // The principal's plane: the riskiest non-obvious assumption + its welded test.
  out.push("## Lead Question");
  out.push("");
  if (brief.leadQuestion) {
    const lq = brief.leadQuestion;
    out.push(`- Project: ${lq.projectName}`);
    out.push(`- Question (riskiest assumption): ${lq.statement}`);
    out.push(`- Test (next action): ${lq.test}`);
    out.push(`- Confidence: ${Math.round(lq.confidence * 100)}%`);
    if (lq.overridden) {
      out.push("> _⚠ Lead overridden from riskiest-first default._");
    }
  } else {
    out.push(
      `> _No testable lead question — no project has a hypothesis with a test plan. ` +
        `Author one for your riskiest non-obvious assumption._`,
    );
  }
  out.push("");

  // -- Open Questions to Validate (the divergent candidate layer) ------------
  out.push("## Open Questions to Validate");
  out.push("");
  const openQs = [...brief.openQuestions].sort(byProjectName);
  for (const q of openQs) {
    const fidelity = q.fidelityMismatch ? " ⚠ _market-assumption / think-test_" : "";
    out.push(`- **${q.projectName}**: ${q.statement}`);
    out.push(`  - Test: ${q.test} (confidence: ${Math.round(q.confidence * 100)}%)${fidelity}`);
  }
  if (openQs.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(
      `> _No additional testable questions. Author hypotheses with test plans to populate this layer._`,
    );
  }
  out.push("");

  // -- Memory / Source Issues -----------------------------------------------
  out.push("## Memory / Source Issues");
  out.push("");
  const memoryIssues = [...brief.staleConflictedMemory].sort(byStaleKind);
  for (const row of memoryIssues) out.push(renderStaleRollupLine(row));
  // D-41: every project with an unset jobClassificationDominant is a
  // data-quality gap the brief itself should prompt the principal to fix.
  const unclassifiedProjects = [...brief.jobMix]
    .filter((r) => r.dominantUnset)
    .sort(byProjectName);
  for (const row of unclassifiedProjects) out.push(renderUnclassifiedDominantLine(row));
  if (
    memoryIssues.length === 0 &&
    unclassifiedProjects.length === 0 &&
    !options.omitEmptySectionPlaceholders
  ) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Decisions needing you (T-3.15: elevated from buried Escalations) -----
  out.push("## Decisions needing you");
  out.push("");
  const escalations = [...brief.escalations].sort(byProjectIdThenQuestion);
  for (const e of escalations) {
    const rec = e.recommendedDecision ? ` (recommends: ${e.recommendedDecision})` : "";
    out.push(`- [ ] ${e.projectId}: ${e.question}${rec}`);
  }
  if (escalations.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Agent task queue (T-3.15: demoted from "AI-Proposed Tasks") -----------
  out.push("## Agent task queue");
  out.push("");
  const proposed = [...brief.highLeverageActions, ...brief.backlogCandidates].sort(byActionSummary);
  for (const a of proposed) out.push(renderProposedActionLine(a));
  if (proposed.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Do Not Rethink --------------------------------------------------------
  out.push("## Do Not Rethink");
  out.push("");
  const dnr = [...brief.doNotRethinkAlerts].sort(byProjectName);
  for (const d of dnr) {
    out.push(`- **${d.projectName}**: ${d.settledDecision}`);
    out.push(`  - ⚠ queued action overlaps: ${d.conflictingAction}`);
  }
  if (dnr.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Completed Since Last Brief -------------------------------------------
  out.push("## Completed Since Last Brief");
  out.push("");
  const completed = [...brief.completedWork].sort((a, b) =>
    a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0,
  );
  for (const c of completed) {
    out.push(`- **${nameOf(brief, c.projectId)}**: ${c.artifact} _(${c.completedAt})_`);
  }
  if (completed.length === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Source Notes ----------------------------------------------------------
  out.push("## Source Notes");
  out.push("");
  const sources = [...brief.sourceNotes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  // Dedupe by (projectId, path)
  const seenSources = new Set<string>();
  let writtenSources = 0;
  for (const s of sources) {
    const key = `${s.projectId}|${s.path}`;
    if (seenSources.has(key)) continue;
    seenSources.add(key);
    out.push(`- **${nameOf(brief, s.projectId)}**: \`${s.path}\``);
    writtenSources += 1;
  }
  if (writtenSources === 0 && !options.omitEmptySectionPlaceholders) {
    out.push(`- ${EMPTY_PLACEHOLDER}`);
  }
  out.push("");

  // -- Control-plane self-check (T-3.10) ------------------------------------
  if (options.selfCheck) {
    for (const line of renderSelfCheckSection(options.selfCheck.metrics, options.selfCheck.now)) {
      out.push(line);
    }
  } else {
    out.push("## Control-plane self-check");
    out.push("");
    out.push("_self-check metrics not wired for this render_");
    out.push("");
  }

  // -- Human Feedback --------------------------------------------------------
  out.push("## Human Feedback");
  out.push("");
  out.push(`- Useful: ${renderTriBool(brief.humanFeedback.useful)}`);
  out.push(`- Wrong: ${brief.humanFeedback.wrong ?? ""}`);
  out.push(`- Changed priority: ${brief.humanFeedback.changedPriority ?? ""}`);
  // T-3.14: H2 reach/bypass — edit to `acted-from-pacc` or `bypassed-to-cli`.
  out.push(`- Today's next action: `);
  const approvedList = [...brief.humanFeedback.approvedActions].sort();
  out.push(
    `- Approved actions: ${approvedList.length === 0 ? "" : approvedList.join(", ")}`,
  );
  out.push("");

  // -- Optional Warnings footer ---------------------------------------------
  if (brief.warnings.length > 0) {
    out.push("---");
    out.push("");
    out.push("## ⚠ Warnings");
    out.push("");
    for (const w of [...brief.warnings].sort()) {
      out.push(`- ${w}`);
    }
    out.push("");
  }

  // Trailing newline only (no Windows-style \r\n) for byte-stability.
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

/** Resolve a projectId to its display name; falls back to a short id if unknown. */
function nameOf(brief: Brief, projectId: string): string {
  return brief.projectNames?.[projectId] ?? `project ${projectId.slice(0, 8)}`;
}

function renderJobMixRow(row: JobMixRow): string {
  const breachParts: string[] = [];
  if (row.thresholdBreach) breachParts.push(row.thresholdBreach);
  if (row.unclassifiedCount > 0) breachParts.push(`${row.unclassifiedCount} unclassified`);
  const breach = breachParts.join("; ");
  return `| ${row.projectName} | ${row.phase ?? ""} | ${pct(row.j1Pct)} | ${pct(row.j2Pct)} | ${pct(row.j3Pct)} | ${pct(row.metaPct)} | ${breach} |`;
}

function pct(n: number | null): string {
  // Stable formatting — same number → same string. `null` (no classified
  // signal, per D-41) renders as "—" rather than a fabricated 0%.
  if (n === null) return "—";
  return `${Math.round(n)}%`;
}

function synthesizeAttentionRows(brief: Brief): string[] {
  // One row per project: blockedProjects ∪ projects-with-highLeverageActions.
  type AttentionInput = {
    projectId: string;
    projectName: string;
    state: string;
    lane: string;
    staleStatus: string;
    recommendedAction: string;
    authority: string;
    confidence: string;
  };

  const byProject = new Map<string, AttentionInput>();

  for (const b of brief.blockedProjects) {
    byProject.set(b.projectId, {
      projectId: b.projectId,
      projectName: b.projectName,
      state: "blocked",
      lane: "",
      staleStatus: "",
      recommendedAction: b.blockerSummary ?? "_unblock_",
      authority: "L1",
      confidence: "",
    });
  }

  for (const a of brief.highLeverageActions) {
    const existing = byProject.get(a.projectId);
    if (existing) {
      existing.recommendedAction = a.summary;
      existing.authority = a.requiredAuthority;
      existing.confidence = a.confidence.toFixed(2);
    } else {
      byProject.set(a.projectId, {
        projectId: a.projectId,
        projectName: nameOf(brief, a.projectId),
        state: "active",
        lane: "",
        staleStatus: "",
        recommendedAction: a.summary,
        authority: a.requiredAuthority,
        confidence: a.confidence.toFixed(2),
      });
    }
  }

  const sorted = [...byProject.values()].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
  return sorted.map(
    (r) =>
      `| ${r.projectName} | ${r.state} | ${r.lane} | ${r.staleStatus} | ${r.recommendedAction} | ${r.authority} | ${r.confidence} |`,
  );
}

function renderStaleRollupLine(row: StaleRollupRow): string {
  const projects = [...row.projectIds].sort().join(", ");
  return `- [ ] **${row.kind}** (${row.count}) — projects: ${projects}`;
}

function renderUnclassifiedDominantLine(row: JobMixRow): string {
  return `- [ ] **${row.projectName}** — unclassified — set jobClassificationDominant`;
}

function renderProposedActionLine(a: ProposedAction): string {
  const artifact = a.expectedArtifact ?? "(no expected artifact)";
  return `- [ ] **${a.summary}** — ${artifact} — ${a.requiredAuthority} — ${a.jobClassification ?? "unclassified"}`;
}

function renderInlineSourceRefs(
  refs: Array<{ kind: string; path: string; section?: string }>,
): string {
  if (refs.length === 0) return "_(none cited)_";
  return refs
    .slice(0, 5)
    .map((r) => `\`${r.path}\`${r.section ? ` ${r.section}` : ""}`)
    .join("; ");
}

function renderTriBool(v: boolean | null): string {
  if (v === null) return "";
  return v ? "yes" : "no";
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

function byProjectName<T extends { projectName: string }>(a: T, b: T): number {
  return a.projectName < b.projectName ? -1 : a.projectName > b.projectName ? 1 : 0;
}

function byStaleKind(a: StaleRollupRow, b: StaleRollupRow): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

function byProjectIdThenQuestion(
  a: { projectId: string; question: string },
  b: { projectId: string; question: string },
): number {
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
  return a.question < b.question ? -1 : a.question > b.question ? 1 : 0;
}

function byActionSummary(a: ProposedAction, b: ProposedAction): number {
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
  return a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0;
}
