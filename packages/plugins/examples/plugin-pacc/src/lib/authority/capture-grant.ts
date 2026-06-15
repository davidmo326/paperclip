/**
 * Authority-grant orchestration — T-4.6 (I/O glue over authority-grant.ts).
 * Deps-injected for testability; the worker wires these to `ctx.entities`.
 */

import {
  makeGrantRecord,
  applyRevoke,
  isActiveAt,
  checkAuthority,
  GrantValidationError,
  type GrantInput,
  type GrantRecord,
  type AuthorityRequest,
} from "./authority-grant.js";

export interface GrantDeps {
  getGrant(id: string): Promise<GrantRecord | null>;
  listGrants(): Promise<GrantRecord[]>;
  putGrant(record: GrantRecord): Promise<void>;
  newId(): string;
}

export async function recordGrant(
  deps: GrantDeps,
  input: GrantInput,
  opts: { now: Date; grantedBy: string },
): Promise<GrantRecord> {
  const record = makeGrantRecord(input, { id: deps.newId(), now: opts.now, grantedBy: opts.grantedBy });
  await deps.putGrant(record);
  return record;
}

export async function revokeGrant(deps: GrantDeps, id: string, now: Date): Promise<GrantRecord> {
  const grant = await deps.getGrant(id);
  if (!grant) throw new GrantValidationError("ALREADY_REVOKED", `no such grant: ${id}`);
  const updated = applyRevoke(grant, now);
  await deps.putGrant(updated);
  return updated;
}

/** Active grants at `now` (live, not revoked, not expired). */
export async function listActiveGrants(deps: GrantDeps, now: Date): Promise<GrantRecord[]> {
  const all = await deps.listGrants();
  return all.filter((g) => isActiveAt(g, now)).sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1));
}

/** Enforcement check against the live grant set (T-5.1 calls this). */
export async function evaluateAuthority(deps: GrantDeps, req: AuthorityRequest): Promise<boolean> {
  return checkAuthority(await deps.listGrants(), req);
}
