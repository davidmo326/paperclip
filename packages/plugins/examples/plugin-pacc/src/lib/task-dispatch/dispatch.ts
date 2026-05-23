/**
 * Task-dispatch state machine — T-1.5.
 *
 * Adapts mission-control's `dispatchAssignedTasks`, `runAegisReviews`, and
 * `autoRouteInboxTasks` to paperclip's surface. The original SQLite queries
 * and OpenClaw-gateway calls are replaced by `DispatchDeps` methods that:
 *   - In production: paperclip plugin SDK + Anthropic SDK
 *   - In tests: hand-rolled mock objects
 *
 * Per T-1.5 spec, no cross-framework adapter abstraction. `DispatchDeps` is
 * dependency injection for testability, not a generalized adapter.
 */

import type {
  CycleResult,
  DispatchableTask,
  DispatchDeps,
  ReviewableTask,
} from "./types.js";
import {
  buildReviewPrompt,
  buildTaskPrompt,
  classifyDirectModel,
  parseReviewVerdict,
  pickBestAgent,
} from "./core.js";

// ---------------------------------------------------------------------------
// runDispatchCycle — adapted from mission-control's dispatchAssignedTasks
// ---------------------------------------------------------------------------

/**
 * Picks up issues in 'assigned' state, sends them to the LLM, records the
 * resolution, transitions to 'review'.
 *
 * Per-task flow:
 *   1. issue.status = 'assigned'           — input
 *   2. updateTaskStatus(id, 'in_progress') — claim
 *   3. callModel(prompt)                   — invoke
 *   4. setTaskResolution(id, response)     — persist agent output
 *   5. updateTaskStatus(id, 'review')      — hand off to reviewer
 *   6. logActivity('task.dispatched', ...) — audit
 *
 * On any failure, the task transitions back to 'assigned' for re-dispatch,
 * with the error logged to activity_log.
 */
export async function runDispatchCycle(deps: DispatchDeps): Promise<CycleResult> {
  let tasks: DispatchableTask[];
  try {
    tasks = await deps.listAssignedTasks();
  } catch (err) {
    return { ok: false, message: `listAssignedTasks failed: ${errMsg(err)}` };
  }

  if (tasks.length === 0) {
    return { ok: true, message: "No assigned tasks to dispatch.", details: [] };
  }

  const details: NonNullable<CycleResult["details"]> = [];

  for (const task of tasks) {
    try {
      await deps.updateTaskStatus(task.id, "in_progress");
      const modelId = classifyDirectModel(task);
      const prompt = buildTaskPrompt(task);

      const response = await deps.callModel({ modelId, prompt });
      const resolution = response.text ?? "(empty agent response)";

      await deps.setTaskResolution(task.id, resolution);
      await deps.updateTaskStatus(task.id, "review");

      await deps.logActivity("task.dispatched", {
        taskId: task.id,
        agentName: task.agent_name,
        modelId,
        sessionId: response.sessionId,
      });

      details.push({ taskId: task.id, outcome: "dispatched" });
    } catch (err) {
      const reason = errMsg(err);
      try {
        // Revert to 'assigned' so the task can be re-attempted.
        await deps.updateTaskStatus(task.id, "assigned", { error: reason });
        await deps.logActivity("task.dispatch_failed", { taskId: task.id, reason });
      } catch {
        /* swallow secondary failure */
      }
      details.push({ taskId: task.id, outcome: "failed", reason });
    }
  }

  const succeeded = details.filter((d) => d.outcome === "dispatched").length;
  return {
    ok: true,
    message: `Dispatched ${succeeded} of ${tasks.length} task(s).`,
    details,
  };
}

// ---------------------------------------------------------------------------
// runReviewCycle — adapted from mission-control's runAegisReviews
// ---------------------------------------------------------------------------

/**
 * Picks up issues in 'review' state, prompts the LLM to evaluate the
 * resolution, records approval or rejection.
 *
 *   approved → updateTaskStatus(id, 'done') + recordReviewApproval
 *   rejected → updateTaskStatus(id, 'assigned', { rejectionFeedback }) +
 *              recordReviewRejection
 */
export async function runReviewCycle(deps: DispatchDeps): Promise<CycleResult> {
  let tasks: ReviewableTask[];
  try {
    tasks = await deps.listReviewableTasks();
  } catch (err) {
    return { ok: false, message: `listReviewableTasks failed: ${errMsg(err)}` };
  }
  if (tasks.length === 0) {
    return { ok: true, message: "No tasks in review.", details: [] };
  }

  const details: NonNullable<CycleResult["details"]> = [];

  for (const task of tasks) {
    try {
      const prompt = buildReviewPrompt(task);
      // Reviews always use a moderate model — they're text-only judgements.
      const response = await deps.callModel({
        modelId: "claude-sonnet-4-6",
        prompt,
      });
      const verdict = parseReviewVerdict(response.text ?? "");

      if (verdict.status === "approved") {
        await deps.recordReviewApproval(task.id, verdict.notes);
        await deps.updateTaskStatus(task.id, "done");
        await deps.logActivity("task.reviewed", {
          taskId: task.id,
          status: "approved",
          notes: verdict.notes,
        });
        details.push({ taskId: task.id, outcome: "approved" });
      } else {
        await deps.recordReviewRejection(task.id, verdict.notes);
        await deps.updateTaskStatus(task.id, "assigned", { rejectionFeedback: verdict.notes });
        await deps.logActivity("task.reviewed", {
          taskId: task.id,
          status: "rejected",
          notes: verdict.notes,
        });
        details.push({ taskId: task.id, outcome: "rejected" });
      }
    } catch (err) {
      const reason = errMsg(err);
      await deps.logActivity("task.review_failed", { taskId: task.id, reason }).catch(() => null);
      details.push({ taskId: task.id, outcome: "failed", reason });
    }
  }

  return { ok: true, message: `Reviewed ${tasks.length} task(s).`, details };
}

// ---------------------------------------------------------------------------
// runAutoRouteCycle — adapted from mission-control's autoRouteInboxTasks
// ---------------------------------------------------------------------------

/**
 * For each inbox task (unassigned), score every agent against the task
 * text and assign to the best candidate. Inbox → assigned transition.
 */
export async function runAutoRouteCycle(deps: DispatchDeps): Promise<CycleResult> {
  let inbox: DispatchableTask[];
  let agents;
  try {
    [inbox, agents] = await Promise.all([
      deps.listInboxTasks(),
      deps.listAgentsForRouting(),
    ]);
  } catch (err) {
    return { ok: false, message: `auto-route inputs failed: ${errMsg(err)}` };
  }

  if (inbox.length === 0) {
    return { ok: true, message: "Inbox empty.", details: [] };
  }

  const details: NonNullable<CycleResult["details"]> = [];

  for (const task of inbox) {
    const text = `${task.title} ${task.description ?? ""}`;
    const best = pickBestAgent(agents, text);
    if (!best) {
      details.push({ taskId: task.id, outcome: "skipped", reason: "no eligible agent" });
      continue;
    }
    try {
      await deps.assignTaskToAgent(task.id, best.name);
      await deps.updateTaskStatus(task.id, "assigned");
      await deps.logActivity("task.routed", {
        taskId: task.id,
        toAgent: best.name,
        agentRole: best.role,
      });
      details.push({ taskId: task.id, outcome: "routed", reason: best.name });
    } catch (err) {
      const reason = errMsg(err);
      await deps.logActivity("task.route_failed", { taskId: task.id, reason }).catch(() => null);
      details.push({ taskId: task.id, outcome: "failed", reason });
    }
  }

  return { ok: true, message: `Routed ${details.filter((d) => d.outcome === "routed").length} of ${inbox.length} inbox task(s).`, details };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
