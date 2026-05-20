/**
 * UI-side WriteM2Adapter — wraps `hostFetchJson` so principal-initiated
 * writes from the browser go through the same mediator as agent writes
 * (T-2.5).
 *
 * Audit emission is currently `console.debug` because the plugin SDK doesn't
 * yet expose an audit-event sink to the browser context. A future ticket
 * (T-2.5-server-enforcement) will wire this up to a real endpoint so the
 * `m2.write.attempted` stream is durable. Until then the UI's writes are
 * still validated through writeM2 — the audit is just transient.
 */

import {
  writeM2,
  type WriteM2Adapter,
  type M2WriteAttemptedEvent,
} from "../lib/write-m2.js";

export interface HostFetchJson {
  <T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

export class UiWriteM2Adapter implements WriteM2Adapter {
  constructor(private readonly hostFetchJson: HostFetchJson) {}

  async writeProjectState(
    projectId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.hostFetchJson(`/api/projects/${projectId}/control-plane`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async writeDecision(
    projectId: string,
    data: Record<string, unknown>,
  ): Promise<{ id: string }> {
    // Server endpoint not yet implemented (decisions/authority_profiles ship
    // in T-1.4 but the HTTP write surface is downstream of T-2.5).
    throw new Error(
      `writeDecision via UI adapter not yet implemented (project=${projectId}, ` +
        `keys=${Object.keys(data).join(",")}). Tracked under T-2.5-server-enforcement.`,
    );
  }

  async writeAuthorityProfile(
    data: Record<string, unknown>,
  ): Promise<{ id: string }> {
    throw new Error(
      `writeAuthorityProfile via UI adapter not yet implemented ` +
        `(keys=${Object.keys(data).join(",")}). Tracked under T-2.5-server-enforcement.`,
    );
  }

  async emitAuditEvent(event: M2WriteAttemptedEvent): Promise<void> {
    if (typeof console !== "undefined") {
      console.debug("[pacc:m2.write.attempted]", event);
    }
  }
}

/**
 * Convenience wrapper for principal-initiated project-state writes from the
 * UI. Fills in the principal defaults so callers only pass what differs.
 *
 * `confidence=1` + `confidenceSource='human_asserted'` bypasses tripwire 3
 * (the principal is asserting). `sourceRefs=[]` is allowed for the principal
 * actor per tripwire 1.
 */
export async function writeProjectStateFromUi(
  hostFetchJson: HostFetchJson,
  projectId: string,
  patch: Record<string, unknown>,
  opts: {
    jobClassification?:
      | "J1_signal"
      | "J2_distribution"
      | "J3_product"
      | "meta";
  } = {},
): Promise<void> {
  const adapter = new UiWriteM2Adapter(hostFetchJson);
  await writeM2(
    { kind: "projectState", projectId, patch },
    {
      sourceRefs: [],
      confidence: 1,
      confidenceSource: "human_asserted",
      actor: "principal",
      jobClassification: opts.jobClassification ?? "meta",
    },
    adapter,
  );
}
