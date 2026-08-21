export const PLUGIN_ID = "paperclip-pacc";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "pacc";
export const PLUGIN_NAMESPACE = "pacc";
export const TELEMETRY_STATE_KEY = "telemetry.v1";
export const RESUME_DRAFT_STATE_KEY = "resume-brief-draft.v1";
/** T-2.6 — per-project freshness report from the weekly hash-rehash job. */
export const FRESHNESS_STATE_KEY = "freshness.v1";
/** T-2.6 — per-project source-decay status from the daily decay check. */
export const SOURCE_DECAY_STATE_KEY = "source-decay.v1";
/** T-2.7 — per-project conflict map. Keyed by field path; quarantines agent writes. */
export const CONFLICTS_STATE_KEY = "conflicts.v1";
/** T-3.6 — advisory lock for the scheduled-brief overlap guard. */
export const BRIEF_IN_PROGRESS_STATE_KEY = "brief-in-progress.v1";
/** T-3.6 — most recent brief metadata (date, path, byteLength). For startup catch-up + history. */
export const BRIEF_LAST_RUN_STATE_KEY = "brief-last-run.v1";
/** T-3.6 — stored Brief object keyed by date (instance scope, namespace=brief-date). */
export const BRIEF_STORE_STATE_KEY = "brief.v1";
/** T-3.7 — rolling 24h hallucination flag counter (instance scope). */
export const HALLUCINATION_FLAGS_STATE_KEY = "hallucination-flags.v1";
/** T-3.7 — briefer self-pause flag (instance scope). */
export const BRIEFER_PAUSED_STATE_KEY = "briefer-paused.v1";
/** T-3.12 — pause/resume audit trail (instance scope, append-only). */
export const BRIEFER_PAUSE_AUDIT_STATE_KEY = "briefer-pause-audit.v1";
/** T-3.9 — captured principal feedback per brief (instance scope, namespace=brief-date). */
export const BRIEF_FEEDBACK_STATE_KEY = "brief-feedback.v1";
/** T-4.8 — steward self-pause flag (instance scope; separate from the briefer's). */
export const STEWARD_PAUSED_STATE_KEY = "steward-paused.v1";
/** T-4.8 — advisory lock for the scheduled-steward overlap guard. */
export const STEWARD_IN_PROGRESS_STATE_KEY = "steward-in-progress.v1";
/** T-4.8 — stored StewardJournal keyed by date (instance scope, namespace=journal-date). */
export const STEWARD_JOURNAL_STORE_STATE_KEY = "steward-journal.v1";
/** T-4.8 — last journal's per-project card keys (the "what changed" diff baseline). */
export const STEWARD_JOURNAL_DELTA_STATE_KEY = "steward-journal-delta.v1";

/**
 * T-6.3 delta-only brief: the last brief's per-project card keys + aging
 * statuses + lead key, persisted alongside each brief so the next run can
 * compute quiet projects (noise discipline — grill Q12, 2026-08-16).
 */
export const BRIEF_DELTA_STATE_KEY = "brief-delta.v1";
/** T-3.10 — kill-criterion metrics: single instance-scoped map keyed by briefDate. */
export const KILL_CRITERION_STATE_KEY = "kill-criterion.v1";

/** PRD § 15.2 tripwire 7: default stale threshold; per-project override possible later. */
export const DEFAULT_STALE_THRESHOLD_DAYS = 30;

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
  /** T-2.6 — weekly hash re-grounding (tripwire 2). */
  staleRehash: "stale-rehash",
  /** T-2.6 — daily source-decay check (tripwire 7). */
  sourceDecayCheck: "source-decay-check",
  /** T-3.6 — daily operating brief at 08:00 local. */
  briefDaily: "brief-daily",
  /** T-3.11 — weekly portfolio review (Mon 09:00). */
  weeklyReview: "weekly-review",
  /** T-3.11 — weekend prep (Fri 16:00). */
  weekendPrep: "weekend-prep",
  /** T-4.8 — daily L0/L1 async steward run (08:20, after the brief). */
  stewardDaily: "steward-daily",
  /**
   * T-2.1 — supervisor tick for the Obsidian filesystem watcher. The watcher
   * itself is a continuous chokidar process started once in `setup()`; this
   * job is a self-healing safety net that (idempotently) restarts it if the
   * worker process was recycled without a fresh `setup()` call, or if the
   * watch handle died silently.
   */
  obsidianWatcherSupervisor: "obsidian-watcher-supervisor",
} as const;

/** T-2.1 — event names emitted by the Obsidian filesystem watcher. */
export const OBSIDIAN_WATCHER_EVENTS = {
  changed: "source.note.changed",
  renamed: "source.note.renamed",
  deleted: "source.note.deleted",
} as const;
