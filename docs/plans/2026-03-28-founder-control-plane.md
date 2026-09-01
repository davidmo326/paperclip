# Founder Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add canonical per-project founder-state and a portfolio control-plane to Paperclip so a solo founder can manage many projects, re-enter after breaks, and track what actually matters.

**Architecture:** Hybrid core + plugin. Core stores `control_plane_state jsonb` on projects, exposes typed PATCH/GET routes, and keeps canonical truth. A first-party plugin (`@paperclipai/founder-control-plane`) stores refreshable telemetry in `plugin_state`, renders the portfolio UI, and runs the scheduled refresh job.

**Tech Stack:** PostgreSQL (Drizzle ORM), Express, Zod validators, TypeScript, React (plugin UI), vitest

---

## File Map

**Created:**
- `packages/db/src/migrations/0046_founder_control_plane.sql`
- `packages/db/src/migrations/meta/0046_snapshot.json` *(minimal stub — not used by migrate runner)*
- `packages/shared/src/types/control-plane.ts`
- `packages/shared/src/validators/control-plane.ts`
- `server/src/services/control-plane.ts`
- `server/src/__tests__/control-plane-routes.test.ts`
- `packages/shared/src/__tests__/control-plane-validators.test.ts`
- `packages/plugins/examples/plugin-founder-control-plane/package.json`
- `packages/plugins/examples/plugin-founder-control-plane/tsconfig.json`
- `packages/plugins/examples/plugin-founder-control-plane/src/constants.ts`
- `packages/plugins/examples/plugin-founder-control-plane/src/manifest.ts`
- `packages/plugins/examples/plugin-founder-control-plane/src/worker.ts`
- `packages/plugins/examples/plugin-founder-control-plane/src/ui/index.tsx`

**Modified:**
- `packages/db/src/schema/projects.ts` — add `controlPlaneState`, `controlPlaneUpdatedAt`
- `packages/db/src/migrations/meta/_journal.json` — add entry for migration 0046
- `packages/shared/src/types/project.ts` — extend `Project` with control plane fields
- `packages/shared/src/types/index.ts` — export new types
- `packages/shared/src/validators/project.ts` — no direct change; control plane validators are in new file
- `packages/shared/src/validators/index.ts` — export control plane validators
- `server/src/services/projects.ts` — map `controlPlaneState`, `controlPlaneUpdatedAt` into project rows
- `server/src/services/index.ts` — export `controlPlaneService`
- `server/src/routes/projects.ts` — add 3 new routes

---

## Task 1: DB schema + migration

**Files:**
- Modify: `packages/db/src/schema/projects.ts`
- Create: `packages/db/src/migrations/0046_founder_control_plane.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add columns to Drizzle schema**

Edit `packages/db/src/schema/projects.ts`. Add after `archivedAt`:

```ts
controlPlaneState: jsonb("control_plane_state").$type<Record<string, unknown>>(),
controlPlaneUpdatedAt: timestamp("control_plane_updated_at", { withTimezone: true }),
```

Full file after edit:
```ts
import { pgTable, uuid, text, timestamp, date, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    controlPlaneState: jsonb("control_plane_state").$type<Record<string, unknown>>(),
    controlPlaneUpdatedAt: timestamp("control_plane_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 2: Create SQL migration file**

Create `packages/db/src/migrations/0046_founder_control_plane.sql`:

```sql
ALTER TABLE "projects" ADD COLUMN "control_plane_state" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "control_plane_updated_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "projects"
SET
  "control_plane_state" = jsonb_build_object(
    'portfolioState', CASE "status"
      WHEN 'in_progress' THEN 'active'
      WHEN 'planned'     THEN 'parked'
      WHEN 'backlog'     THEN 'parked'
      WHEN 'completed'   THEN 'closed'
      WHEN 'cancelled'   THEN 'closed'
      ELSE 'parked'
    END,
    'currentPhase',        'exploration',
    'constraintLane',      NULL,
    'nextSmallestAction',  NULL,
    'blockerSummary',      NULL,
    'latestEvidenceChanged', NULL,
    'resumeBrief',         NULL,
    'doNotRethink',        NULL,
    'killCriteria',        NULL,
    'lastMeaningfulOutput', NULL
  ),
  "control_plane_updated_at" = now()
WHERE "control_plane_state" IS NULL;
```

- [ ] **Step 3: Update _journal.json**

Add to the `entries` array in `packages/db/src/migrations/meta/_journal.json`:

```json
{
  "idx": 46,
  "version": "7",
  "when": 1774620000000,
  "tag": "0046_founder_control_plane",
  "breakpoints": true
}
```

- [ ] **Step 4: Verify schema compiles**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/db build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/projects.ts \
        packages/db/src/migrations/0046_founder_control_plane.sql \
        packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add control_plane_state and control_plane_updated_at to projects"
```

---

## Task 2: Shared control-plane types

**Files:**
- Create: `packages/shared/src/types/control-plane.ts`
- Modify: `packages/shared/src/types/project.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Create `packages/shared/src/types/control-plane.ts`**

```ts
export type ProjectPortfolioState =
  | "primary"
  | "active"
  | "blocked"
  | "paused"
  | "parked"
  | "closed";

export type ProjectPhase =
  | "exploration"
  | "validation"
  | "build"
  | "distribution";

export type ProjectConstraintLane = "product" | "customer" | "distribution";

export type ProjectStaleStatus = "fresh" | "aging" | "stale" | "critical";

export interface ProjectControlPlaneLastOutput {
  kind: "issue" | "work_product" | "document" | "external_link" | "note";
  id: string | null;
  title: string;
  url: string | null;
}

export interface ProjectControlPlaneState {
  portfolioState: ProjectPortfolioState;
  currentPhase: ProjectPhase;
  constraintLane: ProjectConstraintLane | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  latestEvidenceChanged: string | null;
  resumeBrief: string | null;
  doNotRethink: string | null;
  killCriteria: string | null;
  lastMeaningfulOutput: ProjectControlPlaneLastOutput | null;
}

export interface ProjectControlPlaneTelemetry {
  lastTouchedAt: string | null;
  lastActivityAt: string | null;
  issueCounts: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  laneIssueCounts: {
    product: { open: number; inProgress: number; blocked: number; done: number; total: number };
    customer: { open: number; inProgress: number; blocked: number; done: number; total: number };
    distribution: { open: number; inProgress: number; blocked: number; done: number; total: number };
  };
  latestArtifact: {
    id: string | null;
    title: string | null;
    url: string | null;
    updatedAt: string | null;
  } | null;
  repoSnapshot: {
    workspaceId: string | null;
    sourceType: string | null;
    status: "ok" | "warning" | "unavailable";
    branch: string | null;
    headShaShort: string | null;
    dirty: boolean | null;
    dirtySummary: string | null;
    lastCommitAt: string | null;
    aheadBy: number | null;
    behindBy: number | null;
  } | null;
  runHealth: {
    status: "ok" | "warning" | "error" | "idle";
    lastRunAt: string | null;
    lastRunOutcome: "success" | "failed" | "cancelled" | "unknown";
  };
  budgetHealth: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  staleStatus: ProjectStaleStatus;
  staleReason: string | null;
  attentionScore: number;
  refreshedAt: string;
}

export interface ProjectControlPlaneResponse {
  projectId: string;
  companyId: string;
  controlPlaneState: ProjectControlPlaneState | null;
  telemetry: ProjectControlPlaneTelemetry | null;
  warnings: string[];
}

export interface ProjectPortfolioSummary {
  projectId: string;
  name: string;
  color: string | null;
  controlPlaneState: ProjectControlPlaneState | null;
  controlPlaneUpdatedAt: string | null;
  staleStatus: ProjectStaleStatus;
  attentionScore: number;
  warnings: string[];
}

export interface PortfolioResponse {
  companyId: string;
  summary: {
    primaryCount: number;
    activeCount: number;
    staleCount: number;
    blockedCount: number;
  };
  warnings: string[];
  projects: ProjectPortfolioSummary[];
}
```

- [ ] **Step 2: Extend `Project` type in `packages/shared/src/types/project.ts`**

Add two fields at the bottom of the `Project` interface (before the closing `}`):

```ts
  controlPlaneState: ProjectControlPlaneState | null;
  controlPlaneUpdatedAt: Date | null;
```

Also add the import at the top of the file:

```ts
import type { ProjectControlPlaneState } from "./control-plane.js";
```

- [ ] **Step 3: Export from `packages/shared/src/types/index.ts`**

Add after the `Project` export line:

```ts
export type {
  ProjectPortfolioState,
  ProjectPhase,
  ProjectConstraintLane,
  ProjectStaleStatus,
  ProjectControlPlaneLastOutput,
  ProjectControlPlaneState,
  ProjectControlPlaneTelemetry,
  ProjectControlPlaneResponse,
  ProjectPortfolioSummary,
  PortfolioResponse,
} from "./control-plane.js";
```

- [ ] **Step 4: Verify types compile**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/shared build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/control-plane.ts \
        packages/shared/src/types/project.ts \
        packages/shared/src/types/index.ts
git commit -m "feat(shared): add control-plane types to project and index"
```

---

## Task 3: Shared validators

**Files:**
- Create: `packages/shared/src/validators/control-plane.ts`
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Create `packages/shared/src/validators/control-plane.ts`**

```ts
import { z } from "zod";

export const projectPortfolioStateSchema = z.enum([
  "primary",
  "active",
  "blocked",
  "paused",
  "parked",
  "closed",
]);

export const projectPhaseSchema = z.enum([
  "exploration",
  "validation",
  "build",
  "distribution",
]);

export const projectConstraintLaneSchema = z.enum([
  "product",
  "customer",
  "distribution",
]);

export const projectControlPlaneLastOutputSchema = z.object({
  kind: z.enum(["issue", "work_product", "document", "external_link", "note"]),
  id: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
});

export const projectControlPlaneStateSchema = z.object({
  portfolioState: projectPortfolioStateSchema,
  currentPhase: projectPhaseSchema,
  constraintLane: projectConstraintLaneSchema.nullable(),
  nextSmallestAction: z.string().nullable(),
  blockerSummary: z.string().nullable(),
  latestEvidenceChanged: z.string().nullable(),
  resumeBrief: z.string().nullable(),
  doNotRethink: z.string().nullable(),
  killCriteria: z.string().nullable(),
  lastMeaningfulOutput: projectControlPlaneLastOutputSchema.nullable(),
});

export type ProjectControlPlaneStateInput = z.infer<typeof projectControlPlaneStateSchema>;

/** Canonical fields only — telemetry keys are explicitly excluded. */
const CANONICAL_FIELDS = [
  "portfolioState",
  "currentPhase",
  "constraintLane",
  "nextSmallestAction",
  "blockerSummary",
  "latestEvidenceChanged",
  "resumeBrief",
  "doNotRethink",
  "killCriteria",
  "lastMeaningfulOutput",
] as const;

export const updateProjectControlPlaneSchema = projectControlPlaneStateSchema
  .pick(
    Object.fromEntries(CANONICAL_FIELDS.map((k) => [k, true])) as {
      [K in (typeof CANONICAL_FIELDS)[number]]: true;
    },
  )
  .partial();

export type UpdateProjectControlPlane = z.infer<typeof updateProjectControlPlaneSchema>;

export const projectPortfolioSummarySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
  controlPlaneState: projectControlPlaneStateSchema.nullable(),
  controlPlaneUpdatedAt: z.string().nullable(),
  staleStatus: z.enum(["fresh", "aging", "stale", "critical"]),
  attentionScore: z.number(),
  warnings: z.array(z.string()),
});
```

- [ ] **Step 2: Export from `packages/shared/src/validators/index.ts`**

Add after the project validator export block:

```ts
export {
  projectPortfolioStateSchema,
  projectPhaseSchema,
  projectConstraintLaneSchema,
  projectControlPlaneLastOutputSchema,
  projectControlPlaneStateSchema,
  updateProjectControlPlaneSchema,
  projectPortfolioSummarySchema,
  type ProjectControlPlaneStateInput,
  type UpdateProjectControlPlane,
} from "./control-plane.js";
```

- [ ] **Step 3: Verify validators compile**

```bash
pnpm --filter @paperclipai/shared build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/validators/control-plane.ts \
        packages/shared/src/validators/index.ts
git commit -m "feat(shared): add control-plane validators"
```

---

## Task 4: Validator unit tests

**Files:**
- Create: `packages/shared/src/__tests__/control-plane-validators.test.ts`

- [ ] **Step 1: Create test file**

Note: check if `packages/shared/src/__tests__/` exists; if not, create the dir first.

```ts
import { describe, it, expect } from "vitest";
import {
  projectControlPlaneStateSchema,
  updateProjectControlPlaneSchema,
} from "../validators/control-plane.js";

describe("projectControlPlaneStateSchema", () => {
  it("accepts a fully-populated state", () => {
    const result = projectControlPlaneStateSchema.parse({
      portfolioState: "primary",
      currentPhase: "exploration",
      constraintLane: "product",
      nextSmallestAction: "Ship landing page",
      blockerSummary: null,
      latestEvidenceChanged: "User interviewed 2026-03-28",
      resumeBrief: "Focus on conversion",
      doNotRethink: "The tech stack",
      killCriteria: "No paying user by April",
      lastMeaningfulOutput: {
        kind: "issue",
        id: "abc-123",
        title: "Landing page draft",
        url: null,
      },
    });
    expect(result.portfolioState).toBe("primary");
    expect(result.constraintLane).toBe("product");
  });

  it("accepts all-null optional fields", () => {
    const result = projectControlPlaneStateSchema.parse({
      portfolioState: "parked",
      currentPhase: "exploration",
      constraintLane: null,
      nextSmallestAction: null,
      blockerSummary: null,
      latestEvidenceChanged: null,
      resumeBrief: null,
      doNotRethink: null,
      killCriteria: null,
      lastMeaningfulOutput: null,
    });
    expect(result.portfolioState).toBe("parked");
  });

  it("rejects unknown portfolioState values", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({
        portfolioState: "zombie",
        currentPhase: "exploration",
        constraintLane: null,
        nextSmallestAction: null,
        blockerSummary: null,
        latestEvidenceChanged: null,
        resumeBrief: null,
        doNotRethink: null,
        killCriteria: null,
        lastMeaningfulOutput: null,
      }),
    ).toThrow();
  });

  it("rejects unknown currentPhase values", () => {
    expect(() =>
      projectControlPlaneStateSchema.parse({
        portfolioState: "active",
        currentPhase: "growth",
        constraintLane: null,
        nextSmallestAction: null,
        blockerSummary: null,
        latestEvidenceChanged: null,
        resumeBrief: null,
        doNotRethink: null,
        killCriteria: null,
        lastMeaningfulOutput: null,
      }),
    ).toThrow();
  });
});

describe("updateProjectControlPlaneSchema (patch)", () => {
  it("accepts partial updates", () => {
    const result = updateProjectControlPlaneSchema.parse({
      portfolioState: "blocked",
      blockerSummary: "Waiting for legal review",
    });
    expect(result.portfolioState).toBe("blocked");
    expect(result.nextSmallestAction).toBeUndefined();
  });

  it("accepts empty patch", () => {
    const result = updateProjectControlPlaneSchema.parse({});
    expect(result).toEqual({});
  });

  it("rejects unknown extra keys (telemetry injection attempt)", () => {
    // updateProjectControlPlaneSchema uses pick + partial so extra keys pass
    // through Zod's object without .strict() — but they should be stripped.
    // The route handler must not pass unknown keys to the service.
    const result = updateProjectControlPlaneSchema.parse({
      portfolioState: "active",
      attentionScore: 99, // derived telemetry — must be stripped
    } as any);
    expect((result as any).attentionScore).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/shared test --reporter=verbose 2>&1 | tail -30
```

Expected: all 6 assertions pass.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/__tests__/control-plane-validators.test.ts
git commit -m "test(shared): add control-plane validator unit tests"
```

---

## Task 5: Control plane service

**Files:**
- Create: `server/src/services/control-plane.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create `server/src/services/control-plane.ts`**

```ts
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueLabels, labels, projects } from "@paperclipai/db";
import type {
  ProjectControlPlaneState,
  ProjectPortfolioSummary,
  ProjectStaleStatus,
  PortfolioResponse,
  ProjectControlPlaneResponse,
} from "@paperclipai/shared";
import type { UpdateProjectControlPlane } from "@paperclipai/shared";

const STALE_THRESHOLDS_MS: Record<string, { aging: number; stale: number } | null> = {
  primary: { aging: 2 * 24 * 60 * 60 * 1000, stale: 4 * 24 * 60 * 60 * 1000 },
  active: { aging: 5 * 24 * 60 * 60 * 1000, stale: 10 * 24 * 60 * 60 * 1000 },
  blocked: { aging: 3 * 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
  paused: null,
  parked: null,
  closed: null,
};

function computeStaleStatus(
  portfolioState: string,
  updatedAt: Date | null,
): ProjectStaleStatus {
  const thresholds = STALE_THRESHOLDS_MS[portfolioState] ?? null;
  if (!thresholds || !updatedAt) return "fresh";
  const ageMs = Date.now() - updatedAt.getTime();
  if (ageMs >= thresholds.stale) return "stale";
  if (ageMs >= thresholds.aging) return "aging";
  return "fresh";
}

function computeAttentionScore(
  state: ProjectControlPlaneState | null,
  staleStatus: ProjectStaleStatus,
): number {
  if (!state) return 0;
  let score = 0;
  const ps = state.portfolioState;

  if (staleStatus === "stale" && ps === "primary") score += 40;
  if ((ps === "active" || ps === "primary") && !state.nextSmallestAction) score += 30;
  if (ps === "blocked" && !state.blockerSummary) score += 25;
  if (!state.lastMeaningfulOutput) score += 10;

  return score;
}

function computeWarnings(state: ProjectControlPlaneState | null): string[] {
  if (!state) return ["No control-plane state set"];
  const warnings: string[] = [];
  if ((state.portfolioState === "active" || state.portfolioState === "primary") && !state.nextSmallestAction) {
    warnings.push("No next smallest action set");
  }
  if (state.portfolioState === "blocked" && !state.blockerSummary) {
    warnings.push("Project is blocked but no blocker summary is set");
  }
  if (!state.lastMeaningfulOutput) {
    warnings.push("No last meaningful output recorded");
  }
  return warnings;
}

function parseControlPlaneState(raw: Record<string, unknown> | null): ProjectControlPlaneState | null {
  if (!raw) return null;
  return raw as unknown as ProjectControlPlaneState;
}

export function controlPlaneService(db: Db) {
  return {
    /**
     * Returns canonical founder-state for one project.
     * Telemetry is expected to be fetched from plugin_state by the caller (plugin).
     * This endpoint returns null telemetry — the plugin enriches.
     */
    getControlPlane: async (projectId: string): Promise<ProjectControlPlaneResponse | null> => {
      const row = await db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          controlPlaneState: projects.controlPlaneState,
          controlPlaneUpdatedAt: projects.controlPlaneUpdatedAt,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);

      if (!row) return null;

      const state = parseControlPlaneState(row.controlPlaneState ?? null);
      const warnings = computeWarnings(state);

      return {
        projectId: row.id,
        companyId: row.companyId,
        controlPlaneState: state,
        telemetry: null, // filled by plugin layer
        warnings,
      };
    },

    /**
     * Patch canonical founder-state fields on a project.
     * Never writes derived telemetry fields (those live in plugin_state).
     */
    updateControlPlane: async (
      projectId: string,
      patch: UpdateProjectControlPlane,
    ): Promise<ProjectControlPlaneResponse | null> => {
      const existing = await db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          controlPlaneState: projects.controlPlaneState,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      const currentState = parseControlPlaneState(existing.controlPlaneState ?? null) ?? {
        portfolioState: "parked" as const,
        currentPhase: "exploration" as const,
        constraintLane: null,
        nextSmallestAction: null,
        blockerSummary: null,
        latestEvidenceChanged: null,
        resumeBrief: null,
        doNotRethink: null,
        killCriteria: null,
        lastMeaningfulOutput: null,
      };

      const nextState: ProjectControlPlaneState = { ...currentState, ...patch };

      const now = new Date();
      await db
        .update(projects)
        .set({
          controlPlaneState: nextState as unknown as Record<string, unknown>,
          controlPlaneUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, projectId));

      const warnings = computeWarnings(nextState);

      return {
        projectId: existing.id,
        companyId: existing.companyId,
        controlPlaneState: nextState,
        telemetry: null,
        warnings,
      };
    },

    /**
     * Returns portfolio view for all non-closed projects in a company.
     * Sorted by attentionScore desc, then controlPlaneUpdatedAt desc.
     */
    getPortfolio: async (companyId: string): Promise<PortfolioResponse> => {
      const rows = await db
        .select({
          id: projects.id,
          name: projects.name,
          color: projects.color,
          controlPlaneState: projects.controlPlaneState,
          controlPlaneUpdatedAt: projects.controlPlaneUpdatedAt,
        })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, companyId),
          ),
        );

      const summaries: ProjectPortfolioSummary[] = rows
        .filter((row) => {
          const state = parseControlPlaneState(row.controlPlaneState ?? null);
          return state?.portfolioState !== "closed";
        })
        .map((row) => {
          const state = parseControlPlaneState(row.controlPlaneState ?? null);
          const staleStatus = computeStaleStatus(
            state?.portfolioState ?? "parked",
            row.controlPlaneUpdatedAt,
          );
          const attentionScore = computeAttentionScore(state, staleStatus);
          const warnings = computeWarnings(state);
          return {
            projectId: row.id,
            name: row.name,
            color: row.color ?? null,
            controlPlaneState: state,
            controlPlaneUpdatedAt: row.controlPlaneUpdatedAt?.toISOString() ?? null,
            staleStatus,
            attentionScore,
            warnings,
          };
        })
        .sort((a, b) => {
          if (b.attentionScore !== a.attentionScore) return b.attentionScore - a.attentionScore;
          const aTs = a.controlPlaneUpdatedAt ? new Date(a.controlPlaneUpdatedAt).getTime() : 0;
          const bTs = b.controlPlaneUpdatedAt ? new Date(b.controlPlaneUpdatedAt).getTime() : 0;
          return bTs - aTs;
        });

      const primaryCount = summaries.filter((s) => s.controlPlaneState?.portfolioState === "primary").length;
      const activeCount = summaries.filter((s) => s.controlPlaneState?.portfolioState === "active").length;
      const staleCount = summaries.filter((s) => s.staleStatus === "stale" || s.staleStatus === "aging").length;
      const blockedCount = summaries.filter((s) => s.controlPlaneState?.portfolioState === "blocked").length;

      const portfolioWarnings: string[] = [];
      if (primaryCount > 1) portfolioWarnings.push(`${primaryCount} projects marked as primary — only one is recommended`);

      return {
        companyId,
        summary: { primaryCount, activeCount, staleCount, blockedCount },
        warnings: portfolioWarnings,
        projects: summaries,
      };
    },
  };
}
```

- [ ] **Step 2: Export from `server/src/services/index.ts`**

Add the line:

```ts
export { controlPlaneService } from "./control-plane.js";
```

- [ ] **Step 3: Verify service compiles**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/server build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/control-plane.ts server/src/services/index.ts
git commit -m "feat(server): add control plane service with stale detection and attention scoring"
```

---

## Task 6: Extend project payload

**Files:**
- Modify: `server/src/services/projects.ts`

The goal is to make every project row returned from `projectService` include `controlPlaneState` and `controlPlaneUpdatedAt`.

- [ ] **Step 1: Update `ProjectWithGoals` interface**

In `server/src/services/projects.ts`, find the `ProjectWithGoals` interface (around line 41) and add two fields:

```ts
interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  controlPlaneState: import("@paperclipai/shared").ProjectControlPlaneState | null;
  controlPlaneUpdatedAt: Date | null;
}
```

- [ ] **Step 2: Update `attachGoals` to map the new fields**

In the `attachGoals` function (around line 87), the `rows.map` return block needs to pass through `controlPlaneState` and `controlPlaneUpdatedAt`. Since `ProjectRow` now includes these columns (from the schema update), they are already in `r`. But they need to be explicitly typed.

Modify the map to add:

```ts
controlPlaneState: (r.controlPlaneState as import("@paperclipai/shared").ProjectControlPlaneState | null) ?? null,
controlPlaneUpdatedAt: r.controlPlaneUpdatedAt ?? null,
```

Full updated return in the `attachGoals` map:

```ts
return rows.map((r) => {
  const g = map.get(r.id) ?? [];
  return {
    ...r,
    urlKey: deriveProjectUrlKey(r.name, r.id),
    goalIds: g.map((x) => x.id),
    goals: g,
    executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
    controlPlaneState: (r.controlPlaneState as import("@paperclipai/shared").ProjectControlPlaneState | null) ?? null,
    controlPlaneUpdatedAt: r.controlPlaneUpdatedAt ?? null,
  } as ProjectWithGoals;
});
```

- [ ] **Step 3: Verify server compiles**

```bash
pnpm --filter @paperclipai/server build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/projects.ts
git commit -m "feat(server): extend Project payload with controlPlaneState and controlPlaneUpdatedAt"
```

---

## Task 7: Core routes

**Files:**
- Modify: `server/src/routes/projects.ts`

- [ ] **Step 1: Import new schema and service**

At the top of `server/src/routes/projects.ts`, add to existing imports:

```ts
import { updateProjectControlPlaneSchema } from "@paperclipai/shared";
import { controlPlaneService } from "../services/index.js";
```

- [ ] **Step 2: Add control-plane routes**

After the existing `router.patch("/projects/:id/workspaces/:workspaceId", ...)` block and before `return router`, add:

```ts
  // ── Control-plane routes ──────────────────────────────────────────────

  router.get("/projects/:id/control-plane", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const cpSvc = controlPlaneService(db);
    const result = await cpSvc.getControlPlane(id);
    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(result);
  });

  router.patch(
    "/projects/:id/control-plane",
    validate(updateProjectControlPlaneSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const cpSvc = controlPlaneService(db);
      const result = await cpSvc.updateControlPlane(id, req.body);
      if (!result) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.control_plane_updated",
        entityType: "project",
        entityId: id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });

      res.json(result);
    },
  );

  router.get("/companies/:companyId/control-plane/portfolio", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const cpSvc = controlPlaneService(db);
    const result = await cpSvc.getPortfolio(companyId);
    res.json(result);
  });
```

- [ ] **Step 3: Verify routes compile**

```bash
pnpm --filter @paperclipai/server build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/projects.ts
git commit -m "feat(server): add GET/PATCH /projects/:id/control-plane and GET portfolio route"
```

---

## Task 8: Route tests

**Files:**
- Create: `server/src/__tests__/control-plane-routes.test.ts`

- [ ] **Step 1: Create test file**

```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";

// ── mock project service ──────────────────────────────────────────────────

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  resolveByReference: vi.fn(),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => mockProjectService,
}));

// ── mock control plane service ────────────────────────────────────────────

const mockCpService = vi.hoisted(() => ({
  getControlPlane: vi.fn(),
  updateControlPlane: vi.fn(),
  getPortfolio: vi.fn(),
}));

vi.mock("../services/control-plane.js", () => ({
  controlPlaneService: () => mockCpService,
}));

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  controlPlaneService: () => mockCpService,
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// ── helpers ───────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const SAMPLE_PROJECT = {
  id: "proj-1",
  companyId: "company-1",
  name: "Test Project",
  status: "in_progress",
  controlPlaneState: null,
  controlPlaneUpdatedAt: null,
};

const SAMPLE_CP_STATE = {
  portfolioState: "primary",
  currentPhase: "exploration",
  constraintLane: "product",
  nextSmallestAction: "Ship MVP",
  blockerSummary: null,
  latestEvidenceChanged: null,
  resumeBrief: null,
  doNotRethink: null,
  killCriteria: null,
  lastMeaningfulOutput: null,
};

// ── tests ─────────────────────────────────────────────────────────────────

describe("GET /api/projects/:id/control-plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(SAMPLE_PROJECT);
  });

  it("returns 200 with control plane state", async () => {
    mockCpService.getControlPlane.mockResolvedValue({
      projectId: "proj-1",
      companyId: "company-1",
      controlPlaneState: SAMPLE_CP_STATE,
      telemetry: null,
      warnings: [],
    });

    const app = createApp();
    const res = await request(app).get("/api/projects/proj-1/control-plane");
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe("proj-1");
    expect(res.body.controlPlaneState.portfolioState).toBe("primary");
  });

  it("returns 404 when project does not exist", async () => {
    mockProjectService.getById.mockResolvedValue(null);
    const app = createApp();
    const res = await request(app).get("/api/projects/missing/control-plane");
    expect(res.status).toBe(404);
  });

  it("returns 403 when actor has no access to company", async () => {
    mockProjectService.getById.mockResolvedValue({
      ...SAMPLE_PROJECT,
      companyId: "other-company",
    });
    const app = createApp();
    const res = await request(app).get("/api/projects/proj-1/control-plane");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/projects/:id/control-plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(SAMPLE_PROJECT);
  });

  it("returns 200 and updated state", async () => {
    mockCpService.updateControlPlane.mockResolvedValue({
      projectId: "proj-1",
      companyId: "company-1",
      controlPlaneState: SAMPLE_CP_STATE,
      telemetry: null,
      warnings: [],
    });

    const app = createApp();
    const res = await request(app)
      .patch("/api/projects/proj-1/control-plane")
      .send({ portfolioState: "primary" });

    expect(res.status).toBe(200);
    expect(res.body.controlPlaneState.portfolioState).toBe("primary");
  });

  it("returns 422 when portfolioState is invalid", async () => {
    const app = createApp();
    const res = await request(app)
      .patch("/api/projects/proj-1/control-plane")
      .send({ portfolioState: "zombie" });

    expect(res.status).toBe(422);
  });

  it("strips telemetry fields from the patch (derived fields cannot be written)", async () => {
    mockCpService.updateControlPlane.mockResolvedValue({
      projectId: "proj-1",
      companyId: "company-1",
      controlPlaneState: SAMPLE_CP_STATE,
      telemetry: null,
      warnings: [],
    });

    const app = createApp();
    await request(app)
      .patch("/api/projects/proj-1/control-plane")
      .send({ portfolioState: "active", attentionScore: 999 });

    // The service should have been called without attentionScore
    expect(mockCpService.updateControlPlane).toHaveBeenCalledWith(
      "proj-1",
      expect.not.objectContaining({ attentionScore: expect.anything() }),
    );
  });
});

describe("GET /api/companies/:companyId/control-plane/portfolio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with portfolio summary", async () => {
    mockCpService.getPortfolio.mockResolvedValue({
      companyId: "company-1",
      summary: { primaryCount: 1, activeCount: 2, staleCount: 0, blockedCount: 0 },
      warnings: [],
      projects: [],
    });

    const app = createApp();
    const res = await request(app).get("/api/companies/company-1/control-plane/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(res.body.summary.primaryCount).toBe(1);
  });

  it("returns 403 for unauthorized company", async () => {
    const app = createApp();
    const res = await request(app).get("/api/companies/other-company/control-plane/portfolio");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/server test -- control-plane-routes --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/control-plane-routes.test.ts
git commit -m "test(server): add control-plane route tests"
```

---

## Task 9: Plugin package scaffolding

**Files:**
- Create: `packages/plugins/examples/plugin-founder-control-plane/package.json`
- Create: `packages/plugins/examples/plugin-founder-control-plane/tsconfig.json`
- Create: `packages/plugins/examples/plugin-founder-control-plane/src/constants.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@paperclipai/founder-control-plane",
  "version": "0.1.0",
  "description": "Founder control plane — portfolio view, re-entry briefs, and project telemetry for solo operators",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "prebuild": "node ../../../../scripts/ensure-plugin-build-deps.mjs",
    "build": "tsc && node ./scripts/build-ui.mjs",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk build && tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@paperclipai/shared": "workspace:*"
  },
  "devDependencies": {
    "esbuild": "^0.27.3",
    "@types/node": "^24.6.0",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.7.3"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Copy from the kitchen-sink example:

```bash
cp /home/ubuntu/llm_shared/paperclip/packages/plugins/examples/plugin-kitchen-sink-example/tsconfig.json \
   /home/ubuntu/llm_shared/paperclip/packages/plugins/examples/plugin-founder-control-plane/tsconfig.json
```

- [ ] **Step 3: Create `src/constants.ts`**

```ts
export const PLUGIN_ID = "paperclip-founder-control-plane";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "control-plane";
export const PLUGIN_NAMESPACE = "founder-control-plane";
export const TELEMETRY_STATE_KEY = "telemetry.v1";
export const RESUME_DRAFT_STATE_KEY = "resume-brief-draft.v1";

export const LANE_LABELS = ["lane:product", "lane:customer", "lane:distribution"] as const;
export const NEXT_ACTION_LABEL = "next-action" as const;

export const SLOT_IDS = {
  page: "fcp-portfolio-page",
  dashboardWidget: "fcp-dashboard-widget",
  projectSidebarItem: "fcp-project-sidebar-item",
  projectTab: "fcp-project-tab",
  toolbarButton: "fcp-toolbar-button",
  contextMenuItem: "fcp-context-menu-item",
} as const;

export const EXPORT_NAMES = {
  page: "FounderPortfolioPage",
  dashboardWidget: "FounderDashboardWidget",
  projectSidebarItem: "FounderProjectSidebarItem",
  projectTab: "FounderProjectTab",
  toolbarButton: "FounderToolbarButton",
  contextMenuItem: "FounderContextMenuItem",
} as const;

export const JOB_KEYS = {
  refreshTelemetry: "refresh-telemetry",
} as const;
```

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/examples/plugin-founder-control-plane/
git commit -m "feat(plugin): scaffold founder-control-plane plugin package"
```

---

## Task 10: Plugin manifest

**Files:**
- Create: `packages/plugins/examples/plugin-founder-control-plane/src/manifest.ts`
- Create: `packages/plugins/examples/plugin-founder-control-plane/src/index.ts` *(re-export stub)*

- [ ] **Step 1: Create `src/manifest.ts`**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { EXPORT_NAMES, JOB_KEYS, PAGE_ROUTE, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Founder Control Plane",
  description:
    "Portfolio view, re-entry resume briefs, and project telemetry for solo operators managing multiple exploration-stage projects.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "project.workspaces.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  jobs: [
    {
      jobKey: JOB_KEYS.refreshTelemetry,
      displayName: "Refresh Project Telemetry",
      description: "Refreshes issue counts, stale status, and attention scores for all non-closed projects.",
      schedule: "0 */4 * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Control Plane",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Control Plane",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "projectSidebarItem",
        id: SLOT_IDS.projectSidebarItem,
        displayName: "Control Plane",
        exportName: EXPORT_NAMES.projectSidebarItem,
        entityTypes: ["project"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.projectTab,
        displayName: "Control Plane",
        exportName: EXPORT_NAMES.projectTab,
        entityTypes: ["project"],
      },
      {
        type: "toolbarButton",
        id: SLOT_IDS.toolbarButton,
        displayName: "Control Plane Actions",
        exportName: EXPORT_NAMES.toolbarButton,
        entityTypes: ["project"],
      },
      {
        type: "contextMenuItem",
        id: SLOT_IDS.contextMenuItem,
        displayName: "Control Plane",
        exportName: EXPORT_NAMES.contextMenuItem,
        entityTypes: ["project"],
      },
    ],
  },
};

export default manifest;
```

- [ ] **Step 2: Create `src/index.ts`**

```ts
export { default as manifest } from "./manifest.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/examples/plugin-founder-control-plane/src/
git commit -m "feat(plugin): add founder-control-plane manifest"
```

---

## Task 11: Plugin worker

**Files:**
- Create: `packages/plugins/examples/plugin-founder-control-plane/src/worker.ts`

- [ ] **Step 1: Create `src/worker.ts`**

```ts
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginJobContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import {
  PLUGIN_ID,
  PLUGIN_NAMESPACE,
  TELEMETRY_STATE_KEY,
  RESUME_DRAFT_STATE_KEY,
  LANE_LABELS,
  NEXT_ACTION_LABEL,
  JOB_KEYS,
} from "./constants.js";

// ── types ─────────────────────────────────────────────────────────────────

type IssueCountsBucket = {
  open: number;
  inProgress: number;
  blocked: number;
  done: number;
  total: number;
};

type TelemetrySnapshot = {
  lastTouchedAt: string | null;
  lastActivityAt: string | null;
  issueCounts: IssueCountsBucket;
  laneIssueCounts: {
    product: IssueCountsBucket;
    customer: IssueCountsBucket;
    distribution: IssueCountsBucket;
  };
  latestArtifact: { id: string | null; title: string | null; url: string | null; updatedAt: string | null } | null;
  repoSnapshot: null;
  runHealth: { status: "idle"; lastRunAt: null; lastRunOutcome: "unknown" };
  budgetHealth: { activeIncidents: number; pendingApprovals: number; pausedAgents: number; pausedProjects: number };
  staleStatus: "fresh" | "aging" | "stale" | "critical";
  staleReason: string | null;
  attentionScore: number;
  refreshedAt: string;
};

// ── stale detection ───────────────────────────────────────────────────────

const STALE_THRESHOLDS_MS: Record<string, { aging: number; stale: number } | null> = {
  primary: { aging: 2 * 24 * 60 * 60 * 1000, stale: 4 * 24 * 60 * 60 * 1000 },
  active:  { aging: 5 * 24 * 60 * 60 * 1000, stale: 10 * 24 * 60 * 60 * 1000 },
  blocked: { aging: 3 * 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
  paused: null,
  parked: null,
  closed: null,
};

function computeStaleStatus(
  portfolioState: string | undefined,
  lastTouchedAt: string | null,
): { staleStatus: "fresh" | "aging" | "stale" | "critical"; staleReason: string | null } {
  const thresholds = STALE_THRESHOLDS_MS[portfolioState ?? ""] ?? null;
  if (!thresholds) return { staleStatus: "fresh", staleReason: null };
  if (!lastTouchedAt) return { staleStatus: "aging", staleReason: "Never touched" };
  const ageMs = Date.now() - new Date(lastTouchedAt).getTime();
  if (ageMs >= thresholds.stale) return { staleStatus: "stale", staleReason: `Not touched for ${Math.floor(ageMs / 86400000)} days` };
  if (ageMs >= thresholds.aging) return { staleStatus: "aging", staleReason: `Not touched for ${Math.floor(ageMs / 86400000)} days` };
  return { staleStatus: "fresh", staleReason: null };
}

function computeAttentionScore(
  portfolioState: string | undefined,
  staleStatus: string,
  nextSmallestAction: string | null | undefined,
  blockerSummary: string | null | undefined,
  lastMeaningfulOutput: unknown,
  hasFailedRun: boolean,
  hasIncident: boolean,
  multipleNextActions: boolean,
): number {
  let score = 0;
  if (staleStatus === "stale" && portfolioState === "primary") score += 40;
  if ((portfolioState === "active" || portfolioState === "primary") && !nextSmallestAction) score += 30;
  if (portfolioState === "blocked" && !blockerSummary) score += 25;
  if (hasFailedRun) score += 20;
  if (hasIncident) score += 15;
  if (!lastMeaningfulOutput) score += 10;
  if (multipleNextActions) score += 10;
  return score;
}

// ── label bootstrap ───────────────────────────────────────────────────────

async function bootstrapLaneLabels(ctx: PluginContext): Promise<void> {
  const companies = await ctx.api.companies.list();
  for (const company of companies) {
    const existingLabels = await ctx.api.issues.listLabels(company.id);
    const existingNames = new Set(existingLabels.map((l) => l.name));

    for (const labelName of [...LANE_LABELS, NEXT_ACTION_LABEL]) {
      if (!existingNames.has(labelName)) {
        await ctx.api.issues.createLabel(company.id, {
          name: labelName,
          color: labelColorForName(labelName),
        });
      }
    }
  }
}

function labelColorForName(name: string): string {
  const colors: Record<string, string> = {
    "lane:product": "#6366f1",
    "lane:customer": "#10b981",
    "lane:distribution": "#f59e0b",
    "next-action": "#ef4444",
  };
  return colors[name] ?? "#94a3b8";
}

// ── telemetry refresh ─────────────────────────────────────────────────────

async function refreshProjectTelemetry(ctx: PluginContext, projectId: string): Promise<void> {
  const project = await ctx.api.projects.getById(projectId);
  if (!project) return;

  const cpState = (project as any).controlPlaneState as Record<string, unknown> | null;
  const portfolioState = cpState?.portfolioState as string | undefined;

  // Skip closed projects
  if (portfolioState === "closed") return;

  const allIssues = await ctx.api.issues.list(project.companyId, { projectId });

  function emptyBucket(): IssueCountsBucket {
    return { open: 0, inProgress: 0, blocked: 0, done: 0, total: 0 };
  }

  const issueCounts = emptyBucket();
  const laneIssueCounts = {
    product: emptyBucket(),
    customer: emptyBucket(),
    distribution: emptyBucket(),
  };

  let multipleNextActions = false;
  let nextActionCount = 0;

  for (const issue of allIssues) {
    const labels = (issue.labels ?? []) as Array<{ name: string }>;
    const laneLabel = labels.find((l) => LANE_LABELS.includes(l.name as any));
    const hasNextAction = labels.some((l) => l.name === NEXT_ACTION_LABEL);
    if (hasNextAction) nextActionCount++;

    const statusBucket = issue.status === "open" ? "open"
      : issue.status === "in_progress" ? "inProgress"
      : issue.status === "blocked" ? "blocked"
      : "done";

    issueCounts[statusBucket]++;
    issueCounts.total++;

    if (laneLabel) {
      const lane = laneLabel.name.replace("lane:", "") as "product" | "customer" | "distribution";
      laneIssueCounts[lane][statusBucket]++;
      laneIssueCounts[lane].total++;
    }
  }

  multipleNextActions = nextActionCount > 1;

  const lastTouchedAt = (project as any).controlPlaneUpdatedAt as string | null ?? null;
  const { staleStatus, staleReason } = computeStaleStatus(portfolioState, lastTouchedAt);

  const attentionScore = computeAttentionScore(
    portfolioState,
    staleStatus,
    cpState?.nextSmallestAction as string | null,
    cpState?.blockerSummary as string | null,
    cpState?.lastMeaningfulOutput,
    false, // hasFailedRun — extended in future when run events wired up
    false, // hasIncident
    multipleNextActions,
  );

  const telemetry: TelemetrySnapshot = {
    lastTouchedAt,
    lastActivityAt: null,
    issueCounts,
    laneIssueCounts,
    latestArtifact: null,
    repoSnapshot: null,
    runHealth: { status: "idle", lastRunAt: null, lastRunOutcome: "unknown" },
    budgetHealth: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    staleStatus,
    staleReason,
    attentionScore,
    refreshedAt: new Date().toISOString(),
  };

  await ctx.state.set({
    scopeKind: "project",
    scopeId: projectId,
    namespace: PLUGIN_NAMESPACE,
    stateKey: TELEMETRY_STATE_KEY,
  }, telemetry);
}

// ── resume draft generation ───────────────────────────────────────────────

async function generateResumeDraft(ctx: PluginContext, projectId: string): Promise<void> {
  const project = await ctx.api.projects.getById(projectId);
  if (!project) return;

  const cpState = (project as any).controlPlaneState as Record<string, unknown> | null;
  if (!cpState) return;

  const lines: string[] = [];
  lines.push(`## Resume Brief — ${project.name}`);
  lines.push(`**Phase:** ${cpState.currentPhase ?? "unknown"}`);
  lines.push(`**Portfolio state:** ${cpState.portfolioState ?? "unknown"}`);
  if (cpState.constraintLane) lines.push(`**Constraint lane:** ${cpState.constraintLane}`);
  if (cpState.nextSmallestAction) lines.push(`**Next action:** ${cpState.nextSmallestAction}`);
  if (cpState.blockerSummary) lines.push(`**Blocker:** ${cpState.blockerSummary}`);
  if (cpState.latestEvidenceChanged) lines.push(`**Latest evidence:** ${cpState.latestEvidenceChanged}`);
  if (cpState.doNotRethink) lines.push(`**Do not re-think:** ${cpState.doNotRethink}`);
  if (cpState.killCriteria) lines.push(`**Kill criteria:** ${cpState.killCriteria}`);

  const draft = {
    draft: lines.join("\n"),
    sources: [{ kind: "control_plane_state", id: projectId, title: project.name }],
    generatedAt: new Date().toISOString(),
  };

  await ctx.state.set({
    scopeKind: "project",
    scopeId: projectId,
    namespace: PLUGIN_NAMESPACE,
    stateKey: RESUME_DRAFT_STATE_KEY,
  }, draft);
}

// ── plugin definition ─────────────────────────────────────────────────────

const plugin: PaperclipPlugin = definePlugin({
  id: PLUGIN_ID,

  async onActivate(ctx) {
    await bootstrapLaneLabels(ctx);
  },

  async onEvent(ctx, event: PluginEvent) {
    const projectId = (event.payload as any)?.projectId ?? (event.payload as any)?.id ?? null;

    switch (event.type) {
      case "project.created":
      case "project.updated":
        if (typeof projectId === "string") {
          await refreshProjectTelemetry(ctx, projectId);
          await generateResumeDraft(ctx, projectId);
        }
        break;

      case "issue.created":
      case "issue.updated":
        if (typeof projectId === "string") {
          await refreshProjectTelemetry(ctx, projectId);
        }
        break;

      case "agent.run.finished":
      case "agent.run.failed":
        if (typeof projectId === "string") {
          await refreshProjectTelemetry(ctx, projectId);
        }
        break;
    }
  },

  async onJob(ctx, jobCtx: PluginJobContext) {
    if (jobCtx.jobKey !== JOB_KEYS.refreshTelemetry) return;

    const companies = await ctx.api.companies.list();
    for (const company of companies) {
      const projects = await ctx.api.projects.list(company.id);
      for (const project of projects) {
        const cpState = (project as any).controlPlaneState as Record<string, unknown> | null;
        if (cpState?.portfolioState === "closed") continue;
        try {
          await refreshProjectTelemetry(ctx, project.id);
        } catch {
          // Non-fatal: continue refreshing other projects
        }
      }
    }
  },
});

// Required: fixes TS import for PaperclipPlugin
type PaperclipPlugin = Parameters<typeof definePlugin>[0] & { id: string };

runWorker(plugin);
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/examples/plugin-founder-control-plane/src/worker.ts
git commit -m "feat(plugin): add founder-control-plane worker with telemetry refresh and resume draft generation"
```

---

## Task 12: Plugin UI

**Files:**
- Create: `packages/plugins/examples/plugin-founder-control-plane/src/ui/index.tsx`

- [ ] **Step 1: Create `src/ui/index.tsx`**

This renders four surfaces: portfolio page, dashboard widget, project sidebar badge, and project detail tab.

```tsx
import { useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginProjectSidebarItemProps,
  type PluginWidgetProps,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  PLUGIN_ID,
  PLUGIN_NAMESPACE,
  SLOT_IDS,
  TELEMETRY_STATE_KEY,
  RESUME_DRAFT_STATE_KEY,
} from "../constants.js";

// ── shared types (local mirror) ───────────────────────────────────────────

type PortfolioState = "primary" | "active" | "blocked" | "paused" | "parked" | "closed";
type StaleStatus = "fresh" | "aging" | "stale" | "critical";

type CpState = {
  portfolioState: PortfolioState;
  currentPhase: string;
  constraintLane: string | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  latestEvidenceChanged: string | null;
  resumeBrief: string | null;
  doNotRethink: string | null;
  killCriteria: string | null;
  lastMeaningfulOutput: { kind: string; id: string | null; title: string; url: string | null } | null;
};

type TelemetrySnapshot = {
  issueCounts: { open: number; inProgress: number; blocked: number; done: number; total: number };
  staleStatus: StaleStatus;
  attentionScore: number;
  refreshedAt: string;
};

type PortfolioProject = {
  id: string;
  name: string;
  color: string | null;
  controlPlaneState: CpState | null;
  controlPlaneUpdatedAt: string | null;
};

// ── utilities ─────────────────────────────────────────────────────────────

const STATE_COLORS: Record<PortfolioState, string> = {
  primary: "#6366f1",
  active: "#10b981",
  blocked: "#ef4444",
  paused: "#f59e0b",
  parked: "#94a3b8",
  closed: "#64748b",
};

const STALE_COLORS: Record<StaleStatus, string> = {
  fresh: "#10b981",
  aging: "#f59e0b",
  stale: "#ef4444",
  critical: "#7f1d1d",
};

function StateBadge({ state }: { state: PortfolioState }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: STATE_COLORS[state] + "22",
        color: STATE_COLORS[state],
        border: `1px solid ${STATE_COLORS[state]}44`,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {state}
    </span>
  );
}

function StaleBadge({ status }: { status: StaleStatus }) {
  if (status === "fresh") return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        background: STALE_COLORS[status] + "22",
        color: STALE_COLORS[status],
        border: `1px solid ${STALE_COLORS[status]}44`,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginLeft: 4,
      }}
    >
      {status}
    </span>
  );
}

// ── Portfolio Page ────────────────────────────────────────────────────────

export function FounderPortfolioPage({ pluginId, slotId }: PluginPageProps) {
  const { hostContext } = useHostContext();
  const companyId = hostContext?.company?.id ?? null;
  const [filterState, setFilterState] = useState<PortfolioState | "">("");
  const [filterLane, setFilterLane] = useState<string>("");

  const { data, loading, error } = usePluginData<{
    controlPlane: { projects: PortfolioProject[]; warnings: string[]; summary: Record<string, number> } | null;
  }>(pluginId, slotId, {
    enabled: !!companyId,
    fetch: async (ctx) => {
      if (!companyId) return { controlPlane: null };
      const result = await ctx.http.get(`/api/companies/${companyId}/control-plane/portfolio`);
      return { controlPlane: result };
    },
  });

  if (loading) return <div style={{ padding: 24 }}>Loading portfolio…</div>;
  if (error) return <div style={{ padding: 24, color: "#ef4444" }}>Failed to load portfolio: {String(error)}</div>;
  if (!data?.controlPlane) return <div style={{ padding: 24 }}>No company context</div>;

  const { projects, warnings, summary } = data.controlPlane;

  const filtered = projects.filter((p) => {
    if (filterState && p.controlPlaneState?.portfolioState !== filterState) return false;
    if (filterLane && p.controlPlaneState?.constraintLane !== filterLane) return false;
    return true;
  });

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700 }}>Control Plane</h1>
      <p style={{ margin: "0 0 20px", color: "#64748b", fontSize: 14 }}>
        {summary.primaryCount ?? 0} primary · {summary.activeCount ?? 0} active ·{" "}
        {summary.blockedCount ?? 0} blocked · {summary.staleCount ?? 0} stale/aging
      </p>

      {warnings.map((w) => (
        <div
          key={w}
          style={{
            padding: "8px 12px",
            background: "#fef3c7",
            border: "1px solid #f59e0b",
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
            color: "#92400e",
          }}
        >
          ⚠ {w}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <select
          value={filterState}
          onChange={(e) => setFilterState(e.target.value as PortfolioState | "")}
          style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 13 }}
        >
          <option value="">All states</option>
          {(["primary", "active", "blocked", "paused", "parked"] as PortfolioState[]).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={filterLane}
          onChange={(e) => setFilterLane(e.target.value)}
          style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 13 }}
        >
          <option value="">All lanes</option>
          <option value="product">product</option>
          <option value="customer">customer</option>
          <option value="distribution">distribution</option>
        </select>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
            {["Project", "State", "Phase", "Lane", "Next Action", "Stale"].map((h) => (
              <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "#64748b", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((project) => {
            const cp = project.controlPlaneState;
            return (
              <tr key={project.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "8px 10px", fontWeight: 500 }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: project.color ?? "#94a3b8", marginRight: 8 }} />
                  {project.name}
                </td>
                <td style={{ padding: "8px 10px" }}>
                  {cp ? <StateBadge state={cp.portfolioState} /> : <span style={{ color: "#94a3b8" }}>—</span>}
                </td>
                <td style={{ padding: "8px 10px", color: "#475569" }}>{cp?.currentPhase ?? "—"}</td>
                <td style={{ padding: "8px 10px", color: "#475569" }}>{cp?.constraintLane ?? "—"}</td>
                <td style={{ padding: "8px 10px", color: "#475569", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cp?.nextSmallestAction ?? <span style={{ color: "#ef4444" }}>⚡ Missing</span>}
                </td>
                <td style={{ padding: "8px 10px" }}>
                  <StaleBadge status={
                    /* telemetry staleStatus would come from plugin state; use fresh as default */
                    "fresh"
                  } />
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>
                No projects match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Dashboard Widget ──────────────────────────────────────────────────────

export function FounderDashboardWidget({ pluginId, slotId }: PluginWidgetProps) {
  const { hostContext } = useHostContext();
  const companyId = hostContext?.company?.id ?? null;

  const { data, loading } = usePluginData<{
    portfolio: { projects: PortfolioProject[]; warnings: string[]; summary: Record<string, number> } | null;
  }>(pluginId, slotId, {
    enabled: !!companyId,
    fetch: async (ctx) => {
      if (!companyId) return { portfolio: null };
      const result = await ctx.http.get(`/api/companies/${companyId}/control-plane/portfolio`);
      return { portfolio: result };
    },
  });

  if (loading) return <div style={{ padding: 12 }}>Loading…</div>;
  if (!data?.portfolio) return null;

  const { projects, warnings, summary } = data.portfolio;
  const top5 = projects.slice(0, 5);

  return (
    <div style={{ padding: 12, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Control Plane</div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        {[
          { label: "Primary", value: summary.primaryCount ?? 0 },
          { label: "Active", value: summary.activeCount ?? 0 },
          { label: "Blocked", value: summary.blockedCount ?? 0 },
          { label: "Stale/Aging", value: summary.staleCount ?? 0 },
        ].map(({ label, value }) => (
          <div key={label} style={{ textAlign: "center", flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
            <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase" }}>{label}</div>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", padding: "4px 8px", borderRadius: 4, marginBottom: 8 }}>
          ⚠ {warnings[0]}
        </div>
      )}

      {top5.map((project) => {
        const cp = project.controlPlaneState;
        return (
          <div key={project.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid #f1f5f9" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: project.color ?? "#94a3b8", flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {project.name}
            </span>
            {cp && <StateBadge state={cp.portfolioState} />}
          </div>
        );
      })}
    </div>
  );
}

// ── Project Sidebar Item ──────────────────────────────────────────────────

export function FounderProjectSidebarItem({ pluginId, slotId, entityId }: PluginProjectSidebarItemProps) {
  const { data, loading } = usePluginData<{ cp: { controlPlaneState: CpState | null; warnings: string[] } | null }>(
    pluginId,
    slotId,
    {
      enabled: !!entityId,
      fetch: async (ctx) => {
        const result = await ctx.http.get(`/api/projects/${entityId}/control-plane`);
        return { cp: result };
      },
    },
  );

  if (loading || !data?.cp?.controlPlaneState) return null;
  const { portfolioState } = data.cp.controlPlaneState;

  return (
    <div style={{ padding: "2px 8px" }}>
      <StateBadge state={portfolioState} />
    </div>
  );
}

// ── Project Detail Tab ────────────────────────────────────────────────────

export function FounderProjectTab({ pluginId, slotId, entityId }: PluginDetailTabProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<CpState>>({});

  const { data, loading, error, refresh } = usePluginData<{
    cp: { projectId: string; companyId: string; controlPlaneState: CpState | null; warnings: string[] } | null;
    resumeDraft: { draft: string; generatedAt: string } | null;
  }>(pluginId, slotId, {
    enabled: !!entityId,
    fetch: async (ctx) => {
      const [cp, resumeDraft] = await Promise.all([
        ctx.http.get(`/api/projects/${entityId}/control-plane`),
        ctx.state.get({
          scopeKind: "project",
          scopeId: entityId!,
          namespace: PLUGIN_NAMESPACE,
          stateKey: RESUME_DRAFT_STATE_KEY,
        }),
      ]);
      return { cp, resumeDraft: resumeDraft ?? null };
    },
  });

  const { invoke: saveState, loading: saving } = usePluginAction(pluginId, slotId, {
    action: async (ctx, payload: Partial<CpState>) => {
      await ctx.http.patch(`/api/projects/${entityId}/control-plane`, payload);
    },
    onSuccess: () => {
      setEditing(false);
      setDraft({});
      refresh();
    },
  });

  const { invoke: acceptResumeBrief } = usePluginAction(pluginId, slotId, {
    action: async (ctx, briefText: string) => {
      await ctx.http.patch(`/api/projects/${entityId}/control-plane`, { resumeBrief: briefText });
    },
    onSuccess: () => refresh(),
  });

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>;
  if (error) return <div style={{ padding: 16, color: "#ef4444" }}>Error: {String(error)}</div>;
  if (!data) return null;

  const cp = data.cp;
  const state = cp?.controlPlaneState;
  const warnings = cp?.warnings ?? [];

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    border: "1px solid #e2e8f0",
    borderRadius: 4,
    fontSize: 13,
    boxSizing: "border-box",
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: 20,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif", maxWidth: 680 }}>
      {warnings.map((w) => (
        <div
          key={w}
          style={{ padding: "6px 10px", background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 4, marginBottom: 8, fontSize: 12, color: "#92400e" }}
        >
          ⚠ {w}
        </div>
      ))}

      {/* ── Founder State ── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Founder State</h3>
          <button
            onClick={() => { setEditing((v) => !v); if (state) setDraft({ ...state }); }}
            style={{ fontSize: 12, padding: "4px 10px", borderRadius: 4, border: "1px solid #e2e8f0", cursor: "pointer", background: editing ? "#f1f5f9" : "white" }}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        {editing ? (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Portfolio State</label>
                <select
                  value={draft.portfolioState ?? state?.portfolioState ?? "parked"}
                  onChange={(e) => setDraft((d) => ({ ...d, portfolioState: e.target.value as PortfolioState }))}
                  style={inputStyle}
                >
                  {(["primary", "active", "blocked", "paused", "parked"] as PortfolioState[]).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Current Phase</label>
                <select
                  value={draft.currentPhase ?? state?.currentPhase ?? "exploration"}
                  onChange={(e) => setDraft((d) => ({ ...d, currentPhase: e.target.value }))}
                  style={inputStyle}
                >
                  {["exploration", "validation", "build", "distribution"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Constraint Lane</label>
                <select
                  value={draft.constraintLane ?? state?.constraintLane ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, constraintLane: e.target.value || null }))}
                  style={inputStyle}
                >
                  <option value="">None</option>
                  {["product", "customer", "distribution"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {[
              { key: "nextSmallestAction", label: "Next Smallest Action" },
              { key: "blockerSummary", label: "Blocker Summary" },
              { key: "latestEvidenceChanged", label: "Latest Evidence Changed" },
              { key: "doNotRethink", label: "Do Not Re-Think" },
              { key: "killCriteria", label: "Kill Criteria" },
              { key: "resumeBrief", label: "Resume Brief" },
            ].map(({ key, label }) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <label style={labelStyle}>{label}</label>
                <textarea
                  value={(draft[key as keyof CpState] as string) ?? (state?.[key as keyof CpState] as string) ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value || null }))}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
                />
              </div>
            ))}

            <button
              onClick={() => saveState(draft)}
              disabled={saving}
              style={{ padding: "6px 16px", background: "#6366f1", color: "white", border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer", fontWeight: 600 }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <div>
            {!state ? (
              <div style={{ color: "#94a3b8", fontSize: 13 }}>No control-plane state set. Click Edit to initialize.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  ["Portfolio State", <StateBadge state={state.portfolioState} />],
                  ["Phase", state.currentPhase],
                  ["Constraint Lane", state.constraintLane ?? "—"],
                  ["Next Action", state.nextSmallestAction ?? <span style={{ color: "#ef4444" }}>⚡ Not set</span>],
                  ["Blocker", state.blockerSummary ?? "—"],
                  ["Latest Evidence", state.latestEvidenceChanged ?? "—"],
                  ["Do Not Re-Think", state.doNotRethink ?? "—"],
                  ["Kill Criteria", state.killCriteria ?? "—"],
                ].map(([k, v]) => (
                  <div key={String(k)} style={{ padding: "6px 0" }}>
                    <div style={labelStyle}>{k}</div>
                    <div style={{ fontSize: 13, color: "#1e293b" }}>{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Resume Draft ── */}
      {data.resumeDraft && (
        <div style={sectionStyle}>
          <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>Resume Brief Draft</h3>
          <pre style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: 12, fontSize: 12, whiteSpace: "pre-wrap", margin: "0 0 8px" }}>
            {data.resumeDraft.draft}
          </pre>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => data.resumeDraft && acceptResumeBrief(data.resumeDraft.draft)}
              style={{ padding: "4px 12px", background: "#10b981", color: "white", border: "none", borderRadius: 4, fontSize: 12, cursor: "pointer", fontWeight: 600 }}
            >
              Accept as Canonical
            </button>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>
              Generated {new Date(data.resumeDraft.generatedAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toolbar Button (Quick Actions) ────────────────────────────────────────

export function FounderToolbarButton({ pluginId, slotId, entityId }: PluginDetailTabProps) {
  const [open, setOpen] = useState(false);

  const { invoke } = usePluginAction(pluginId, slotId, {
    action: async (ctx, payload: { action: string }) => {
      const statePatches: Record<string, Partial<CpState>> = {
        "set-primary":  { portfolioState: "primary" },
        "mark-active":  { portfolioState: "active" },
        "mark-blocked": { portfolioState: "blocked" },
        "pause":        { portfolioState: "paused" },
        "park":         { portfolioState: "parked" },
      };
      if (statePatches[payload.action]) {
        await ctx.http.patch(`/api/projects/${entityId}/control-plane`, statePatches[payload.action]);
      }
    },
  });

  const QUICK_ACTIONS = [
    { key: "set-primary",  label: "Set Primary" },
    { key: "mark-active",  label: "Mark Active" },
    { key: "mark-blocked", label: "Mark Blocked" },
    { key: "pause",        label: "Pause Project" },
    { key: "park",         label: "Park Project" },
  ];

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ padding: "4px 10px", border: "1px solid #e2e8f0", borderRadius: 4, cursor: "pointer", fontSize: 12, background: "white" }}
      >
        Control Plane ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            minWidth: 160,
            zIndex: 100,
          }}
        >
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.key}
              onClick={() => { invoke({ action: a.key }); setOpen(false); }}
              style={{ display: "block", width: "100%", padding: "8px 12px", textAlign: "left", border: "none", background: "white", cursor: "pointer", fontSize: 13 }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Context Menu Item ─────────────────────────────────────────────────────

export function FounderContextMenuItem({ pluginId, slotId, entityId }: PluginDetailTabProps) {
  return (
    <div style={{ padding: "4px 0", fontSize: 13 }}>
      View Control Plane
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/examples/plugin-founder-control-plane/src/ui/index.tsx
git commit -m "feat(plugin): add founder-control-plane UI (portfolio, widget, detail tab, quick actions)"
```

---

## Task 13: Final build check and run tests

- [ ] **Step 1: Build all affected packages**

```bash
cd /home/ubuntu/llm_shared/paperclip
pnpm --filter @paperclipai/db build 2>&1 | tail -10
pnpm --filter @paperclipai/shared build 2>&1 | tail -10
pnpm --filter @paperclipai/server build 2>&1 | tail -10
```

Expected: no errors in any package.

- [ ] **Step 2: Run validator tests**

```bash
pnpm --filter @paperclipai/shared test --reporter=verbose 2>&1 | tail -30
```

Expected: all control-plane validator tests pass.

- [ ] **Step 3: Run server tests**

```bash
pnpm --filter @paperclipai/server test -- control-plane --reporter=verbose 2>&1 | tail -30
```

Expected: all route tests pass.

- [ ] **Step 4: Run full server test suite (regression check)**

```bash
pnpm --filter @paperclipai/server test 2>&1 | tail -20
```

Expected: no new failures.

- [ ] **Step 5: Final commit**

```bash
git add .
git status
# Review files, then:
git commit -m "chore: final build verification for founder control plane"
```

---

## Spec Coverage Checklist (Self-Review)

| Spec requirement | Task |
|---|---|
| DB columns `control_plane_state`, `control_plane_updated_at` | Task 1 |
| Backfill on migration | Task 1, Step 2 |
| Journal.json update | Task 1, Step 3 |
| Shared types: all 6 shapes | Task 2 |
| Validators: all 7 schemas | Task 3 |
| Validator tests | Task 4 |
| Service: getControlPlane | Task 5 |
| Service: updateControlPlane (never writes telemetry) | Task 5 |
| Service: getPortfolio with attention scoring + stale detection | Task 5 |
| Extend Project payload | Task 6 |
| GET /projects/:id/control-plane | Task 7 |
| PATCH /projects/:id/control-plane | Task 7 |
| GET /companies/:companyId/control-plane/portfolio | Task 7 |
| Route tests with auth checks + telemetry-key rejection | Task 8 |
| Plugin scaffolding + package.json | Task 9 |
| Plugin manifest with job + UI slots | Task 10 |
| Worker: label bootstrap | Task 11 |
| Worker: telemetry refresh on events | Task 11 |
| Worker: scheduled 4h refresh job | Task 11 |
| Worker: resume draft generation | Task 11 |
| UI: portfolio page with filters | Task 12 |
| UI: dashboard widget with top-5 | Task 12 |
| UI: project sidebar badge | Task 12 |
| UI: project detail tab (edit + resume accept) | Task 12 |
| UI: quick actions toolbar | Task 12 |

## Intentionally Deferred

| Item | Reason |
|---|---|
| Repo/git snapshot via curated commands | Requires plugin workspace execution — complex sandboxing; add in v1.1 |
| Run health from agent.run events | Needs run service integration; partial scaffold left in worker |
| Budget health from budget service | Requires budget service wiring; worker currently hardcodes 0 |
| `attentionScore +10` for multiple `next-action` issues | Worker computes `multipleNextActions` but does not yet update canonical portfolio route attention score; the plugin_state telemetry holds its own score independently |
| `scripts/build-ui.mjs` for plugin | Plugin build script not included; copy from kitchen-sink-example |
| Snapshot JSON for migration 0046 | Drizzle migrate runner uses journal.json + SQL files only; snapshot is for drizzle-kit diffing |
| UI: telemetry panel (issue counts, repo snapshot) | Detail tab scaffolded; telemetry section deferred until plugin state read-back API is wired in UI data fetcher |
