/**
 * T-1.4 integration test — cross-FK constraints on `decisions` and
 * `authority_profiles`.
 *
 * KNOWN VITEST HARNESS QUIRK: This file passes 10/10 when run in isolation
 * (`pnpm exec vitest run decisions-authority-profiles.test.ts`) but fails
 * when run as part of the full db-package suite because of a race with
 * `client.test.ts`'s migration-history fixtures. The schema and FK behavior
 * are validated by the standalone pass; the quirk is about test
 * orchestration, not about the code under test. Investigated by T-1.4;
 * see PHASE_LOG 2026-05-20 for the diagnosis. Filed as informal follow-up.
 *
 *
 * Verifies:
 *   - the 0047 migration applies cleanly on a fresh DB
 *   - FK constraints enforce the expected ON DELETE behavior:
 *       * decisions.project_id  -> projects (cascade)
 *       * decisions.approval_ref -> approvals (set null)
 *       * decisions.supersedes  -> decisions (set null)
 *       * authority_profiles.project_id -> projects (cascade)
 *       * authority_profiles.agent_id -> agents (cascade)
 *   - the unique index on (agent_id, project_id, action_class) enforces
 *     one-active-grant-per-key (T-5.2 expiry sweep depends on this).
 *
 * Uses paperclip's embedded-postgres test harness so each test gets a
 * fresh isolated DB with all migrations applied.
 */
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeIfPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!support.supported) {
  console.warn(
    `Skipping decisions/authority_profiles integration tests: ${support.reason ?? "unsupported"}`,
  );
}

async function freshDb() {
  const db = await startEmbeddedPostgresTestDatabase("pacc-t14-");
  cleanups.push(db.cleanup);
  return postgres(db.connectionString);
}

/**
 * Seeds a company + agent + project + (optionally) an approval. Returns the ids.
 * Uses minimal columns to keep the test resilient to unrelated schema additions.
 */
async function seedBaseRows(sql: ReturnType<typeof postgres>) {
  const [{ id: companyId }] = await sql<Array<{ id: string }>>`
    INSERT INTO companies (name) VALUES ('test-co') RETURNING id
  `;
  const [{ id: agentId }] = await sql<Array<{ id: string }>>`
    INSERT INTO agents (company_id, name) VALUES (${companyId}, 'steward') RETURNING id
  `;
  const [{ id: projectId }] = await sql<Array<{ id: string }>>`
    INSERT INTO projects (company_id, name) VALUES (${companyId}, 'test-project') RETURNING id
  `;
  const [{ id: approvalId }] = await sql<Array<{ id: string }>>`
    INSERT INTO approvals (company_id, type, payload)
    VALUES (${companyId}, 'decision_review', '{}'::jsonb)
    RETURNING id
  `;
  return { companyId, agentId, projectId, approvalId };
}

describeIfPostgres("decisions table — FK and supersedes graph", () => {
  it("applies migration 0047 and creates the table", async () => {
    const sql = await freshDb();
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='decisions'
    `;
    expect(rows).toHaveLength(1);
    await sql.end();
  });

  it("CASCADEs decisions when their project is deleted", async () => {
    const sql = await freshDb();
    const { projectId } = await seedBaseRows(sql);

    await sql`
      INSERT INTO decisions (project_id, summary, chosen_option, rationale, decided_by, job_classification, actor)
      VALUES (${projectId}, 's', 'opt-a', 'because', 'principal', 'J3_product', 'principal')
    `;

    await sql`DELETE FROM projects WHERE id = ${projectId}`;

    const remaining = await sql`SELECT id FROM decisions WHERE project_id = ${projectId}`;
    expect(remaining).toHaveLength(0);
    await sql.end();
  });

  it("SETs NULL decision.approval_ref when its approval is deleted", async () => {
    const sql = await freshDb();
    const { projectId, approvalId } = await seedBaseRows(sql);

    const [{ id: decisionId }] = await sql<Array<{ id: string }>>`
      INSERT INTO decisions (project_id, summary, chosen_option, rationale, decided_by, job_classification, actor, approval_ref)
      VALUES (${projectId}, 's', 'opt-a', 'because', 'principal', 'meta', 'principal', ${approvalId})
      RETURNING id
    `;

    await sql`DELETE FROM approvals WHERE id = ${approvalId}`;

    const [row] = await sql<Array<{ approval_ref: string | null }>>`
      SELECT approval_ref FROM decisions WHERE id = ${decisionId}
    `;
    expect(row.approval_ref).toBeNull();
    await sql.end();
  });

  it("SETs NULL decisions.supersedes when the superseded row is deleted", async () => {
    const sql = await freshDb();
    const { projectId } = await seedBaseRows(sql);

    const [{ id: olderId }] = await sql<Array<{ id: string }>>`
      INSERT INTO decisions (project_id, summary, chosen_option, rationale, decided_by, job_classification, actor)
      VALUES (${projectId}, 'old', 'opt-a', 'r', 'principal', 'J1_signal', 'principal')
      RETURNING id
    `;
    const [{ id: newerId }] = await sql<Array<{ id: string }>>`
      INSERT INTO decisions (project_id, summary, chosen_option, rationale, decided_by, job_classification, actor, supersedes)
      VALUES (${projectId}, 'new', 'opt-b', 'r', 'principal', 'J1_signal', 'principal', ${olderId})
      RETURNING id
    `;

    await sql`DELETE FROM decisions WHERE id = ${olderId}`;

    const [row] = await sql<Array<{ supersedes: string | null }>>`
      SELECT supersedes FROM decisions WHERE id = ${newerId}
    `;
    expect(row.supersedes).toBeNull();
    await sql.end();
  });

  it("rejects decisions with a project_id that doesn't exist", async () => {
    const sql = await freshDb();
    await expect(
      sql`
        INSERT INTO decisions (project_id, summary, chosen_option, rationale, decided_by, job_classification, actor)
        VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 's', 'opt-a', 'r', 'principal', 'meta', 'principal')
      `,
    ).rejects.toThrow(/foreign key|violates/i);
    await sql.end();
  });
});

describeIfPostgres("authority_profiles table — FK and uniqueness", () => {
  it("CASCADEs grants when project is deleted", async () => {
    const sql = await freshDb();
    const { projectId, agentId } = await seedBaseRows(sql);

    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
      VALUES
        (${projectId}, ${agentId}, 'state', 'L2', 'principal', now() + interval '30 days', 'principal')
    `;

    await sql`DELETE FROM projects WHERE id = ${projectId}`;

    const remaining = await sql`SELECT id FROM authority_profiles WHERE project_id = ${projectId}`;
    expect(remaining).toHaveLength(0);
    await sql.end();
  });

  it("CASCADEs grants when agent is deleted", async () => {
    const sql = await freshDb();
    const { projectId, agentId } = await seedBaseRows(sql);

    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
      VALUES
        (${projectId}, ${agentId}, 'draft', 'L1', 'principal', now() + interval '30 days', 'principal')
    `;

    await sql`DELETE FROM agents WHERE id = ${agentId}`;

    const remaining = await sql`SELECT id FROM authority_profiles WHERE agent_id = ${agentId}`;
    expect(remaining).toHaveLength(0);
    await sql.end();
  });

  it("enforces unique (agent_id, project_id, action_class)", async () => {
    const sql = await freshDb();
    const { projectId, agentId } = await seedBaseRows(sql);

    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
      VALUES
        (${projectId}, ${agentId}, 'state', 'L2', 'principal', now() + interval '30 days', 'principal')
    `;

    await expect(
      sql`
        INSERT INTO authority_profiles
          (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
        VALUES
          (${projectId}, ${agentId}, 'state', 'L3', 'principal', now() + interval '30 days', 'principal')
      `,
    ).rejects.toThrow(/unique|duplicate/i);
    await sql.end();
  });

  it("allows portfolio-wide grants (project_id null) alongside per-project grants", async () => {
    const sql = await freshDb();
    const { projectId, agentId } = await seedBaseRows(sql);

    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
      VALUES
        (${projectId}, ${agentId}, 'state', 'L2', 'principal', now() + interval '30 days', 'principal')
    `;
    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, expires_at, actor)
      VALUES
        (NULL, ${agentId}, 'state', 'L1', 'principal', now() + interval '30 days', 'principal')
    `;

    const all = await sql`SELECT id FROM authority_profiles WHERE agent_id = ${agentId}`;
    expect(all).toHaveLength(2);
    await sql.end();
  });

  it("supports the T-5.2 expiry sweep query (filtered index on expires_at)", async () => {
    const sql = await freshDb();
    const { projectId, agentId } = await seedBaseRows(sql);

    // One expired grant, one active grant
    await sql`
      INSERT INTO authority_profiles
        (project_id, agent_id, action_class, ceiling, granted_by, granted_at, expires_at, actor)
      VALUES
        (${projectId}, ${agentId}, 'draft', 'L1', 'principal', now() - interval '60 days', now() - interval '30 days', 'principal'),
        (${projectId}, ${agentId}, 'state', 'L2', 'principal', now(), now() + interval '30 days', 'principal')
    `;

    const expired = await sql`
      SELECT action_class FROM authority_profiles
      WHERE expires_at < NOW() AND revoked_at IS NULL
    `;
    expect(expired).toHaveLength(1);
    expect((expired[0] as { action_class: string }).action_class).toBe("draft");
    await sql.end();
  });
});
