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
  displayName: "Founder Control Plane",
  description:
    "Portfolio view, re-entry briefs, and project telemetry for solo operators running multiple concurrent projects.",
  author: "Paperclip",
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
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Founder Portfolio",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Founder Portfolio",
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
