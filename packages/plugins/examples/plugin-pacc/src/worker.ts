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
  ProjectControlPlaneTelemetry,
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
  SOURCE_DECAY_STATE_KEY,
  STEWARD_PAUSED_STATE_KEY,
  TELEMETRY_STATE_KEY,
  STEWARD_JOURNAL_STORE_STATE_KEY,
} from "./constants.js";
import { runStaleRehash } from "./jobs/stale-rehash.js";
import { runSourceDecayCheck } from "./jobs/source-decay-check.js";
import { runMissedBriefCatchUp, runScheduledBrief, type ScheduledBriefResult } from "./lib/briefer/scheduled-brief.js";
import { resolveHeartbeatUrl, sendHeartbeat } from "./lib/heartbeat.js";
import {
  runMissedStewardCatchUp,
  runScheduledSteward,
} from "./lib/steward/scheduled-steward.js";
import { makeScheduledStewardDeps } from "./lib/steward/worker-deps.js";
import {
  makeObsidianGuard, makeScheduledBriefDeps,
  makeCaptureFeedbackDeps,
  assembleProjectCards,
  resumeBrieferAction,
  readHallucinationAuditWindow,
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
import { backtestBacklog, makeJobClassStore, refreshJobClasses, resolveJobClassConfig } from "./lib/job-class/job-class-deps.js";
import { JOB_CLASSES, effectiveJobClass, isJobClass, jobClassAgreement } from "./lib/job-class/job-class.js";
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
import {
  startObsidianWatcher,
  withSourceIndexForwarding,
  type ObsidianWatcherHandle,
} from "./lib/obsidian-watcher-deps.js";
import { resolveVaultRoot } from "./lib/vault-root.js";
import {
  applyNoteChanged,
  applyNoteDeleted,
  applyNoteRenamed,
  runInitialScan,
} from "./lib/source-index/indexer.js";
import { makeSourceIndexerDeps, makeSourceIndexStore } from "./lib/source-index/worker-deps.js";
import { runAssociation } from "./lib/note-association/associate.js";
import { makeNoteAssociationDeps, makeNoteAssociationStore } from "./lib/note-association/worker-deps.js";

/**
 * Obsidian daily directory — where briefs, weekly reviews, and weekend prep
 * land. Resolved at call-time (not module-load) and overridable via
 * PACC_OBSIDIAN_DIR so it never falls back to a stray relative path when HOME
 * is unset in the worker child.
 */
function obsidianDailyDir(): string {
  const override = process.env.PACC_OBSIDIAN_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME?.trim();
  return home ? `${home}/llm_shared/Obsidian/00_Daily` : "/home/ubuntu/llm_shared/Obsidian/00_Daily";
}

/**
 * T-6.1: ping the external dead-man's switch after a duty-cycle result.
 * Ping ONLY on `completed` — a self-paused briefer, a failed run, or an
 * overlapping run must NOT ping (silence from the switch is the alert).
 */
async function pingHeartbeatAfterBrief(
  result: ScheduledBriefResult,
  logger: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void },
  runId: string | undefined,
): Promise<void> {
  const url = resolveHeartbeatUrl();
  if (url === null) return; // unset → skip silently (documented in always-on.md)
  if (result.kind !== "completed") {
    logger.warn("heartbeat: duty cycle did not complete — no ping (alert path)", {
      runId,
      kind: result.kind,
    });
    return;
  }
  await sendHeartbeat(url, { logger: { warn: (msg, fields) => logger.warn(msg, { runId, ...fields }) } });
}

// ---------------------------------------------------------------------------
// Stale threshold constants — T-6.2: moved to evidence-clock.ts (single
// source of truth); re-exported for existing imports.
// ---------------------------------------------------------------------------

import { STALE_THRESHOLDS_MS, evidenceAgeDays } from "./lib/evidence-clock.js";
import {
  makeWorkItem,
  applyPatch,
  makeCapacityDay,
  defaultAllocation,
  type NewWorkItemInput,
  type WorkItemPatch,
} from "./lib/work-items/work-items.js";
import { makeWorkItemDeps } from "./lib/work-items/work-item-deps.js";
import { makeLineDeps } from "./lib/lines/lines-deps.js";
import type { LinePatch } from "./lib/lines/lines.js";
import { renderSnapshot } from "./lib/lines/lines.js";
import { promoteEntry, reconcileBacklog, summarizeBacklog, updateBacklogEntry } from "./lib/lines/backlog.js";
import { dispatchCardFor, importLines, recordRunResult, updateLine } from "./lib/lines/floor-actions.js";
export { STALE_THRESHOLDS_MS };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStaleStatus(
  portfolioState: ProjectPortfolioState | null | undefined,
  controlPlaneUpdatedAt: Date | string | null | undefined,
  /**
   * T-6.2 evidence clock: days since the project's evidence base last
   * changed. When finite, THIS is the decay key — controlPlaneUpdatedAt
   * (any state-write, whosever) never resets decay (grill 2026-08-16).
   * Null → legacy fallback to controlPlaneUpdatedAt (pre-evidence rows).
   */
  evidenceAgeDays: number | null = null,
): ProjectStaleStatus {
  if (!portfolioState) return "fresh";
  const thresholds = STALE_THRESHOLDS_MS[portfolioState] ?? null;
  if (thresholds === null) return "fresh";

  if (evidenceAgeDays !== null && Number.isFinite(evidenceAgeDays)) {
    // Evidence-keyed path — the only thing that resets it is an evidence event.
    if (evidenceAgeDays * 86_400_000 >= thresholds.stale) return "stale";
    if (evidenceAgeDays * 86_400_000 >= thresholds.aging) return "aging";
    return "fresh";
  }

  // Legacy fallback (no evidence signal recorded yet).
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

  // T-6.2: evidence clock inputs — source-decay record (M1a mtimes), the
  // state-stamped evidence events, and the latest decision in the ledger.
  // Read-side observation only: no write path can launder the decay key.
  const [decayRecord, decisions] = await Promise.all([
    ctx.state
      .get({ scopeKind: "project", scopeId: projectId, namespace: PLUGIN_NAMESPACE, stateKey: SOURCE_DECAY_STATE_KEY })
      .catch(() => null) as Promise<{ daysSinceLastTouch: number | null } | null>,
    makeDecisionDeps(ctx)
      .listProjectDecisions(projectId)
      .catch(() => [] as Array<{ createdAt: string }>),
  ]);
  const latestDecisionAt = decisions.reduce<string | null>(
    (acc, d) => (acc === null || d.createdAt > acc ? d.createdAt : acc),
    null,
  );
  const evidenceAge = evidenceAgeDays({
    sourceDecayDaysSinceTouch: decayRecord?.daysSinceLastTouch ?? null,
    lastEvidenceAt:
      (project.controlPlaneState as { lastEvidenceAt?: string | null } | null)?.lastEvidenceAt ?? null,
    latestDecisionAt,
  });

  // Compute stale status using the evidence clock (T-6.2) — controlPlaneUpdatedAt
  // is only the legacy fallback for rows with no evidence signal yet.
  const staleStatus = computeStaleStatus(
    portfolioState,
    project.controlPlaneUpdatedAt,
    evidenceAge,
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
      staleReason = `No new evidence in over ${thresholdDays}d (${portfolioState})`;
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
// T-2.1: Obsidian filesystem watcher — continuous chokidar process
// ---------------------------------------------------------------------------

/**
 * Module-level so the supervisor job (a periodic safety net) can check
 * whether `setup()` already started the watcher for this worker process,
 * rather than spinning up a second concurrent chokidar watch.
 */
let obsidianWatcherHandle: ObsidianWatcherHandle | null = null;

async function ensureObsidianWatcherRunning(ctx: PluginContext): Promise<void> {
  if (obsidianWatcherHandle) return;
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const eventCompanyId = companies[0]?.id ?? "instance";
  try {
    // T-2.2b: forward every markdown watcher event to the source indexer as
    // well as ctx.events, so the index stays live after the initial scan.
    // Indexer deps are assembled fresh per-call (cheap: fs + ctx.state
    // wrappers) rather than cached, matching the `index-vault` action above.
    const indexerDeps = makeSourceIndexerDeps(ctx);
    const emit = withSourceIndexForwarding(
      async (event) => {
        const { type, ...payload } = event;
        await ctx.events.emit(type, eventCompanyId, payload);
      },
      {
        applyNoteChanged: (event) => applyNoteChanged(indexerDeps, event),
        applyNoteRenamed: (event) => applyNoteRenamed(indexerDeps, event),
        applyNoteDeleted: (event) => applyNoteDeleted(indexerDeps, event),
        logger: ctx.logger,
      },
    );
    obsidianWatcherHandle = await startObsidianWatcher({
      vaultRoot: resolveVaultRoot(),
      emit,
      logger: ctx.logger,
    });
    ctx.logger.info("obsidian-watcher started", {
      vaultRoot: obsidianWatcherHandle.vaultRoot,
    });
    const warnings = obsidianWatcherHandle.registryWarnings();
    if (warnings.length > 0) {
      ctx.logger.warn("obsidian-watcher: value-anchor registry warnings", { warnings });
    }
  } catch (error) {
    ctx.logger.warn("obsidian-watcher: failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    ctx.logger.info("pacc plugin starting", { pluginId: PLUGIN_ID });

    // T-2.1: start the continuous vault watcher immediately at plugin
    // startup (not gated behind a cron tick — it's a long-lived process).
    await ensureObsidianWatcherRunning(ctx);

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
        const { deps, model, eventCompanyId } = await makeScheduledBriefDeps(ctx);
        // T-2.4: fresh registry read per run = morning-sweep reload semantics.
        const m1b = await makeObsidianGuard(ctx, eventCompanyId);
        if (m1b.registryWarnings.length > 0) {
          ctx.logger.warn("value-anchor registry warnings", {
            runId: job.runId,
            warnings: m1b.registryWarnings,
          });
        }
        ctx.logger.info("daily-brief model mode", {
          runId: job.runId,
          modelEnabled: model.enabled,
          modelId: model.modelId,
        });
        const result = await runScheduledBrief(deps, {
          runId: job.runId,
          obsidianBaseDir: obsidianDailyDir(),
          brieferOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
          obsidianGuard: m1b.guard,
        });
        await pingHeartbeatAfterBrief(result, ctx.logger, job.runId);
        ctx.logger.info("daily-brief job complete", {
          runId: job.runId,
          kind: result.kind,
        });
      },
    );

    // -----------------------------------------------------------------------
    // Job: T-4.8 daily L0/L1 async steward run (08:20 local, after the brief)
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.stewardDaily,
      async (job: PluginJobContext): Promise<void> => {
        ctx.logger.info("Running daily-steward job", {
          runId: job.runId,
          trigger: job.trigger,
        });
        // Model wiring mirrors the briefer: PACC_STEWARD_MODEL enables the
        // local Claude CLI (subscription auth); unset/off → deterministic
        // state-diff journal. Authority is hard-capped L0/L1 by construction
        // of StewardDeps (no writeM2/task/approvals surface).
        const { deps, model } = await makeScheduledStewardDeps(ctx);
        ctx.logger.info("daily-steward model mode", {
          runId: job.runId,
          modelEnabled: model.enabled,
          modelId: model.modelId,
        });
        const result = await runScheduledSteward(deps, {
          runId: job.runId,
          obsidianBaseDir: obsidianDailyDir(),
          stewardOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
        });
        // Heartbeat stays brief-only (T-6.1) — the steward rides the same
        // duty cycle; a dead host silences the brief ping too.
        ctx.logger.info("daily-steward job complete", {
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
        const jobMix = computeJobMix(jobMixInputs, (await refreshJobClasses(ctx, ctx.logger, { now })).activities, { now });
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
          guard: (await makeObsidianGuard(ctx)).guard,
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
          guard: (await makeObsidianGuard(ctx)).guard,
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
    // Job: T-2.1 supervisor — idempotent restart-if-dead safety net for the
    // continuous Obsidian watcher started above in setup().
    // -----------------------------------------------------------------------

    ctx.jobs.register(
      JOB_KEYS.obsidianWatcherSupervisor,
      async (job: PluginJobContext): Promise<void> => {
        await ensureObsidianWatcherRunning(ctx);
        ctx.logger.info("obsidian-watcher-supervisor tick complete", {
          runId: job.runId,
          running: obsidianWatcherHandle !== null,
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

    ctx.data.register("project-control-plane", async (params) => {
      const projectId =
        typeof params.projectId === "string" ? params.projectId : "";
      const companyId =
        typeof params.companyId === "string" ? params.companyId : "";
      if (!projectId || !companyId) return null;
      const project = await ctx.projects.get(projectId, companyId);
      if (!project) return null;
      const telemetry = await ctx.state.get({
        scopeKind: "project",
        scopeId: projectId,
        namespace: PLUGIN_NAMESPACE,
        stateKey: TELEMETRY_STATE_KEY,
      });
      return {
        projectId,
        companyId,
        controlPlaneState: project.controlPlaneState ?? null,
        telemetry: (telemetry as ProjectControlPlaneTelemetry | null) ?? null,
        warnings: [],
      };
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
      const { deps, model, eventCompanyId } = await makeScheduledBriefDeps(ctx);
      const m1b = await makeObsidianGuard(ctx, eventCompanyId);
      const result = await runScheduledBrief(deps, {
        now,
        obsidianBaseDir: obsidianDailyDir(),
        brieferOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
        obsidianGuard: m1b.guard,
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

    // T-3.12 (D-39): clear the hallucination self-pause flag. Errors clearly
    // if no pause is active; writes a `principal`-attributed audit row.
    ctx.actions.register("resume-briefer", async (params) => {
      const actor = typeof params.actor === "string" && params.actor ? params.actor : "principal";
      const result = await resumeBrieferAction(ctx, actor, new Date());
      if (result.kind === "not_paused") {
        throw new Error("briefer is not paused — nothing to resume");
      }
      return { resumed: true, auditRow: result.auditRow };
    });

    // T-4.8: run the steward on demand (`pacc steward --run`). Reuses the
    // exact cron pipeline; same-day re-runs are idempotent (byte-identical
    // journal → no write).
    ctx.actions.register("run-steward", async (params) => {
      // The model run outlives the host's 30s action RPC: the cockpit asks for
      // a background run and watches for the journal/Triage items instead.
      if (params?.background === true) {
        void (async () => {
          try {
            const { deps, model } = await makeScheduledStewardDeps(ctx);
            const result = await runScheduledSteward(deps, {
              obsidianBaseDir: obsidianDailyDir(),
              stewardOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
            });
            ctx.logger.info("steward: on-demand run finished", { kind: result.kind, modelEnabled: model.enabled });
          } catch (err) {
            ctx.logger.warn("steward: on-demand run failed", { error: String(err) });
          }
        })();
        return { kind: "started" };
      }
      const { deps, model } = await makeScheduledStewardDeps(ctx);
      const result = await runScheduledSteward(deps, {
        obsidianBaseDir: obsidianDailyDir(),
        stewardOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
      });
      return {
        kind: result.kind,
        modelEnabled: model.enabled,
        modelId: model.modelId,
        path: result.kind === "completed" || result.kind === "skipped_paused" ? result.obsidianWrite.path : null,
        hallucinationFlagCount: result.kind === "completed" ? result.hallucinationFlagCount : 0,
        selfPaused: result.kind === "completed" ? result.selfPaused : result.kind === "skipped_paused",
      };
    });

    // T-4.8 (D-39 parity): clear the steward's self-pause flag.
    ctx.actions.register("resume-steward", async () => {
      const prior = (await ctx.state.get({
        scopeKind: "instance",
        namespace: PLUGIN_NAMESPACE,
        stateKey: STEWARD_PAUSED_STATE_KEY,
      })) as { paused: boolean; reason: string | null } | null;
      if (prior === null || prior.paused !== true) {
        throw new Error("steward is not paused — nothing to resume");
      }
      if (ctx.state.delete) {
        await ctx.state.delete({
          scopeKind: "instance",
          namespace: PLUGIN_NAMESPACE,
          stateKey: STEWARD_PAUSED_STATE_KEY,
        });
      } else {
        await ctx.state.set(
          { scopeKind: "instance", namespace: PLUGIN_NAMESPACE, stateKey: STEWARD_PAUSED_STATE_KEY },
          null,
        );
      }
      await ctx.events.emit(
        "agent.resumed",
        (await ctx.companies.list({ limit: 1, offset: 0 }))[0]?.id ?? "instance",
        {
          agent: "steward",
          actor: "principal",
          at: new Date().toISOString(),
          priorReason: prior.reason,
        },
      );
      return { resumed: true, priorReason: prior.reason };
    });

    // T-3.12 (D-39): the current 24h hallucination-flag window, one row per
    // unique normalized reference (not per flagged run).
    ctx.data.register("hallucination-audit", async () => {
      return await readHallucinationAuditWindow(ctx, new Date());
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

    // T-floor (ADR 0002): work items on the factory floor.
    ctx.actions.register("create-work-item", async (params) => {
      const deps = makeWorkItemDeps(ctx);
      const actor = typeof params.actor === "string" && params.actor ? params.actor : "principal";
      const item = makeWorkItem(params as unknown as NewWorkItemInput, { id: deps.newId(), now: new Date(), actor });
      await deps.putItem(item);
      return { item };
    });

    ctx.actions.register("update-work-item", async (params) => {
      const deps = makeWorkItemDeps(ctx);
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) throw new Error("id is required");
      const prior = await deps.getItem(id);
      if (!prior) throw new Error(`no work item ${id}`);
      const actor = typeof params.actor === "string" && params.actor ? params.actor : "principal";
      const item = applyPatch(prior, (params.patch ?? {}) as WorkItemPatch, { now: new Date(), actor });
      await deps.putItem(item);
      return { item };
    });

    ctx.data.register("list-work-items", async (params) => {
      const items = await makeWorkItemDeps(ctx).listItems();
      const projectId = typeof params.projectId === "string" ? params.projectId : "";
      return projectId ? items.filter((i) => i.projectId === projectId) : items;
    });

    // T-jev: job classes of worked floor items — the review surface for the
    // Jev shadow trial (principal label vs Jev, agreement). Read-only.
    ctx.data.register("job-class-review", async () => {
      const config = resolveJobClassConfig();
      const [records, items] = await Promise.all([makeJobClassStore(ctx).list(), makeWorkItemDeps(ctx).listItems()]);
      const byId = new Map(items.map((i) => [i.id, i]));
      const rows = records
        .filter((r) => byId.has(r.itemId) || r.source === "backlog")
        .map((r) => {
          const item = byId.get(r.itemId);
          return {
            itemId: r.itemId,
            projectId: r.projectId,
            source: r.source ?? "floor",
            title: item?.title ?? r.title ?? r.itemId,
            workType: item?.workType ?? null,
            stage: item?.stage ?? "backlog",
            rule: r.rule,
            jev: r.jev,
            jevError: r.jevError,
            principal: r.principal?.jobClass ?? null,
            effective: effectiveJobClass(r, config.minProbability),
          };
        })
        .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.title.localeCompare(b.title));
      return { mode: config.mode, minProbability: config.minProbability, agreement: jobClassAgreement(records, config.minProbability), rows };
    });

    // T-jev: one labelling pass now (classifies anything new). Runs in shadow
    // mode when the configured mode is off, so the trial can start before the
    // brief is switched over.
    ctx.actions.register("refresh-job-classes", async (params) => {
      const config = resolveJobClassConfig();
      if (params.backlog === true) {
        // Bounded per call so one action stays well inside the RPC timeout; the CLI loops.
        const maxCalls = Number.isInteger(params.maxCalls) ? Math.min(Math.max(params.maxCalls as number, 1), 60) : 40;
        const r = await backtestBacklog(ctx, ctx.logger, { maxCalls, config });
        return { mode: config.mode, jevConfigured: config.jevConfigured, backlog: true, subjects: r.subjects, calls: r.calls, errors: r.errors, changed: r.changed.length, records: r.records.size };
      }
      const r = await refreshJobClasses(ctx, ctx.logger, { config: { ...config, mode: config.mode === "off" ? "shadow" : config.mode } });
      return { mode: config.mode, jevConfigured: config.jevConfigured, calls: r.calls, errors: r.errors, changed: r.changed.length, records: r.records.size };
    });

    ctx.actions.register("set-job-class", async (params) => {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const jobClass = params.jobClass === null ? null : params.jobClass;
      if (!itemId) throw new Error("itemId is required");
      if (jobClass !== null && !isJobClass(jobClass)) throw new Error(`jobClass must be one of ${JOB_CLASSES.join(", ")} or null`);
      const store = makeJobClassStore(ctx);
      const rec = (await store.list()).find((r) => r.itemId === itemId);
      if (!rec) throw new Error(`no job-class record for ${itemId} — run refresh-job-classes first`);
      const next = { ...rec, principal: jobClass === null ? null : { jobClass, at: new Date().toISOString() } };
      await store.put(next);
      return { record: next };
    });

    // ADR 0003: project lines are the record for project state.
    ctx.data.register("list-lines", async () => {
      // the backlog stays behind the line: callers get a summary, the tree via get-backlog
      return (await makeLineDeps(ctx).listLines()).map(({ backlog, ...l }) => ({ ...l, backlogSummary: summarizeBacklog(backlog) }));
    });

    // The reconciled pile behind a line (CONTEXT.md: Backlog).
    ctx.data.register("get-backlog", async (params) => {
      const line = await makeLineDeps(ctx).getLine(typeof params.id === "string" ? params.id : "");
      if (!line) throw new Error("no such line");
      return { backlog: line.backlog ?? null };
    });

    ctx.actions.register("reconcile-backlog", async (params) => {
      const deps = makeLineDeps(ctx);
      const line = await deps.getLine(typeof params.id === "string" ? params.id : "");
      if (!line) throw new Error("no such line");
      const input = (params.backlog ?? {}) as Record<string, unknown>;
      const backlog = reconcileBacklog(line.backlog, input, { now: new Date(), by: typeof params.by === "string" ? params.by : "reconciler" });
      await deps.putLine({ ...line, backlog });
      return { summary: summarizeBacklog(backlog) };
    });

    ctx.actions.register("update-backlog-entry", async (params) => {
      const deps = makeLineDeps(ctx);
      const line = await deps.getLine(typeof params.id === "string" ? params.id : "");
      if (!line?.backlog) throw new Error("no backlog on that line");
      const backlog = updateBacklogEntry(line.backlog, String(params.entryId ?? ""), (params.patch ?? {}) as { status?: unknown; text?: unknown }, new Date());
      await deps.putLine({ ...line, backlog });
      return { entry: backlog.entries.find((e) => e.id === params.entryId) };
    });

    ctx.actions.register("promote-backlog-entry", async (params) => {
      const deps = makeLineDeps(ctx);
      const items = makeWorkItemDeps(ctx);
      const line = await deps.getLine(typeof params.id === "string" ? params.id : "");
      if (!line?.backlog) throw new Error("no backlog on that line");
      const to = params.to === "kq" || params.to === "candidate" ? params.to : "triage";
      const out = promoteEntry(line, line.backlog, String(params.entryId ?? ""), to, { now: new Date(), newId: () => items.newId() });
      if (out.item) await items.putItem(out.item);
      await deps.putLine({ ...out.line, backlog: out.backlog });
      return { item: out.item, line: { ...out.line, backlog: undefined } };
    });

    ctx.data.register("lines-snapshot", async () => {
      return { body: renderSnapshot(await makeLineDeps(ctx).listLines()) };
    });

    ctx.actions.register("update-line", async (params) => {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) throw new Error("id is required");
      const actor = typeof params.actor === "string" && params.actor ? params.actor : "principal";
      return await updateLine(makeLineDeps(ctx), id, (params.patch ?? {}) as LinePatch, { now: new Date(), actor });
    });

    // One-time takeover of the portfolio seed (missing-only unless mode=overwrite).
    ctx.actions.register("import-lines", async (params) => {
      const seed = Array.isArray(params.seed) ? (params.seed as unknown[]) : [];
      if (seed.length === 0) throw new Error("seed (array) is required");
      // Carry the legacy Paperclip project ids so per-project plugin state still joins.
      const legacyByName: Record<string, string> = {};
      try {
        const companies = await ctx.companies.list({ limit: 10, offset: 0 });
        for (const c of companies) {
          for (const p of await ctx.projects.list({ companyId: c.id, limit: 500, offset: 0 })) {
            legacyByName[p.name] = p.id;
          }
        }
      } catch {
        // no legacy projects visible — lines still import
      }
      return await importLines(makeLineDeps(ctx), seed, {
        now: new Date(),
        actor: typeof params.actor === "string" && params.actor ? params.actor : "principal",
        legacyByName,
        mode: params.mode === "overwrite" ? "overwrite" : "missing-only",
      });
    });

    // Context carry — outbound: the card a hand receives with its task.
    ctx.data.register("dispatch-card", async (params) => {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      if (!itemId) throw new Error("itemId is required");
      const { card } = await dispatchCardFor({ lines: makeLineDeps(ctx), items: makeWorkItemDeps(ctx) }, itemId);
      return { card };
    });

    // Context carry — return: what a hand brought back.
    ctx.actions.register("record-run-result", async (params) => {
      const s = (k: string) => (typeof params[k] === "string" && params[k] ? (params[k] as string) : null);
      const itemId = s("itemId");
      if (!itemId) throw new Error("itemId is required");
      return await recordRunResult(
        { lines: makeLineDeps(ctx), items: makeWorkItemDeps(ctx) },
        {
          itemId,
          output: s("output") ?? "",
          ok: params.ok !== false,
          sessionId: s("sessionId"),
          machine: s("machine"),
          tool: s("tool"),
          worker: s("worker"),
          cwd: s("cwd"),
          costUsd: typeof params.costUsd === "number" ? params.costUsd : null,
          commandId: s("commandId"),
        },
        new Date(),
      );
    });

    // The chief of staff's latest journal, for the surface (vault is input only).
    ctx.data.register("steward-latest", async () => {
      const today = new Date();
      for (let back = 0; back < 14; back++) {
        // journals are keyed by LOCAL date (runSteward's formatLocalDate), not UTC
        const d = new Date(today.getTime() - back * 86_400_000);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const journal = await ctx.state.get({
          scopeKind: "instance",
          namespace: date,
          stateKey: STEWARD_JOURNAL_STORE_STATE_KEY,
        });
        if (journal) return { journal };
      }
      return { journal: null };
    });

    // T-floor: capacity score per day (J reads `Capacity: N/10`; no note = zero).
    ctx.actions.register("record-capacity-day", async (params) => {
      const day = makeCapacityDay(params as Parameters<typeof makeCapacityDay>[0], new Date());
      await makeWorkItemDeps(ctx).putCapacityDay(day);
      return { day, allocation: defaultAllocation(day.score) };
    });

    ctx.data.register("list-capacity-days", async () => {
      const days = await makeWorkItemDeps(ctx).listCapacityDays();
      return days.map((d) => ({ ...d, allocation: defaultAllocation(d.score) }));
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

    // T-3.6 review fix: catch up a missed daily brief at startup. Fire-and-
    // forget — a catch-up failure must never break plugin activation; the
    // overlap guard inside runScheduledBrief makes a cron/catch-up race safe.
    void (async () => {
      try {
        const { deps, model, eventCompanyId } = await makeScheduledBriefDeps(ctx);
        const m1b = await makeObsidianGuard(ctx, eventCompanyId);
        const outcome = await runMissedBriefCatchUp({
          obsidianBaseDir: obsidianDailyDir(),
          logger: ctx.logger,
          runner: (options) => runScheduledBrief(deps, options),
          runnerOptions: {
            brieferOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
            obsidianGuard: m1b.guard,
          },
        });
        if (outcome.ran) {
          await pingHeartbeatAfterBrief(outcome.result, ctx.logger, "missed-run-catchup");
          ctx.logger.info("missed-run catch-up finished", { kind: outcome.result.kind });
        }
      } catch (err) {
        ctx.logger.error("missed-run catch-up failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    // T-4.8: catch up a missed steward run at startup, same fire-and-forget
    // contract as the brief catch-up.
    void (async () => {
      try {
        const { deps, model } = await makeScheduledStewardDeps(ctx);
        const outcome = await runMissedStewardCatchUp({
          obsidianBaseDir: obsidianDailyDir(),
          logger: ctx.logger,
          runner: (options) => runScheduledSteward(deps, options),
          runnerOptions: {
            stewardOptions: { skipModel: !model.enabled, modelId: model.modelId ?? undefined },
          },
        });
        if (outcome.ran) {
          ctx.logger.info("steward missed-run catch-up finished", { kind: outcome.result.kind });
        }
      } catch (err) {
        ctx.logger.error("steward missed-run catch-up failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    // T-2.2: trigger the initial full-vault source-index scan. Resumable by
    // design: an interrupted run leaves a checkpoint in plugin_state and the
    // next invocation skips already-indexed files. Tier-agnostic (v3
    // amendment) — M1a/M1b is joined at query time against T-2.4's registry.
    ctx.actions.register("index-vault", async (params) => {
      const vaultRoot = typeof params.vaultRoot === "string" && params.vaultRoot ? params.vaultRoot : undefined;
      const deps = makeSourceIndexerDeps(ctx, { vaultRoot });
      const result = await runInitialScan(deps);
      ctx.logger.info("index-vault action complete", {
        vaultRoot: deps.vaultRoot,
        ...result,
      });
      return { vaultRoot: deps.vaultRoot, ...result };
    });

    // T-2.2: index status — record count + in-flight scan checkpoint.
    ctx.data.register("source-index-status", async () => {
      const store = makeSourceIndexStore(ctx);
      const [count, checkpoint] = await Promise.all([store.count(), store.getCheckpoint()]);
      return { count, checkpoint };
    });

    // T-2.2: one record by vault-relative path.
    ctx.data.register("source-index-get", async (params) => {
      const path = typeof params.path === "string" ? params.path : "";
      if (!path) return null;
      return await makeSourceIndexStore(ctx).getByPath(path);
    });

    // T-2.2: all indexed paths + content hashes (stale-detection surface).
    ctx.data.register("source-index-catalog", async () => {
      return await makeSourceIndexStore(ctx).listPathsAndHashes();
    });

    // T-2.3: recompute note-to-project association for every indexed note.
    // Input is T-2.2's source index, not the vault — this action never walks
    // the filesystem itself.
    ctx.actions.register("associate-notes", async () => {
      const sourceIndex = makeSourceIndexStore(ctx);
      const deps = await makeNoteAssociationDeps(ctx, sourceIndex);
      const result = await runAssociation(deps);
      ctx.logger.info("associate-notes action complete", { ...result });
      return result;
    });

    // T-2.3: one association record by vault-relative path.
    ctx.data.register("note-association-get", async (params) => {
      const path = typeof params.path === "string" ? params.path : "";
      if (!path) return null;
      return await makeNoteAssociationStore(ctx).getByPath(path);
    });

    // T-2.3: association summary — per-project counts + unassociated bucket.
    ctx.data.register("note-association-summary", async () => {
      return await makeNoteAssociationStore(ctx).summary();
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
