// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Conversation } from "../components/conversation";
import { learningFixture } from "./conversation-fixtures";
import type { TaskPayload } from "./prentice";
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const props = {
  earlier: [], providers: [], prompt: "", pending: false, running: false, separateConversation: false,
  canContinue: false, busyElsewhere: null, disconnected: false, repoPath: "/tmp/check", activeFile: "",
  providerOverride: "", intensityOverride: "", useProviderMax: false, changing: false,
  onPrompt: () => {}, onSend: () => {}, onStop: () => {}, onChanging: () => {}, onProvider: () => {}, onIntensity: () => {}, onMax: () => {}, onOpen: () => {}, onError: () => {},
  explainError: null, hasProject: true, needsAgent: false, choosing: false, chooseError: null, recentProjects: [], onChooseFolder: () => {}, onOpenProject: () => {}, onOpenAccounts: () => {},
};
let host: HTMLDivElement;
let root: Root;
let task: TaskPayload;
const explain = vi.fn(async (_path: string, _body?: unknown): Promise<void> => { void _path; void _body; throw new Error("Connection dropped before acknowledgement"); });
beforeEach(() => { explain.mockClear(); task = learningFixture("authentication"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render() { await act(async () => { root.render(<Conversation {...props} task={task} onExplain={explain} />); }); }
async function type(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLTextAreaElement>("#explain-answer")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function failReply() {
  await render(); await type("The server checks the verified caller and resource owner.");
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(explain).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection dropped");
}
async function acknowledge() {
  const body = explain.mock.calls[0]![1] as unknown as { messageId: string; answer: string };
  task = { ...task, explain: { ...task.explain!, turns: [{ id: body.messageId, questionId: "q", prompt: "Why?", message: body.answer, status: "replied", response: "Saved feedback", kind: "inference" }] } };
  await render();
}
it("clears an already saved reply and transport error when its matching stream acknowledgement arrives", async () => {
  await failReply(); await acknowledge();
  expect(host.querySelector<HTMLTextAreaElement>("#explain-answer")!.value).toBe("");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Saved feedback");
});
it("preserves a new draft when a late acknowledgement belongs to the previous message", async () => {
  await failReply(); await type("A different follow-up draft"); await acknowledge();
  expect(host.querySelector<HTMLTextAreaElement>("#explain-answer")!.value).toBe("A different follow-up draft");
});

it("keeps a failed or unrelated reply retryable instead of treating it as saved", async () => {
  await failReply();
  const body = explain.mock.calls[0]![1] as { messageId: string; answer: string };
  task = { ...task, explain: { ...task.explain!, turns: [
    { id: body.messageId, questionId: "q", prompt: "Why?", message: body.answer, status: "failed", response: null, kind: "unrecorded" },
    { id: "unrelated", questionId: "q", prompt: "Why?", message: "Other answer", status: "replied", response: "Other feedback", kind: "general" },
  ] } };
  await render();
  expect(host.querySelector<HTMLTextAreaElement>("#explain-answer")!.value).toBe(body.answer);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection dropped");
});
