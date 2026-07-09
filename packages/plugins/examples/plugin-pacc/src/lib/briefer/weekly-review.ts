/**
 * Weekly portfolio review — T-3.11 (PRD § 13.2).
 *
 * Pure build + render, mirroring the daily-brief pattern (T-3.3): a typed
 * review object assembled from canonical project state + job-mix, then a
 * deterministic Markdown renderer (same input on the same week → byte-identical
 * output, so the Monday cron is idempotent).
 *
 * Sections that need data not yet readable via the plugin SDK (decisions due
 * for review → T-4.7; expiring authority grants → authority_profiles SDK read;
 * tasks completed vs created + agent performance → issues/runs wiring) render a
 * consistent "(not yet wired)" placeholder, exactly like the daily brief's
 * unwired slots. They light up as those readers land.
 */

import type { JobMixRow } from "./types.js";

export interface WeeklyProjectInput {
  projectId: string;
  projectName: string;
  portfolioState: string | null;
  phase: string | null;
  staleStatus: string | null;
  /** Null when the project has no declared next smallest action. */
  nextAction: string | null;
  /** Assumptions whose status is stale/challenged → due for review. */
  assumptionsDue: Array<{ statement: string }>;
  /** Count of stale/drift/conflict markers (pending re-grounding). */
  driftCount: number;
}

export interface WeeklyReviewInput {
  projects: readonly WeeklyProjectInput[];
  jobMix: readonly JobMixRow[];
  /** Decisions past their reviewDate with no outcome yet (T-4.7). */
  decisionsDue?: ReadonlyArray<{ projectName: string; summary: string; reviewDate: string | null }>;
  /** Authority grants expiring within the week (T-4.6). */
  expiringGrants?: ReadonlyArray<{ label: string; expiresAt: string }>;
  now: Date;
}

export interface WeeklyReview {
  weekLabel: string; // ISO YYYY-Www
  generatedAt: string;
  rollup: Array<{ state: string; projects: string[] }>;
  jobMix: JobMixRow[];
  assumptionsDue: Array<{ projectName: string; statement: string }>;
  decisionsDue: Array<{ projectName: string; summary: string; reviewDate: string | null }>;
  expiringGrants: Array<{ label: string; expiresAt: string }>;
  driftPending: Array<{ projectName: string; count: number }>;
  staleProjects: string[];
  noNextActionProjects: string[];
  warnings: string[];
}

const PORTFOLIO_ORDER = ["primary", "active", "blocked", "paused", "parked", "closed"];

export function buildWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  const byState = new Map<string, string[]>();
  for (const s of PORTFOLIO_ORDER) byState.set(s, []);
  for (const p of input.projects) {
    const state = p.portfolioState ?? "unknown";
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push(p.projectName);
  }
  const rollup = [...byState.entries()]
    .filter(([, names]) => names.length > 0)
    .map(([state, names]) => ({ state, projects: [...names].sort() }));

  const assumptionsDue = input.projects
    .flatMap((p) => p.assumptionsDue.map((a) => ({ projectName: p.projectName, statement: a.statement })))
    .sort((a, b) => (a.projectName + a.statement < b.projectName + b.statement ? -1 : 1));

  const driftPending = input.projects
    .filter((p) => p.driftCount > 0)
    .map((p) => ({ projectName: p.projectName, count: p.driftCount }))
    .sort((a, b) => (a.projectName < b.projectName ? -1 : 1));

  const staleProjects = input.projects
    .filter((p) => p.staleStatus === "stale" || p.staleStatus === "critical")
    .map((p) => p.projectName)
    .sort();

  const noNextActionProjects = input.projects
    .filter((p) => (p.portfolioState === "primary" || p.portfolioState === "active") && p.nextAction === null)
    .map((p) => p.projectName)
    .sort();

  const decisionsDue = [...(input.decisionsDue ?? [])].sort((a, b) =>
    a.projectName + a.summary < b.projectName + b.summary ? -1 : 1,
  );

  const expiringGrants = [...(input.expiringGrants ?? [])].sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1));

  return {
    weekLabel: isoWeekLabel(input.now),
    generatedAt: input.now.toISOString(),
    rollup,
    jobMix: [...input.jobMix],
    assumptionsDue,
    decisionsDue,
    expiringGrants,
    driftPending,
    staleProjects,
    noNextActionProjects,
    warnings: [],
  };
}

const NOT_WIRED = "_(not yet wired)_";

export function renderWeeklyReviewMarkdown(review: WeeklyReview): string {
  const out: string[] = [];
  out.push(`# Weekly Portfolio Review - ${review.weekLabel}`);
  out.push("");

  out.push("## Portfolio Roll-call");
  out.push("");
  if (review.rollup.length === 0) {
    out.push("- _no projects_");
  } else {
    for (const r of review.rollup) {
      out.push(`- **${r.state}** (${r.projects.length}): ${r.projects.join(", ")}`);
    }
  }
  out.push("");

  out.push("## Job Mix (weekly, per project)");
  out.push("");
  out.push("| Project | Phase | J1 | J2 | J3 | meta | Flag |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of [...review.jobMix].sort((a, b) => (a.projectName < b.projectName ? -1 : 1))) {
    out.push(
      `| ${row.projectName} | ${row.phase ?? ""} | ${pct(row.j1Pct)} | ${pct(row.j2Pct)} | ${pct(row.j3Pct)} | ${pct(row.metaPct)} | ${row.thresholdBreach ?? ""} |`,
    );
  }
  if (review.jobMix.length === 0) out.push("| _no projects_ | | | | | | |");
  out.push("");

  // FPCP ritual prompts (static — the principal answers them).
  out.push("## FPCP Ritual");
  out.push("");
  out.push("- **Did this week serve Job 1?** (yes/no + evidence): ");
  out.push("- **Did I build for return, or for intensity?**: ");
  out.push("");

  out.push("## Assumptions Due for Review");
  out.push("");
  if (review.assumptionsDue.length === 0) {
    out.push("- _none due_");
  } else {
    for (const a of review.assumptionsDue) out.push(`- **${a.projectName}**: ${a.statement}`);
  }
  out.push("");

  out.push("## Decisions Due for Review");
  out.push("");
  if (review.decisionsDue.length === 0) {
    out.push("- _none due_");
  } else {
    for (const d of review.decisionsDue) {
      const due = d.reviewDate ? ` _(review date ${d.reviewDate})_` : "";
      out.push(`- **${d.projectName}**: ${d.summary}${due}`);
    }
    out.push("");
    out.push("_Record an outcome with_ `pacc decide --review <id> --outcome <good|mixed|bad|too-early>`.");
  }
  out.push("");

  out.push("## Memory Drift");
  out.push("");
  if (review.driftPending.length === 0) {
    out.push("- _no pending drift_");
  } else {
    for (const d of review.driftPending) out.push(`- **${d.projectName}**: ${d.count} marker(s) pending re-grounding`);
  }
  out.push("");

  out.push("## Authority Grants Expiring This Week");
  out.push("");
  if (review.expiringGrants.length === 0) {
    out.push("- _none expiring_");
  } else {
    for (const g of review.expiringGrants) out.push(`- ${g.label} _(expires ${g.expiresAt})_`);
  }
  out.push("");

  out.push("## Stale Projects");
  out.push("");
  out.push(review.staleProjects.length === 0 ? "- _none_" : review.staleProjects.map((p) => `- ${p}`).join("\n"));
  out.push("");

  out.push("## Projects With No Next Action");
  out.push("");
  out.push(
    review.noNextActionProjects.length === 0
      ? "- _none_"
      : review.noNextActionProjects.map((p) => `- ${p}`).join("\n"),
  );
  out.push("");

  out.push("## Tasks Completed vs Created");
  out.push("");
  out.push(`- ${NOT_WIRED} — needs issues activity read.`);
  out.push("");

  out.push("## Agent Performance & Failure Patterns");
  out.push("");
  out.push(`- ${NOT_WIRED} — needs run-history read.`);
  out.push("");

  out.push("## Recommended Authority Ceiling Changes");
  out.push("");
  out.push(`- ${NOT_WIRED} — emerges after M-L2.`);
  out.push("");

  if (review.warnings.length > 0) {
    out.push("---");
    out.push("");
    out.push("## ⚠ Warnings");
    out.push("");
    for (const w of [...review.warnings].sort()) out.push(`- ${w}`);
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function pct(n: number | null): string {
  // `null` (no classified signal for the project, per D-41) renders as "—".
  if (n === null) return "—";
  return `${Math.round(n)}%`;
}

/**
 * ISO-8601 week label `YYYY-Www` (ISO week date — Monday-based, week 1 contains
 * the first Thursday). Deterministic; matches Obsidian-friendly file naming.
 */
export function isoWeekLabel(date: Date): string {
  // Work in UTC to stay deterministic.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
