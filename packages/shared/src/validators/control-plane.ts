import { z } from "zod";
import { sourceRefSchema } from "./source-ref.js";

export const projectPortfolioStateSchema = z.enum([
  "primary",
  "active",
  "blocked",
  "paused",
  "parked",
  "closed",
]);

/**
 * Project phase enum.
 *
 * The first 6 values are the PRD § 8.1 spec (search/validate/build/distribution/scale/maintenance).
 * The last 2 (exploration, validation) are deprecated aliases kept for backward compatibility
 * with rows persisted before T-1.3. A future ticket renames them in-place; until then both sets
 * must parse to keep `plugin-founder-control-plane` working against existing data.
 */
export const projectPhaseSchema = z.enum([
  "search",
  "validate",
  "build",
  "distribution",
  "scale",
  "maintenance",
  // deprecated aliases (do not write):
  "exploration",
  "validation",
]);

export const projectConstraintLaneSchema = z.enum([
  "product",
  "customer",
  "distribution",
  "ops",
  "finance",
  "unknown",
]);

export const projectControlPlaneLastOutputSchema = z.object({
  kind: z.enum(["issue", "work_product", "document", "external_link", "note"]),
  id: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
});

// --- T-1.3 additions: Hypothesis, Assumption, Escalation, OpenLoop schemas ---

export const jobClassificationSchema = z.enum(["J1_signal", "J2_distribution", "J3_product", "meta"]);

export const authorityLevelSchema = z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]);

export const hypothesisSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  evidenceFor: z.array(sourceRefSchema),
  evidenceAgainst: z.array(sourceRefSchema),
  confidence: z.number().min(0).max(1),
  testPlan: z.string().nullable(),
  status: z.enum(["active", "validated", "invalidated", "inconclusive", "retired"]),
  reviewDate: z.string().nullable(),
});

export const assumptionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema),
  confidence: z.number().min(0).max(1),
  riskIfWrong: z.string().nullable(),
  lastReviewedAt: z.string().nullable(),
  status: z.enum(["accepted", "challenged", "stale", "replaced"]),
});

export const escalationSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  question: z.string().min(1),
  recommendedDecision: z.string().nullable(),
  options: z.array(
    z.object({
      label: z.string().min(1),
      tradeoffs: z.string().nullable(),
    }),
  ),
  risk: z.string().nullable(),
  requiredBy: z.string().nullable(),
  sourceRefs: z.array(sourceRefSchema),
  status: z.enum(["open", "approved", "rejected", "deferred", "resolved"]),
});

export const openLoopSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  createdAt: z.string().min(1),
});

// --- ProjectControlPlaneState schema (v1 fields required, v2 fields optional) ---

export const projectControlPlaneStateSchema = z.object({
  // v1 fields
  portfolioState: projectPortfolioStateSchema,
  currentPhase: projectPhaseSchema,
  constraintLane: projectConstraintLaneSchema.nullable(),
  nextSmallestAction: z.string().nullable(),
  blockerSummary: z.string().nullable(),
  latestEvidenceChanged: z.string().nullable(),
  resumeBrief: z.string().nullable(),
  doNotRethink: z.string().nullable(),
  killCriteria: z.string().nullable(),
  lastMeaningfulOutput: projectControlPlaneLastOutputSchema.nullable(),

  // v2 fields — all optional for back-compat with existing rows.
  intent: z.string().nullable().optional(),
  currentStatus: z.string().nullable().optional(),
  authorityProfileId: z.string().nullable().optional(),
  memoryIndexRefs: z.array(sourceRefSchema).optional(),
  sourceRefs: z.array(sourceRefSchema).optional(),
  openLoops: z.array(openLoopSchema).optional(),
  assumptions: z.array(assumptionSchema).optional(),
  hypotheses: z.array(hypothesisSchema).optional(),
  escalations: z.array(escalationSchema).optional(),
  decisionRefs: z.array(z.string().uuid()).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  lastReviewedAt: z.string().nullable().optional(),
  jobClassificationDominant: jobClassificationSchema.nullable().optional(),
  voiceSensitive: z.boolean().optional(),
});

export type ProjectControlPlaneStateInput = z.infer<typeof projectControlPlaneStateSchema>;

export const updateProjectControlPlaneSchema = projectControlPlaneStateSchema.partial();

export type UpdateProjectControlPlane = z.infer<typeof updateProjectControlPlaneSchema>;

export const projectPortfolioSummarySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
  controlPlaneState: projectControlPlaneStateSchema.nullable(),
  controlPlaneUpdatedAt: z.string().nullable(),
  staleStatus: z.enum(["fresh", "aging", "stale", "critical"]),
  attentionScore: z.number(),
  warnings: z.array(z.string()),
});
