/**
 * Authority grants — pure core (T-4.6, PRD § 10).
 *
 * A grant authorizes an agent (or any agent, when agentId is null) to act up to
 * a `ceiling` level for a given `actionClass` on a project (or portfolio-wide
 * when projectId is null), until `expiresAt`. Authority is NEVER auto-granted —
 * `grantedBy` is always the principal (§ 10). Every grant has an explicit expiry
 * (default 30 days); revocation sets `revokedAt` (never deletes).
 *
 * Storage note (same as decisions, T-4.4): the plugin has no SDK access to the
 * core `authority_profiles` table (T-1.4); grants persist via `ctx.entities`.
 * The shape matches § 10 so a later core migration is mechanical.
 */

import type { AuthorityLevel } from "@paperclipai/shared";

export const ACTION_CLASSES = ["read", "draft", "state", "local-exec", "material", "strategic"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const AUTHORITY_LEVELS: AuthorityLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];
const LEVEL_RANK: Record<AuthorityLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };

export type GrantStatus = "active" | "revoked";

export interface GrantInput {
  /** Null = portfolio-wide (applies to every project unless a per-project grant overrides). */
  projectId: string | null;
  /** Null = any agent. */
  agentId: string | null;
  actionClass: ActionClass;
  ceiling: AuthorityLevel;
  /** ISO-8601 expiry. */
  expiresAt: string;
  notes?: string | null;
}

export interface GrantRecord {
  id: string;
  projectId: string | null;
  agentId: string | null;
  actionClass: ActionClass;
  ceiling: AuthorityLevel;
  /** Always "principal" (§ 10 — authority is never auto-granted). */
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  notes: string | null;
  status: GrantStatus;
  actor: string;
  createdAt: string;
  updatedAt: string;
}

export type GrantErrorCode =
  | "INVALID_CEILING"
  | "INVALID_ACTION_CLASS"
  | "NOT_PRINCIPAL"
  | "INVALID_EXPIRY"
  | "ALREADY_REVOKED";

export class GrantValidationError extends Error {
  constructor(
    public readonly code: GrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GrantValidationError";
  }
}

/** Parse an `--expires-in` spec (e.g. "30d", "12h", "2w") into an ISO expiry. */
export function parseExpiresIn(spec: string, now: Date): string {
  const m = /^(\d+)([hdw])$/.exec(spec.trim());
  if (!m) throw new GrantValidationError("INVALID_EXPIRY", `--expires-in must look like 30d / 12h / 2w (got "${spec}")`);
  const n = Number(m[1]);
  const unitMs = m[2] === "h" ? 3_600_000 : m[2] === "d" ? 86_400_000 : 7 * 86_400_000;
  return new Date(now.getTime() + n * unitMs).toISOString();
}

export function makeGrantRecord(
  input: GrantInput,
  opts: { id: string; now: Date; grantedBy: string },
): GrantRecord {
  if (!AUTHORITY_LEVELS.includes(input.ceiling)) {
    throw new GrantValidationError("INVALID_CEILING", `ceiling must be one of ${AUTHORITY_LEVELS.join("/")}`);
  }
  if (!ACTION_CLASSES.includes(input.actionClass)) {
    throw new GrantValidationError("INVALID_ACTION_CLASS", `actionClass must be one of ${ACTION_CLASSES.join("/")}`);
  }
  if (opts.grantedBy !== "principal") {
    throw new GrantValidationError("NOT_PRINCIPAL", "authority is never auto-granted — grantedBy must be principal (PRD § 10)");
  }
  if (Number.isNaN(new Date(input.expiresAt).getTime()) || new Date(input.expiresAt).getTime() <= opts.now.getTime()) {
    throw new GrantValidationError("INVALID_EXPIRY", "expiresAt must be a future ISO timestamp");
  }
  const iso = opts.now.toISOString();
  return {
    id: opts.id,
    projectId: input.projectId,
    agentId: input.agentId,
    actionClass: input.actionClass,
    ceiling: input.ceiling,
    grantedBy: "principal",
    grantedAt: iso,
    expiresAt: input.expiresAt,
    revokedAt: null,
    notes: input.notes ?? null,
    status: "active",
    actor: "principal",
    createdAt: iso,
    updatedAt: iso,
  };
}

export function applyRevoke(grant: GrantRecord, now: Date): GrantRecord {
  if (grant.status === "revoked") {
    throw new GrantValidationError("ALREADY_REVOKED", `grant ${grant.id} is already revoked`);
  }
  const iso = now.toISOString();
  return { ...grant, status: "revoked", revokedAt: iso, updatedAt: iso };
}

/** True iff the grant is live at `now` (active, not revoked, not expired). */
export function isActiveAt(grant: GrantRecord, now: Date): boolean {
  return (
    grant.status === "active" &&
    grant.revokedAt === null &&
    new Date(grant.expiresAt).getTime() > now.getTime()
  );
}

export interface AuthorityRequest {
  projectId: string;
  actionClass: ActionClass;
  level: AuthorityLevel;
  agentId?: string | null;
  now: Date;
}

/**
 * Enforcement check (used by T-5.1): is there a live grant authorizing `level`
 * for `actionClass` on `projectId`? A per-project grant or a portfolio-wide
 * grant (projectId null) both count; an agent-scoped grant matches only its
 * agent (a null-agent grant matches any agent).
 */
export function checkAuthority(grants: readonly GrantRecord[], req: AuthorityRequest): boolean {
  const want = LEVEL_RANK[req.level];
  return grants.some((g) => {
    if (!isActiveAt(g, req.now)) return false;
    if (g.actionClass !== req.actionClass) return false;
    if (g.projectId !== null && g.projectId !== req.projectId) return false;
    if (g.agentId !== null && req.agentId != null && g.agentId !== req.agentId) return false;
    return LEVEL_RANK[g.ceiling] >= want;
  });
}

/** Grants expiring within `days` of `now` (still active). For the weekly review. */
export function selectExpiringGrants(grants: readonly GrantRecord[], now: Date, days: number): GrantRecord[] {
  const horizon = now.getTime() + days * 86_400_000;
  return grants
    .filter((g) => isActiveAt(g, now) && new Date(g.expiresAt).getTime() <= horizon)
    .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1));
}
