/**
 * Markdown renderer for the project context card — T-2.8.
 *
 * Pure. Takes a `ContextCard` from `context-card.ts` and emits a stable
 * Markdown rendering. Stable = same inputs produce byte-identical output,
 * so diff-friendly + cache-friendly.
 *
 * Section ordering follows PRD § 9.1 "Minimum contents" + § 15.3 eight
 * questions block at the end so the steward sees the synthesis first when
 * reading top-to-bottom.
 */

import type {
  AnswerWithCitations,
  ContextCard,
  EightQuestions,
} from "./context-card.js";

const QUESTION_LABELS: Record<keyof EightQuestions, string> = {
  achieve: "What is this project trying to achieve?",
  status: "What is the current status?",
  decisions: "What decisions have already been made?",
  assumptions: "What assumptions are we operating under?",
  blocked: "What is blocked?",
  changed: "What changed recently?",
  safeNext: "What can I safely do next?",
  requiresApproval: "What requires human approval?",
};

export function renderContextCardMarkdown(card: ContextCard): string {
  const lines: string[] = [];

  lines.push(`# Context Card — ${card.projectName}`);
  lines.push("");
  lines.push(`> Generated ${card.generatedAt} · cache ${card.cacheKey.slice(0, 12)}`);
  lines.push("");

  // Warnings (if any) up top so they're impossible to miss.
  if (card.warnings.length > 0) {
    lines.push("## ⚠ Warnings");
    for (const w of card.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  // PRD § 9.1 minimum contents
  lines.push("## State");
  lines.push(
    `- **portfolio state:** ${card.portfolioState ?? "_unknown_"}`,
    `- **phase:** ${card.currentPhase ?? "_unknown_"}`,
    `- **constraint lane:** ${card.constraintLane ?? "_unknown_"}`,
    `- **stale status:** ${card.staleStatus ?? "_unknown_"}`,
    `- **confidence:** ${card.confidence != null ? card.confidence.toFixed(2) : "_unknown_"}`,
  );
  lines.push("");

  lines.push("## Goal");
  lines.push(renderAnswer(card.goal));
  lines.push("");

  lines.push("## Current Status");
  lines.push(renderAnswer(card.currentStatus));
  lines.push("");

  lines.push("## Next Action");
  lines.push(renderAnswer(card.nextActions));
  lines.push("");

  lines.push("## Blockers");
  lines.push(renderAnswer(card.blockers));
  lines.push("");

  if (card.latestDecisions.length > 0) {
    lines.push("## Recent Decisions");
    for (const d of card.latestDecisions) {
      const chain = d.supersedes ? ` (supersedes \`${d.supersedes.slice(0, 8)}\`)` : "";
      lines.push(`- **${d.summary}** → ${d.chosenOption}${chain}`);
      if (d.rationale) lines.push(`  - rationale: ${d.rationale}`);
      if (d.outcome) lines.push(`  - outcome (${d.outcome.reviewedAt}): ${d.outcome.outcome}`);
    }
    lines.push("");
  }

  if (card.activeAssumptions.length > 0) {
    lines.push("## Active Assumptions");
    for (const a of card.activeAssumptions) {
      lines.push(`- **${a.statement}** _(status: ${a.status}, confidence: ${a.confidence})_`);
      if (a.riskIfWrong) lines.push(`  - risk if wrong: ${a.riskIfWrong}`);
    }
    lines.push("");
  }

  if (card.activeHypotheses.length > 0) {
    lines.push("## Active Hypotheses");
    for (const h of card.activeHypotheses) {
      lines.push(`- **${h.statement}** _(confidence: ${h.confidence})_`);
      if (h.testPlan) lines.push(`  - test plan: ${h.testPlan}`);
    }
    lines.push("");
  }

  if (card.activeTasks.length > 0) {
    lines.push("## Active Tasks");
    for (const t of card.activeTasks.slice(0, 20)) {
      const who = t.assigneeAgentId
        ? `agent:${t.assigneeAgentId.slice(0, 8)}`
        : t.assigneeUserId
          ? `user:${t.assigneeUserId}`
          : "unassigned";
      lines.push(`- **${t.title}** _(${t.status}, ${who})_`);
      if (t.whyItMatters) lines.push(`  - why it matters: ${t.whyItMatters}`);
    }
    lines.push("");
  }

  if (card.openEscalations.length > 0) {
    lines.push("## Open Escalations");
    for (const e of card.openEscalations) {
      lines.push(`- **${e.question}**`);
      if (e.recommendedDecision) lines.push(`  - recommendation: ${e.recommendedDecision}`);
      if (e.risk) lines.push(`  - risk: ${e.risk}`);
    }
    lines.push("");
  }

  if (card.killCriteria.answer) {
    lines.push("## Kill Criteria");
    lines.push(renderAnswer(card.killCriteria));
    lines.push("");
  }

  if (card.doNotRethink.answer) {
    lines.push("## Do Not Rethink");
    lines.push(renderAnswer(card.doNotRethink));
    lines.push("");
  }

  if (card.authorityCeiling.length > 0) {
    lines.push("## Authority Grants");
    for (const a of card.authorityCeiling) {
      const status = a.revoked ? "REVOKED" : "active";
      lines.push(
        `- \`${a.agentId.slice(0, 8)}\` × \`${a.actionClass}\` → ${a.ceiling} (${status}, expires ${a.expiresAt})`,
      );
    }
    lines.push("");
  }

  if (card.staleMarkers.length > 0) {
    lines.push("## Stale Markers");
    for (const m of card.staleMarkers) {
      lines.push(`- **${m.kind}** — \`${m.target}\`${m.detail ? `: ${m.detail}` : ""}`);
    }
    lines.push("");
  }

  if (card.sourceRefs.length > 0) {
    lines.push("## Source Refs");
    for (const r of card.sourceRefs) {
      const section = r.section ? ` ${r.section}` : "";
      lines.push(`- \`${r.kind}\` \`${r.path}\`${section} · hash \`${r.hash.slice(0, 12)}…\``);
    }
    lines.push("");
  }

  // § 15.3 eight questions
  lines.push("## Eight Questions (§ 15.3)");
  lines.push("");
  for (const key of Object.keys(card.eightQuestions) as Array<keyof EightQuestions>) {
    const q = card.eightQuestions[key];
    lines.push(`### ${QUESTION_LABELS[key]}`);
    lines.push(renderAnswer(q));
    lines.push("");
  }

  if (card.unansweredQuestions.length > 0) {
    lines.push("> 🟡 unanswered: " + card.unansweredQuestions.join(", "));
    lines.push("");
  }

  return lines.join("\n");
}

function renderAnswer(a: AnswerWithCitations): string {
  if (a.answer === null) return "_unknown_";
  const confTag =
    a.confidence === "high" ? "" : a.confidence === "low" ? " _(low confidence)_" : " _(unknown)_";
  const citations = a.sourceRefs.length > 0
    ? "\n\n_Sources: " +
      a.sourceRefs
        .map((r) => `\`${r.path}\`${r.section ? ` ${r.section}` : ""}`)
        .join("; ") +
      "_"
    : "";
  return `${a.answer}${confTag}${citations}`;
}
