/**
 * Task-dispatch pure-logic core — T-1.5.
 *
 * Lifted verbatim from mission-control's `task-dispatch.ts` with imports
 * cleaned up and types tightened. These are the testable utility functions
 * — model classification, prompt building, response parsing, agent
 * scoring. No DB, no IO, no globals.
 *
 * Provenance: each function below is annotated with the mission-control
 * line range it was lifted from (as of 2026-05-21 read).
 */

import type {
  AgentRecord,
  AgentResponseParsed,
  DispatchableTask,
  ReviewableTask,
} from "./types.js";

// ---------------------------------------------------------------------------
// classifyTaskModel — mission-control task-dispatch.ts lines 40–78
// ---------------------------------------------------------------------------

/**
 * Classify a task's complexity and return a router-prefixed model ID for
 * gateway dispatch. Returns null when the agent's configured default model
 * should be used.
 *
 * Tiers (lifted verbatim):
 *   ROUTINE  → cheap   (Haiku)
 *   MODERATE → mid     (Sonnet — default fallback)
 *   COMPLEX  → premium (Opus)
 */
export function classifyTaskModel(task: DispatchableTask): string | null {
  // Allow per-agent config override
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config);
      if (typeof cfg.dispatchModel === "string" && cfg.dispatchModel) return cfg.dispatchModel;
    } catch {
      /* ignore */
    }
  }

  const text = `${task.title} ${task.description ?? ""}`.toLowerCase();
  const priority = task.priority?.toLowerCase() ?? "";

  // Complex signals → Opus
  const complexSignals = [
    "debug", "diagnos", "architect", "design system", "security audit",
    "root cause", "investigate", "incident", "failure", "broken", "not working",
    "refactor", "migration", "performance optim", "why is",
  ];
  if (priority === "critical" || complexSignals.some((s) => text.includes(s))) {
    return "9router/cc/claude-opus-4-6";
  }

  // Routine signals → Haiku
  const routineSignals = [
    "status check", "health check", "ping", "list ", "fetch ", "format",
    "rename", "move file", "read file", "update readme", "bump version",
    "send message", "post to", "notify", "summarize", "translate",
    "quick ", "simple ", "routine ", "minor ",
  ];
  if (priority === "low" && routineSignals.some((s) => text.includes(s))) {
    return "9router/cc/claude-haiku-4-5-20251001";
  }
  if (
    routineSignals.some((s) => text.includes(s)) &&
    priority !== "high" &&
    priority !== "critical"
  ) {
    return "9router/cc/claude-haiku-4-5-20251001";
  }

  return null;
}

// ---------------------------------------------------------------------------
// classifyDirectModel — mission-control task-dispatch.ts lines 181–216
// ---------------------------------------------------------------------------

/**
 * Like classifyTaskModel but returns a bare model ID (no router prefix) for
 * direct Anthropic SDK use. Strips gateway prefixes from config overrides.
 */
export function classifyDirectModel(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config);
      if (typeof cfg.dispatchModel === "string" && cfg.dispatchModel) {
        return cfg.dispatchModel.replace(/^.*\//, "");
      }
    } catch {
      /* ignore */
    }
  }

  const text = `${task.title} ${task.description ?? ""}`.toLowerCase();
  const priority = task.priority?.toLowerCase() ?? "";

  const complexSignals = [
    "debug", "diagnos", "architect", "design system", "security audit",
    "root cause", "investigate", "incident", "refactor", "migration",
  ];
  if (priority === "critical" || complexSignals.some((s) => text.includes(s))) {
    return "claude-opus-4-6";
  }

  const routineSignals = [
    "status check", "health check", "format", "rename", "summarize",
    "translate", "quick ", "simple ", "routine ", "minor ",
  ];
  if (
    routineSignals.some((s) => text.includes(s)) &&
    priority !== "high" &&
    priority !== "critical"
  ) {
    return "claude-haiku-4-5-20251001";
  }

  // Default → Sonnet
  return "claude-sonnet-4-6";
}

// ---------------------------------------------------------------------------
// resolveGatewayAgentId — mission-control task-dispatch.ts lines 82–90
// ---------------------------------------------------------------------------

export function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config);
      if (typeof cfg.openclawId === "string" && cfg.openclawId) return cfg.openclawId;
    } catch {
      /* ignore */
    }
  }
  return task.agent_name;
}

// ---------------------------------------------------------------------------
// buildTaskPrompt — mission-control task-dispatch.ts lines 92–118
// ---------------------------------------------------------------------------

export function buildTaskPrompt(
  task: DispatchableTask,
  rejectionFeedback?: string | null,
): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, "0")}`
    : `TASK-${task.id}`;

  const lines = [
    "You have been assigned a task.",
    "",
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ];

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(", ")}`);
  }

  if (task.description) {
    lines.push("", task.description);
  }

  if (rejectionFeedback) {
    lines.push(
      "",
      "## Previous Review Feedback",
      rejectionFeedback,
      "",
      "Please address this feedback in your response.",
    );
  }

  lines.push("", "Complete this task and provide your response. Be concise and actionable.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// parseGatewayJson — mission-control task-dispatch.ts lines 121–132
// ---------------------------------------------------------------------------

/** Extract first valid JSON object from raw stdout (handles surrounding text). */
export function parseGatewayJson(raw: string): unknown {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseAgentResponse — mission-control task-dispatch.ts lines 139–159
// ---------------------------------------------------------------------------

export function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const sessionId: string | null =
      typeof parsed?.sessionId === "string"
        ? parsed.sessionId
        : typeof parsed?.session_id === "string"
          ? parsed.session_id
          : null;

    const payloads = parsed?.payloads as Array<{ text?: string }> | undefined;
    if (payloads?.[0]?.text) {
      return { text: payloads[0].text, sessionId };
    }
    if (parsed?.result) return { text: String(parsed.result), sessionId };
    if (parsed?.output) return { text: String(parsed.output), sessionId };
    return { text: JSON.stringify(parsed, null, 2), sessionId };
  } catch {
    return { text: stdout.trim() || null, sessionId: null };
  }
}

// ---------------------------------------------------------------------------
// buildReviewPrompt — mission-control task-dispatch.ts lines 327–363
// ---------------------------------------------------------------------------

export function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, "0")}`
    : `TASK-${task.id}`;

  const lines = [
    "You are Aegis, the quality reviewer.",
    "Review the following completed task and its resolution.",
    "",
    `**[${ticket}] ${task.title}**`,
  ];

  if (task.description) {
    lines.push("", "## Task Description", task.description);
  }
  if (task.resolution) {
    lines.push("", "## Agent Resolution", task.resolution.substring(0, 6000));
  }

  lines.push(
    "",
    "## Instructions",
    "Evaluate whether the agent's response adequately addresses the task.",
    "Respond with EXACTLY one of these two formats:",
    "",
    "If the work is acceptable:",
    "VERDICT: APPROVED",
    "NOTES: <brief summary of why it passes>",
    "",
    "If the work needs improvement:",
    "VERDICT: REJECTED",
    "NOTES: <specific issues that need to be fixed>",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// parseReviewVerdict — mission-control task-dispatch.ts lines 365–371
// ---------------------------------------------------------------------------

export function parseReviewVerdict(
  text: string,
): { status: "approved" | "rejected"; notes: string } {
  const upper = text.toUpperCase();
  const status = upper.includes("VERDICT: APPROVED") ? ("approved" as const) : ("rejected" as const);
  const notesMatch = text.match(/NOTES:\s*(.+)/i);
  const notes =
    notesMatch?.[1]?.trim().substring(0, 2000) ||
    (status === "approved" ? "Quality check passed" : "Quality check failed");
  return { status, notes };
}

// ---------------------------------------------------------------------------
// scoreAgentForTask + ROLE_AFFINITY — mission-control task-dispatch.ts 886–928
// ---------------------------------------------------------------------------

/** Role affinity mapping — which task keywords match which agent roles. */
export const ROLE_AFFINITY: Record<string, string[]> = {
  coder: [
    "code", "implement", "build", "fix", "bug", "test", "unit test",
    "refactor", "feature", "api", "endpoint", "function", "class", "module",
    "component", "deploy", "ci", "pipeline",
  ],
  researcher: [
    "research", "investigate", "analyze", "compare", "find", "discover",
    "audit", "review", "survey", "benchmark", "evaluate", "assess",
    "competitor", "market", "trend",
  ],
  reviewer: [
    "review", "audit", "check", "verify", "validate", "quality",
    "security", "compliance", "approve",
  ],
  tester: ["test", "qa", "e2e", "integration test", "regression", "coverage", "verify", "validate"],
  devops: [
    "deploy", "infrastructure", "ci", "cd", "docker", "kubernetes",
    "monitoring", "pipeline", "server", "nginx", "ssl",
  ],
  assistant: [
    "write", "draft", "summarize", "translate", "format", "document",
    "docs", "readme", "email", "message", "report",
  ],
  agent: [],
};

export function scoreAgentForTask(agent: AgentRecord, taskText: string): number {
  if (agent.status === "offline" || agent.status === "error" || agent.status === "sleeping") return -1;

  const text = taskText.toLowerCase();
  const keywords = ROLE_AFFINITY[agent.role] || [];

  let score = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) score += 10;
  }
  if (agent.status === "idle") score += 5;

  if (agent.config) {
    try {
      const cfg = JSON.parse(agent.config);
      const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
      for (const cap of caps) {
        if (typeof cap === "string" && text.includes(cap.toLowerCase())) score += 15;
      }
    } catch {
      /* ignore */
    }
  }

  return Math.max(score, 1);
}

/**
 * Given a list of agents + a task text, return the highest-scoring agent
 * (deterministic tie-break by agent name). Returns null if no agent can take
 * work (all offline/error/sleeping).
 */
export function pickBestAgent(
  agents: readonly AgentRecord[],
  taskText: string,
): AgentRecord | null {
  let best: { agent: AgentRecord; score: number } | null = null;
  for (const a of agents) {
    const s = scoreAgentForTask(a, taskText);
    if (s < 0) continue;
    if (best === null || s > best.score || (s === best.score && a.name < best.agent.name)) {
      best = { agent: a, score: s };
    }
  }
  return best?.agent ?? null;
}
