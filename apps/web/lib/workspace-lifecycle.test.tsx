// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../components/workspace";
import { loadSession, readTaskStream, runtimeFetch } from "./prentice";
import { learningFixture } from "./conversation-fixtures";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("next/dynamic", async () => {
  const { lazy, createElement, Suspense } = await import("react");
  return { default: (_loader: unknown, options?: { loading?: React.ComponentType }) => {
    // Keep the code renderer pending to exercise the actual component's loading boundary.
    const Pending = lazy(() => new Promise<{ default: React.ComponentType }>(() => {}));
    return function DelayedRenderer() {
      return options?.loading
        ? createElement(Suspense, { fallback: createElement(options.loading) }, createElement(Pending))
        : createElement(Pending);
    };
  } };
});
vi.mock("@/lib/prentice", () => ({ loadSession: vi.fn(), runtimeFetch: vi.fn(), readTaskStream: vi.fn() }));
vi.mock("@/components/home", () => ({ Home: ({ active, disconnected, onChoose }: { active: boolean; disconnected: boolean; onChoose(): void }) => <section hidden={!active}><button onClick={onChoose}>Open a project</button><span>{disconnected ? "home disconnected" : "home connected"}</span></section> }));
vi.mock("@/components/conversation", () => ({ Conversation: ({ disconnected }: { disconnected: boolean }) => <p>{disconnected ? "conversation disconnected" : "conversation connected"}</p> }));
vi.mock("@/components/project-switcher", () => ({ ProjectNavigation: () => null }));
vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }));

const project = { id: "selected", name: "prentice-test", path: "/Users/test/Desktop/prentice-test" };
const snapshot = { project, branch: "main", tree: [{ name: "math.js", path: "math.js", kind: "file" }], changes: [], additions: 0, deletions: 0 };
let host: HTMLDivElement;
let root: Root;
let reconnected: (() => void) | undefined;
let selected: boolean;
let scan: () => Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  selected = false;
  reconnected = undefined;
  window.history.replaceState(null, "", "/?view=home");
  scan = async () => snapshot;
  vi.mocked(loadSession).mockResolvedValue({ token: "test", runtimeUrl: "https://cloud.test", mode: "relay", onReconnect: listener => { reconnected = listener; return () => {}; } });
  vi.mocked(readTaskStream).mockResolvedValue();
  vi.mocked(runtimeFetch).mockImplementation(async (_session, path) => {
    if (path === "/v1/providers") return { providers: [] } as never;
    if (path === "/v1/projects") return { projects: [] } as never;
    if (path === "/v1/tasks/latest") return { task: null, earlier: [] } as never;
    if (path === "/v1/project/choose") { selected = true; return { project } as never; }
    if (path === "/v1/workspace") return await scan() as never;
    if (path.startsWith("/v1/workspace/diff?")) return { patch: "diff --git a/math.js b/math.js\n+new code" } as never;
    throw new Error("Unexpected endpoint " + path);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function mount() { await act(async () => { root.render(<React.Suspense fallback={<p>Whole workspace loading</p>}><Workspace authToken="signed-in" /></React.Suspense>); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

it("does not let an older failed startup scan disconnect a successfully selected project", async () => {
  let attempts = 0;
  let rejectOld!: (error: Error) => void;
  const old = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
  scan = () => {
    if (selected) return Promise.resolve(snapshot);
    attempts++;
    return attempts < 4 ? Promise.reject(new Error("old scan failed")) : old;
  };
  await mount(); await tick(1000); await tick(2000); await tick(3000);
  expect(attempts).toBe(4);
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Open a project")!.click(); });
  expect(host.textContent).toContain("prentice-test");
  await act(async () => { rejectOld(new Error("This computer did not answer in time.")); });
  expect(host.textContent).toContain("conversation connected");
  expect(host.textContent).not.toContain("conversation disconnected");
});

it("recovers after startup request failures when the live relay reconnects", async () => {
  scan = async () => { throw new Error("This computer did not answer in time."); };
  await mount(); await tick(1000); await tick(2000); await tick(3000);
  scan = async () => snapshot;
  await act(async () => { reconnected?.(); });
  expect(host.textContent).toContain("home connected");
  expect(host.textContent).not.toContain("home disconnected");
});

it("does not turn a rejected task subscription into a false computer disconnection", async () => {
  const task = learningFixture("validation");
  vi.mocked(readTaskStream).mockRejectedValue(new Error("Task subscription timed out"));
  const base = vi.mocked(runtimeFetch).getMockImplementation()!;
  vi.mocked(runtimeFetch).mockImplementation(async (session, path, init) => path === "/v1/tasks/latest" ? { task, earlier: [] } as never : base(session, path, init));
  await mount();
  expect(host.textContent).toContain("conversation connected");
  expect(host.textContent).toContain("Live task updates could not be restored");
  expect(host.textContent).not.toContain("conversation disconnected");
});

it("keeps the workspace visible while the first Git diff renderer is still loading", async () => {
  scan = async () => ({ ...snapshot, changes: [{ path: "math.js", change: "added" }] });
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Changes"]')!.click(); });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("math.js"))!.click(); });
  expect(host.textContent).toContain("Opening diff…");
  expect(host.textContent).not.toContain("Whole workspace loading");
});
