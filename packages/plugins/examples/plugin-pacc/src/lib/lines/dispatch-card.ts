/**
 * Dispatch card — the outbound leg of context carry (ControlPlane CONTEXT.md).
 *
 * When the floor dispatches a work item to a hand, the hand receives this card
 * ahead of the task: the project's grounding, the key question the item moves,
 * the item with its history and last result, and the sessions that already
 * worked on it. The card closes with the return contract: a fenced `result`
 * block the runtime parses back onto the item (summary, links, evidence,
 * follow-ups into Triage). Pure and deterministic for identical inputs.
 */

import type { ProjectLine } from "./lines.js";
import type { WorkItem } from "../work-items/work-items.js";

export const RESULT_FENCE = "pacc-result";

function section(title: string, body: string | null | undefined): string[] {
  if (!body || !body.trim()) return [];
  return [`### ${title}`, body.trim(), ""];
}

export function renderDispatchCard(input: {
  line: ProjectLine | null;
  item: WorkItem;
  /** Other open items on the same line, for awareness (not to be worked). */
  openSiblings?: WorkItem[];
}): string {
  const { line, item } = input;
  const out: string[] = [];
  out.push(`## Work item: ${item.title}`);
  out.push("");
  out.push(
    `Project: **${line?.name ?? item.projectId}** · type: ${item.workType} · size: ${item.size}` +
      (item.size === "bite" ? " (≤25 min, finishable under interruption — keep it small)" : ""),
  );
  out.push("");
  if (item.detail) out.push(item.detail.trim(), "");

  const kq = item.keyQuestion ?? line?.keyQuestion ?? null;
  if (kq) out.push("### Key question this moves", kq, "");

  if (line) {
    out.push(...section("Intent", line.intent));
    out.push(...section("Current status", line.currentStatus));
    out.push(...section("Blockers", line.blockerSummary));
    out.push(...section("Kill criteria", line.killCriteria));
    out.push(...section("Do not rethink", line.doNotRethink));
    const refs = [
      ...(line.repoPath ? [`repo: ${line.repoPath}`] : []),
      ...(line.obsidianFolder ? [`vault folder: ${line.obsidianFolder} (read-only)`] : []),
      ...line.groundingRefs.map((r) => `${r.label ?? r.kind}: ${r.path}${r.anchor ? ` → ${r.anchor}` : ""}`),
    ];
    if (refs.length) out.push("### Grounding (read where it lives)", ...refs.map((r) => `- ${r}`), "");
  }

  const moves = item.history.slice(-6).map((h) => `- ${h.at.slice(0, 16)} ${h.from ?? "new"} → ${h.to} (${h.by})${h.note ? `: ${h.note}` : ""}`);
  if (moves.length) out.push("### Item history", ...moves, "");
  if (item.result) {
    out.push(
      "### Last result",
      `${item.result.ok ? "ok" : "failed"} — ${item.result.summary || "(no summary)"}`,
      ...item.result.links.map((l) => `- ${l}`),
      "",
    );
  }
  const sessions = item.sessions ?? [];
  if (sessions.length) {
    out.push(
      "### Earlier sessions on this item",
      ...sessions.slice(-5).map((s) => `- ${s.sessionId.slice(0, 8)} on ${s.machine ?? "?"}${s.title ? ` — ${s.title}` : ""}`),
      "",
    );
  }
  const siblings = (input.openSiblings ?? []).filter((s) => s.id !== item.id && s.stage !== "done").slice(0, 8);
  if (siblings.length) {
    out.push("### Other open items on this line (context only — do not work them)", ...siblings.map((s) => `- [${s.stage}] ${s.title}`), "");
  }

  out.push(
    "### Rules",
    "- Work only inside the project's repo/worktree. Never post, send, email or publish anything: put any outward text in the result as a draft for the principal to approve.",
    "- If the item is bigger than its size, do the first finishable slice and propose the rest as follow-ups.",
    "",
    "### Return contract",
    `End your final message with exactly one fenced block tagged \`${RESULT_FENCE}\` containing JSON:`,
    "```" + RESULT_FENCE,
    JSON.stringify(
      {
        summary: "one or two sentences: what changed and what the principal needs to know",
        links: ["commit sha / file path / URL you produced"],
        evidence: false,
        draft: null,
        followUps: [{ title: "next smallest step", workType: item.workType, size: "bite" }],
      },
      null,
      2,
    ),
    "```",
    "`evidence` is true only if the result changes what we know about the key question (a customer reply, a test outcome, a shipped artifact someone used) — not for drafts or refactors. `draft` is `{channel, text}` when you wrote something for the principal to publish.",
  );
  return out.join("\n");
}

export interface ParsedResult {
  summary: string;
  links: string[];
  evidence: boolean;
  draft: { channel: string; text: string } | null;
  followUps: Array<{ title: string; workType: string; size: string }>;
}

/** Pull the last `pacc-result` block out of a hand's final output (null when absent or malformed). */
export function parseResultBlock(output: string): ParsedResult | null {
  const re = new RegExp("```" + RESULT_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: string | null = null;
  for (const m of output.matchAll(re)) last = m[1] ?? null;
  if (last === null) return null;
  try {
    const j = JSON.parse(last) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const draftRaw = j.draft as Record<string, unknown> | null | undefined;
    return {
      summary: s(j.summary).slice(0, 4000),
      links: Array.isArray(j.links) ? j.links.map(s).filter(Boolean).slice(0, 50) : [],
      evidence: j.evidence === true,
      draft:
        draftRaw && typeof draftRaw === "object" && s(draftRaw.text)
          ? { channel: s(draftRaw.channel) || "unspecified", text: s(draftRaw.text) }
          : null,
      followUps: Array.isArray(j.followUps)
        ? (j.followUps as Array<Record<string, unknown>>)
            .filter((f) => f && s(f.title))
            .slice(0, 5)
            .map((f) => ({ title: s(f.title), workType: s(f.workType), size: s(f.size) }))
        : [],
    };
  } catch {
    return null;
  }
}
