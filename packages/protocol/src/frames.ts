import { z } from "zod";
import { protocolErrorSchema, requestSchemas } from "./schemas";

const requestId = { kind: z.literal("request"), id: z.string().min(1) } as const;

const projectCurrent = requestSchemas["project.current"].extend(requestId);
const projectsList = requestSchemas["projects.list"].extend(requestId);
const projectOpen = requestSchemas["project.open"].extend(requestId);
const workspaceGet = requestSchemas["workspace.get"].extend(requestId);
const workspaceFile = requestSchemas["workspace.file"].extend(requestId);
const workspaceDiff = requestSchemas["workspace.diff"].extend(requestId);
const providersList = requestSchemas["providers.list"].extend(requestId);
const providersConnect = requestSchemas["providers.connect"].extend(requestId);
const providersDisconnect = requestSchemas["providers.disconnect"].extend(requestId);
const preferencesPin = requestSchemas["preferences.pin"].extend(requestId);
const tasksAnalyze = requestSchemas["tasks.analyze"].extend(requestId);
const tasksLatest = requestSchemas["tasks.latest"].extend(requestId);
const conversationsSelect = requestSchemas["conversations.select"].extend(requestId);
const tasksStart = requestSchemas["tasks.start"].extend(requestId);
const tasksInterrupt = requestSchemas["tasks.interrupt"].extend(requestId);
const tasksGet = requestSchemas["tasks.get"].extend(requestId);
const tasksEvents = requestSchemas["tasks.events"].extend(requestId);
const tasksUnderstand = requestSchemas["tasks.understand"].extend(requestId);
const tasksExplainBack = requestSchemas["tasks.explainBack"].extend(requestId);
const tasksExplainAnswer = requestSchemas["tasks.explainAnswer"].extend(requestId);
const tasksExplainSkip = requestSchemas["tasks.explainSkip"].extend(requestId);
const tasksExplainDiscuss = requestSchemas["tasks.explainDiscuss"].extend(requestId);
const tasksContinue = requestSchemas["tasks.continue"].extend(requestId);

const requestFrameSchema = z.discriminatedUnion("method", [
  projectCurrent,
  projectsList,
  projectOpen,
  workspaceGet,
  workspaceFile,
  workspaceDiff,
  providersList,
  providersConnect,
  providersDisconnect,
  preferencesPin,
  tasksAnalyze,
  tasksLatest,
  conversationsSelect,
  tasksStart,
  tasksInterrupt,
  tasksGet,
  tasksEvents,
  tasksUnderstand,
  tasksExplainBack,
  tasksExplainAnswer,
  tasksExplainSkip,
  tasksExplainDiscuss,
  tasksContinue,
]);

const responseFrameSchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(true),
    status: z.number().int(),
    body: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    id: z.string().min(1),
    ok: z.literal(false),
    status: z.number().int(),
    error: protocolErrorSchema,
  }),
]);

const eventFrameSchema = z.object({
  kind: z.literal("event"),
  method: z.literal("tasks.events"),
  taskId: z.string().min(1),
  event: z.enum(["task", "ping"]),
  data: z.unknown(),
});

const authFrameSchema = z.discriminatedUnion("role", [
  z.object({
    kind: z.literal("auth"),
    role: z.literal("connector"),
    token: z.string().min(1),
  }),
  z.object({
    kind: z.literal("auth"),
    role: z.literal("browser"),
    token: z.string().min(1),
    deviceId: z.string().min(1),
  }),
]);

export const frameSchema = z.discriminatedUnion("kind", [
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
  authFrameSchema,
]);

export type Frame = z.infer<typeof frameSchema>;

export function parseFrame(input: unknown): Frame {
  return frameSchema.parse(input);
}
