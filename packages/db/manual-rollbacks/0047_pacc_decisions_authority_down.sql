-- ============================================================================
-- DOWN migration for 0047_pacc_decisions_authority.sql
-- ============================================================================
--
-- Lives OUTSIDE src/migrations on purpose: the runner applies every *.sql in
-- that folder, and on 2026-05-20 it auto-applied this file in production,
-- dropping both tables (review 2026-10-07 F2; history row id 49 is its hash).
-- It is a documented manual rollback for nuclear cases where you need to
-- drop the T-1.4 tables and start over.
--
-- Usage (against a dev DB only — destructive):
--   psql "$PACC_DEV_DB_URL" -f packages/db/manual-rollbacks/0047_pacc_decisions_authority_down.sql
--
-- Or — for the filesystem-snapshot rollback path (Option A from T-0.6):
--   pkill -f dev-watch && bash ControlPlane/scripts/restore-dev-db.sh <pre-T-1.4-snapshot>
--
-- Order matters: drop indexes first, then drop tables in FK-reverse order.
-- ============================================================================

DROP INDEX IF EXISTS "authority_profiles_expires_at_active_idx";
DROP INDEX IF EXISTS "authority_profiles_agent_project_action_uniq";
DROP INDEX IF EXISTS "decisions_supersedes_idx";
DROP INDEX IF EXISTS "decisions_project_created_at_idx";

DROP TABLE IF EXISTS "authority_profiles";
DROP TABLE IF EXISTS "decisions";

-- After running this, remove the row from drizzle.__drizzle_migrations:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash LIKE '0047_%';
-- Without that step the forward migration won't re-apply on a fresh start.
