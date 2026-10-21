import { z } from "zod";

const id = z.string().uuid();
const date = z.string().datetime({ offset: true });
const safeLabel = z.string().trim().min(1).max(160).refine(value => !/[\r\n\\/]/.test(value) && !value.includes("://"));

export const syncProjectSchema = z.object({
  id, displayName: safeLabel, createdAt: date, lastActiveAt: date,
}).strict();
export const syncActivitySchema = z.object({
  id, projectId: id, createdAt: date, finishedAt: date.nullable(),
  status: z.enum(["completed", "failed", "interrupted"]),
  providerId: z.enum(["codex", "claude-code", "cursor", "fixture"]).nullable(),
  filesAdded: z.number().int().min(0).max(100000),
  filesModified: z.number().int().min(0).max(100000),
  filesDeleted: z.number().int().min(0).max(100000),
  testsPassed: z.number().int().min(0).max(100000).nullable(),
  testsFailed: z.number().int().min(0).max(100000).nullable(),
}).strict();
export const syncConceptSchema = z.object({
  projectId: id, concept: safeLabel, state: z.enum(["explored", "understood"]), recordedAt: date,
}).strict();
export const syncPayloadSchema = z.object({
  projects: z.array(syncProjectSchema).max(500),
  activity: z.array(syncActivitySchema).max(50),
  concepts: z.array(syncConceptSchema).max(1000),
}).strict();
export type SyncPayload = z.infer<typeof syncPayloadSchema>;
