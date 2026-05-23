/**
 * Task-dispatch types — T-1.5.
 *
 * Lifted from mission-control's `task-dispatch.ts`, but with the paperclip
 * surface mapped on:
 *   - `tasks` table  → paperclip `issues`
 *   - `agents` table → paperclip `agents`
 *   - `gateways`     → not applicable (we call Anthropic directly when needed)
 *   - SQLite queries → replaced by `DispatchDeps` methods that the plugin SDK
 *                      supplies (or that tests mock).
 *
 * NO cross-framework adapter abstraction (per T-1.5 spec). DispatchDeps is
 * dependency injection for testability only — not a reusable abstraction
 * layer across host frameworks.
 */

/**
 * A task ready to be dispatched. Fields lifted from mission-control's
 * DispatchableTask, with the paperclip equivalents wired:
 *   - `id`            → `issues.id` (paperclip uses UUIDs, mission-control used ints)
 *   - `assigned_to`   → `agents.name` (resolved from `issues.assignee_agent_id`)
 *   - `agent_config`  → JSON of agent.adapterConfig | agent.runtimeConfig
 *   - `ticket_prefix` → derived (paperclip uses `issues.identifier` instead)
 *   - `project_ticket_no` → paperclip uses `issues.issueNumber`
 */
export interface DispatchableTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: string;
  workspace_id: string;
  agent_name: string;
  agent_id: string;
  agent_config: string | null;
  ticket_prefix: string | null;
  project_ticket_no: number | null;
  project_id: string | null;
  tags?: string[];
}

/** Subset of issue fields needed for an Aegis-style quality review. */
export interface ReviewableTask {
  id: string;
  title: string;
  description: string | null;
  resolution: string | null;
  assigned_to: string;
  workspace_id: string;
  ticket_prefix: string | null;
  project_ticket_no: number | null;
  agent_config: string | null;
}

/** Per-agent record (subset of paperclip's `agents` table). */
export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  status: string;
  config: string | null;
}

/** Result of running one dispatch / review / route cycle. */
export interface CycleResult {
  ok: boolean;
  message: string;
  /** Per-task summaries for tests + audit. */
  details?: Array<{
    taskId: string;
    outcome: "dispatched" | "completed" | "approved" | "rejected" | "requeued" | "routed" | "skipped" | "failed";
    reason?: string;
  }>;
}

/** Parsed agent response. */
export interface AgentResponseParsed {
  text: string | null;
  sessionId: string | null;
}

/**
 * Dependencies the dispatch loop calls out to. Everything here is plumbed
 * by the plugin SDK in production and by mocks in tests.
 *
 * The three paperclip surfaces called out by T-1.5 spec are:
 *   1. issues CRUD          → listAssignedTasks / updateTaskStatus / setTaskResolution
 *   2. approvals CRUD       → recordReviewApproval / recordReviewRejection
 *   3. activity_log insert  → logActivity
 *
 * Plus an LLM call (callModel) — the lifted logic needs SOME way to invoke
 * the model. Mocked in tests.
 */
export interface DispatchDeps {
  // --- task / issue surface ---
  listAssignedTasks(): Promise<DispatchableTask[]>;
  listReviewableTasks(): Promise<ReviewableTask[]>;
  listInboxTasks(): Promise<DispatchableTask[]>;
  listAgentsForRouting(): Promise<AgentRecord[]>;

  /** Mark an issue's status (e.g. 'in_progress' → 'review' → 'done'). */
  updateTaskStatus(taskId: string, status: string, fields?: Record<string, unknown>): Promise<void>;
  /** Store the agent's resolution text on the issue. */
  setTaskResolution(taskId: string, resolution: string): Promise<void>;
  /** Re-assign an inbox task to a specific agent. */
  assignTaskToAgent(taskId: string, agentName: string): Promise<void>;

  // --- approval / review surface ---
  recordReviewApproval(taskId: string, notes: string): Promise<void>;
  recordReviewRejection(taskId: string, notes: string): Promise<void>;

  // --- audit surface ---
  logActivity(event: string, payload: Record<string, unknown>): Promise<void>;

  // --- LLM call ---
  /**
   * Invoke a Claude model with a prompt. Returns the agent response shape.
   * Implementations may use the Anthropic SDK directly, or route through a
   * gateway. The caller passes the modelId routed by classifyDirectModel /
   * classifyTaskModel — implementations strip gateway prefixes as needed.
   */
  callModel(args: {
    modelId: string;
    prompt: string;
    systemPrompt?: string | null;
  }): Promise<AgentResponseParsed>;
}
