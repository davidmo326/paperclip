export const PLUGIN_ID = "paperclip-pacc";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "pacc";
export const PLUGIN_NAMESPACE = "pacc";
export const TELEMETRY_STATE_KEY = "telemetry.v1";
export const RESUME_DRAFT_STATE_KEY = "resume-brief-draft.v1";

export const LANE_LABELS = ["lane:product", "lane:customer", "lane:distribution"] as const;
export const NEXT_ACTION_LABEL = "next-action" as const;

export const SLOT_IDS = {
  page: "pacc-portfolio-page",
  dashboardWidget: "pacc-dashboard-widget",
  projectSidebarItem: "pacc-project-sidebar-item",
  projectTab: "pacc-project-tab",
  toolbarButton: "pacc-toolbar-button",
  contextMenuItem: "pacc-context-menu-item",
} as const;

export const EXPORT_NAMES = {
  page: "PaccPortfolioPage",
  dashboardWidget: "PaccDashboardWidget",
  projectSidebarItem: "PaccProjectSidebarItem",
  projectTab: "PaccProjectTab",
  toolbarButton: "PaccToolbarButton",
  contextMenuItem: "PaccContextMenuItem",
} as const;

export const JOB_KEYS = {
  refreshTelemetry: "refresh-telemetry",
} as const;
