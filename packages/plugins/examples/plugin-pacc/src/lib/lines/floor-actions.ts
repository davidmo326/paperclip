/**
 * Floor actions that span project lines and work items — the seams where the
 * three parts (state, runtime, surface) meet. Pure orchestration over injected
 * deps; the worker wires them to `ctx.entities` and exposes them on the bridge.
 */

import type { LineDeps } from "./lines-deps.js";
import { applyLinePatch, lineFromSeed, recordEvidence, type LinePatch, type ProjectLine } from "./lines.js";
import { parseResultBlock, renderDispatchCard } from "./dispatch-card.js";
import type { WorkItemDeps } from "../work-items/work-item-deps.js";
import {
  applyPatch,
  makeWorkItem,
  SIZES,
  WORK_TYPES,
  type WorkItem,
} from "../work-items/work-items.js";
import type { StewardJournal } from "../steward/steward.js";

export interface FloorDeps {
  lines: LineDeps;
  items: WorkItemDeps;
}

/**
 * One-time takeover of the seed into the record. `missing-only` never
 * overwrites a line that already exists — the record wins over the snapshot.
 */
export async function importLines(
  deps: LineDeps,
  seed: unknown[],
  opts: { now: Date; actor: string; legacyByName?: Record<string, string>; mode?: "missing-only" | "overwrite" },
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const entry of seed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const line = lineFromSeed(e, { now: opts.now, actor: opts.actor, legacyProjectId: opts.legacyByName?.[name] ?? null });
    const existing = await deps.getLine(line.id);
    if (existing && opts.mode !== "overwrite") {
      skipped.push(line.id);
      continue;
    }
    await deps.putLine(existing ? { ...line, edits: [...existing.edits, ...line.edits] } : line);
    created.push(line.id);
  }
  return { created, skipped };
}

export async function updateLine(
  deps: LineDeps,
  id: string,
  patch: LinePatch,
  opts: { now: Date; actor: string },
): Promise<{ line: ProjectLine; changed: string[] }> {
  const prior = await deps.getLine(id);
  if (!prior) throw new Error(`no project line ${id}`);
  const out = applyLinePatch(prior, patch, opts);
  if (out.changed.length) await deps.putLine(out.line);
  return out;
}

export async function dispatchCardFor(deps: FloorDeps, itemId: string): Promise<{ card: string; item: WorkItem; line: ProjectLine | null }> {
  const item = await deps.items.getItem(itemId);
  if (!item) throw new Error(`no work item ${itemId}`);
  const line = await deps.lines.getLine(item.projectId);
  const siblings = (await deps.items.listItems()).filter((i) => i.projectId === item.projectId);
  return { card: renderDispatchCard({ line, item, openSiblings: siblings }), item, line };
}

function oneOfOr<T extends string>(list: readonly T[], v: string, fallback: T): T {
  return (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Return leg of context carry: a hand finished (or failed) a run on an item.
 * The item gets the session link and the parsed result and moves to Needs you;
 * an evidence result moves the line's evidence clock; a draft goes behind the
 * publish gate; follow-ups arrive in Intake (a hand is not a triaging actor).
 */
export async function recordRunResult(
  deps: FloorDeps,
  input: {
    itemId: string;
    output: string;
    ok: boolean;
    sessionId?: string | null;
    machine?: string | null;
    tool?: string | null;
    worker?: string | null;
    cwd?: string | null;
    costUsd?: number | null;
    commandId?: string | null;
  },
  now: Date,
): Promise<{ item: WorkItem; followUps: WorkItem[]; evidence: boolean; parsed: boolean }> {
  const prior = await deps.items.getItem(input.itemId);
  if (!prior) throw new Error(`no work item ${input.itemId}`);
  const parsed = parseResultBlock(input.output ?? "");
  const tail = (input.output ?? "").trim().slice(-600);
  const summary = parsed?.summary || (input.ok ? tail : `run failed: ${tail}`);
  let item = applyPatch(
    prior,
    {
      ...(input.sessionId
        ? {
            linkSession: {
              sessionId: input.sessionId,
              machine: input.machine ?? null,
              tool: input.tool ?? "claude",
              worker: input.worker ?? prior.worker ?? "generic",
              cwd: input.cwd ?? null,
            },
          }
        : {}),
      result: {
        ok: input.ok,
        summary,
        links: parsed?.links ?? [],
        evidence: input.ok && parsed?.evidence === true,
        sessionId: input.sessionId ?? null,
        costUsd: input.costUsd ?? null,
      },
      ...(parsed?.draft ? { draft: { channel: parsed.draft.channel, text: parsed.draft.text, status: "pending" as const } } : {}),
      stage: prior.stage === "done" ? "done" : "needs-you",
      note: input.ok ? `hand returned${parsed ? "" : " (no result block)"}` : "hand run failed",
    },
    { now, actor: "hand" },
  );
  await deps.items.putItem(item);

  const evidence = item.result?.evidence === true;
  if (evidence) {
    const line = await deps.lines.getLine(item.projectId);
    if (line) await deps.lines.putLine(recordEvidence(line, now));
  }

  const followUps: WorkItem[] = [];
  if (input.ok && parsed) {
    const open = (await deps.items.listItems()).filter((i) => i.projectId === item.projectId && i.stage !== "done");
    for (const f of parsed.followUps) {
      if (open.some((o) => o.title.toLowerCase() === f.title.toLowerCase())) continue;
      const fu = makeWorkItem(
        {
          projectId: item.projectId,
          title: f.title,
          workType: oneOfOr(WORK_TYPES, f.workType, item.workType),
          size: oneOfOr(SIZES, f.size, "bite"),
          keyQuestion: item.keyQuestion,
          detail: `Proposed by the hand that worked “${item.title}”.`,
          sourceRefs: [{ kind: "work-item", path: item.id }],
        },
        { id: deps.items.newId(), now, actor: "hand" },
      );
      await deps.items.putItem(fu);
      followUps.push(fu);
    }
  }
  item = (await deps.items.getItem(item.id)) ?? item;
  return { item, followUps, evidence, parsed: parsed !== null };
}

/**
 * The chief of staff's journal reaches the surface as work: each attention
 * proposal becomes a Triage item on its line (Needs you is the one attention
 * primitive; Intake is not priority — the CoS is a triaging actor, so its
 * proposals start at Triage, never at Needs you). Deduped against open items.
 */
export async function promoteJournalToFloor(
  deps: FloorDeps,
  journal: Pick<StewardJournal, "journalDate" | "attention" | "drafts">,
  now: Date,
): Promise<{ created: WorkItem[]; unmatched: string[] }> {
  const lines = await deps.lines.listLines();
  const byKey = new Map<string, ProjectLine>();
  for (const l of lines) {
    byKey.set(l.id.toLowerCase(), l);
    byKey.set(l.name.toLowerCase(), l);
    if (l.legacyProjectId) byKey.set(l.legacyProjectId.toLowerCase(), l);
  }
  const items = await deps.items.listItems();
  const created: WorkItem[] = [];
  const unmatched: string[] = [];
  for (const p of journal.attention) {
    const line = byKey.get((p.project ?? "").toLowerCase());
    if (!line) {
      unmatched.push(p.project);
      continue;
    }
    const title = p.proposal.trim().slice(0, 200);
    const dupe = items.concat(created).some(
      (i) => i.projectId === line.id && i.stage !== "done" && i.title.toLowerCase() === title.toLowerCase(),
    );
    if (dupe) continue;
    const item = makeWorkItem(
      {
        projectId: line.id,
        title,
        detail: [p.whyNow && `Why now: ${p.whyNow}`, p.riskIfIgnored && `Risk if ignored: ${p.riskIfIgnored}`]
          .filter(Boolean)
          .join("\n"),
        workType:
          p.jobClassification === "J3_product"
            ? "build"
            : p.jobClassification === "meta"
              ? "hypothesis-design"
              : "market-contact",
        size: "bite",
        stage: "triage",
        keyQuestion: line.keyQuestion,
        worker: "cos",
        sourceRefs: [
          { kind: "steward-journal", path: journal.journalDate },
          ...p.sourceRefs.slice(0, 5).map((r) => ({ kind: "source", path: r })),
        ],
      },
      { id: deps.items.newId(), now, actor: "cos" },
    );
    await deps.items.putItem(item);
    created.push(item);
  }
  return { created, unmatched };
}
