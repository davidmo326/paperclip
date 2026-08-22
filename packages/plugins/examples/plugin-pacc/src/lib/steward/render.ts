/**
 * Steward Journal renderer — T-4.8 (T-3.3 template pattern).
 *
 * Deterministic Markdown rendering of a StewardJournal. Sections per PLAN
 * T-4.8: what changed, top-3 attention proposals (source refs + anchor
 * citation + authority + J-class), drafts, awaiting return (travel queue),
 * self-check.
 */

import type { StewardJournal } from "./steward.js";

export function renderStewardJournalMarkdown(journal: StewardJournal): string {
  const lines: string[] = [];
  const push = (...ls: string[]): void => {
    lines.push(...ls);
  };

  // NB: keep timestamps out of ISO-T form here — "2026-08-21T21:37" makes the
  // D-39 slug detector backtrack onto the date prefix ("2026-08-") and
  // false-flag the journal's own header.
  const generatedAtReadable = journal.generatedAt.replace("T", " ").replace(/(\.\d{3})?Z$/, " UTC");
  push(
    `# Steward Journal — ${journal.journalDate}`,
    "",
    `_Generated ${generatedAtReadable} · ${
      journal.modelGenerated ? "model on · L0/L1" : "deterministic (model off)"
    } · confidence ${journal.confidence.toFixed(2)}_`,
    "",
  );

  push("## What changed since yesterday", "");
  if (journal.whatChanged.length === 0) {
    push("_Nothing observed. Silence is valid output._", "");
  } else {
    for (const w of journal.whatChanged) push(`- ${w}`);
    push("");
  }

  push("## Attention (top 3)", "");
  if (journal.attention.length === 0) {
    push("_No proposals today — see self-check._", "");
  } else {
    for (const [i, a] of journal.attention.entries()) {
      push(
        `### ${i + 1}. ${a.project}`,
        "",
        `- **Proposal:** ${a.proposal}`,
        `- **Why now:** ${a.whyNow}`,
        `- **J-class:** ${a.jobClassification} · **Authority:** ${a.requiredAuthority} · **Confidence:** ${a.confidence.toFixed(2)}`,
        `- **Risk if ignored:** ${a.riskIfIgnored}`,
      );
      if (a.sourceRefs.length > 0) {
        push(`- **Sources:** ${a.sourceRefs.map((r) => `\`${r}\``).join(", ")}`);
      }
      if (a.anchorCitations.length > 0) {
        push(`- **Value anchors:** ${a.anchorCitations.join(", ")}`);
      }
      push("");
    }
  }

  push("## Drafts this run", "");
  if (journal.drafts.length === 0) {
    push("_None._", "");
  } else {
    for (const d of journal.drafts) push(`- \`${d.path}\` — ${d.purpose}`);
    push("");
  }

  push("## Awaiting return (travel queue)", "");
  if (journal.awaitingReturn.length === 0) {
    push("_Empty._", "");
  } else {
    for (const a of journal.awaitingReturn) {
      push(`- **[${a.authority}]** ${a.item}`, `  - Recommendation: ${a.recommendation}`);
    }
    push("");
  }

  if (journal.dissent.length > 0) {
    push("## Dissent", "");
    for (const d of journal.dissent) push(`- ${d}`);
    push("");
  }

  push("## Self-check", "");
  if (journal.selfCheck.length === 0) {
    push("_Nothing declined, nothing almost-wrong._", "");
  } else {
    for (const s of journal.selfCheck) push(`- ${s}`);
    push("");
  }

  if (journal.warnings.length > 0) {
    push("## Warnings", "");
    for (const w of journal.warnings) push(`- ⚠️ ${w}`);
    push("");
  }

  return lines.join("\n");
}
