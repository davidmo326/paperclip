CREATE TABLE "authority_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"agent_id" uuid NOT NULL,
	"action_class" text NOT NULL,
	"ceiling" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"notes" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"chosen_option" text NOT NULL,
	"options_considered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"approval_ref" uuid,
	"reversible_until" timestamp with time zone,
	"review_date" timestamp with time zone,
	"job_classification" text NOT NULL,
	"supersedes" uuid,
	"outcome" jsonb,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- NOTE: drizzle-kit emitted two spurious ALTER TABLE statements re-adding
-- projects.control_plane_state and projects.control_plane_updated_at because
-- migration 0046_founder_control_plane.sql ships without a corresponding
-- meta/0046_snapshot.json (upstream paperclip merge artifact). The columns
-- already exist in the live DB. Removing the spurious statements here so the
-- migration is idempotent against any DB that has 0046 applied.
ALTER TABLE "authority_profiles" ADD CONSTRAINT "authority_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authority_profiles" ADD CONSTRAINT "authority_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_approval_ref_approvals_id_fk" FOREIGN KEY ("approval_ref") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedes_decisions_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authority_profiles_agent_project_action_uniq" ON "authority_profiles" USING btree ("agent_id","project_id","action_class");--> statement-breakpoint
CREATE INDEX "authority_profiles_expires_at_active_idx" ON "authority_profiles" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "decisions_project_created_at_idx" ON "decisions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "decisions_supersedes_idx" ON "decisions" USING btree ("supersedes");