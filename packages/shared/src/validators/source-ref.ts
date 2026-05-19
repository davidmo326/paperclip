import { z } from "zod";
import type { SourceRef } from "../types/source-ref.js";

export const sourceRefKindSchema = z.enum(["M1a", "M1b", "M2", "M3", "M4", "M5", "M6"]);

export const sourceRefSchema = z.object({
  kind: sourceRefKindSchema,
  path: z.string().min(1, "SourceRef.path is required"),
  section: z.string().optional(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "SourceRef.hash must be SHA-256 hex (64 chars)"),
  capturedAt: z.string().datetime({ message: "SourceRef.capturedAt must be ISO-8601" }),
}) satisfies z.ZodType<SourceRef>;

export type SourceRefInput = z.infer<typeof sourceRefSchema>;
