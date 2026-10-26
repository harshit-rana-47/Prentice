import type { ProtocolMethod } from "./methods";

export const REQUEST_TIMEOUT_MS = 30_000;
export const FOLDER_TIMEOUT_MS = 6 * 60_000;
export const LEARNING_TIMEOUT_MS = 90_000;

/** Learning includes generation and review; the relay must outlast the connector's HTTP deadline. */
export function relayRequestTimeout(method: ProtocolMethod, ordinary = REQUEST_TIMEOUT_MS): number {
  if (method === "project.choose") return FOLDER_TIMEOUT_MS;
  if (["tasks.understand", "tasks.explainBack", "tasks.explainAnswer", "tasks.explainDiscuss"].includes(method)) return LEARNING_TIMEOUT_MS;
  return ordinary;
}
