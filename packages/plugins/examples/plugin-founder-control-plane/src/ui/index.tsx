import { useState, type CSSProperties, type ReactNode } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginProjectSidebarItemProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type {
  PortfolioResponse,
  ProjectControlPlaneResponse,
  ProjectConstraintLane,
  ProjectPhase,
  ProjectPortfolioState,
  ProjectPortfolioSummary,
} from "@paperclipai/shared";
import { PLUGIN_ID, SLOT_IDS } from "../constants.js";

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "12px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "14px",
  background: "var(--card, transparent)",
};

const subtleCardStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
  borderRadius: "10px",
  padding: "12px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  marginBottom: "10px",
};

const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "6px 12px",
  fontSize: "12px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

const selectStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "6px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "12px",
  cursor: "pointer",
  minWidth: "120px",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "12px",
  resize: "vertical",
  minHeight: "72px",
  boxSizing: "border-box",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "12px",
  boxSizing: "border-box",
};

const mutedTextStyle: CSSProperties = {
  fontSize: "12px",
  opacity: 0.72,
  lineHeight: 1.45,
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  opacity: 0.65,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  marginBottom: "4px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "12px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid var(--border)",
  fontSize: "11px",
  opacity: 0.65,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
  verticalAlign: "top",
};

// ---------------------------------------------------------------------------
// Badge colour mapping
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<ProjectPortfolioState, string> = {
  primary: "#22c55e",
  active: "#3b82f6",
  blocked: "#ef4444",
  paused: "#f59e0b",
  parked: "#8b5cf6",
  closed: "#6b7280",
};

function portfolioStateBadgeStyle(state: ProjectPortfolioState): CSSProperties {
  const color = STATE_COLORS[state] ?? "#888";
  return {
    display: "inline-block",
    borderRadius: "999px",
    padding: "2px 8px",
    fontSize: "11px",
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 55%, var(--border))`,
    color,
    whiteSpace: "nowrap",
  };
}

function staleIndicatorStyle(stale: string): CSSProperties {
  if (stale === "stale" || stale === "critical") {
    return { color: "#ef4444", fontWeight: 600, fontSize: "11px" };
  }
  if (stale === "aging") {
    return { color: "#f59e0b", fontSize: "11px" };
  }
  return { color: "#22c55e", fontSize: "11px" };
}

// ---------------------------------------------------------------------------
// Small reusable components
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: ProjectPortfolioState }) {
  return <span style={portfolioStateBadgeStyle(state)}>{state}</span>;
}

function WarningBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div
      style={{
        ...subtleCardStyle,
        borderColor: "color-mix(in srgb, #f59e0b 55%, var(--border))",
        background: "color-mix(in srgb, #f59e0b 8%, transparent)",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "6px" }}>
        Warnings
      </div>
      <ul style={{ margin: 0, paddingLeft: "16px", fontSize: "12px" }}>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function LoadingState() {
  return <div style={mutedTextStyle}>Loading…</div>;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      style={{
        ...subtleCardStyle,
        borderColor: "color-mix(in srgb, #ef4444 55%, var(--border))",
        color: "#ef4444",
        fontSize: "12px",
      }}
    >
      {message}
    </div>
  );
}

function SummaryCountGrid({
  primary,
  active,
  blocked,
  stale,
}: {
  primary: number;
  active: number;
  blocked: number;
  stale: number;
}) {
  const counts: Array<{ label: string; value: number; color: string }> = [
    { label: "Primary", value: primary, color: STATE_COLORS.primary },
    { label: "Active", value: active, color: STATE_COLORS.active },
    { label: "Blocked", value: blocked, color: STATE_COLORS.blocked },
    { label: "Stale/Aging", value: stale, color: "#f59e0b" },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "8px",
      }}
    >
      {counts.map(({ label, value, color }) => (
        <div
          key={label}
          style={{
            ...subtleCardStyle,
            textAlign: "center",
            borderColor: `color-mix(in srgb, ${color} 40%, var(--border))`,
          }}
        >
          <div style={{ fontSize: "22px", fontWeight: 700, color }}>{value}</div>
          <div style={{ fontSize: "11px", opacity: 0.7 }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  });
}

// ---------------------------------------------------------------------------
// FounderPortfolioPage
// ---------------------------------------------------------------------------

export function FounderPortfolioPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const portfolioResult = usePluginData<PortfolioResponse>(
    "portfolio",
    companyId ? { companyId } : {},
  );

  const [stateFilter, setStateFilter] = useState<string>("");
  const [laneFilter, setLaneFilter] = useState<string>("");

  if (!companyId) {
    return <div style={mutedTextStyle}>No company context.</div>;
  }

  if (portfolioResult.loading) {
    return (
      <div style={{ padding: "24px" }}>
        <LoadingState />
      </div>
    );
  }

  if (portfolioResult.error) {
    return (
      <div style={{ padding: "24px" }}>
        <ErrorState message={portfolioResult.error.message} />
      </div>
    );
  }

  const data = portfolioResult.data;
  if (!data) return null;

  const projects = data.projects ?? [];
  const summary = data.summary;

  const staleCount =
    projects.filter(
      (p) => p.staleStatus === "stale" || p.staleStatus === "aging" || p.staleStatus === "critical",
    ).length;

  const filtered = projects.filter((p) => {
    if (stateFilter && p.controlPlaneState?.portfolioState !== stateFilter) {
      return false;
    }
    if (laneFilter && p.controlPlaneState?.constraintLane !== laneFilter) {
      return false;
    }
    return true;
  });

  const PORTFOLIO_STATES: ProjectPortfolioState[] = [
    "primary",
    "active",
    "blocked",
    "paused",
    "parked",
    "closed",
  ];
  const LANES: ProjectConstraintLane[] = ["product", "customer", "distribution"];

  return (
    <div style={{ padding: "24px", maxWidth: "1100px" }}>
      <div style={{ ...layoutStack, gap: "20px" }}>
        <div style={sectionHeaderStyle}>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
            Founder Portfolio
          </h2>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => portfolioResult.refresh()}
          >
            Refresh
          </button>
        </div>

        <SummaryCountGrid
          primary={summary.primaryCount}
          active={summary.activeCount}
          blocked={summary.blockedCount}
          stale={staleCount}
        />

        <WarningBanner warnings={data.warnings ?? []} />

        {/* Filters */}
        <div style={{ ...rowStyle, gap: "12px" }}>
          <div>
            <div style={labelStyle}>Portfolio State</div>
            <select
              style={selectStyle}
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
            >
              <option value="">All states</option>
              {PORTFOLIO_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={labelStyle}>Constraint Lane</div>
            <select
              style={selectStyle}
              value={laneFilter}
              onChange={(e) => setLaneFilter(e.target.value)}
            >
              <option value="">All lanes</option>
              {LANES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {(stateFilter || laneFilter) && (
            <div style={{ alignSelf: "flex-end" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  setStateFilter("");
                  setLaneFilter("");
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        {/* Projects table */}
        <div style={cardStyle}>
          {filtered.length === 0 ? (
            <div style={mutedTextStyle}>No projects match the current filters.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Project</th>
                  <th style={thStyle}>State</th>
                  <th style={thStyle}>Phase</th>
                  <th style={thStyle}>Lane</th>
                  <th style={thStyle}>Next Smallest Action</th>
                  <th style={thStyle}>Stale</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const state = p.controlPlaneState;
                  const missingAction =
                    (state?.portfolioState === "primary" ||
                      state?.portfolioState === "active") &&
                    !state?.nextSmallestAction;
                  return (
                    <tr key={p.projectId}>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                      </td>
                      <td style={tdStyle}>
                        {state?.portfolioState ? (
                          <StateBadge state={state.portfolioState} />
                        ) : (
                          <span style={mutedTextStyle}>—</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <span style={mutedTextStyle}>
                          {state?.currentPhase ?? "—"}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={mutedTextStyle}>
                          {state?.constraintLane ?? "—"}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        {missingAction ? (
                          <span style={{ color: "#ef4444", fontSize: "12px" }}>
                            Missing
                          </span>
                        ) : (
                          <span style={mutedTextStyle}>
                            {state?.nextSmallestAction ?? "—"}
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <span style={staleIndicatorStyle(p.staleStatus)}>
                          {p.staleStatus}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FounderDashboardWidget
// ---------------------------------------------------------------------------

export function FounderDashboardWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const portfolioResult = usePluginData<PortfolioResponse>(
    "portfolio",
    companyId ? { companyId } : {},
  );

  if (!companyId) {
    return <div style={mutedTextStyle}>No company context.</div>;
  }

  if (portfolioResult.loading) {
    return (
      <div style={cardStyle}>
        <LoadingState />
      </div>
    );
  }

  if (portfolioResult.error) {
    return (
      <div style={cardStyle}>
        <ErrorState message={portfolioResult.error.message} />
      </div>
    );
  }

  const data = portfolioResult.data;
  if (!data) return null;

  const projects = data.projects ?? [];
  const summary = data.summary;
  const staleCount = projects.filter(
    (p) => p.staleStatus === "stale" || p.staleStatus === "aging" || p.staleStatus === "critical",
  ).length;

  // Top 5 by attention score
  const top5: ProjectPortfolioSummary[] = [...projects]
    .sort((a, b) => b.attentionScore - a.attentionScore)
    .slice(0, 5);

  const firstWarning = data.warnings?.[0] ?? null;

  return (
    <div style={{ ...cardStyle, ...layoutStack }}>
      <div style={sectionHeaderStyle}>
        <strong>Founder Portfolio</strong>
      </div>

      <SummaryCountGrid
        primary={summary.primaryCount}
        active={summary.activeCount}
        blocked={summary.blockedCount}
        stale={staleCount}
      />

      {firstWarning && (
        <div
          style={{
            ...subtleCardStyle,
            borderColor: "color-mix(in srgb, #f59e0b 55%, var(--border))",
            fontSize: "12px",
          }}
        >
          {firstWarning}
        </div>
      )}

      {top5.length > 0 && (
        <div style={layoutStack}>
          <div style={labelStyle}>Top Projects by Attention</div>
          {top5.map((p) => (
            <div
              key={p.projectId}
              style={{ ...rowStyle, justifyContent: "space-between" }}
            >
              <span style={{ fontSize: "12px" }}>{p.name}</span>
              {p.controlPlaneState?.portfolioState ? (
                <StateBadge state={p.controlPlaneState.portfolioState} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FounderProjectSidebarItem
// ---------------------------------------------------------------------------

type ProjectTelemetryData = {
  portfolioState?: ProjectPortfolioState | null;
  staleStatus?: string | null;
};

export function FounderProjectSidebarItem({
  context,
}: PluginProjectSidebarItemProps) {
  const telemetry = usePluginData<ProjectTelemetryData>(
    "project-telemetry",
    context.entityId ? { projectId: context.entityId } : {},
  );

  const href = context.companyPrefix
    ? `/${context.companyPrefix}/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`
    : `/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`;

  return (
    <a
      href={href}
      style={{
        fontSize: "12px",
        textDecoration: "none",
        display: "flex",
        alignItems: "center",
        gap: "6px",
      }}
    >
      Control Plane
      {telemetry.data?.portfolioState ? (
        <StateBadge state={telemetry.data.portfolioState} />
      ) : null}
    </a>
  );
}

// ---------------------------------------------------------------------------
// FounderProjectTab
// ---------------------------------------------------------------------------

type ResumeDraftData = {
  brief: string;
  generatedAt: string;
} | null;

const PORTFOLIO_STATE_OPTIONS: ProjectPortfolioState[] = [
  "primary",
  "active",
  "blocked",
  "paused",
  "parked",
  "closed",
];

const PHASE_OPTIONS: ProjectPhase[] = [
  "exploration",
  "validation",
  "build",
  "distribution",
];

const LANE_OPTIONS: Array<ProjectConstraintLane | ""> = [
  "",
  "product",
  "customer",
  "distribution",
];

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: "12px" }}>{children}</div>
    </div>
  );
}

export function FounderProjectTab({ context }: PluginDetailTabProps) {
  const projectId = context.entityId;
  const companyId = context.companyId;

  const cpResult = usePluginData<ProjectControlPlaneResponse>(
    "project-control-plane",
    projectId && companyId ? { projectId, companyId } : {},
  );

  const resumeResult = usePluginData<ResumeDraftData>(
    "resume-draft",
    projectId ? { projectId } : {},
  );

  const refreshTelemetry = usePluginAction("refresh-project-telemetry");

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [acceptingResume, setAcceptingResume] = useState(false);

  // Form state (populated from loaded data)
  const [formState, setFormState] = useState<{
    portfolioState: ProjectPortfolioState;
    currentPhase: ProjectPhase;
    constraintLane: ProjectConstraintLane | "";
    nextSmallestAction: string;
    blockerSummary: string;
    latestEvidenceChanged: string;
    resumeBrief: string;
    doNotRethink: string;
    killCriteria: string;
    lastMeaningfulOutputTitle: string;
    lastMeaningfulOutputUrl: string;
  } | null>(null);

  function startEdit() {
    const state = cpResult.data?.controlPlaneState;
    if (!state) return;
    setFormState({
      portfolioState: state.portfolioState,
      currentPhase: state.currentPhase,
      constraintLane: state.constraintLane ?? "",
      nextSmallestAction: state.nextSmallestAction ?? "",
      blockerSummary: state.blockerSummary ?? "",
      latestEvidenceChanged: state.latestEvidenceChanged ?? "",
      resumeBrief: state.resumeBrief ?? "",
      doNotRethink: state.doNotRethink ?? "",
      killCriteria: state.killCriteria ?? "",
      lastMeaningfulOutputTitle: state.lastMeaningfulOutput?.title ?? "",
      lastMeaningfulOutputUrl: state.lastMeaningfulOutput?.url ?? "",
    });
    setEditing(true);
    setSaveError(null);
  }

  async function handleSave() {
    if (!formState || !projectId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        portfolioState: formState.portfolioState,
        currentPhase: formState.currentPhase,
        constraintLane: formState.constraintLane || null,
        nextSmallestAction: formState.nextSmallestAction || null,
        blockerSummary: formState.blockerSummary || null,
        latestEvidenceChanged: formState.latestEvidenceChanged || null,
        resumeBrief: formState.resumeBrief || null,
        doNotRethink: formState.doNotRethink || null,
        killCriteria: formState.killCriteria || null,
      };

      if (formState.lastMeaningfulOutputTitle) {
        body.lastMeaningfulOutput = {
          kind: "note",
          id: null,
          title: formState.lastMeaningfulOutputTitle,
          url: formState.lastMeaningfulOutputUrl || null,
        };
      } else {
        body.lastMeaningfulOutput = null;
      }

      await hostFetchJson(`/api/projects/${projectId}/control-plane`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

      if (companyId) {
        await refreshTelemetry({ companyId, projectId }).catch(() => null);
      }

      setEditing(false);
      cpResult.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleAcceptResume() {
    if (!projectId || !resumeResult.data?.brief) return;
    setAcceptingResume(true);
    try {
      await hostFetchJson(`/api/projects/${projectId}/control-plane`, {
        method: "PATCH",
        body: JSON.stringify({ resumeBrief: resumeResult.data.brief }),
      });
      cpResult.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setAcceptingResume(false);
    }
  }

  if (!projectId) {
    return <div style={mutedTextStyle}>No project context.</div>;
  }

  if (cpResult.loading) {
    return (
      <div style={{ padding: "20px" }}>
        <LoadingState />
      </div>
    );
  }

  if (cpResult.error) {
    return (
      <div style={{ padding: "20px" }}>
        <ErrorState message={cpResult.error.message} />
      </div>
    );
  }

  const cpData = cpResult.data;
  const cpState = cpData?.controlPlaneState ?? null;
  const warnings = cpData?.warnings ?? [];

  return (
    <div style={{ padding: "20px", ...layoutStack, gap: "16px" }}>
      <WarningBanner warnings={warnings} />

      {/* Header */}
      <div style={sectionHeaderStyle}>
        <strong style={{ fontSize: "14px" }}>Control Plane</strong>
        <div style={rowStyle}>
          {!editing && cpState && (
            <button type="button" style={buttonStyle} onClick={startEdit}>
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {saveError && <ErrorState message={saveError} />}

      {!cpState && (
        <div style={mutedTextStyle}>No control plane state set for this project.</div>
      )}

      {/* Read-only view */}
      {cpState && !editing && (
        <div style={{ ...cardStyle, ...layoutStack, gap: "12px" }}>
          <FieldRow label="Portfolio State">
            <StateBadge state={cpState.portfolioState} />
          </FieldRow>
          <FieldRow label="Current Phase">
            <span>{cpState.currentPhase}</span>
          </FieldRow>
          <FieldRow label="Constraint Lane">
            <span>{cpState.constraintLane ?? "—"}</span>
          </FieldRow>
          <FieldRow label="Next Smallest Action">
            {cpState.nextSmallestAction ? (
              <span>{cpState.nextSmallestAction}</span>
            ) : (
              <span style={{ color: "#ef4444" }}>Not set</span>
            )}
          </FieldRow>
          <FieldRow label="Blocker Summary">
            <span>{cpState.blockerSummary ?? "—"}</span>
          </FieldRow>
          <FieldRow label="Latest Evidence Changed">
            <span>{cpState.latestEvidenceChanged ?? "—"}</span>
          </FieldRow>
          <FieldRow label="Resume Brief">
            {cpState.resumeBrief ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontSize: "12px",
                  fontFamily: "inherit",
                }}
              >
                {cpState.resumeBrief}
              </pre>
            ) : (
              <span style={mutedTextStyle}>—</span>
            )}
          </FieldRow>
          <FieldRow label="Do Not Rethink">
            <span>{cpState.doNotRethink ?? "—"}</span>
          </FieldRow>
          <FieldRow label="Kill Criteria">
            <span>{cpState.killCriteria ?? "—"}</span>
          </FieldRow>
          <FieldRow label="Last Meaningful Output">
            {cpState.lastMeaningfulOutput ? (
              <span>
                {cpState.lastMeaningfulOutput.url ? (
                  <a
                    href={cpState.lastMeaningfulOutput.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit" }}
                  >
                    {cpState.lastMeaningfulOutput.title}
                  </a>
                ) : (
                  cpState.lastMeaningfulOutput.title
                )}
              </span>
            ) : (
              <span style={mutedTextStyle}>—</span>
            )}
          </FieldRow>
        </div>
      )}

      {/* Edit form */}
      {editing && formState && (
        <div style={{ ...cardStyle, ...layoutStack, gap: "14px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Portfolio State</div>
            <select
              style={selectStyle}
              value={formState.portfolioState}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  portfolioState: e.target.value as ProjectPortfolioState,
                })
              }
            >
              {PORTFOLIO_STATE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Current Phase</div>
            <select
              style={selectStyle}
              value={formState.currentPhase}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  currentPhase: e.target.value as ProjectPhase,
                })
              }
            >
              {PHASE_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Constraint Lane</div>
            <select
              style={selectStyle}
              value={formState.constraintLane}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  constraintLane: e.target.value as ProjectConstraintLane | "",
                })
              }
            >
              {LANE_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l === "" ? "None" : l}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Next Smallest Action</div>
            <input
              style={inputStyle}
              value={formState.nextSmallestAction}
              onChange={(e) =>
                setFormState({ ...formState, nextSmallestAction: e.target.value })
              }
              placeholder="What's the very next step?"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Blocker Summary</div>
            <textarea
              style={textareaStyle}
              value={formState.blockerSummary}
              onChange={(e) =>
                setFormState({ ...formState, blockerSummary: e.target.value })
              }
              placeholder="Describe the current blocker…"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Latest Evidence Changed</div>
            <textarea
              style={textareaStyle}
              value={formState.latestEvidenceChanged}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  latestEvidenceChanged: e.target.value,
                })
              }
              placeholder="What new evidence changed your model?"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Resume Brief</div>
            <textarea
              style={{ ...textareaStyle, minHeight: "120px" }}
              value={formState.resumeBrief}
              onChange={(e) =>
                setFormState({ ...formState, resumeBrief: e.target.value })
              }
              placeholder="Brief for resuming this project…"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Do Not Rethink</div>
            <textarea
              style={textareaStyle}
              value={formState.doNotRethink}
              onChange={(e) =>
                setFormState({ ...formState, doNotRethink: e.target.value })
              }
              placeholder="Decisions already made — don't revisit…"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Kill Criteria</div>
            <textarea
              style={textareaStyle}
              value={formState.killCriteria}
              onChange={(e) =>
                setFormState({ ...formState, killCriteria: e.target.value })
              }
              placeholder="Conditions under which this project should be killed…"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Last Meaningful Output — Title</div>
            <input
              style={inputStyle}
              value={formState.lastMeaningfulOutputTitle}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  lastMeaningfulOutputTitle: e.target.value,
                })
              }
              placeholder="Title of the last deliverable or output"
            />
          </div>

          <div style={{ display: "grid", gap: "4px" }}>
            <div style={labelStyle}>Last Meaningful Output — URL</div>
            <input
              style={inputStyle}
              value={formState.lastMeaningfulOutputUrl}
              onChange={(e) =>
                setFormState({
                  ...formState,
                  lastMeaningfulOutputUrl: e.target.value,
                })
              }
              placeholder="https://…"
            />
          </div>
        </div>
      )}

      {/* Resume draft section */}
      {resumeResult.data?.brief && (
        <div style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <strong style={{ fontSize: "13px" }}>Resume Draft</strong>
            <div style={rowStyle}>
              <span style={mutedTextStyle}>
                {resumeResult.data.generatedAt
                  ? new Date(resumeResult.data.generatedAt).toLocaleString()
                  : ""}
              </span>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => void handleAcceptResume()}
                disabled={acceptingResume}
              >
                {acceptingResume ? "Accepting…" : "Accept as Canonical"}
              </button>
            </div>
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              fontSize: "12px",
              fontFamily: "inherit",
              opacity: 0.85,
            }}
          >
            {resumeResult.data.brief}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FounderToolbarButton
// ---------------------------------------------------------------------------

export function FounderToolbarButton() {
  const context = useHostContext();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const projectId = context.entityId;

  async function patchState(portfolioState: ProjectPortfolioState) {
    if (!projectId) return;
    setOpen(false);
    setStatus("Saving…");
    try {
      await hostFetchJson(`/api/projects/${projectId}/control-plane`, {
        method: "PATCH",
        body: JSON.stringify({ portfolioState }),
      });
      setStatus(`Set to ${portfolioState}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    setTimeout(() => setStatus(null), 2500);
  }

  const ACTIONS: Array<{ label: string; state: ProjectPortfolioState }> = [
    { label: "Set Primary", state: "primary" },
    { label: "Mark Active", state: "active" },
    { label: "Mark Blocked", state: "blocked" },
    { label: "Pause", state: "paused" },
    { label: "Park", state: "parked" },
  ];

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => setOpen((v) => !v)}
        disabled={!projectId}
      >
        Control Plane
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 999,
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            padding: "4px",
            minWidth: "160px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          {ACTIONS.map(({ label, state }) => (
            <button
              key={state}
              type="button"
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderRadius: "6px",
                padding: "7px 10px",
                fontSize: "12px",
                cursor: "pointer",
                color: "inherit",
              }}
              onClick={() => void patchState(state)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {status && (
        <span
          style={{
            marginLeft: "8px",
            fontSize: "11px",
            opacity: 0.7,
          }}
        >
          {status}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FounderContextMenuItem
// ---------------------------------------------------------------------------

export function FounderContextMenuItem() {
  const context = useHostContext();

  const href = context.companyPrefix
    ? `/${context.companyPrefix}/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`
    : `/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`;

  return (
    <a
      href={href}
      style={{
        display: "block",
        fontSize: "12px",
        textDecoration: "none",
        color: "inherit",
        padding: "2px 0",
      }}
    >
      View Control Plane
    </a>
  );
}
