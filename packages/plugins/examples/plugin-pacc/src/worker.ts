import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import type {
  Issue,
  Project,
  ProjectPortfolioState,
  ProjectStaleStatus,
} from "@paperclipai/shared";
import {
  JOB_KEYS,
  LANE_LABELS,
  NEXT_ACTION_LABEL,
  PLUGIN_ID,
  PLUGIN_NAMESPACE,
  RESUME_DRAFT_STATE_KEY,
  TELEMETRY_STATE_KEY,
} from "./constants.js";
import { runStaleRehash } from "./jobs/stale-rehash.js";
import { runSourceDecayCheck } from "./jobs/source-decay-check.js";
import { runScheduledBrief } from "./lib/briefer/scheduled-brief.js";
import {
  makeScheduledBriefDeps,
  makeCaptureFeedbackDeps,
  assembleProjectCards,
} from "./lib/briefer/worker-deps.js";
import { captureBriefFeedback } from "./lib/briefer/capture-feedback.js";
import { makeDecisionDeps } from "./lib/decisions/decision-deps.js";
import { recordDecision, getDecisionHistory, reviewDecision } from "./lib/decisions/capture-decision.js";
import { selectDecisionsDue, type DecisionInput, type OutcomeLabel } from "./lib/decisions/decision-log.js";
import { makeGrantDeps } from "./lib/authority/grant-deps.js";
import { recordGrant, revokeGrant, listActiveGrants, evaluateAuthority } from "./lib/authority/capture-grant.js";
import {
  parseExpiresIn,
  selectExpiringGrants,
  type ActionClass,
  type GrantInput,
} from "./lib/authority/authority-grant.js";
import type { AuthorityLevel } from "@paperclipai/shared";
import { writeObsidianBrief } from "./lib/briefer/obsidian-writer.js";
import { computeJobMix, type JobMixProjectInput, type JobMixPhase } from "./lib/briefer/job-mix.js";
import {
  buildWeeklyReview,
  renderWeeklyReviewMarkdown,
  isoWeekLabel,
  type WeeklyProjectInput,
} from "./lib/briefer/weekly-review.js";
import {
  buildWeekendPrep,
  renderWeekendPrepMarkdown,
  type WeekendProjectInput,
} from "./lib/briefer/weekend-prep.js";

/**
 * Obsidian daily directory — where briefs, weekly reviews, and weekend prep
 * land. Mirrors the default in scheduled-brief.ts.
 */
function obsidianDailyDir(): string {
  return process.env.HOME
    ? `${process.env.HOME}/llm_shared/Obsidian/00_Daily`
    : "./Obsidian/00_Daily";
}

// ---------------------------------------------------------------------------
// Stale threshold constants (mirrors control-plane.service.ts)
// ---------------------------------------------------------------------------

const STALE_THRESHOLDS_MS: Record<
  ProjectPortfolioState,
  { aging: number; stale: number } | null
> = {
  primary: { aging: 2 * 24 * 60 * 60 * 1000, stale: 4 * 24 * 60 * 60 * 1000 },
  active:  { aging: 5 * 24 * 60 * 60 * 1000, stale: 10 * 24 * 60 * 60 * 1000 },
  blocked: { aging: 3 * 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
  paused:  null,
  parked:  null,
  closed:  null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStaleStatus(
  portfolioState: ProjectPortfolioState | null | undefined,
  controlPlaneUpdatedAt: Date | string | null | undefined,
): ProjectStaleStatus {
  if (!portfolioState) return "fresh";
  const thresholds = STALE_THRESHOLDS_MS[portfolioState] ?? null;
  if (thresholds === null) return "fresh";
  if (!controlPlaneUpdatedAt) return "fresh";
  const updatedMs =
    typeof controlPlaneUpdatedAt === "string"
      ? new Date(controlPlaneUpdatedAt).getTime()
      : (controlPlaneUpdatedAt as Date).getTime();
  const ageMs = Date.now() - updatedMs;
  if (ageMs >= thresholds.stale) return "stale";
  if (ageMs >= thresholds.aging) return "aging";
  return "fresh";
}

function computeAttentionScore(
  project: Project,
  staleStatus: ProjectStaleStatus,
): number {
  const state = project.controlPlaneState;
  if (state === null) return 0;
  let score = 0;
  if (staleStatus === "stale" && state.portfolioState === "primary") score += 40;
  if (
    (state.portfolioState === "active" || state.portfolioState === "primary") &&
    !state.nextSmallestAction
  ) {
    score += 30;
  }
  if (state.portfolioState === "blocked" && !state.blockerSummary) score += 25;
  if (!state.lastMeaningfulOutput) score += 10;
  return score;
}

function getIssueStatus(issue: Issue): "open" | "inProgress" | "blocked" | "done" {
  const s = issue.status as string;
  if (s === "done" || s === "cancelled") return "done";
  if (s === "in_progress" || s === "in-progress") return "inProgress";
  if (s === "blocked") return "blocked";
  return "open";
}

function hasLabel(issue: Issue, labelName: string): boolean {
  if (issue.labels) {
    return issue.labels.some((l) => l.name === labelName);
  }
  return false;
}

function blankLaneCounts() {
  return { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Core telemetry computation
// ---------------------------------------------------------------------------

async function refreshProjectTelemetry(
  ctx: PluginContext,
  companyId: string,
  projectId: string,
): Promise<void> {
  const project = await ctx.projects.get(projectId, companyId);
  if (!project) return;

  const portfolioState = project.controlPlaneState?.portfolioState ?? null;
  if (portfolioState === "closed") return;

  // Fetch all issues for this project
  const issues = await ctx.issues.list({ companyId, projectId, limit: 500, offset: 0 });

  // Aggregate issue counts
  const issueCounts = { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 };
  const laneIssueCounts = {
    product:      blankLaneCounts(),
    customer:     blankLaneCounts(),
    distribution: blankLaneCounts(),
  };
  let nextActionCount = 0;

  for (const issue of issues) {
    const bucket = getIssueStatus(issue);
    issueCounts[bucket] += 1;
    issueCounts.total += 1;

    // Lane counts
    for (const lane of LANE_LABELS) {
      if (hasLabel(issue, lane)) {
        const laneKey = lane.replace("lane:", "") as keyof typeof laneIssueCounts;
        laneIssueCounts[laneKey][bucket] += 1;
        laneIssueCounts[laneKey].total += 1;
      }
    }

    // Next-action count
    if (hasLabel(issue, NEXT_ACTION_LABEL)) {
      nextActionCount += 1;
    }
  }

  // Compute stale status using control plane updated-at
  const staleStatus = computeStaleStatus(
    portfolioState,
    project.controlPlaneUpdatedAt,
  );

  // Compute stale reason
  let staleReason: string | null = null;
  if (staleStatus !== "fresh" && portfolioState) {
    const thresholds = STALE_THRESHOLDS_MS[portfolioState];
    if (thresholds) {
      const thresholdDays =
        staleStatus === "stale"
          ? thresholds.stale / (24 * 60 * 60 * 1000)
          : thresholds.aging / (24 * 60 * 60 * 1000);
      staleReason = `Control plane not updated in over ${thresholdDays}d (${portfolioState})`;
    }
  }

  // Compute attention score (mirrors core service logic + multipleNextActions)
  let attentionScore = computeAttentionScore(project, staleStatus);
  if (nextActionCount > 1) attentionScore += 10;

  const snapshot = {
    projectId,
    companyId,
    portfolioState,
    issueCounts,
    laneIssueCounts,
    nextActionCount,
    staleStatus,
    staleReason,
    attentionScore,
    refreshedAt: new Date().toISOString(),
  };

  await ctx.state.set(
    {
      scopeKind: "project",
      scopeId: projectId,
      namespace: PLUGIN_NAMESPACE,
      stateKey: TELEMETRY_STATE_KEY,
    },
    snapshot,
  );

  ctx.logger.info("Refreshed project telemetry", {
    projectId,
    staleStatus,
    attentionScore,
  });
}

// ---------------------------------------------------------------------------
// Resume draft generation
// ---------------------------------------------------------------------------

async function generateResumeDraft(
  ctx: PluginContext,
  companyId: string,
  projectId: string,
): Promise<void> {
  const project = await ctx.projects.get(projectId, companyId);
  if (!project) return;

  const state = project.controlPlaneState;
  if (!state) return;

  const lines: string[] = [
    `# Re-entry Brief: ${project.name}`,
    "",
    `**Portfolio state:** ${state.portfolioState}`,
    `**Phase:** ${state.currentPhase}`,
    state.constraintLane ? `**Constraint lane:** ${state.constraintLane}` : null,
    "",
    "## Next Smallest Action",
    state.nextSmallestAction ?? "_Not set_",
    "",
    state.blockerSummary
      ? `## Blocker\n${state.blockerSummary}\n`
      : null,
    state.lastMeaningfulOutput
      ? `## Last Meaningful Output\n${state.lastMeaningfulOutput.title}${state.lastMeaningfulOutput.url ? ` — ${state.lastMeaningfulOutput.url}` : ""}\n`
      : null,
    state.latestEvidenceChanged
      ? `## Latest Evidence Changed\n${state.latestEvidenceChanged}\n`
      : null,
    state.doNotRethink
      ? `## Do Not Rethink\n${state.doNotRethink}\n`
      : null,
    state.killCriteria
      ? `## Kill Criteria\n${state.killCriteria}\n`
      : null,
    `---`,
    `_Generated by pacc plugin at ${new Date().toISOString()}_`,
  ].filter((line): line is string => line !== null);

  const brief = lines.join("\n");

  await ctx.state.set(
    {
      scopeKind: "project",
      scopeId: projectId,
      namespace: PLUGIN_NAMESPACE,
      stateKey: RESUME_DRAFT_STATE_KEY,
    },
    { brief, generatedAt: new Date().toISOString() },
  );

  ctx.logger.info("Generated resume draft", { projectId });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    ctx.logger.info("pacc plugin starting", { pluginId: PLUGIN_ID });

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    ctx.events.on("project.created", async (event: PluginEvent) => {
      const projectId = typeof event.entityId === "string" ? event.entityId : null;
      if (!projectId) return;
      await refreshProjectTelemetry(ctx, event.companyId, projectId);
      await generateResumeDraft(ctx, event.companyId, projectId);
    });

    ctx.events.on("project.updated", async (event: PluginEvent) => {
      const projectId = typeof event.entityId === "string" ? event.entityId : null;
      if (!projectId) return;
      await refreshProjectTelemetry(ctx, event.companyId, projectId);
      await generateResumeDraft(ctx, event.companyId, projectId);
    });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown> | null;
      const projectId =
        typeof payload?.projectId === "string" ? payload.projectId : null;
      if (!projectId) return;
      await refreshProjectTelemetry(ctx, event.companyId, projectId);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown> | null;
      const projectId =
        typeof payload?.projectId === "string" ? payload.projectId : null;
      if (!projectId) return;
      await refreshProjectTelemetry(ctx, event.companyId, projectId);
    });

    // -----------------------------------------------------------------------
    // Job: batch-refresh telemetry for all active projects
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.refreshTelemetry,
      async (job: PluginJobContext): Promise<void> => {
        ctx.logger.info("Running refresh-telemetry job", {
          runId: job.runId,
          trigger: job.trigger,
        });

        const companies = await ctx.companies.list({ limit: 200, offset: 0 });
        let refreshed = 0;
        let skipped = 0;

        for (const company of companies) {
          const projects = await ctx.projects.list({
            companyId: company.id,
            limit: 200,
            offset: 0,
          });

          for (const project of projects) {
            const portfolioState =
              project.controlPlaneState?.portfolioState ?? null;

            // Skip closed projects
            if (portfolioState === "closed") {
              skipped += 1;
              continue;
            }

            try {
              await refreshProjectTelemetry(ctx, company.id, project.id);
              refreshed += 1;
            } catch (error) {
              ctx.logger.warn("Failed to refresh telemetry for project", {
                projectId: project.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        ctx.logger.info("refresh-telemetry job complete", {
          runId: job.runId,
          refreshed,
          skipped,
        });
      },
    );

    // -----------------------------------------------------------------------
    // Job: T-2.6 weekly source hash re-grounding (PRD § 15.2 tripwire 2)
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.staleRehash,
      async (job: PluginJobContext): Promise<void> => {
        ctx.logger.info("Running stale-rehash job", {
          runId: job.runId,
          trigger: job.trigger,
        });
        await runStaleRehash(ctx);
      },
    );

    // -----------------------------------------------------------------------
    // Job: T-2.6 daily source-decay check (PRD § 15.2 tripwire 7)
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.sourceDecayCheck,
      async (job: PluginJobContext): Promise<void> => {
        ctx.logger.info("Running source-decay-check job", {
          runId: job.runId,
          trigger: job.trigger,
        });
        await runSourceDecayCheck(ctx);
      },
    );

    // -----------------------------------------------------------------------
    // Job: T-3.6/T-3.7 daily operating brief (08:00 local)
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.briefDaily,
      async (job: PluginJobContext): Promise<void> => {
        ctx.logger.info("Running daily-brief job", {
          runId: job.runId,
          trigger: job.trigger,
        });
        // Model wiring: when PACC_BRIEFER_MODEL is set, the briefer generates
        // its narrative via the local Claude Code CLI (subscription auth — no
        // API key). Unset → deterministic offline brief. Either way the
        // pause-check (T-3.7), overlap guard (T-3.6), and kill-criterion meter
        // (T-3.10) are wired via the plugin_state-backed deps assembled here.
        const { deps, model } = await makeScheduledBriefDeps(ctx);
        ctx.logger.info("daily-brief model mode", {
          runId: job.runId,
          modelEnabled: model.enabled,
          modelId: model.modelId,
        });
        const result = await runScheduledBrief(deps, {
          runId: job.runId,
          brieferOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
        });
        ctx.logger.info("daily-brief job complete", {
          runId: job.runId,
          kind: result.kind,
        });
      },
    );

    // T-3.11: Weekly portfolio review (Mon 09:00).
    ctx.jobs.register(
      JOB_KEYS.weeklyReview,
      async (job: PluginJobContext): Promise<void> => {
        const now = new Date();
        const cards = await assembleProjectCards(ctx);
        const jobMixInputs: JobMixProjectInput[] = cards.map((c) => ({
          projectId: c.projectId,
          projectName: c.projectName,
          phase: (c.card.currentPhase as JobMixPhase | null) ?? null,
          jobClassificationDominant:
            (c.card as { jobClassificationDominant?: JobMixProjectInput["jobClassificationDominant"] })
              .jobClassificationDominant ?? null,
        }));
        const jobMix = computeJobMix(jobMixInputs, [], { now });
        // T-4.7: decisions past their reviewDate with no outcome yet.
        const decisionDeps = makeDecisionDeps(ctx);
        const projectNameById = new Map(cards.map((c) => [c.projectId, c.projectName]));
        const decisionsDue: Array<{ projectName: string; summary: string; reviewDate: string | null }> = [];
        for (const c of cards) {
          const due = selectDecisionsDue(await decisionDeps.listProjectDecisions(c.projectId), now);
          for (const d of due) {
            decisionsDue.push({
              projectName: projectNameById.get(d.projectId) ?? d.projectId,
              summary: d.summary,
              reviewDate: d.reviewDate,
            });
          }
        }
        const weeklyProjects: WeeklyProjectInput[] = cards.map((c) => ({
          projectId: c.projectId,
          projectName: c.projectName,
          portfolioState: c.card.portfolioState ?? null,
          phase: c.card.currentPhase ?? null,
          staleStatus: c.card.staleStatus ?? null,
          nextAction: c.card.nextActions.answer,
          assumptionsDue: c.card.activeAssumptions
            .filter((a) => a.status === "stale" || a.status === "challenged")
            .map((a) => ({ statement: a.statement })),
          driftCount: c.card.staleMarkers.length,
        }));
        // T-4.6: authority grants expiring within the week.
        const expiringGrants = selectExpiringGrants(await makeGrantDeps(ctx).listGrants(), now, 7).map((g) => ({
          label: `${g.ceiling} ${g.actionClass} @ ${g.projectId ?? "portfolio"}`,
          expiresAt: g.expiresAt,
        }));
        const review = buildWeeklyReview({ projects: weeklyProjects, jobMix, decisionsDue, expiringGrants, now });
        const markdown = renderWeeklyReviewMarkdown(review);
        const write = await writeObsidianBrief(markdown, {
          baseDir: obsidianDailyDir(),
          briefDate: review.weekLabel,
          filenamePrefix: "Weekly Portfolio Review - ",
        });
        ctx.logger.info("weekly-review job complete", {
          runId: job.runId,
          week: isoWeekLabel(now),
          path: write.path,
          kind: write.kind,
        });
      },
    );

    // T-3.11: Weekend prep (Fri 16:00).
    ctx.jobs.register(
      JOB_KEYS.weekendPrep,
      async (job: PluginJobContext): Promise<void> => {
        const now = new Date();
        const cards = await assembleProjectCards(ctx);
        const weekendProjects: WeekendProjectInput[] = cards.map((c) => ({
          projectId: c.projectId,
          projectName: c.projectName,
          portfolioState: c.card.portfolioState ?? null,
          blockerSummary: c.card.blockers.answer,
          preAuthorizedAsyncWork: [],
        }));
        const prep = buildWeekendPrep({ projects: weekendProjects, now });
        const markdown = renderWeekendPrepMarkdown(prep);
        const write = await writeObsidianBrief(markdown, {
          baseDir: obsidianDailyDir(),
          briefDate: prep.date,
          filenamePrefix: "Weekend Prep - ",
        });
        ctx.logger.info("weekend-prep job complete", {
          runId: job.runId,
          date: prep.date,
          path: write.path,
          kind: write.kind,
        });
      },
    );

    // -----------------------------------------------------------------------
    // Data handlers (for plugin UI)
    // -----------------------------------------------------------------------

    ctx.data.register("portfolio", async (params) => {
      const companyId =
        typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return [];

      const projects = await ctx.projects.list({
        companyId,
        limit: 200,
        offset: 0,
      });

      const results = await Promise.all(
        projects.map(async (project) => {
          const telemetry = await ctx.state.get({
            scopeKind: "project",
            scopeId: project.id,
            namespace: PLUGIN_NAMESPACE,
            stateKey: TELEMETRY_STATE_KEY,
          });
          return { project, telemetry };
        }),
      );

      return results;
    });

    ctx.data.register("project-telemetry", async (params) => {
      const projectId =
        typeof params.projectId === "string" ? params.projectId : "";
      if (!projectId) return null;
      return await ctx.state.get({
        scopeKind: "project",
        scopeId: projectId,
        namespace: PLUGIN_NAMESPACE,
        stateKey: TELEMETRY_STATE_KEY,
      });
    });

    ctx.data.register("resume-draft", async (params) => {
      const projectId =
        typeof params.projectId === "string" ? params.projectId : "";
      if (!projectId) return null;
      return await ctx.state.get({
        scopeKind: "project",
        scopeId: projectId,
        namespace: PLUGIN_NAMESPACE,
        stateKey: RESUME_DRAFT_STATE_KEY,
      });
    });

    // -----------------------------------------------------------------------
    // Action handlers
    // -----------------------------------------------------------------------

    ctx.actions.register("refresh-project-telemetry", async (params) => {
      const companyId =
        typeof params.companyId === "string" ? params.companyId : "";
      const projectId =
        typeof params.projectId === "string" ? params.projectId : "";
      if (!companyId || !projectId) {
        throw new Error("companyId and projectId are required");
      }
      await refreshProjectTelemetry(ctx, companyId, projectId);
      await generateResumeDraft(ctx, companyId, projectId);
      return { ok: true };
    });

    // T-3.9: capture principal feedback from an edited brief. The CLI
    // (`pacc brief --feedback`) reads the edited Obsidian brief Markdown and
    // POSTs it here; we parse it, persist the feedback row, and fold the
    // accepted count into the kill-criterion meter.
    ctx.actions.register("capture-brief-feedback", async (params) => {
      const briefDate = typeof params.briefDate === "string" ? params.briefDate : "";
      const markdown = typeof params.markdown === "string" ? params.markdown : "";
      if (!briefDate || !markdown) {
        throw new Error("briefDate and markdown are required");
      }
      const result = await captureBriefFeedback(makeCaptureFeedbackDeps(ctx), {
        briefDate,
        markdown,
      });
      return result;
    });

    // T-3.8 follow-up: generate a brief on demand (for the M-Brief trial). An
    // optional `date` (YYYY-MM-DD) overrides "now" so several distinct-date
    // briefs can be produced in one sitting. Reuses the exact cron path.
    ctx.actions.register("run-brief", async (params) => {
      const dateStr = typeof params.date === "string" ? params.date : "";
      const now = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T08:00:00.000Z`) : new Date();
      const { deps, model } = await makeScheduledBriefDeps(ctx);
      const result = await runScheduledBrief(deps, {
        now,
        brieferOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
      });
      return {
        kind: result.kind,
        modelEnabled: model.enabled,
        modelId: model.modelId,
        briefDate: result.kind === "completed" ? result.brief.briefDate : now.toISOString().slice(0, 10),
        path: result.kind === "completed" || result.kind === "skipped_paused" ? result.obsidianWrite.path : null,
        hallucinationFlagCount: result.kind === "completed" ? result.hallucinationFlagCount : 0,
        selfPaused: result.kind === "completed" ? result.selfPaused : result.kind === "skipped_paused",
      };
    });

    // T-4.4: record a decision (append-only; supersede marks the prior).
    ctx.actions.register("record-decision", async (params) => {
      const str = (k: string): string => (typeof params[k] === "string" ? (params[k] as string) : "");
      const projectId = str("projectId");
      const summary = str("summary");
      const chosenOption = str("chosenOption");
      const rationale = str("rationale");
      if (!projectId || !summary || !chosenOption || !rationale) {
        throw new Error("projectId, summary, chosenOption, and rationale are required");
      }
      const input: DecisionInput = {
        projectId,
        summary,
        chosenOption,
        rationale,
        optionsConsidered: Array.isArray(params.optionsConsidered)
          ? (params.optionsConsidered as DecisionInput["optionsConsidered"])
          : [],
        sourceRefs: Array.isArray(params.sourceRefs)
          ? (params.sourceRefs as DecisionInput["sourceRefs"])
          : [],
        decidedBy: str("decidedBy") || "principal",
        jobClassification: (str("jobClassification") || "meta") as DecisionInput["jobClassification"],
        supersedes: typeof params.supersede === "string" ? (params.supersede as string) : null,
        reviewDate: typeof params.reviewDate === "string" ? (params.reviewDate as string) : null,
        reversibleUntil: typeof params.reversibleUntil === "string" ? (params.reversibleUntil as string) : null,
      };
      const actor = str("actor") || "principal";
      const result = await recordDecision(makeDecisionDeps(ctx), input, { now: new Date(), actor });
      return result;
    });

    // T-4.7: record the principal's retrospective outcome on a decision (L5).
    ctx.actions.register("review-decision", async (params) => {
      const id = typeof params.id === "string" ? params.id : "";
      const outcome = typeof params.outcome === "string" ? (params.outcome as OutcomeLabel) : ("" as OutcomeLabel);
      if (!id || !outcome) throw new Error("id and outcome are required");
      const force = params.force === true;
      const updated = await reviewDecision(makeDecisionDeps(ctx), id, outcome, { now: new Date(), force });
      return updated;
    });

    // T-4.4: read the supersession chain for a decision id.
    ctx.data.register("decision-history", async (params) => {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return [];
      return await getDecisionHistory(makeDecisionDeps(ctx), id);
    });

    // T-4.4: list a project's decisions (used by weekly review's "decisions due").
    ctx.data.register("list-decisions", async (params) => {
      const projectId = typeof params.projectId === "string" ? params.projectId : "";
      if (!projectId) return [];
      return await makeDecisionDeps(ctx).listProjectDecisions(projectId);
    });

    // T-4.6: grant authority (principal only; explicit expiry).
    ctx.actions.register("record-grant", async (params) => {
      const str = (k: string): string => (typeof params[k] === "string" ? (params[k] as string) : "");
      const actionClass = str("actionClass") as ActionClass;
      const ceiling = str("ceiling") as AuthorityLevel;
      if (!actionClass || !ceiling) throw new Error("actionClass and ceiling are required");
      const now = new Date();
      const expiresAt = str("expiresAt") || parseExpiresIn(str("expiresIn") || "30d", now);
      const input: GrantInput = {
        projectId: str("projectId") || null,
        agentId: str("agentId") || null,
        actionClass,
        ceiling,
        expiresAt,
        notes: str("notes") || null,
      };
      const grantedBy = str("grantedBy") || "principal";
      return await recordGrant(makeGrantDeps(ctx), input, { now, grantedBy });
    });

    // T-4.6: revoke a grant (never deletes).
    ctx.actions.register("revoke-grant", async (params) => {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) throw new Error("id is required");
      return await revokeGrant(makeGrantDeps(ctx), id, new Date());
    });

    // T-4.6: list active grants.
    ctx.data.register("list-grants", async () => {
      return await listActiveGrants(makeGrantDeps(ctx), new Date());
    });

    // T-4.6/T-5.1: authority enforcement check.
    ctx.data.register("check-authority", async (params) => {
      const projectId = typeof params.projectId === "string" ? params.projectId : "";
      const actionClass = typeof params.actionClass === "string" ? (params.actionClass as ActionClass) : ("" as ActionClass);
      const level = typeof params.level === "string" ? (params.level as AuthorityLevel) : ("" as AuthorityLevel);
      if (!projectId || !actionClass || !level) return { allowed: false };
      const agentId = typeof params.agentId === "string" ? (params.agentId as string) : null;
      const allowed = await evaluateAuthority(makeGrantDeps(ctx), {
        projectId,
        actionClass,
        level,
        agentId,
        now: new Date(),
      });
      return { allowed };
    });

    ctx.logger.info("pacc plugin setup complete");
  },

  async onHealth() {
    return {
      status: "ok",
      message: "pacc plugin ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
