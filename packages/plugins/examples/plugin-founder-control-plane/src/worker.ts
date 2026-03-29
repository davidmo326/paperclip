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
    `_Generated by Founder Control Plane plugin at ${new Date().toISOString()}_`,
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
    ctx.logger.info("Founder Control Plane plugin starting", { pluginId: PLUGIN_ID });

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

    ctx.logger.info("Founder Control Plane plugin setup complete");
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Founder Control Plane plugin ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
