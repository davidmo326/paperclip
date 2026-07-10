import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Personal AI Control Plane (pacc)",
  description:
    "Portfolio steward, daily briefs, decision log, and authority-gated delegation for solo founders running multiple concurrent projects.",
  author: "pacc",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
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
      description:
        "Iterates all active projects across all companies and refreshes their telemetry snapshot in plugin state.",
      schedule: "0 */4 * * *",
    },
    {
      jobKey: JOB_KEYS.staleRehash,
      displayName: "Weekly Source Hash Re-grounding",
      description:
        "T-2.6 / tripwire 2: re-hashes every M1 source cited by an M2 row and flags drift in plugin_state[freshness.v1].",
      schedule: "0 6 * * 1", // Mondays 06:00
    },
    {
      jobKey: JOB_KEYS.sourceDecayCheck,
      displayName: "Daily Source Decay Check",
      description:
        "T-2.6 / tripwire 7: for each project, emits project.source_decay when the most-recently-touched M1 source exceeds the project's stale threshold (default 30 days).",
      schedule: "0 7 * * *", // 07:00 daily
    },
    {
      jobKey: JOB_KEYS.briefDaily,
      displayName: "Daily Operating Brief",
      description:
        "T-3.6 / PRD § 13.1: produces the day's operating brief and writes it to Obsidian (00_Daily/Daily Brief - YYYY-MM-DD.md). Overlap-guarded via plugin_state advisory lock; idempotent Obsidian write so re-runs on the same day produce no diff.",
      schedule: "0 8 * * *", // 08:00 local daily
    },
    {
      jobKey: JOB_KEYS.weeklyReview,
      displayName: "Weekly Portfolio Review",
      description:
        "T-3.11 / PRD § 13.2: Monday review — portfolio roll-call, weekly J-mix, FPCP ritual prompts, assumptions/decisions due, memory drift, expiring grants, stale + no-next-action projects. Writes 00_Daily/Weekly Portfolio Review - YYYY-Www.md (idempotent).",
      schedule: "0 9 * * 1", // Mondays 09:00 local
    },
    {
      jobKey: JOB_KEYS.weekendPrep,
      displayName: "Weekend Prep",
      description:
        "T-3.11 / PRD § 13.4: Friday prep — pre-authorized async work, self-pause boundaries, must-land-before-Monday. Writes 00_Daily/Weekend Prep - YYYY-MM-DD.md (idempotent).",
      schedule: "0 16 * * 5", // Fridays 16:00 local
    },
    {
      jobKey: JOB_KEYS.obsidianWatcherSupervisor,
      displayName: "Obsidian Watcher Supervisor",
      description:
        "T-2.1: ensures the continuous vault filesystem watcher (chokidar) is running — started immediately in plugin setup(), with this job as an idempotent restart-if-dead safety net. Emits source.note.changed/renamed/deleted, tagged M1a/M1b via the T-2.4 value-anchor registry.",
      schedule: "*/5 * * * *", // every 5 minutes
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Portfolio (pacc)",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Portfolio (pacc)",
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
        displayName: "Control Plane",
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
