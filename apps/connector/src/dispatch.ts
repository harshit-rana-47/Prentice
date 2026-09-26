import type { Frame } from "@prentice/protocol";
import type { ConnectorApi, ConnectorResult } from "./connector.js";

export async function dispatchRequest(connector: ConnectorApi, frame: Extract<Frame, { kind: "request" }>): Promise<Frame> {
  const result = await call(connector, frame);
  if (!result.ok) {
    return { kind: "response", id: frame.id, ok: false, status: result.status, error: result.error };
  }
  return { kind: "response", id: frame.id, ok: true, status: result.status, body: result.body };
}

async function call(connector: ConnectorApi, frame: Extract<Frame, { kind: "request" }>): Promise<ConnectorResult<unknown>> {
  switch (frame.method) {
    case "project.current":
      return connector.currentProject();
    case "projects.list":
      return connector.projects();
    case "project.open":
      return connector.openProject(frame.params);
    case "workspace.get":
      return connector.workspace();
    case "workspace.file":
      return connector.workspaceFile(frame.params.path);
    case "workspace.diff":
      return connector.workspaceDiff(frame.params.path);
    case "providers.list":
      return connector.providers();
    case "providers.connect":
      return connector.connectProvider(frame.params.providerId);
    case "providers.disconnect":
      return connector.disconnectProvider(frame.params.providerId);
    case "preferences.pin":
      return connector.pinProvider(frame.params);
    case "tasks.analyze":
      return connector.analyze(frame.params);
    case "tasks.latest":
      return connector.latestTask();
    case "conversations.select":
      return connector.selectConversation(frame.params.conversationId);
    case "tasks.start":
      return connector.start(frame.params.taskId, { consent: frame.params.consent, override: frame.params.override });
    case "tasks.interrupt":
      return connector.interrupt(frame.params.taskId);
    case "tasks.get":
      return connector.task(frame.params.taskId);
    case "tasks.understand":
      return connector.understand(frame.params.taskId);
    case "tasks.explainBack":
      return connector.explainBack(frame.params.taskId);
    case "tasks.explainAnswer":
      return connector.answerExplainBack(frame.params.taskId, { answer: frame.params.answer });
    case "tasks.explainSkip":
      return connector.skipExplainBack(frame.params.taskId);
    case "tasks.explainDiscuss":
      return connector.discussExplainBack(frame.params.taskId, { question: frame.params.question });
    case "tasks.continue":
      return connector.continueTask(frame.params.taskId, { prompt: frame.params.prompt, consent: frame.params.consent });
    case "tasks.events": {
      const opened = connector.watchTask(frame.params.taskId);
      if (!opened.ok) return opened;
      return { ok: true, status: 200, body: { subscribed: true } };
    }
    default:
      return { ok: false, status: 404, error: { code: "NOT_FOUND", message: "Unknown method.", retryable: false } };
  }
}
