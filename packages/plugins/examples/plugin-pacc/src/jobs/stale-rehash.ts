/**
 * stale-rehash job — T-2.6 / PRD § 15.2 tripwire 2.
 *
 * Walks every active project, collects the SourceRefs from its
 * controlPlaneState (memoryIndexRefs, sourceRefs, assumptions[].sourceRefs,
 * hypotheses[].evidenceFor/Against, escalations[].sourceRefs), re-hashes
 * each cited file, and writes a freshness report into plugin_state so the
 * brief generator can decorate the affected M2 fields as
 * `stale_pending_re_grounding`.
 *
 * The actual decoration of M2 rows (changing controlPlaneState in-place to
 * mark fields stale) is intentionally NOT done here — that would require
 * an L2 write through writeM2, which is the next ticket's responsibility.
 * For now the freshness report lives in plugin_state and downstream code
 * (brief generator, UI) reads it as a side-band overlay.
 *
 * Pure-ish: filesystem reads + ctx-like dispatch only. The minimal context
 * shape `StaleRehashCtx` lets this function be unit-tested with stubs.
 */

import type { SourceRef } from "@paperclipai/shared";
import {
  checkSourceRefsFreshness,
  collectSourceRefsFromControlPlaneState,
  type FreshnessReport,
} from "../lib/stale-detection.js";
import { FRESHNESS_STATE_KEY, PLUGIN_NAMESPACE } from "../constants.js";

// ---------------------------------------------------------------------------
// Minimal ctx shape (subset of PluginContext we actually use)
// ---------------------------------------------------------------------------

export interface StaleRehashCompany {
  id: string;
}

export interface StaleRehashProject {
  id: string;
  /**
   * Loosely typed because paperclip's `Project.controlPlaneState` is a typed
   * interface but we only need to read a few JSON-array fields out of it.
   * The collector function narrows at runtime.
   */
  controlPlaneState: unknown;
}

export interface StaleRehashLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface StaleRehashCtx {
  companies: {
    list(opts: { limit: number; offset: number }): Promise<StaleRehashCompany[]>;
  };
  projects: {
    list(opts: { companyId: string; limit: number; offset: number }): Promise<StaleRehashProject[]>;
  };
  state: {
    set(scope: { scopeKind: "project"; scopeId: string; namespace: string; stateKey: string }, value: unknown): Promise<void>;
  };
  logger: StaleRehashLogger;
}

// ---------------------------------------------------------------------------
// Per-project freshness payload — what we write to plugin_state
// ---------------------------------------------------------------------------

export interface ProjectFreshnessRecord {
  projectId: string;
  generatedAt: string;
  totalRefs: number;
  freshCount: number;
  staleCount: number;
  orphanedCount: number;
  hasDrift: boolean;
  /** Up to 50 drift entries; truncates beyond to keep plugin_state row size sane. */
  drifts: Array<{
    path: string;
    kind: "stale" | "orphaned";
    expectedHash: string;
    currentHash?: string;
  }>;
}

export function buildFreshnessRecord(
  projectId: string,
  report: FreshnessReport,
  now: Date = new Date(),
): ProjectFreshnessRecord {
  const drifts = [...report.stale, ...report.orphaned]
    .slice(0, 50)
    .map((r) => {
      if (r.kind === "stale") {
        return {
          path: r.path,
          kind: "stale" as const,
          expectedHash: r.expectedHash,
          currentHash: r.currentHash,
        };
      }
      return {
        path: r.path,
        kind: "orphaned" as const,
        expectedHash: r.expectedHash,
      };
    });
  return {
    projectId,
    generatedAt: now.toISOString(),
    totalRefs: report.totalRefs,
    freshCount: report.fresh.length,
    staleCount: report.stale.length,
    orphanedCount: report.orphaned.length,
    hasDrift: report.hasDrift,
    drifts,
  };
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

export interface RunStaleRehashResult {
  projectsScanned: number;
  projectsWithDrift: number;
  refsChecked: number;
}

export async function runStaleRehash(
  ctx: StaleRehashCtx,
  options: { now?: Date } = {},
): Promise<RunStaleRehashResult> {
  const now = options.now ?? new Date();
  const companies = await ctx.companies.list({ limit: 200, offset: 0 });

  let projectsScanned = 0;
  let projectsWithDrift = 0;
  let refsChecked = 0;

  for (const company of companies) {
    const projects = await ctx.projects.list({
      companyId: company.id,
      limit: 200,
      offset: 0,
    });

    for (const project of projects) {
      const refs: SourceRef[] = collectSourceRefsFromControlPlaneState(
        project.controlPlaneState ?? null,
      );
      if (refs.length === 0) {
        projectsScanned += 1;
        continue;
      }

      let report: FreshnessReport;
      try {
        report = await checkSourceRefsFreshness(refs);
      } catch (err) {
        ctx.logger.warn("stale-rehash: failed to check refs", {
          projectId: project.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      refsChecked += refs.length;
      projectsScanned += 1;
      if (report.hasDrift) projectsWithDrift += 1;

      const record = buildFreshnessRecord(project.id, report, now);
      await ctx.state.set(
        {
          scopeKind: "project",
          scopeId: project.id,
          namespace: PLUGIN_NAMESPACE,
          stateKey: FRESHNESS_STATE_KEY,
        },
        record,
      );
    }
  }

  ctx.logger.info("stale-rehash job complete", {
    projectsScanned,
    projectsWithDrift,
    refsChecked,
  });

  return { projectsScanned, projectsWithDrift, refsChecked };
}
