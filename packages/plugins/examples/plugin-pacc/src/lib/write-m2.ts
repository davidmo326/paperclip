/**
 * writeM2 — the M2 canonical-state mediator (T-2.5).
 *
 * Every state-mutating code path in pacc routes through here so the
 * tripwires in PRD § 15.2 are enforced uniformly:
 *
 *   1. Provenance — agent-actor writes require sourceRefs[]; principal-actor
 *      writes are allowed without (the principal IS the source).
 *   3. Confidence floors per authority — L2 ≥ 0.7, L3 ≥ 0.85, unless
 *      confidenceSource === 'human_asserted' which bypasses the floor.
 *
 * Audit trail — `m2.write.attempted` is emitted on every call (success,
 * rejection, candidate, or conflict). T-3.10 (kill-criterion meter) reads
 * this stream.
 *
 * Scope cuts vs the original ticket:
 *   - The "Drizzle query-builder wrapper" enforcement requires paperclip
 *     server-side code; the plugin doesn't have direct DB access. The
 *     TypeScript-side enforcement (everything in pacc calls writeM2) is
 *     delivered here. Server-side interception is filed as follow-up
 *     T-2.5-server-enforcement.
 *
 * Architecture: the `WriteM2Adapter` interface lets the same logic dispatch
 * to a UI-fetch path (for principal-initiated writes from the web UI) or
 * to a worker-API path (for agent-initiated writes from the steward).
 */

import { sourceRefSchema } from "@paperclipai/shared";
import type { SourceRef } from "@paperclipai/shared";
import type {
  AuthorityLevel,
  JobClassification,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type M2WriteErrorCode =
  | "NO_SOURCE_REFS"
  | "INVALID_SOURCE_REF"
  | "INVALID_ACTOR"
  | "INVALID_CONFIDENCE"
  | "CONFIDENCE_FLOOR"
  | "L4_REQUIRES_HUMAN_APPROVAL"
  | "INVALID_JOB_CLASSIFICATION";

export class M2WriteError extends Error {
  constructor(
    public readonly code: M2WriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "M2WriteError";
  }
}

/**
 * Thrown when downstream code attempts an M2 write outside the mediator.
 * The plugin's own write paths in this codebase always go through
 * `writeM2`/`proposeM2`. A future server-side ticket will enforce this at
 * the Drizzle layer too.
 */
export class M2WriteOutsideMediatorError extends Error {
  constructor(target: string) {
    super(
      `Direct write to ${target} attempted outside writeM2 mediator. ` +
        `Use writeM2 from packages/plugins/examples/plugin-pacc/src/lib/write-m2.ts.`,
    );
    this.name = "M2WriteOutsideMediatorError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actor pattern: 'principal' or 'agent:<id>' per PRD § 9.7 / § 15.2. */
const ACTOR_PATTERN = /^(principal|agent:[A-Za-z0-9._:-]+)$/;

export type WriteM2Op =
  | {
      readonly kind: "projectState";
      readonly projectId: string;
      /** Partial `ProjectControlPlaneState` patch. Validated server-side. */
      readonly patch: Record<string, unknown>;
    }
  | {
      readonly kind: "decision";
      readonly projectId: string;
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: "authorityProfile";
      readonly data: Record<string, unknown>;
    };

export interface WriteM2Opts {
  /**
   * Citations from the M1a/M1b/M2 tier supporting this write. Required for
   * `agent:*` actors (tripwire 1). For `principal` actor, may be empty
   * (the principal IS the source).
   */
  sourceRefs: SourceRef[];
  /** Float in [0..1]. Combined with `confidenceSource` to apply tripwire 3. */
  confidence: number;
  /**
   * `agent_inferred` triggers the L2/L3 confidence floors.
   * `human_asserted` bypasses them (per PRD § 15.2 tripwire 3).
   */
  confidenceSource: "agent_inferred" | "human_asserted";
  /** `principal` or `agent:<id>`. */
  actor: string;
  /** Per PRD § 8.1 / § 8.5. */
  jobClassification: JobClassification;
  /**
   * Authority level required for this write. Default `L2` (canonical state
   * writes are inherently L2). L4/L5 must go through approvals, not writeM2.
   */
  requiredAuthority?: AuthorityLevel;
}

export type M2AuditStatus = "success" | "rejected" | "candidate" | "conflict";

export interface M2WriteAttemptedEvent {
  readonly emittedAt: string;
  readonly opKind: WriteM2Op["kind"];
  readonly status: M2AuditStatus;
  readonly actor: string;
  readonly confidence: number;
  readonly confidenceSource: WriteM2Opts["confidenceSource"];
  readonly authorityLevel: AuthorityLevel;
  readonly jobClassification: JobClassification;
  readonly sourceRefCount: number;
  readonly errorCode?: M2WriteErrorCode;
  readonly reason?: string;
}

/**
 * Concrete implementations:
 *   - `UiWriteM2Adapter` — wraps paperclip's API endpoints via hostFetchJson.
 *   - `WorkerWriteM2Adapter` (TODO) — wraps `ctx.host.fetch` from a worker.
 *   - `InMemoryWriteM2Adapter` (test fixture) — captures audit events.
 */
export interface WriteM2Adapter {
  writeProjectState(
    projectId: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  writeDecision(
    projectId: string,
    data: Record<string, unknown>,
  ): Promise<{ id: string }>;
  writeAuthorityProfile(
    data: Record<string, unknown>,
  ): Promise<{ id: string }>;
  emitAuditEvent(event: M2WriteAttemptedEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Validation =
  | { ok: true; authorityLevel: AuthorityLevel }
  | { ok: false; code: M2WriteErrorCode; reason: string };

function validate(op: WriteM2Op, opts: WriteM2Opts): Validation {
  // Actor pattern
  if (!ACTOR_PATTERN.test(opts.actor)) {
    return {
      ok: false,
      code: "INVALID_ACTOR",
      reason: `actor must match ${ACTOR_PATTERN}, got "${opts.actor}"`,
    };
  }

  const isPrincipal = opts.actor === "principal";

  // Tripwire 1: provenance enforcement
  if (!isPrincipal && opts.sourceRefs.length === 0) {
    return {
      ok: false,
      code: "NO_SOURCE_REFS",
      reason:
        "agent-actor M2 writes require sourceRefs[] (PRD § 15.2 tripwire 1)",
    };
  }
  for (const ref of opts.sourceRefs) {
    const parsed = sourceRefSchema.safeParse(ref);
    if (!parsed.success) {
      return {
        ok: false,
        code: "INVALID_SOURCE_REF",
        reason: `invalid SourceRef: ${parsed.error.errors[0]?.message ?? "unknown"}`,
      };
    }
  }

  // Confidence range
  if (
    typeof opts.confidence !== "number" ||
    !Number.isFinite(opts.confidence) ||
    opts.confidence < 0 ||
    opts.confidence > 1
  ) {
    return {
      ok: false,
      code: "INVALID_CONFIDENCE",
      reason: `confidence must be a finite number in [0..1], got ${opts.confidence}`,
    };
  }

  // Authority gating
  const level: AuthorityLevel = opts.requiredAuthority ?? "L2";
  if (level === "L4" || level === "L5") {
    return {
      ok: false,
      code: "L4_REQUIRES_HUMAN_APPROVAL",
      reason: `${level} writes go through approval flow, not writeM2 (PRD § 10)`,
    };
  }

  // Tripwire 3: confidence floors — only enforced for agent_inferred
  if (opts.confidenceSource === "agent_inferred") {
    const floor = level === "L3" ? 0.85 : level === "L2" ? 0.7 : 0;
    if (opts.confidence < floor) {
      return {
        ok: false,
        code: "CONFIDENCE_FLOOR",
        reason:
          `confidence ${opts.confidence} below floor ${floor} for ${level} ` +
          `(PRD § 15.2 tripwire 3). Set confidenceSource='human_asserted' to bypass.`,
      };
    }
  }

  // jobClassification (cheap inline check)
  const validJobClasses = new Set<JobClassification>([
    "J1_signal",
    "J2_distribution",
    "J3_product",
    "meta",
  ]);
  if (!validJobClasses.has(opts.jobClassification)) {
    return {
      ok: false,
      code: "INVALID_JOB_CLASSIFICATION",
      reason: `jobClassification must be one of ${[...validJobClasses].join("/")}`,
    };
  }

  // op-specific validation hooks (decision/authorityProfile shape is checked
  // server-side at the API layer for now; this is the boundary).
  void op;

  return { ok: true, authorityLevel: level };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform an M2 write. Validates inputs, dispatches via the adapter, emits
 * audit. Throws `M2WriteError` if validation fails (audit event is still
 * emitted with status='rejected' so the kill-criterion meter sees it).
 */
export async function writeM2(
  op: WriteM2Op,
  opts: WriteM2Opts,
  adapter: WriteM2Adapter,
): Promise<void> {
  const v = validate(op, opts);
  if (!v.ok) {
    await adapter.emitAuditEvent(
      auditEvent(op, opts, opts.requiredAuthority ?? "L2", "rejected", {
        errorCode: v.code,
        reason: v.reason,
      }),
    );
    throw new M2WriteError(v.code, v.reason);
  }

  switch (op.kind) {
    case "projectState":
      await adapter.writeProjectState(op.projectId, op.patch);
      break;
    case "decision":
      await adapter.writeDecision(op.projectId, op.data);
      break;
    case "authorityProfile":
      await adapter.writeAuthorityProfile(op.data);
      break;
  }

  await adapter.emitAuditEvent(
    auditEvent(op, opts, v.authorityLevel, "success"),
  );
}

/**
 * Propose an M2 write as a candidate (PRD § 9.3: "candidate memory cannot
 * silently overwrite accepted canonical state"). Same validation as writeM2
 * except confidence floors are NOT enforced — proposals are drafts.
 *
 * Provenance (sourceRefs) is still required for agent actors.
 *
 * MVP behavior: emits a `m2.write.attempted` audit event with
 * status='candidate'. Storing the candidate row itself is the adapter's
 * concern (most implementations will write to a separate candidate table
 * or set `status='candidate'` on the same row).
 */
export async function proposeM2(
  op: WriteM2Op,
  opts: Omit<WriteM2Opts, "confidenceSource">,
  adapter: WriteM2Adapter,
): Promise<void> {
  const fullOpts: WriteM2Opts = {
    ...opts,
    // Synthetic confidenceSource bypasses the floor — proposals are drafts.
    confidenceSource: "human_asserted",
  };
  const v = validate(op, fullOpts);
  if (!v.ok) {
    await adapter.emitAuditEvent(
      auditEvent(op, fullOpts, opts.requiredAuthority ?? "L2", "rejected", {
        errorCode: v.code,
        reason: v.reason,
      }),
    );
    throw new M2WriteError(v.code, v.reason);
  }

  // Adapter dispatch is intentionally NOT called here — candidate writes
  // go to a different store (candidate table / draft column) which the
  // adapter's caller will route. Emit the audit and return.
  await adapter.emitAuditEvent(
    auditEvent(op, fullOpts, v.authorityLevel, "candidate"),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditEvent(
  op: WriteM2Op,
  opts: WriteM2Opts,
  authorityLevel: AuthorityLevel,
  status: M2AuditStatus,
  extras: { errorCode?: M2WriteErrorCode; reason?: string } = {},
): M2WriteAttemptedEvent {
  return {
    emittedAt: new Date().toISOString(),
    opKind: op.kind,
    status,
    actor: opts.actor,
    confidence: opts.confidence,
    confidenceSource: opts.confidenceSource,
    authorityLevel,
    jobClassification: opts.jobClassification,
    sourceRefCount: opts.sourceRefs.length,
    ...extras,
  };
}

/** In-memory adapter for tests. Captures every audit event and write. */
export class InMemoryWriteM2Adapter implements WriteM2Adapter {
  readonly auditEvents: M2WriteAttemptedEvent[] = [];
  readonly projectStateWrites: Array<{ projectId: string; patch: Record<string, unknown> }> = [];
  readonly decisionWrites: Array<{ projectId: string; data: Record<string, unknown>; id: string }> = [];
  readonly authorityProfileWrites: Array<{ data: Record<string, unknown>; id: string }> = [];

  async writeProjectState(projectId: string, patch: Record<string, unknown>) {
    this.projectStateWrites.push({ projectId, patch });
  }
  async writeDecision(projectId: string, data: Record<string, unknown>) {
    const id = `dec-${this.decisionWrites.length + 1}`;
    this.decisionWrites.push({ projectId, data, id });
    return { id };
  }
  async writeAuthorityProfile(data: Record<string, unknown>) {
    const id = `auth-${this.authorityProfileWrites.length + 1}`;
    this.authorityProfileWrites.push({ data, id });
    return { id };
  }
  async emitAuditEvent(event: M2WriteAttemptedEvent) {
    this.auditEvents.push(event);
  }
}
