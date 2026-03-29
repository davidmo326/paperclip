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
