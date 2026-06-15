/**
 * Weekend prep — T-3.11 (PRD § 13.4).
 *
 * Friday-afternoon ritual: queue pre-authorized async work, set self-pause
 * boundaries, surface what should land before Monday. Pure build + deterministic
 * render (idempotent on the same day).
 *
 * Pre-authorized async work requires the authority-grant model (M-L2 / T-5.x)
 * to be meaningful — until then it renders empty with a note. Self-pause
 * boundaries are the standing safety defaults from PRD § 15.1. Must-land-by-
 * Monday is derived from blocked projects (the most reliable "needs attention
 * before the week starts" signal available today).
 */

export interface WeekendProjectInput {
  projectId: string;
  projectName: string;
  portfolioState: string | null;
  /** Populated when the project is blocked (its blocker summary). */
  blockerSummary: string | null;
  /** Pre-authorized async work items (empty until the authority model lands). */
  preAuthorizedAsyncWork: string[];
}

export interface WeekendPrepInput {
  projects: readonly WeekendProjectInput[];
  now: Date;
}

export interface WeekendPrep {
  date: string; // YYYY-MM-DD
  generatedAt: string;
  preAuthorized: Array<{ projectName: string; items: string[] }>;
  selfPauseBoundaries: string[];
  mustLandByMonday: Array<{ projectName: string; reason: string }>;
  warnings: string[];
}

/** Standing self-pause boundaries — PRD § 15.1 baseline. */
export const DEFAULT_SELF_PAUSE_BOUNDARIES = [
  "Pause on any L4+ action (publish, send, deploy, spend) — always requires the principal.",
  "Pause on uncertainty, repeated failure, rate limits, or missing source context.",
  "Pause on any write to a value-anchor (M1b) note — never permitted.",
  "Pause if three hallucination flags accumulate within 24h.",
];

export function buildWeekendPrep(input: WeekendPrepInput): WeekendPrep {
  const preAuthorized = input.projects
    .filter((p) => p.preAuthorizedAsyncWork.length > 0)
    .map((p) => ({ projectName: p.projectName, items: [...p.preAuthorizedAsyncWork] }))
    .sort((a, b) => (a.projectName < b.projectName ? -1 : 1));

  const mustLandByMonday = input.projects
    .filter((p) => p.portfolioState === "blocked" || p.blockerSummary !== null)
    .map((p) => ({
      projectName: p.projectName,
      reason: p.blockerSummary ?? "blocked — needs unblocking before Monday",
    }))
    .sort((a, b) => (a.projectName < b.projectName ? -1 : 1));

  return {
    date: input.now.toISOString().slice(0, 10),
    generatedAt: input.now.toISOString(),
    preAuthorized,
    selfPauseBoundaries: [...DEFAULT_SELF_PAUSE_BOUNDARIES],
    mustLandByMonday,
    warnings: [],
  };
}

export function renderWeekendPrepMarkdown(prep: WeekendPrep): string {
  const out: string[] = [];
  out.push(`# Weekend Prep - ${prep.date}`);
  out.push("");

  out.push("## Pre-authorized Async Work");
  out.push("");
  if (prep.preAuthorized.length === 0) {
    out.push("- _(not yet wired)_ — needs the authority-grant model (M-L2 / T-5.x).");
  } else {
    for (const p of prep.preAuthorized) {
      out.push(`- **${p.projectName}**`);
      for (const item of p.items) out.push(`  - ${item}`);
    }
  }
  out.push("");

  out.push("## Self-pause Boundaries");
  out.push("");
  for (const b of prep.selfPauseBoundaries) out.push(`- ${b}`);
  out.push("");

  out.push("## Must Land Before Monday");
  out.push("");
  if (prep.mustLandByMonday.length === 0) {
    out.push("- _nothing flagged_");
  } else {
    for (const m of prep.mustLandByMonday) out.push(`- **${m.projectName}**: ${m.reason}`);
  }
  out.push("");

  if (prep.warnings.length > 0) {
    out.push("---");
    out.push("");
    out.push("## ⚠ Warnings");
    out.push("");
    for (const w of [...prep.warnings].sort()) out.push(`- ${w}`);
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}
