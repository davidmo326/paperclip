/**
 * decisions — committed choices in the project's decision graph.
 *
 * PRD § 8.5 + T-1.2 audit recommendation. Stays a first-class table (not
 * JSON) because the `supersedes` graph is a real query pattern (walking
 * the chain for "what led here?"), and because approvalRef joins to the
 * existing `approvals` table.
 *
 * Owned by T-1.4 v2 slim plan.
 */
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { approvals } from "./approvals.js";

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    summary: text("summary").notNull(),
    chosenOption: text("chosen_option").notNull(),
    /**
     * Array of { label: string; rationale: string; tradeoffs: string }
     * — validated by zod at write time (T-2.5 writeM2 enforces).
     */
    optionsConsidered: jsonb("options_considered")
      .$type<Array<{ label: string; rationale: string; tradeoffs: string }>>()
      .notNull()
      .default([]),
    rationale: text("rationale").notNull(),
    /**
     * SourceRef[] from packages/shared/src/types/source-ref.ts.
     * Provenance enforcement: every agent-written row must have ≥1 source.
     */
    sourceRefs: jsonb("source_refs")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),

    /**
     * `'principal'` or `'agent:<id>'`. Mirrors the actor convention used
     * across the steward layer.
     */
    decidedBy: text("decided_by").notNull(),

    /** Optional FK to approvals row (when the decision required L4+ approval). */
    approvalRef: uuid("approval_ref").references(() => approvals.id, { onDelete: "set null" }),

    /** Null = irreversible. */
    reversibleUntil: timestamp("reversible_until", { withTimezone: true }),

    /** When the steward should re-check this decision (e.g. weekly retro). */
    reviewDate: timestamp("review_date", { withTimezone: true }),

    /** PRD § 8.5 job classification: J1_signal / J2_distribution / J3_product / meta */
    jobClassification: text("job_classification").notNull(),

    /** Decision graph: this decision replaces the one pointed to (nullable). */
    supersedes: uuid("supersedes").references((): AnyPgColumn => decisions.id, {
      onDelete: "set null",
    }),

    /**
     * Backfilled by T-4.7 retro job. Shape:
     *   { reviewedAt: string; outcome: 'good' | 'mixed' | 'bad' | 'too-early' }
     * Null until reviewed.
     */
    outcome: jsonb("outcome").$type<{
      reviewedAt: string;
      outcome: "good" | "mixed" | "bad" | "too-early";
    }>(),

    /** Per-row actor for audit (same actor format as decidedBy; preserved on updates). */
    actor: text("actor").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedAtIdx: index("decisions_project_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
    supersedesIdx: index("decisions_supersedes_idx").on(table.supersedes),
  }),
);
