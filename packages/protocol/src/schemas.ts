import { z } from "zod";

/** Kept in this package so the browser bundle does not import `@prentice/domain`. */
export const protocolProviderIds = ["claude-code", "codex", "cursor", "fixture"] as const;

export const protocolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

const providerIdSchema = z.enum(protocolProviderIds);

const overrideSchema = z
  .object({
    providerId: providerIdSchema.optional(),
    intensity: z.enum(["fast", "balanced", "deep", "maximum"]).optional(),
    useProviderMax: z.boolean().optional(),
  })
  .optional();

const idField = z.string().min(1);

export const requestSchemas = {
  "project.current": z.object({ method: z.literal("project.current") }),
  "projects.list": z.object({ method: z.literal("projects.list") }),
  "project.open": z.object({ method: z.literal("project.open"), params: z.object({ path: z.string().min(1) }) }),
  "project.choose": z.object({ method: z.literal("project.choose") }),
  "workspace.get": z.object({ method: z.literal("workspace.get") }),
  "workspace.file": z.object({ method: z.literal("workspace.file"), params: z.object({ path: z.string().min(1) }) }),
  "workspace.diff": z.object({ method: z.literal("workspace.diff"), params: z.object({ path: z.string().min(1) }) }),
  "providers.list": z.object({ method: z.literal("providers.list") }),
  "providers.connect": z.object({
    method: z.literal("providers.connect"),
    params: z.object({ providerId: providerIdSchema }),
  }),
  "providers.disconnect": z.object({
    method: z.literal("providers.disconnect"),
    params: z.object({ providerId: providerIdSchema }),
  }),
  "preferences.pin": z.object({
    method: z.literal("preferences.pin"),
    params: z.object({ providerId: providerIdSchema.nullable() }),
  }),
  "tasks.analyze": z.object({
    method: z.literal("tasks.analyze"),
    params: z.object({ prompt: z.string().trim().min(1).max(20_000) }),
  }),
  "tasks.latest": z.object({ method: z.literal("tasks.latest") }),
  "conversations.select": z.object({
    method: z.literal("conversations.select"),
    params: z.object({ conversationId: idField }),
  }),
  "tasks.start": z.object({
    method: z.literal("tasks.start"),
    params: z.object({ taskId: idField, consent: z.boolean(), override: overrideSchema }),
  }),
  "tasks.interrupt": z.object({ method: z.literal("tasks.interrupt"), params: z.object({ taskId: idField }) }),
  "tasks.get": z.object({ method: z.literal("tasks.get"), params: z.object({ taskId: idField }) }),
  "tasks.events": z.object({ method: z.literal("tasks.events"), params: z.object({ taskId: idField }) }),
  "tasks.understand": z.object({ method: z.literal("tasks.understand"), params: z.object({ taskId: idField }) }),
  "tasks.explainBack": z.object({ method: z.literal("tasks.explainBack"), params: z.object({ taskId: idField }) }),
  "tasks.explainAnswer": z.object({
    method: z.literal("tasks.explainAnswer"),
    params: z.object({ taskId: idField, answer: z.string().trim().min(1).max(8_000) }),
  }),
  "tasks.explainSkip": z.object({ method: z.literal("tasks.explainSkip"), params: z.object({ taskId: idField }) }),
  "tasks.explainDiscuss": z.object({
    method: z.literal("tasks.explainDiscuss"),
    params: z.object({ taskId: idField, question: z.string().trim().min(1).max(4_000) }),
  }),
  "tasks.continue": z.object({
    method: z.literal("tasks.continue"),
    params: z.object({ taskId: idField, prompt: z.string().trim().min(1).max(20_000), consent: z.boolean() }),
  }),
} as const;

const taskPayloadSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    status: z.string(),
    providerId: z.string().nullable(),
    error: protocolErrorSchema.nullable(),
    decision: z.unknown().nullable(),
    labels: z.object({ complexity: z.string(), intensity: z.string() }).nullable(),
    timeline: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          detail: z.string().optional(),
          tone: z.enum(["neutral", "change", "fail", "ok"]),
        })
        .passthrough(),
    ),
    understand: z.unknown().nullable(),
    explain: z.unknown().nullable(),
    issues: z.array(z.object({ id: z.string(), symptom: z.string(), evidence: z.string() }).passthrough()),
  })
  .passthrough();

export const taskResponseSchema = z.object({ task: taskPayloadSchema.nullable() });
