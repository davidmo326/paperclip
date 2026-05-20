/**
 * authority_profiles — per-(agent × project × action-class) authority grants.
 *
 * PRD § 10 + T-1.2 audit recommendation. Stays a first-class table because
 * T-5.2's 30-day expiry sweep needs queryable rows:
 *   SELECT * FROM authority_profiles
 *   WHERE expires_at < NOW() AND revoked_at IS NULL
 *
 * A grant pairs an agent with a project (or portfolio-wide if project_id
 * is null) and an action class (read/draft/state/local-exec/material/strategic
 * — matches L0..L5). The `ceiling` is the maximum level the agent may invoke
 * for that combination.
 *
 * All grants come from `principal` per PRD § 10 (L5 is never delegable),
 * so granted_by is a text actor field rather than an FK.
 *
 * Owned by T-1.4 v2 slim plan.
 */
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const authorityProfiles = pgTable(
  "authority_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null = portfolio-wide grant (applies to all projects unless overridden). */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),

    /**
     * Per PRD § 10 action-class mapping (one of read / draft / state /
     * local-exec / material / strategic).
     */
    actionClass: text("action_class").notNull(),

    /** L0..L5 (text enum). Strategic (L5) is never granted; included only for completeness. */
    ceiling: text("ceiling").notNull(),

    /**
     * Always `principal` per PRD § 10 — authority is never auto-granted.
     * Stored as text rather than FK because the principal isn't an `agents` row.
     */
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Default 30 days from grant per PRD § 10 — but the actual default is
     * set by the granting service (T-4.6 `pacc grant`), not by Drizzle, so
     * the column itself just stores whatever timestamp the service writes.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Null = active. Non-null = revoked at this time (preserved for audit). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    notes: text("notes"),

    /** Per-row actor for audit. Same format as decisions.actor. */
    actor: text("actor").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * One ACTIVE grant per (agent × project × action_class). NULL project_id
     * is treated as a distinct key by Postgres, so portfolio-wide grants are
     * separate from per-project grants for the same agent + action class.
     */
    agentProjectActionUniq: uniqueIndex("authority_profiles_agent_project_action_uniq").on(
      table.agentId,
      table.projectId,
      table.actionClass,
    ),
    /**
     * Partial index for the T-5.2 expiry sweep — only indexes active grants,
     * keeps the index small even as revoked rows accumulate over time.
     */
    expiresAtActiveIdx: index("authority_profiles_expires_at_active_idx").on(table.expiresAt),
  }),
);
