# Founder Control Plane Adaptation

Ready-to-implement product and technical spec for adapting Paperclip into a founder control plane for a solo operator managing multiple exploration-stage projects with frequent context switching.

This document is intentionally specific. It should be implementable without additional product interviews.

---

## 1. Problem

Paperclip already models companies, projects, goals, issues, agents, budgets, heartbeats, and approvals. That makes it a strong orchestration layer for agent work.

It does **not** yet solve the founder-state problem:

- many projects are in motion at once
- progress is split across product, customer, and distribution lanes
- the founder context-switches often
- when a project is paused, the cognitive thread is lost
- repo/task telemetry exists, but entrepreneurial state is not explicit

The missing layer is a **project control plane** that answers, for each project:

1. What state is it in now?
2. Which lane is currently constraining it: product, customer, or distribution?
3. What is the next smallest action?
4. What changed since the last touch?
5. What should not be re-thought on re-entry?
6. Which projects need attention first?

This adaptation makes Paperclip the canonical live control plane for that state.

---

## 2. Product Goal

Turn Paperclip from an agent/company orchestrator into a **founder operating control plane** without breaking its current identity.

The result should let one founder:

- see the live state of many projects from one portfolio view
- resume any paused project without reconstructing context manually
- combine repo/workspace telemetry with founder judgement
- keep Paperclip, not memory, as the live source of project state
- use agents and automations where helpful without letting activity masquerade as progress

---

## 3. Product Principles

### 3.1 Paperclip is canonical for live project state

Obsidian may remain useful for reflection and long-form notes, but the live project state must be canonical inside Paperclip.

### 3.2 Founder judgement and telemetry are separate

Repo status, task counts, and run logs are telemetry.

`constraintLane`, `nextSmallestAction`, `killCriteria`, and `latestEvidenceChanged` are founder judgement.

Telemetry may assist, but must not silently overwrite canonical founder-state.

### 3.3 Re-entry is the primary use case

The first question this control plane must answer is:

> "If I return to this project after a break, what should I do next without re-thinking the whole thing?"

### 3.4 Project-first UI

The system should start from projects, then show the agent/task/repo layers underneath. The founder should not have to reconstruct project state from issue detail and agent logs.

### 3.5 Mixed automation

Automation should fill in telemetry, freshness, and suggested resume drafts.

The founder should explicitly assert canonical state.

### 3.6 Soft governance, not hard locks

Paperclip should warn when the founder is running too many live projects or has active projects without next actions.

It should not hard-block progress in v1.

---

## 4. Ideal Control Plane Coverage

| Requirement | Current Paperclip | V1 Adaptation |
|---|---|---|
| Cross-project portfolio view | Partial | Yes |
| Canonical founder-state per project | No | Yes |
| Product / customer / distribution lane visibility | No | Yes |
| Re-entry / resume brief | No | Yes |
| Repo and workspace telemetry | Partial | Yes |
| Stale detection | No | Yes |
| Attention prioritization | No | Yes |
| Task/issue linkage | Yes | Yes |
| Agent/run telemetry | Yes | Yes |
| Founder-state automation suggestions | No | Yes |
| Multi-human collaboration | Out of scope | No |
| Obsidian sync | Out of scope | No |

---

## 5. V1 Scope

V1 includes:

- canonical founder-state on each project
- portfolio view across projects
- project detail surfaces for state + telemetry + resume
- mixed automation for telemetry and draft generation
- repo/workspace snapshotting from the primary workspace
- lane-based issue aggregation using canonical labels
- quick actions for common control-plane operations
- soft governance warnings

V1 does **not** include:

- literal slash command parsing
- multi-human workflows or approvals for founder-state edits
- automatic Obsidian synchronization
- deep CRM or sales system integrations
- heavy inference that auto-decides whether a project should live or die

---

## 6. Architecture Choice

### 6.1 Selected architecture

Use a **hybrid core + plugin** design:

- **Core** stores canonical founder-state and exposes typed APIs
- **Plugin** provides portfolio UI, project surfaces, telemetry refresh, and draft generation
- **Plugin state** stores refreshable cache and drafts, not canonical truth

### 6.2 Why this architecture

- Plugin-only is insufficient because the plugin SDK can read projects but not mutate canonical project fields directly through a dedicated projects API surface.
- Core-only is too rigid for a first iteration and would bloat the host UI with a narrow founder-specific workflow.
- Hybrid keeps the durable truth in the platform while using the existing plugin surfaces for rapid operator UX.

---

## 7. Canonical Core Data Model

### 7.1 Database changes

Add to `projects`:

- `control_plane_state jsonb`
- `control_plane_updated_at timestamptz`

Do **not** add many narrow project columns in v1. Use one typed object to preserve iteration speed while keeping the shape contract strict in shared validators.

### 7.2 Shared types

Add:

- `ProjectPortfolioState`
- `ProjectPhase`
- `ProjectConstraintLane`
- `ProjectControlPlaneLastOutput`
- `ProjectControlPlaneState`

#### `ProjectPortfolioState`

```ts
"primary" | "active" | "blocked" | "paused" | "parked" | "closed"
```

#### `ProjectPhase`

```ts
"exploration" | "validation" | "build" | "distribution"
```

#### `ProjectConstraintLane`

```ts
"product" | "customer" | "distribution"
```

#### `ProjectControlPlaneLastOutput`

```ts
{
  kind: "issue" | "work_product" | "document" | "external_link" | "note";
  id: string | null;
  title: string;
  url: string | null;
}
```

#### `ProjectControlPlaneState`

```ts
{
  portfolioState: "primary" | "active" | "blocked" | "paused" | "parked" | "closed";
  currentPhase: "exploration" | "validation" | "build" | "distribution";
  constraintLane: "product" | "customer" | "distribution" | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  latestEvidenceChanged: string | null;
  resumeBrief: string | null;
  doNotRethink: string | null;
  killCriteria: string | null;
  lastMeaningfulOutput: {
    kind: "issue" | "work_product" | "document" | "external_link" | "note";
    id: string | null;
    title: string;
    url: string | null;
  } | null;
}
```

### 7.3 Rules on canonical fields

These fields are **manual source-of-truth**:

- `portfolioState`
- `currentPhase`
- `constraintLane`
- `nextSmallestAction`
- `blockerSummary`
- `latestEvidenceChanged`
- `doNotRethink`
- `killCriteria`

These fields are **assisted but canonical after acceptance**:

- `resumeBrief`
- `lastMeaningfulOutput`

Automation may suggest values for assisted fields, but final acceptance is explicit.

---

## 8. Derived Telemetry Model

Derived telemetry lives in plugin-scoped `plugin_state`, project scope, namespace `founder-control-plane`.

### 8.1 Telemetry snapshot shape

Use one project-scoped key:

- `stateKey = "telemetry.v1"`

Suggested shape:

```ts
{
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
  staleStatus: "fresh" | "aging" | "stale" | "critical";
  staleReason: string | null;
  attentionScore: number;
  refreshedAt: string;
}
```

### 8.2 Resume draft shape

Use separate project-scoped key:

- `stateKey = "resume-brief-draft.v1"`

Shape:

```ts
{
  draft: string;
  sources: Array<{ kind: string; id: string | null; title: string | null }>;
  generatedAt: string;
}
```

---

## 9. Defaults and Backfill

When the migration runs, backfill existing projects:

- `in_progress -> portfolioState = "active"`
- `planned -> portfolioState = "parked"`
- `backlog -> portfolioState = "parked"`
- `completed -> portfolioState = "closed"`
- `cancelled -> portfolioState = "closed"`
- `currentPhase = "exploration"`
- all other fields = `null`

Set `controlPlaneUpdatedAt = now()` during backfill.

---

## 10. API and Validation Changes

### 10.1 Shared validators

Add:

- `projectPortfolioStateSchema`
- `projectPhaseSchema`
- `projectConstraintLaneSchema`
- `projectControlPlaneLastOutputSchema`
- `projectControlPlaneStateSchema`
- `updateProjectControlPlaneSchema`
- `projectPortfolioSummarySchema`

### 10.2 Core routes

Add new routes instead of overloading generic project patch semantics.

#### `GET /projects/:id/control-plane`

Returns:

```ts
{
  projectId: string;
  companyId: string;
  controlPlaneState: ProjectControlPlaneState | null;
  telemetry: ProjectControlPlaneTelemetry | null;
  warnings: string[];
}
```

#### `PATCH /projects/:id/control-plane`

Accepts patch only for canonical fields:

- `portfolioState`
- `currentPhase`
- `constraintLane`
- `nextSmallestAction`
- `blockerSummary`
- `latestEvidenceChanged`
- `resumeBrief`
- `doNotRethink`
- `killCriteria`
- `lastMeaningfulOutput`

Reject writes to derived telemetry fields.

#### `GET /companies/:companyId/control-plane/portfolio`

Returns:

```ts
{
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

`ProjectPortfolioSummary` should contain:

- core founder-state
- telemetry summary
- warning list
- attentionScore
- staleStatus

### 10.3 Existing project payloads

Extend existing project reads so `Project` includes:

- `controlPlaneState: ProjectControlPlaneState | null`
- `controlPlaneUpdatedAt: Date | null`

Do not change existing project creation flow beyond allowing optional initialization later.

---

## 11. Lane Taxonomy

Do **not** add issue table columns in v1.

Use canonical issue labels:

- `lane:product`
- `lane:customer`
- `lane:distribution`
- `next-action`

Rules:

- A project issue may have at most one `lane:*` label.
- `next-action` is allowed on only one open issue per project. If multiple exist, show a warning.
- The plugin should ensure these labels exist per company on activation.

---

## 12. Automation Model

### 12.1 Event subscriptions

The plugin worker subscribes to:

- `project.created`
- `project.updated`
- `project.workspace_created`
- `project.workspace_updated`
- `issue.created`
- `issue.updated`
- `issue.comment.created`
- `agent.run.started`
- `agent.run.finished`
- `agent.run.failed`
- `activity.logged`
- `cost_event.created`

### 12.2 Scheduled jobs

Add one scheduled plugin job:

- `jobKey = "refresh-telemetry"`
- schedule: every 4 hours

This job refreshes project telemetry snapshots for all non-closed projects.

### 12.3 Auto-written fields

These are derived and may be overwritten automatically:

- `lastTouchedAt`
- `lastActivityAt`
- `issueCounts`
- `laneIssueCounts`
- `latestArtifact`
- `repoSnapshot`
- `runHealth`
- `budgetHealth`
- `staleStatus`
- `staleReason`
- `attentionScore`

### 12.4 Resume brief generation

The plugin worker may generate a draft resume brief from:

- current canonical founder-state
- latest artifact
- latest issue activity
- latest run outcome
- latest evidence field

The draft is stored in plugin state until the founder accepts it. Accepting it writes `resumeBrief` into canonical project control-plane state.

---

## 13. Repo and Workspace Telemetry

Telemetry is collected only for the **primary workspace**.

If no primary workspace exists, set `repoSnapshot.status = "unavailable"`.

### 13.1 Curated commands

Use curated commands only:

- `git branch --show-current`
- `git rev-parse --short HEAD`
- `git status --porcelain=v1 --branch`
- `git log -1 --format=%ct`

Optional only if upstream exists:

- `git rev-list --left-right --count @{upstream}...HEAD`

Do not execute arbitrary user-defined shell commands for repo telemetry in v1.

### 13.2 Degradation rules

- non-git workspace -> `status = "unavailable"`
- remote-managed workspace without local git -> `status = "unavailable"`
- git command failure -> `status = "warning"` and store error summary
- missing workspace path -> `status = "warning"` and store error summary

---

## 14. Stale Detection and Attention Ordering

### 14.1 Stale defaults

- `primary` project becomes `aging` after 2 days without meaningful touch
- `primary` project becomes `stale` after 4 days
- `active` project becomes `aging` after 5 days
- `active` project becomes `stale` after 10 days
- `blocked` project becomes `stale` after 7 days without blocker update
- `paused`, `parked`, `closed` do not participate in stale alerts by default

### 14.2 Attention score

Use deterministic additive scoring:

- `+40` stale primary project
- `+30` active or primary project with no `nextSmallestAction`
- `+25` blocked project with no unblock move in `blockerSummary`
- `+20` recent failed run
- `+15` active budget incident
- `+10` no `lastMeaningfulOutput`
- `+10` multiple `next-action` issues
- `+10` more than one `primary` in portfolio

Sort portfolio descending by `attentionScore`, then most recent `controlPlaneUpdatedAt`.

---

## 15. UI Specification

### 15.1 Delivery mechanism

Implement as a first-party plugin:

- package name: `@paperclipai/founder-control-plane`

Use these UI slots:

- `dashboardWidget`
- `page`
- `projectSidebarItem`
- `detailTab` for `project`
- `toolbarButton`
- `contextMenuItem`

### 15.2 Portfolio page

The portfolio page is the main founder surface.

It must provide:

- table of all non-closed projects
- filter by `portfolioState`
- filter by `constraintLane`
- filter by `staleStatus`
- sort by `attentionScore`
- compact columns:
  - project name
  - portfolioState
  - currentPhase
  - constraintLane
  - nextSmallestAction
  - blockerSummary
  - staleStatus
  - lastTouchedAt
  - latestArtifact
  - repoSnapshot summary

### 15.3 Dashboard widget

Show only:

- top 5 attention-needed projects
- count of stale projects
- count of blocked projects
- warning if more than one `primary`

### 15.4 Project sidebar item

Render a compact state badge:

- `portfolioState`
- `constraintLane`
- stale indicator

### 15.5 Project detail tab

The project detail tab is the canonical edit surface.

It should contain:

1. **Founder State**
   - editable canonical fields
2. **Telemetry**
   - issue counts
   - lane counts
   - repo snapshot
   - last run health
   - latest artifact
3. **Resume**
   - generated draft
   - accepted canonical resume brief
4. **Warnings**
   - stale state
   - missing next action
   - multiple next-action issues

### 15.6 Quick actions

Do not implement literal slash command parsing in v1.

Provide slash-equivalent operator actions through toolbar/context/launcher surfaces:

- `Set Primary`
- `Mark Active`
- `Mark Blocked`
- `Pause Project`
- `Park Project`
- `Refresh Telemetry`
- `Generate Resume Brief`
- `Accept Latest Artifact as Meaningful Output`
- `Create Next Action Issue`

---

## 16. Implementation Boundaries

### 16.1 Core responsibilities

- DB migration
- shared types and validators
- project control-plane service
- control-plane routes
- project payload extension
- auth and activity logging for control-plane writes

### 16.2 Plugin responsibilities

- portfolio UI
- project surfaces
- telemetry refresh
- label bootstrap
- draft resume generation
- quick actions
- project-scoped telemetry cache

### 16.3 Explicit non-goals for v1

- no multi-user founder-state merge logic
- no automatic project kill/continue decisioning
- no Obsidian sync
- no comment slash parser
- no deep CRM integration

---

## 17. Acceptance Criteria

V1 is done when all are true:

1. Every project can hold canonical founder-state in Paperclip.
2. The founder can view all live projects in one portfolio page.
3. The founder can identify the current constraint lane for each project.
4. The founder can see one next smallest action per active project.
5. The system can generate and store a resume brief draft for a project.
6. The founder can accept the draft into canonical state.
7. Repo/workspace telemetry appears when a primary workspace exists.
8. Stale and attention warnings appear without manual spreadsheeting.
9. Multiple primaries and missing next actions are surfaced as warnings.
10. Canonical founder-state is never silently replaced by automation.

---

## 18. Test Plan

### 18.1 Schema and migration

- validator tests for `ProjectControlPlaneState`
- migration tests for backfill defaults
- project payload tests including new fields

### 18.2 API

- auth tests for control-plane routes
- patch route rejects derived telemetry keys
- portfolio route returns warnings and summaries correctly

### 18.3 Plugin worker

- event-driven telemetry refresh
- scheduled refresh job
- resume draft generation
- label bootstrap idempotence
- stale detection and attention scoring

### 18.4 UI

- dashboard widget renders top attention projects
- portfolio page filters and sorts correctly
- project detail tab edits canonical fields
- quick actions apply correct state changes
- telemetry panel handles unavailable workspaces gracefully

### 18.5 Manual regression scenarios

- solo founder with 5 projects, 1 primary, 2 active, 2 paused
- project with no workspace
- project with non-git workspace
- blocked project with stale blocker
- active project with no next action
- project with failed recent run and latest artifact present

---

## 19. Recommended Delivery Order

1. Add core schema + validators + routes
2. Backfill existing projects
3. Build portfolio endpoint
4. Build plugin project tab and dashboard widget
5. Add telemetry refresh and cache
6. Add quick actions
7. Add resume draft generation
8. Add attention scoring and warnings

---

## 20. Overall Setup Positioning

This adaptation assumes:

- `Paperclip` is the canonical live control plane
- `Codex / Claude / OpenClaw / Bash / HTTP` remain execution runtimes under Paperclip
- `Obsidian` remains useful for reflection and long-form synthesis, but is not the live project state authority

The control plane succeeds if it reduces re-entry cost and surfaces what matters now.

If it only increases dashboard surface area, it has failed.
