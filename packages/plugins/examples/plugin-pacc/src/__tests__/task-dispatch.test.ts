/**
 * T-1.5 — task-dispatch tests.
 *
 * Two layers:
 *   1. Pure-function tests for classifyTaskModel / buildTaskPrompt /
 *      parseAgentResponse / parseReviewVerdict / scoreAgentForTask /
 *      pickBestAgent.
 *   2. State-machine tests for runDispatchCycle / runReviewCycle /
 *      runAutoRouteCycle, each driven with a hand-rolled mock DispatchDeps.
 *
 * No paperclip host needed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  buildTaskPrompt,
  classifyDirectModel,
  classifyTaskModel,
  parseAgentResponse,
  parseGatewayJson,
  parseReviewVerdict,
  pickBestAgent,
  resolveGatewayAgentId,
  ROLE_AFFINITY,
  scoreAgentForTask,
} from "../lib/task-dispatch/core.js";
import {
  runAutoRouteCycle,
  runDispatchCycle,
  runReviewCycle,
} from "../lib/task-dispatch/dispatch.js";
import type {
  AgentRecord,
  DispatchableTask,
  DispatchDeps,
  ReviewableTask,
} from "../lib/task-dispatch/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<DispatchableTask> = {}): DispatchableTask {
  return {
    id: "t-1",
    title: "Add login button",
    description: "We need a primary CTA on the landing page.",
    status: "assigned",
    priority: "medium",
    assigned_to: "Builder",
    workspace_id: "ws-1",
    agent_name: "Builder",
    agent_id: "a-1",
    agent_config: null,
    ticket_prefix: "WEB",
    project_ticket_no: 42,
    project_id: "p-1",
    tags: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a-1",
    name: "Builder",
    role: "coder",
    status: "idle",
    config: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure-function tests
// ---------------------------------------------------------------------------

describe("classifyTaskModel", () => {
  it("returns Opus for 'critical' priority regardless of text", () => {
    expect(classifyTaskModel(makeTask({ priority: "critical" }))).toContain("opus");
  });

  it("returns Opus when text contains a complex signal", () => {
    expect(
      classifyTaskModel(makeTask({ title: "Investigate root cause of memory leak" })),
    ).toContain("opus");
  });

  it("returns Haiku for 'low' priority + routine signal", () => {
    expect(
      classifyTaskModel(makeTask({ priority: "low", title: "Status check on prod" })),
    ).toContain("haiku");
  });

  it("respects agent_config dispatchModel override", () => {
    const config = JSON.stringify({ dispatchModel: "9router/cc/claude-custom-1" });
    expect(classifyTaskModel(makeTask({ agent_config: config }))).toBe("9router/cc/claude-custom-1");
  });

  it("returns null for ambiguous tasks (agent default model)", () => {
    expect(classifyTaskModel(makeTask({ priority: "medium" }))).toBeNull();
  });

  it("ignores routine signal when priority is high/critical", () => {
    expect(
      classifyTaskModel(makeTask({ priority: "high", title: "format the readme" })),
    ).toBeNull();
  });
});

describe("classifyDirectModel", () => {
  it("strips router prefix when reading agent_config override", () => {
    const config = JSON.stringify({ dispatchModel: "9router/cc/claude-sonnet-4-6" });
    expect(classifyDirectModel(makeTask({ agent_config: config }))).toBe("claude-sonnet-4-6");
  });

  it("returns bare Opus id for complex tasks", () => {
    expect(classifyDirectModel(makeTask({ priority: "critical" }))).toBe("claude-opus-4-6");
  });

  it("returns Sonnet by default", () => {
    expect(classifyDirectModel(makeTask({ priority: "medium" }))).toBe("claude-sonnet-4-6");
  });
});

describe("resolveGatewayAgentId", () => {
  it("falls back to agent_name when no openclawId in config", () => {
    expect(resolveGatewayAgentId(makeTask())).toBe("Builder");
  });

  it("uses openclawId from config when present", () => {
    const config = JSON.stringify({ openclawId: "builder-v2" });
    expect(resolveGatewayAgentId(makeTask({ agent_config: config }))).toBe("builder-v2");
  });
});

describe("buildTaskPrompt", () => {
  it("renders the ticket key when prefix + number present", () => {
    const prompt = buildTaskPrompt(makeTask());
    expect(prompt).toContain("[WEB-042] Add login button");
    expect(prompt).toContain("Priority: medium");
  });

  it("falls back to TASK-<id> when prefix missing", () => {
    const prompt = buildTaskPrompt(makeTask({ ticket_prefix: null, project_ticket_no: null }));
    expect(prompt).toContain("[TASK-t-1]");
  });

  it("appends rejection feedback section when provided", () => {
    const prompt = buildTaskPrompt(makeTask(), "Missing accessibility labels");
    expect(prompt).toContain("## Previous Review Feedback");
    expect(prompt).toContain("Missing accessibility labels");
  });

  it("includes tags line when tags non-empty", () => {
    const prompt = buildTaskPrompt(makeTask({ tags: ["frontend", "css"] }));
    expect(prompt).toContain("Tags: frontend, css");
  });
});

describe("parseGatewayJson", () => {
  it("extracts the first JSON object from noisy stdout", () => {
    expect(parseGatewayJson('warning: foo\n{"a":1}\n')).toEqual({ a: 1 });
  });

  it("returns null for empty input", () => {
    expect(parseGatewayJson("")).toBeNull();
  });

  it("returns null when no braces", () => {
    expect(parseGatewayJson("nothing here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseGatewayJson('{"a":1')).toBeNull();
  });
});

describe("parseAgentResponse", () => {
  it("extracts payloads[0].text + sessionId", () => {
    const result = parseAgentResponse(
      JSON.stringify({ sessionId: "s-1", payloads: [{ text: "hello" }] }),
    );
    expect(result).toEqual({ text: "hello", sessionId: "s-1" });
  });

  it("supports session_id snake_case alias", () => {
    const result = parseAgentResponse(
      JSON.stringify({ session_id: "s-2", payloads: [{ text: "hi" }] }),
    );
    expect(result.sessionId).toBe("s-2");
  });

  it("falls back to .result then .output", () => {
    expect(parseAgentResponse(JSON.stringify({ result: "ok" })).text).toBe("ok");
    expect(parseAgentResponse(JSON.stringify({ output: "ok2" })).text).toBe("ok2");
  });

  it("returns raw stdout when not valid JSON", () => {
    expect(parseAgentResponse("just text").text).toBe("just text");
  });

  it("returns null text for empty input", () => {
    expect(parseAgentResponse("").text).toBeNull();
  });
});

describe("buildReviewPrompt + parseReviewVerdict", () => {
  const reviewTask: ReviewableTask = {
    id: "t-1",
    title: "Add login button",
    description: "Primary CTA on landing",
    resolution: "Added <button>Login</button> at top-right.",
    assigned_to: "Builder",
    workspace_id: "ws-1",
    ticket_prefix: "WEB",
    project_ticket_no: 42,
    agent_config: null,
  };

  it("renders both task and resolution sections", () => {
    const prompt = buildReviewPrompt(reviewTask);
    expect(prompt).toContain("[WEB-042] Add login button");
    expect(prompt).toContain("## Task Description");
    expect(prompt).toContain("## Agent Resolution");
    expect(prompt).toContain("VERDICT: APPROVED");
  });

  it("parses APPROVED verdict + extracts notes", () => {
    expect(parseReviewVerdict("VERDICT: APPROVED\nNOTES: looks good")).toEqual({
      status: "approved",
      notes: "looks good",
    });
  });

  it("defaults to REJECTED when verdict not approved", () => {
    expect(parseReviewVerdict("VERDICT: REJECTED\nNOTES: missing aria-label").status).toBe(
      "rejected",
    );
  });

  it("falls back to default notes when NOTES line missing", () => {
    expect(parseReviewVerdict("VERDICT: APPROVED").notes).toBe("Quality check passed");
    expect(parseReviewVerdict("VERDICT: REJECTED").notes).toBe("Quality check failed");
  });
});

describe("scoreAgentForTask + pickBestAgent", () => {
  it("excludes offline / error / sleeping agents (score < 0)", () => {
    expect(scoreAgentForTask(makeAgent({ status: "offline" }), "any task")).toBe(-1);
    expect(scoreAgentForTask(makeAgent({ status: "error" }), "any task")).toBe(-1);
    expect(scoreAgentForTask(makeAgent({ status: "sleeping" }), "any task")).toBe(-1);
  });

  it("scores keyword matches at +10 each", () => {
    const score = scoreAgentForTask(
      makeAgent({ role: "coder", status: "busy" }),
      "implement a new API endpoint with unit test",
    );
    // 'implement', 'api', 'endpoint', 'unit test', 'test'
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it("adds +5 idle bonus", () => {
    const idle = scoreAgentForTask(makeAgent({ status: "idle" }), "implement");
    const busy = scoreAgentForTask(makeAgent({ status: "busy" }), "implement");
    expect(idle).toBe(busy + 5);
  });

  it("adds +15 per matching capability from agent.config", () => {
    const config = JSON.stringify({ capabilities: ["graphql"] });
    const score = scoreAgentForTask(
      makeAgent({ status: "busy", role: "coder", config }),
      "build a GraphQL endpoint",
    );
    // keyword 'endpoint' (10) + capability 'graphql' (15)
    expect(score).toBeGreaterThanOrEqual(25);
  });

  it("returns minimum 1 even for no-match non-offline agents", () => {
    expect(scoreAgentForTask(makeAgent({ role: "agent", status: "busy" }), "nothing")).toBe(1);
  });

  it("pickBestAgent picks the highest score with deterministic tie-break", () => {
    const a = makeAgent({ id: "a", name: "Aaron", role: "coder", status: "idle" });
    const b = makeAgent({ id: "b", name: "Beth", role: "coder", status: "idle" });
    // Equal scores → name alphabetic order
    expect(pickBestAgent([b, a], "implement a feature")?.name).toBe("Aaron");
  });

  it("pickBestAgent returns null when all agents are offline", () => {
    expect(
      pickBestAgent([makeAgent({ status: "offline" }), makeAgent({ status: "error" })], "x"),
    ).toBeNull();
  });

  it("ROLE_AFFINITY covers expected roles", () => {
    expect(Object.keys(ROLE_AFFINITY)).toEqual(
      expect.arrayContaining(["coder", "researcher", "reviewer", "tester", "devops", "assistant", "agent"]),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. State-machine tests with mocked DispatchDeps
// ---------------------------------------------------------------------------

interface MockState {
  assigned: DispatchableTask[];
  reviewable: ReviewableTask[];
  inbox: DispatchableTask[];
  agents: AgentRecord[];
  statusUpdates: Array<{ id: string; status: string; fields?: Record<string, unknown> }>;
  resolutions: Array<{ id: string; text: string }>;
  approvals: Array<{ id: string; notes: string }>;
  rejections: Array<{ id: string; notes: string }>;
  assignments: Array<{ id: string; agent: string }>;
  activity: Array<{ event: string; payload: Record<string, unknown> }>;
  /** Per-task model response stub. Keyed by taskId; falls back to default. */
  modelResponses: Map<string, { text: string | null; sessionId: string | null }>;
  /** Per-call hook for forcing errors (e.g. throw when updateTaskStatus called). */
  throwOn?: { method: keyof DispatchDeps };
}

function makeDeps(state: MockState): DispatchDeps {
  const maybeThrow = (method: keyof DispatchDeps) => {
    if (state.throwOn?.method === method) throw new Error(`forced error on ${method}`);
  };
  return {
    async listAssignedTasks() {
      maybeThrow("listAssignedTasks");
      return state.assigned;
    },
    async listReviewableTasks() {
      maybeThrow("listReviewableTasks");
      return state.reviewable;
    },
    async listInboxTasks() {
      maybeThrow("listInboxTasks");
      return state.inbox;
    },
    async listAgentsForRouting() {
      maybeThrow("listAgentsForRouting");
      return state.agents;
    },
    async updateTaskStatus(id, status, fields) {
      maybeThrow("updateTaskStatus");
      state.statusUpdates.push({ id, status, fields });
    },
    async setTaskResolution(id, text) {
      maybeThrow("setTaskResolution");
      state.resolutions.push({ id, text });
    },
    async assignTaskToAgent(id, agent) {
      maybeThrow("assignTaskToAgent");
      state.assignments.push({ id, agent });
    },
    async recordReviewApproval(id, notes) {
      maybeThrow("recordReviewApproval");
      state.approvals.push({ id, notes });
    },
    async recordReviewRejection(id, notes) {
      maybeThrow("recordReviewRejection");
      state.rejections.push({ id, notes });
    },
    async logActivity(event, payload) {
      state.activity.push({ event, payload });
    },
    async callModel({ modelId: _modelId }) {
      maybeThrow("callModel");
      return (
        state.modelResponses.get(state.assigned[0]?.id ?? "") ?? {
          text: "default model response",
          sessionId: null,
        }
      );
    },
  };
}

function freshState(over: Partial<MockState> = {}): MockState {
  return {
    assigned: [],
    reviewable: [],
    inbox: [],
    agents: [],
    statusUpdates: [],
    resolutions: [],
    approvals: [],
    rejections: [],
    assignments: [],
    activity: [],
    modelResponses: new Map(),
    ...over,
  };
}

let state: MockState;
beforeEach(() => {
  state = freshState();
});

describe("runDispatchCycle", () => {
  it("returns ok with empty details when no assigned tasks", async () => {
    const result = await runDispatchCycle(makeDeps(state));
    expect(result).toEqual({ ok: true, message: expect.stringContaining("No assigned"), details: [] });
  });

  it("transitions an assigned task through in_progress → review and stores resolution", async () => {
    state.assigned = [makeTask()];
    state.modelResponses.set("t-1", { text: "Done; PR opened.", sessionId: "sess-1" });

    const result = await runDispatchCycle(makeDeps(state));

    expect(result.ok).toBe(true);
    expect(state.statusUpdates).toEqual([
      { id: "t-1", status: "in_progress", fields: undefined },
      { id: "t-1", status: "review", fields: undefined },
    ]);
    expect(state.resolutions).toEqual([{ id: "t-1", text: "Done; PR opened." }]);
    expect(state.activity[0].event).toBe("task.dispatched");
    expect(state.activity[0].payload).toMatchObject({
      taskId: "t-1",
      sessionId: "sess-1",
    });
    expect(result.details).toEqual([{ taskId: "t-1", outcome: "dispatched" }]);
  });

  it("returns failure detail and reverts to 'assigned' when callModel throws", async () => {
    state.assigned = [makeTask()];
    state.throwOn = { method: "callModel" };

    const result = await runDispatchCycle(makeDeps(state));

    expect(result.ok).toBe(true); // cycle itself succeeds; one task failed
    expect(result.details?.[0].outcome).toBe("failed");
    expect(state.statusUpdates[state.statusUpdates.length - 1]).toMatchObject({
      status: "assigned",
      fields: { error: expect.any(String) },
    });
    expect(state.activity.some((a) => a.event === "task.dispatch_failed")).toBe(true);
  });

  it("returns ok=false when listAssignedTasks itself throws", async () => {
    state.throwOn = { method: "listAssignedTasks" };
    const result = await runDispatchCycle(makeDeps(state));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("listAssignedTasks failed");
  });
});

describe("runReviewCycle", () => {
  const reviewTask: ReviewableTask = {
    id: "t-1",
    title: "Add login button",
    description: "Primary CTA",
    resolution: "Added <button>",
    assigned_to: "Builder",
    workspace_id: "ws-1",
    ticket_prefix: "WEB",
    project_ticket_no: 42,
    agent_config: null,
  };

  it("approves and moves to 'done' when verdict is APPROVED", async () => {
    state.reviewable = [reviewTask];
    state.modelResponses.set(
      "",
      { text: "VERDICT: APPROVED\nNOTES: clean implementation", sessionId: null },
    );
    // The mock's modelResponses lookup uses state.assigned[0]?.id ?? "" — set entry for ""
    const deps = makeDeps(state);
    // Override callModel for this test to return an approved verdict
    (deps as DispatchDeps & { callModel: DispatchDeps["callModel"] }).callModel = async () => ({
      text: "VERDICT: APPROVED\nNOTES: clean implementation",
      sessionId: null,
    });

    const result = await runReviewCycle(deps);

    expect(result.ok).toBe(true);
    expect(state.approvals).toEqual([{ id: "t-1", notes: "clean implementation" }]);
    expect(state.statusUpdates).toEqual([{ id: "t-1", status: "done", fields: undefined }]);
    expect(result.details?.[0].outcome).toBe("approved");
  });

  it("rejects and reverts to 'assigned' when verdict is REJECTED", async () => {
    state.reviewable = [reviewTask];
    const deps = makeDeps(state);
    (deps as DispatchDeps & { callModel: DispatchDeps["callModel"] }).callModel = async () => ({
      text: "VERDICT: REJECTED\nNOTES: missing aria-label",
      sessionId: null,
    });

    const result = await runReviewCycle(deps);

    expect(state.rejections).toEqual([{ id: "t-1", notes: "missing aria-label" }]);
    expect(state.statusUpdates).toEqual([
      { id: "t-1", status: "assigned", fields: { rejectionFeedback: "missing aria-label" } },
    ]);
    expect(result.details?.[0].outcome).toBe("rejected");
  });
});

describe("runAutoRouteCycle", () => {
  it("routes an inbox task to the highest-scoring agent", async () => {
    state.inbox = [makeTask({ id: "t-99", description: "Implement a new API endpoint", assigned_to: "" })];
    state.agents = [
      makeAgent({ name: "Builder", role: "coder", status: "idle" }),
      makeAgent({ name: "Writer", role: "assistant", status: "idle" }),
    ];

    const result = await runAutoRouteCycle(makeDeps(state));

    expect(result.ok).toBe(true);
    expect(state.assignments).toEqual([{ id: "t-99", agent: "Builder" }]);
    expect(state.statusUpdates).toEqual([{ id: "t-99", status: "assigned", fields: undefined }]);
    expect(state.activity[0]).toMatchObject({
      event: "task.routed",
      payload: { taskId: "t-99", toAgent: "Builder", agentRole: "coder" },
    });
    expect(result.details?.[0].outcome).toBe("routed");
  });

  it("skips inbox tasks when all agents are offline", async () => {
    state.inbox = [makeTask({ id: "t-2" })];
    state.agents = [makeAgent({ status: "offline" })];

    const result = await runAutoRouteCycle(makeDeps(state));

    expect(state.assignments).toEqual([]);
    expect(result.details?.[0]).toMatchObject({ outcome: "skipped", reason: "no eligible agent" });
  });

  it("returns the empty-inbox message when no inbox tasks", async () => {
    const result = await runAutoRouteCycle(makeDeps(state));
    expect(result.message).toContain("Inbox empty");
  });

  it("returns ok=false when an input fetch throws", async () => {
    state.throwOn = { method: "listInboxTasks" };
    const result = await runAutoRouteCycle(makeDeps(state));
    expect(result.ok).toBe(false);
  });
});
