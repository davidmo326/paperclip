ALTER TABLE "projects" ADD COLUMN "control_plane_state" jsonb;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "control_plane_updated_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "projects"
SET
  "control_plane_state" = jsonb_build_object(
    'portfolioState', CASE "status"
      WHEN 'in_progress' THEN 'active'
      WHEN 'planned'     THEN 'parked'
      WHEN 'backlog'     THEN 'parked'
      WHEN 'completed'   THEN 'closed'
      WHEN 'cancelled'   THEN 'closed'
      ELSE 'parked'
    END,
    'currentPhase',        'exploration',
    'constraintLane',      NULL,
    'nextSmallestAction',  NULL,
    'blockerSummary',      NULL,
    'latestEvidenceChanged', NULL,
    'resumeBrief',         NULL,
    'doNotRethink',        NULL,
    'killCriteria',        NULL,
    'lastMeaningfulOutput', NULL
  ),
  "control_plane_updated_at" = now()
WHERE "control_plane_state" IS NULL;
