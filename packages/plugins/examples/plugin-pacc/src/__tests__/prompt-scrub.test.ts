/**
 * Data policy (2026-10-07) — prompt scrubber + steward wiring.
 *
 * (a) secrets / personal identifiers in daily-note-derived text never reach
 *     the model prompt; Secrets/ notes never enter the pack;
 * (b) a pack full of real pacc ids and vault paths passes through unchanged,
 *     and the D-39 hallucination tripwire still grounds a model journal that
 *     echoes them (no flags, no self-pause).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isPromptDeniedPath, scrubForPrompt } from "../lib/prompt-scrub.js";
import {
  runSteward,
  scrubStewardPackForPrompt,
  type StewardDeps,
  type StewardFloorInput,
  type StewardRehydrationPack,
} from "../lib/steward/steward.js";
import { runScheduledSteward, type ScheduledStewardDeps } from "../lib/steward/scheduled-steward.js";
import type { HallucinationDeps } from "../lib/briefer/scheduled-brief.js";
import type { HallucinationCounterState } from "../lib/briefer/hallucination.js";
import type { BriefInProgressLock, OverlapGuardStore } from "../lib/briefer/overlap-guard.js";
import type { BrieferProjectInput, ValueAnchorSummary } from "../lib/briefer/types.js";
import { buildContextCard } from "../lib/context-card.js";
import { walkMarkdownFiles } from "../lib/vault-walk.js";

const NOW = new Date("2026-10-07T21:20:00.000Z");

// Real-shaped pacc identifiers.
const PROJECT_ID = "383e88f1-e81f-42e4-9acb-03fd3e3a6801";
const LINE_ID = "9b2f4c1e-7d3a-4e8b-a1c2-5f6e7d8c9b0a";
const ITEM_ID = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
const CARD_KEY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LONG_PATH = "20_Knowledge/TypeSafe-Jev-Intelligence-as-a-Software-Primitive-a16z-2026.md";
const SPACED_PATH = "10_Builds/Personal AI Control Plane/Value Anchors.md";
const DAILY_PATH = "00_Daily/2026-10-07.md";
const ANCHORS: ValueAnchorSummary[] = [{ name: "Ship Small", purpose: "small bets", resolved: true }];

// ---------------------------------------------------------------------------
// scrubForPrompt
// ---------------------------------------------------------------------------

describe("scrubForPrompt", () => {
  const cases: Array<[string, string, string]> = [
    ["openai key", "use sk-proj-AbCdEf0123456789xyzXYZ now", "secret"],
    ["github token", "ghp_0123456789abcdefABCDEF0123456789abcd", "secret"],
    ["github pat", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "secret"],
    ["google key", "AIzaSyA-0123456789abcdefghijklmnopqrstu", "secret"],
    ["jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig_part-123", "secret"],
    ["slack", "xoxb-1234567890-abcdefghij", "secret"],
    ["aws", "AKIAIOSFODNN7EXAMPLE", "secret"],
    ["board key", "pcp_board_0123456789abcdef0123456789abcdef", "secret"],
    ["tailscale", "tskey-auth-kAbCdEf1CNTRL-xyz", "secret"],
    ["pem", "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----", "secret"],
    ["key=value", "password = hunter2!", "secret"],
    ["api_key:", "api_key: abc", "secret"],
    ["long run", "x Zq8vN2mL5pR7tY1wK4hJ6gF3dS9aQ0eXcV", "secret"],
    ["email", "mail jane.citizen+pacc@example.com.au today", "email"],
    ["au mobile", "call 0412 345 678", "phone"],
    ["intl", "call +61 412 345 678", "phone"],
    ["landline", "(02) 9876 5432", "phone"],
    ["tfn", "my TFN is 123 456 789", "tfn"],
    ["bsb", "BSB 062-000", "account"],
    ["card", "card 4111 1111 1111 1111", "card"],
    ["address", "lives at 12 Smith Street", "address"],
  ];
  for (const [name, input, type] of cases) {
    it(`redacts ${name}`, () => {
      const out = scrubForPrompt(input);
      expect(out).toContain(`[REDACTED:${type}]`);
    });
  }

  it("leaves ordinary prose, dates, times and short numbers alone", () => {
    const text = "Shipped T-6.7 on 2026-10-07 at 08:20; 3 deep blocks, 2 bites, follow-up with circlo.";
    expect(scrubForPrompt(text)).toBe(text);
  });

  it("does not redact a non-Luhn 16-digit number as a card", () => {
    expect(scrubForPrompt("ref 1234 5678 9012 3456")).not.toContain("[REDACTED:card]");
  });

  it("exempts UUIDs, vault file references and keep-strings from the 32+ rule", () => {
    const text = `item ${ITEM_ID} grounded in ${LONG_PATH}; card ${CARD_KEY}`;
    expect(scrubForPrompt(text, { keep: [CARD_KEY] })).toBe(text);
    // without the keep entry the bare hash is treated as a secret-shaped run
    expect(scrubForPrompt(text)).toContain("[REDACTED:secret]");
  });

  it("an email on a .md domain is still redacted", () => {
    expect(scrubForPrompt("ping someone@long-domain-name.md")).toContain("[REDACTED:email]");
  });
});

describe("isPromptDeniedPath", () => {
  it("denies Secrets/, *.env and *.key", () => {
    for (const p of ["Secrets/env/README.md", "notes/secrets/x.md", "a/b/paperclip.env", ".env.local", "id_ed25519.key"]) {
      expect(isPromptDeniedPath(p)).toBe(true);
    }
    for (const p of [DAILY_PATH, SPACED_PATH, "10_Builds/env-setup.md", "keys/notes.md"]) {
      expect(isPromptDeniedPath(p)).toBe(false);
    }
  });
});

describe("walkMarkdownFiles skips Secrets/", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pacc-walk-"));
    await mkdir(path.join(root, "Secrets", "env"), { recursive: true });
    await mkdir(path.join(root, "00_Daily"), { recursive: true });
    await writeFile(path.join(root, "Secrets", "env", "README.md"), "token=abc");
    await writeFile(path.join(root, "00_Daily", "2026-10-07.md"), "day");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("lists the daily note but nothing under Secrets/", async () => {
    const files = (await walkMarkdownFiles(root)).map((f) => path.relative(root, f));
    expect(files).toEqual([DAILY_PATH]);
  });
});

// ---------------------------------------------------------------------------
// Steward wiring
// ---------------------------------------------------------------------------

function projectInput(notes: Array<{ path: string; summary: string | null }>): BrieferProjectInput {
  const card = buildContextCard(
    {
      project: {
        id: PROJECT_ID,
        name: "pacc",
        controlPlaneState: {
          portfolioState: "primary",
          currentPhase: "validate",
          constraintLane: "customer",
          nextSmallestAction: `Ship ${ITEM_ID} (see ${LONG_PATH})`,
          blockerSummary: null,
          latestEvidenceChanged: null,
          resumeBrief: null,
          doNotRethink: null,
          killCriteria: null,
          lastMeaningfulOutput: null,
          intent: "personal control plane",
        },
        controlPlaneUpdatedAt: null,
      },
      telemetry: null,
      freshness: null,
      decay: null,
      conflicts: null,
      recentDecisions: [],
      activeTasks: [],
      authority: [],
      associatedNotes: notes.map((n) => ({ ...n, modifiedAt: "2026-10-07T00:00:00.000Z" })),
    },
    NOW,
  );
  return { projectId: PROJECT_ID, projectName: "pacc", card };
}

function floor(occupiedBy: string | null): StewardFloorInput {
  return {
    capacity: { date: "2026-10-08", score: 3, deepBlocks: 2, bites: 3, occupiedBy, recorded: true },
    lines: [
      {
        id: LINE_ID,
        name: "pacc",
        keyQuestion: "does the CoS save an hour a day?",
        open: { intake: 1, triage: 2, inProgress: 1, needsYou: 1 },
        needsYouTitles: [`review ${ITEM_ID}`],
        doneLast7Days: 4,
      },
    ],
  };
}

interface Captured {
  prompts: string[];
}

function stewardDeps(
  captured: Captured,
  opts: {
    notes: Array<{ path: string; summary: string | null }>;
    occupiedBy: string | null;
    lastBrief: string | null;
    feedback: string | null;
    reply: (prompt: string) => string | null;
  },
): StewardDeps {
  return {
    async readFloor() {
      return floor(opts.occupiedBy);
    },
    async listActiveProjectCards() {
      return [projectInput(opts.notes)];
    },
    async listValueAnchors() {
      return ANCHORS;
    },
    async readOpenLedgers() {
      return { decisionsDue: [], expiringGrants: [] };
    },
    async readLastJournalDelta() {
      return { journalDate: "2026-10-06", projectCardKeys: { [PROJECT_ID]: CARD_KEY } };
    },
    async readLastBrief() {
      return opts.lastBrief === null ? null : { briefDate: "2026-10-07", markdown: opts.lastBrief };
    },
    async readBriefFeedback() {
      return opts.feedback;
    },
    async proposeM2() {},
    async saveJournal() {
      return { id: "j-1" };
    },
    async writeDraft(p) {
      return { path: p, kind: "wrote" };
    },
    async callModel({ prompt }) {
      captured.prompts.push(prompt);
      return { text: opts.reply(prompt), sessionId: null };
    },
  };
}

function packFromPrompt(prompt: string): StewardRehydrationPack {
  const at = prompt.indexOf("## Rehydration pack (today)");
  const m = prompt.slice(at).match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error("no pack in prompt");
  return JSON.parse(m[1]!) as StewardRehydrationPack;
}

const emptyJournal = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    whatChanged: [],
    attention: [],
    drafts: [],
    awaitingReturn: [],
    dissent: [],
    selfCheck: ["ok"],
    warnings: [],
    confidence: 0.6,
    ...extra,
  });

describe("(a) daily-note PII and secrets never reach the steward prompt", () => {
  const CANARIES = [
    "jane.citizen@example.com",
    "0412 345 678",
    "123 456 789",
    "062-000",
    "4111 1111 1111 1111",
    "12 Smith Street",
    "sk-proj-AbCdEf0123456789xyzXYZ",
    "pcp_board_0123456789abcdef0123456789abcdef",
    "hunter2",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "Zq8vN2mL5pR7tY1wK4hJ6gF3dS9aQ0eXcV",
  ];
  const dailySummary =
    "Call with jane.citizen@example.com (0412 345 678) about the lease at 12 Smith Street. " +
    "TFN 123 456 789, BSB 062-000, card 4111 1111 1111 1111. password: hunter2. " +
    "token sk-proj-AbCdEf0123456789xyzXYZ and pcp_board_0123456789abcdef0123456789abcdef " +
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY----- " +
    "blob Zq8vN2mL5pR7tY1wK4hJ6gF3dS9aQ0eXcV";

  it("scrubs summaries, the Occupied line, the last brief and feedback; drops Secrets/ notes", async () => {
    const captured: Captured = { prompts: [] };
    const journal = await runSteward(
      stewardDeps(captured, {
        notes: [
          { path: DAILY_PATH, summary: dailySummary },
          { path: "Secrets/env/README.md", summary: "SECRET-NOTE-CANARY" },
        ],
        occupiedBy: "school pickup, ring 0412 345 678",
        lastBrief: `## Source Notes\n- ${DAILY_PATH} — ${dailySummary}`,
        feedback: "email me at jane.citizen@example.com",
        reply: () => emptyJournal({ whatChanged: ["noted [REDACTED:email] follow-up"] }),
      }),
      { now: NOW, skipModel: false },
    );
    expect(captured.prompts).toHaveLength(1);
    const prompt = captured.prompts[0]!;
    for (const c of CANARIES) expect(prompt).not.toContain(c);
    expect(prompt).not.toContain("Secrets/");
    expect(prompt).not.toContain("SECRET-NOTE-CANARY");
    for (const t of ["email", "phone", "tfn", "account", "card", "address", "secret"]) {
      expect(prompt).toContain(`[REDACTED:${t}]`);
    }
    // structured ids/paths survive in the same prompt
    for (const s of [PROJECT_ID, LINE_ID, CARD_KEY, DAILY_PATH]) expect(prompt).toContain(s);
    expect(journal.modelGenerated).toBe(true);
  });
});

describe("(b) real pacc ids and paths pass through unchanged; the tripwire still passes", () => {
  const notes = [
    { path: LONG_PATH, summary: `Jev adoption test for ${ITEM_ID}; see ${SPACED_PATH} and ${DAILY_PATH}.` },
    { path: SPACED_PATH, summary: `Anchors for line ${LINE_ID}, card ${CARD_KEY}, project ${PROJECT_ID}.` },
    { path: DAILY_PATH, summary: "Capacity 3, two deep blocks; smb-assistant follow-up." },
  ];
  const lastBrief = `## Source Notes\n- ${LONG_PATH} — Jev\n- ${SPACED_PATH} — anchors\n\nItem ${ITEM_ID} on line ${LINE_ID}.`;

  it("scrubStewardPackForPrompt returns an identical pack", () => {
    const pack: StewardRehydrationPack = {
      journalDate: "2026-10-08",
      valueAnchors: ANCHORS,
      projects: [
        {
          projectId: PROJECT_ID,
          projectName: "pacc",
          portfolioState: "primary",
          currentPhase: "validate",
          staleStatus: null,
          nextAction: `Ship ${ITEM_ID}`,
          blockers: null,
          cardKey: CARD_KEY,
          sourceNotes: notes,
        },
      ],
      ledgers: { decisionsDue: [], expiringGrants: [] },
      yesterdaysJournal: { journalDate: "2026-10-07", projectCardKeys: { [PROJECT_ID]: CARD_KEY } },
      lastBrief: { briefDate: "2026-10-07", markdown: lastBrief },
      briefFeedback: `looks right for ${LINE_ID}`,
      floor: floor("3 deep blocks, the rest is admin"),
    };
    expect(scrubStewardPackForPrompt(pack)).toEqual(pack);
  });

  it("a model journal echoing the prompt's ids/paths raises no flags and does not self-pause", async () => {
    const captured: Captured = { prompts: [] };
    const steward = stewardDeps(captured, {
      notes,
      occupiedBy: "3 deep blocks, the rest is admin",
      lastBrief,
      feedback: `looks right for ${LINE_ID}`,
      reply: (prompt) => {
        // Echo exactly what the prompt carried, as a grounded model would.
        const pack = packFromPrompt(prompt);
        const p = pack.projects[0]!;
        const line = pack.floor!.lines[0]!;
        return emptyJournal({
          whatChanged: [`line ${line.id} moved; ${ITEM_ID} is in progress`],
          attention: [
            {
              project: p.projectName,
              proposal: `Close ${ITEM_ID} using ${p.sourceNotes[0]!.path}`,
              whyNow: `card ${p.projectId} changed`,
              jobClassification: "J3_product",
              requiredAuthority: "L1",
              sourceRefs: p.sourceNotes.map((n) => n.path),
              anchorCitations: [],
              confidence: 0.7,
              riskIfIgnored: "drift",
            },
          ],
        });
      },
    });

    let flags: HallucinationCounterState | null = null;
    let pausedWith: string | null = null;
    const hallucination: HallucinationDeps = {
      // as production builds it: project + line + item ids and names
      knownIds: new Set([PROJECT_ID, "pacc", LINE_ID, ITEM_ID]),
      groundingText: ["smb-assistant follow-up"],
      async readFlags() {
        return flags;
      },
      async writeFlags(s) {
        flags = s;
      },
      async isPaused() {
        return { paused: false, reason: null };
      },
      async setPaused(reason) {
        pausedWith = reason;
      },
    } as HallucinationDeps;

    let lockState: BriefInProgressLock | null = null;
    const lock: OverlapGuardStore = {
      async read() {
        return lockState;
      },
      async write(l) {
        lockState = l;
      },
      async clear() {
        lockState = null;
      },
    };
    const workdir = await mkdtemp(path.join(tmpdir(), "pacc-scrub-steward-"));
    try {
      const deps: ScheduledStewardDeps = {
        steward,
        lock,
        async emitEvent() {},
        logger: { info() {}, warn() {}, error() {} },
        hallucination,
      };
      const result = await runScheduledSteward(deps, {
        now: NOW,
        obsidianBaseDir: workdir,
        stewardOptions: { skipModel: false },
      });

      const prompt = captured.prompts[0]!;
      for (const s of [PROJECT_ID, LINE_ID, ITEM_ID, CARD_KEY, LONG_PATH, SPACED_PATH, DAILY_PATH]) {
        expect(prompt).toContain(s);
      }
      expect(prompt).not.toContain("[REDACTED:");
      expect(result, JSON.stringify(result)).toMatchObject({ kind: "completed" });
      if (result.kind !== "completed") return;
      expect(result.hallucinationFlagCount).toBe(0);
      expect(result.selfPaused).toBe(false);
      expect(pausedWith).toBeNull();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
