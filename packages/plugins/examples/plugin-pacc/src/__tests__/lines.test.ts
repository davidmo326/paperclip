import { describe, expect, it } from "vitest";

import {
  applyLinePatch,
  homeRelative,
  LineValidationError,
  lineFromSeed,
  lineToControlPlaneState,
  recordEvidence,
  renderSnapshot,
  type ProjectLine,
} from "../lib/lines/lines.js";
import { parseResultBlock, renderDispatchCard, RESULT_FENCE } from "../lib/lines/dispatch-card.js";
import {
  importLines,
  promoteJournalToFloor,
  recordRunResult,
  updateLine,
} from "../lib/lines/floor-actions.js";
import type { LineDeps } from "../lib/lines/lines-deps.js";
import type { WorkItemDeps } from "../lib/work-items/work-item-deps.js";
import { makeWorkItem, type WorkItem } from "../lib/work-items/work-items.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");

const SEED = {
  id: "hometrics",
  slug: "hometrics",
  name: "Hometrics",
  portfolioState: "active",
  phase: "find demand",
  intent: "Help owners see their home's running cost",
  keyQuestion: "Will 3 owners use it weekly?",
  keyQuestionCandidates: ["Is cost the hook?", "Is cost the hook?", ""],
  repoPath: "/home/david/Work/Hometrics",
  groundingRefs: [{ kind: "icp-profile", path: "/home/david/Obsidian/ICP.md", anchor: "## 2", label: "ICP" }],
  sourceRefs: [{ kind: "obsidian-folder", path: "/home/david/Obsidian/10_Builds/Hometrics" }],
  confidence: 1,
  voice_sensitive: null,
};

function memLines(initial: ProjectLine[] = []): LineDeps & { rows: Map<string, ProjectLine> } {
  const rows = new Map(initial.map((l) => [l.id, l]));
  return {
    rows,
    async getLine(id) {
      return rows.get(id) ?? null;
    },
    async listLines() {
      return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    async putLine(line) {
      rows.set(line.id, line);
    },
  };
}

function memItems(initial: WorkItem[] = []): WorkItemDeps & { rows: Map<string, WorkItem> } {
  const rows = new Map(initial.map((i) => [i.id, i]));
  let n = 0;
  return {
    rows,
    async getItem(id) {
      return rows.get(id) ?? null;
    },
    async listItems() {
      return [...rows.values()];
    },
    async putItem(item) {
      rows.set(item.id, item);
    },
    async putCapacityDay() {},
    async listCapacityDays() {
      return [];
    },
    newId() {
      n += 1;
      return `id-${n}`;
    },
  };
}

describe("project lines (ADR 0003 record)", () => {
  it("imports a seed entry with home-relative paths and keeps unmodelled fields", () => {
    const line = lineFromSeed(SEED, { now: NOW, actor: "principal" });
    expect(line.id).toBe("hometrics");
    expect(line.repoPath).toBe("~/Work/Hometrics");
    expect(line.groundingRefs[0]?.path).toBe("~/Obsidian/ICP.md");
    expect(line.keyQuestionCandidates).toEqual(["Is cost the hook?"]);
    expect(line.extra).toEqual({ confidence: 1, voice_sensitive: null });
    expect(homeRelative("/home/dm/Work/x")).toBe("~/Work/x");
  });

  it("enforces the curation split", () => {
    const line = lineFromSeed(SEED, { now: NOW, actor: "principal" });
    const out = applyLinePatch(line, { keyQuestion: "New KQ?" }, { now: NOW, actor: "principal" });
    expect(out.changed).toEqual(["keyQuestion"]);
    expect(out.line.edits.at(-1)?.fields).toEqual(["keyQuestion"]);
    expect(() => applyLinePatch(line, { intent: "x" }, { now: NOW, actor: "cos" })).toThrow(LineValidationError);
    expect(() => applyLinePatch(line, { currentStatus: "x" }, { now: NOW, actor: "cos" })).toThrow(/sourceRefs/);
    const cos = applyLinePatch(line, { currentStatus: "moving", sourceRefs: [{ kind: "x", path: "y" }] }, { now: NOW, actor: "cos" });
    expect(cos.line.currentStatus).toBe("moving");
    expect(() => applyLinePatch(line, { currentStatus: "x" }, { now: NOW, actor: "hand" })).toThrow(LineValidationError);
    expect(applyLinePatch(line, { keyQuestion: line.keyQuestion }, { now: NOW, actor: "principal" }).changed).toEqual([]);
  });

  it("renders a byte-identical snapshot for identical lines", () => {
    const a = lineFromSeed(SEED, { now: NOW, actor: "principal" });
    const b = lineFromSeed({ ...SEED, id: "accounting", slug: "accounting", name: "Accounting" }, { now: NOW, actor: "principal" });
    expect(renderSnapshot([a, b])).toBe(renderSnapshot([b, a]));
    const parsed = JSON.parse(renderSnapshot([a]));
    expect(Object.keys(parsed[0]).slice(0, 3)).toEqual(["id", "slug", "name"]);
    expect(parsed[0].confidence).toBe(1);
  });

  it("moves only the evidence clock forward", () => {
    const line = lineFromSeed({ ...SEED, lastEvidenceAt: "2026-09-01T00:00:00.000Z" }, { now: NOW, actor: "principal" });
    expect(recordEvidence(line, NOW).lastEvidenceAt).toBe(NOW.toISOString());
    expect(recordEvidence(line, new Date("2026-01-01")).lastEvidenceAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("passes only well-formed source refs to the context card", () => {
    const state = lineToControlPlaneState(lineFromSeed(SEED, { now: NOW, actor: "principal" }));
    expect(state.sourceRefs).toEqual([]);
    expect(state.keyQuestion).toBe("Will 3 owners use it weekly?");
  });
});

describe("context carry", () => {
  it("renders a dispatch card with grounding and the return contract", () => {
    const line = lineFromSeed(SEED, { now: NOW, actor: "principal" });
    const item = makeWorkItem(
      { projectId: "hometrics", title: "Walk through with owner", workType: "market-contact", size: "bite", keyQuestion: line.keyQuestion },
      { id: "i1", now: NOW, actor: "principal" },
    );
    const card = renderDispatchCard({ line, item });
    expect(card).toContain("Will 3 owners use it weekly?");
    expect(card).toContain("repo: ~/Work/Hometrics");
    expect(card).toContain("```" + RESULT_FENCE);
    expect(card).toBe(renderDispatchCard({ line, item }));
  });

  it("parses the last result block and tolerates junk", () => {
    const out = [
      "working…",
      "```" + RESULT_FENCE,
      '{"summary":"old"}',
      "```",
      "done",
      "```" + RESULT_FENCE,
      JSON.stringify({ summary: "Sent nothing; drafted the email", links: ["a.md"], evidence: false, draft: { channel: "email", text: "Hi" }, followUps: [{ title: "Send it", workType: "market-contact", size: "bite" }] }),
      "```",
    ].join("\n");
    const r = parseResultBlock(out);
    expect(r?.summary).toBe("Sent nothing; drafted the email");
    expect(r?.draft).toEqual({ channel: "email", text: "Hi" });
    expect(r?.followUps).toHaveLength(1);
    expect(parseResultBlock("no block")).toBeNull();
    expect(parseResultBlock("```" + RESULT_FENCE + "\nnot json\n```")).toBeNull();
  });

  it("records a run result: needs-you, session link, evidence clock, draft gate, follow-ups in intake", async () => {
    const lines = memLines([lineFromSeed(SEED, { now: NOW, actor: "principal" })]);
    const item = makeWorkItem(
      { projectId: "hometrics", title: "Run test", workType: "build", size: "bite", stage: "in-progress" },
      { id: "i1", now: NOW, actor: "principal" },
    );
    const items = memItems([item]);
    const output =
      "```" + RESULT_FENCE + "\n" +
      JSON.stringify({ summary: "Owner used it twice", links: ["abc123"], evidence: true, draft: { channel: "linkedin", text: "Post" }, followUps: [{ title: "Ask owner #2", workType: "market-contact", size: "bite" }, { title: "Run test", workType: "build", size: "bite" }] }) +
      "\n```";
    const later = new Date("2026-09-30T05:00:00.000Z");
    const r = await recordRunResult({ lines, items }, { itemId: "i1", output, ok: true, sessionId: "sess-1", machine: "omarchy-desktop" }, later);
    expect(r.item.stage).toBe("needs-you");
    expect(r.item.sessions?.[0]?.sessionId).toBe("sess-1");
    expect(r.item.result?.evidence).toBe(true);
    expect(r.item.draft?.status).toBe("pending");
    expect(r.followUps.map((f) => [f.title, f.stage])).toEqual([["Ask owner #2", "intake"]]);
    expect((await lines.getLine("hometrics"))?.lastEvidenceAt).toBe(later.toISOString());
  });

  it("a failed run never counts as evidence", async () => {
    const lines = memLines([lineFromSeed(SEED, { now: NOW, actor: "principal" })]);
    const item = makeWorkItem({ projectId: "hometrics", title: "x", workType: "build", size: "bite" }, { id: "i1", now: NOW, actor: "principal" });
    const items = memItems([item]);
    const output = "```" + RESULT_FENCE + '\n{"summary":"s","evidence":true}\n```';
    const r = await recordRunResult({ lines, items }, { itemId: "i1", output, ok: false }, NOW);
    expect(r.evidence).toBe(false);
    expect(r.item.result?.ok).toBe(false);
  });
});

describe("floor seams", () => {
  it("imports missing lines only, keeping the record over the snapshot", async () => {
    const lines = memLines();
    const first = await importLines(lines, [SEED], { now: NOW, actor: "principal" });
    expect(first.created).toEqual(["hometrics"]);
    await updateLine(lines, "hometrics", { keyQuestion: "Edited on the floor?" }, { now: NOW, actor: "principal" });
    const again = await importLines(lines, [SEED], { now: NOW, actor: "principal" });
    expect(again.skipped).toEqual(["hometrics"]);
    expect((await lines.getLine("hometrics"))?.keyQuestion).toBe("Edited on the floor?");
  });

  it("promotes steward proposals to Triage, deduped, matched by name or id", async () => {
    const lines = memLines([lineFromSeed(SEED, { now: NOW, actor: "principal" })]);
    const items = memItems();
    const proposal = {
      project: "Hometrics",
      proposal: "Book the owner walkthrough",
      whyNow: "capacity 7",
      jobClassification: "J1_signal" as const,
      requiredAuthority: "L1",
      sourceRefs: [],
      anchorCitations: [],
      confidence: 0.8,
      riskIfIgnored: "KQ stalls",
    };
    const journal = { journalDate: "2026-09-30", attention: [proposal, { ...proposal, project: "ghost" }], drafts: [] };
    const r = await promoteJournalToFloor({ lines, items }, journal, NOW);
    expect(r.created.map((i) => [i.projectId, i.stage, i.workType, i.worker])).toEqual([
      ["hometrics", "triage", "market-contact", "cos"],
    ]);
    expect(r.unmatched).toEqual(["ghost"]);
    const again = await promoteJournalToFloor({ lines, items }, journal, NOW);
    expect(again.created).toEqual([]);
  });
});

describe("attention and triage moves", () => {
  it("lets the runtime place attention in Needs you, and nowhere else", () => {
    const at = makeWorkItem({ projectId: "p", title: "waiting", workType: "build", size: "bite", stage: "needs-you" }, { id: "a", now: NOW, actor: "runtime" });
    expect(at.stage).toBe("needs-you");
    const other = makeWorkItem({ projectId: "p", title: "x", workType: "build", size: "bite", stage: "triage" }, { id: "b", now: NOW, actor: "runtime" });
    expect(other.stage).toBe("intake");
  });

  it("only triaging actors re-home items", async () => {
    const { applyPatch } = await import("../lib/work-items/work-items.js");
    const item = makeWorkItem({ projectId: "loose-ends", title: "x", workType: "build", size: "bite" }, { id: "a", now: NOW, actor: "principal" });
    expect(applyPatch(item, { projectId: "hometrics" }, { now: NOW, actor: "principal" }).projectId).toBe("hometrics");
    expect(() => applyPatch(item, { projectId: "hometrics" }, { now: NOW, actor: "hand" })).toThrow();
  });
});

describe("CoS allocation (L6)", () => {
  const proposal = (project: string, proposal: string, size: "bite" | "deep") => ({
    project, proposal, size, whyNow: "", jobClassification: "J1_signal" as const, requiredAuthority: "L1",
    sourceRefs: [], anchorCitations: [], confidence: 0.8, riskIfIgnored: "",
  });

  it("a recorded zero writes the day off; deep proposals are capped by deep blocks", async () => {
    const { promoteJournalToFloor, readStewardFloor } = await import("../lib/lines/floor-actions.js");
    const lines = memLines([lineFromSeed(SEED, { now: NOW, actor: "principal" })]);
    const items = memItems();
    const journal = { journalDate: "2026-09-30", attention: [proposal("Hometrics", "deep one", "deep"), proposal("Hometrics", "deep two", "deep"), proposal("Hometrics", "a bite", "bite")], drafts: [] };
    const zero = await promoteJournalToFloor({ lines, items }, journal, NOW, { capacity: { date: "2026-09-30", score: 0, deepBlocks: 0, bites: 0, occupiedBy: null, recorded: true } });
    expect(zero.created).toEqual([]);
    expect(zero.skippedForCapacity).toBe(3);
    const five = await promoteJournalToFloor({ lines, items }, journal, NOW, { capacity: { date: "2026-09-30", score: 5, deepBlocks: 1, bites: 2, occupiedBy: null, recorded: true } });
    expect(five.created.map((i) => [i.title, i.size])).toEqual([["deep one", "deep"], ["a bite", "bite"]]);
    expect(five.skippedForCapacity).toBe(1);
    const floor = await readStewardFloor({ lines, items }, NOW);
    expect(floor.lines[0]?.open.triage).toBe(2);
    expect(floor.capacity.recorded).toBe(false);
  });
});

describe("CoS on the principal's Claude subscription", () => {
  it("strips provider overrides, skips user settings and restores HOME", async () => {
    const { cliAuthEnv } = await import("../lib/briefer/model-claude-cli.js");
    const base = { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "x", PACC_STEWARD_MODEL: "m" };
    const sub = cliAuthEnv("subscription", base);
    expect(sub.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(sub.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(sub.env.PACC_STEWARD_MODEL).toBe("m");
    expect(typeof sub.env.HOME).toBe("string");
    expect(sub.argv).toEqual(["--setting-sources", "project,local"]);
    expect(cliAuthEnv("env", base).env).toBe(base);
  });
});

describe("CoS over an Anthropic-compatible Messages API (z.ai GLM)", () => {
  it("posts the prompt and returns text; degrades on errors", async () => {
    const { callModelViaMessagesApi } = await import("../lib/briefer/model-messages-api.js");
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ id: "m1", content: [{ type: "text", text: "{}" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await callModelViaMessagesApi({ modelId: "glm-5.3", prompt: "p" }, { baseUrl: "https://z/api/anthropic/", token: "t", fetchFn: ok });
    expect(r).toEqual({ text: "{}", sessionId: "m1" });
    expect(seen!.url).toBe("https://z/api/anthropic/v1/messages");
    expect(seen!.body.model).toBe("glm-5.3");
    const bad = (async () => new Response(JSON.stringify({ error: { message: "unknown model" } }), { status: 400 })) as unknown as typeof fetch;
    expect((await callModelViaMessagesApi({ modelId: "x", prompt: "p" }, { baseUrl: "https://z", token: "t", fetchFn: bad })).text).toBeNull();
    expect((await callModelViaMessagesApi({ modelId: "x", prompt: "p" }, { baseUrl: "", token: "" })).text).toBeNull();
  });
});
