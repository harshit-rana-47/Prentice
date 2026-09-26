import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { disconnectedAccounts } from "./accounts.js";
import { createConnector } from "./connector.js";
import { migrate, openDatabase } from "./db.js";
import { SecretStore } from "./secrets.js";
import { worktreeFingerprint } from "./git.js";
import { repositorySessionNote } from "./paths.js";
import { createApp } from "./server.js";
import { claimProject, claimedWriteMissed, commandWritesRepository, releaseProject } from "./session.js";
import { Store } from "./store.js";

const exec = promisify(execFile);
const scratch = join(import.meta.dirname, "../.tmp");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local runtime", () => {
  it("rejects a missing token and a foreign origin", async () => {
    const { app, auth } = await harness();
    const missing = await app.request("/v1/project");
    expect(missing.status).toBe(401);
    const foreign = await app.request("/v1/project", {
      headers: { authorization: "Bearer test-token", origin: "https://example.com" },
    });
    expect(foreign.status).toBe(403);
    const connect = await app.request("/v1/providers/codex/connect", { method: "POST", headers: auth });
    expect(connect.status).toBe(202);
  });

  it("switches the workspace back to a repository that was opened earlier", async () => {
    const { connector, app, auth } = await harness();
    const first = await tempRepo();
    const second = await tempRepo();
    for (const path of [first, second, first]) {
      const opened = await connector.openProject({ path });
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.status).toBe(200);
    }
    const workspace = await connector.workspace();
    expect(workspace.ok).toBe(true);
    if (workspace.ok) expect(workspace.body.project.path).toBe(first);
    const http = await app.request("/v1/workspace", { headers: auth });
    const httpBody = (await http.json()) as { project: { path: string } };
    expect(http.status).toBe(200);
    expect(httpBody.project.path).toBe(first);
  });

  it("keeps each repository's conversation when the open project changes", async () => {
    const { app, auth } = await harness();
    const first = await tempRepo();
    const second = await tempRepo();
    await openRepo(app, auth, first);
    const firstTask = await analyze(app, auth, "Work in the first repository");
    await start(app, auth, firstTask);
    await openRepo(app, auth, second);
    const secondTask = await analyze(app, auth, "Work in the second repository");
    await start(app, auth, secondTask);

    await openRepo(app, auth, first);
    const restored = await latest(app, auth);
    expect(restored.task?.id).toBe(firstTask);
    expect(restored.task?.prompt).toBe("Work in the first repository");
    expect(restored.task?.timeline.some((item) => item.title.includes("session-note.ts"))).toBe(true);
    expect(restored.earlier).toEqual([]);

    await openRepo(app, auth, second);
    const other = await latest(app, auth);
    expect(other.task?.id).toBe(secondTask);
    expect(other.task?.prompt).toBe("Work in the second repository");
    expect(other.task?.id).not.toBe(firstTask);
  });

  it("treats another spelling of the same directory as the same project and conversation", async () => {
    const { app, auth, store } = await harness();
    const repo = await tempRepo();
    await openRepo(app, auth, repo);
    const taskId = await analyze(app, auth, "Keep this conversation with the repository");
    const alt = join(dirname(repo), flipCase(basename(repo)));
    const sameDirectory = await sameInode(repo, alt);
    if (!sameDirectory) {
      const rejected = await app.request("/v1/project", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ path: alt }),
      });
      expect(rejected.status).toBe(400);
      await openRepo(app, auth, repo);
      expect((await latest(app, auth)).task?.id).toBe(taskId);
      return;
    }
    store.upsertProject(alt, "alias");
    expect(store.listProjects()).toHaveLength(2);
    const opened = await app.request("/v1/project", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: alt }),
    });
    const openedBody = (await opened.json()) as { project: { id: string; path: string } };
    expect(opened.status).toBe(200);
    expect(openedBody.project.path).toBe(repo);
    expect(store.listProjects()).toHaveLength(1);
    const restored = await latest(app, auth);
    expect(restored.task?.id).toBe(taskId);
    expect(restored.task?.prompt).toBe("Keep this conversation with the repository");
  });

  it("restores a continued conversation past the first few turns", async () => {
    const { app, auth, store } = await harness();
    const repo = await tempRepo();
    await openRepo(app, auth, repo);
    const project = store.latestProject();
    expect(project?.path).toBe(repo);
    let previous = "";
    for (let index = 0; index < 8; index += 1) {
      const task = store.insertTask(project!.id, `turn ${index}`);
      if (previous) {
        store.updateTask(task.id, {
          status: "completed",
          provider_id: "codex",
          provider_session_id: "thread-1",
          continues_task_id: previous,
        });
      }
      previous = task.id;
    }
    const restored = await latest(app, auth);
    expect(restored.task?.prompt).toBe("turn 7");
    expect(restored.earlier?.map((turn) => turn.prompt)).toEqual([
      "turn 0",
      "turn 1",
      "turn 2",
      "turn 3",
      "turn 4",
      "turn 5",
      "turn 6",
    ]);
  });

  it("keeps each conversation's transcript and provider thread, and runs one agent at a time", async () => {
    const { app, auth, store } = await harness();
    const repo = await tempRepo();
    const other = await tempRepo();
    await openRepo(app, auth, repo);
    const first = await analyze(app, auth, "Chat 1 reads the readme");
    const second = await analyze(app, auth, "Chat 2 reads the readme");
    const project = store.latestProject();
    expect(project).toBeTruthy();
    expect(claimProject(project!.id)).toBe(true);
    const blocked = await app.request(`/v1/tasks/${second}/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consent: true }),
    });
    const blockedBody = (await blocked.json()) as { error: { code: string } };
    expect(blocked.status).toBe(409);
    expect(blockedBody.error.code).toBe("PROJECT_BUSY");
    releaseProject(project!.id);

    store.updateTask(first, { status: "completed", provider_id: "codex", provider_session_id: "thread-1" });
    store.updateTask(second, { status: "completed", provider_id: "codex", provider_session_id: "thread-2" });
    const open = await latest(app, auth);
    expect(open.conversations?.map((conversation) => conversation.title)).toEqual([
      "Chat 2 reads the readme",
      "Chat 1 reads the readme",
    ]);
    expect(open.task?.prompt).toBe("Chat 2 reads the readme");
    const chat1 = open.conversations?.find((conversation) => conversation.title.startsWith("Chat 1"));
    const chat2 = open.conversations?.find((conversation) => conversation.title.startsWith("Chat 2"));
    expect(chat1?.id).toBeTruthy();
    expect(chat2?.id).not.toBe(chat1?.id);

    const selected = await app.request(`/v1/conversations/${chat1!.id}/select`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const selectedBody = (await selected.json()) as {
      task: { id: string; prompt: string };
      earlier: unknown[];
      selectedConversationId: string;
    };
    expect(selected.status).toBe(200);
    expect(selectedBody.task.id).toBe(first);
    expect(selectedBody.task.prompt).toBe("Chat 1 reads the readme");
    expect(selectedBody.earlier).toEqual([]);
    expect(selectedBody.selectedConversationId).toBe(chat1!.id);

    const continued = await app.request(`/v1/tasks/${first}/continue`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "still chat 1", consent: true }),
    });
    expect(continued.status).toBe(200);
    const continuedBody = (await continued.json()) as { task: { id: string } };
    const row = store.getTask(continuedBody.task.id);
    expect(row?.conversation_id).toBe(chat1!.id);
    expect(row?.provider_session_id).toBe("thread-1");
    expect(row?.continues_task_id).toBe(first);
    expect(store.getTask(second)?.provider_session_id).toBe("thread-2");
    expect(store.getTask(second)?.conversation_id).toBe(chat2!.id);
    await app.request(`/v1/tasks/${continuedBody.task.id}/interrupt`, { method: "POST", headers: auth });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = store.getTask(continuedBody.task.id);
      if (current && current.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    releaseProject(project!.id);

    const restoredChat2 = await app.request(`/v1/conversations/${chat2!.id}/select`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const chat2Body = (await restoredChat2.json()) as { task: { id: string; prompt: string }; earlier: unknown[] };
    expect(chat2Body.task.id).toBe(second);
    expect(chat2Body.task.prompt).toBe("Chat 2 reads the readme");
    expect(chat2Body.earlier).toEqual([]);

    await openRepo(app, auth, other);
    const otherLatest = await latest(app, auth);
    expect(otherLatest.task).toBeNull();
    expect(otherLatest.conversations).toEqual([]);

    await openRepo(app, auth, repo);
    const back = await latest(app, auth);
    expect(back.conversations?.map((conversation) => conversation.title).sort()).toEqual([
      "Chat 1 reads the readme",
      "Chat 2 reads the readme",
    ]);
    expect(back.selectedConversationId).toBe(chat2!.id);
    expect(back.task?.prompt).toBe("Chat 2 reads the readme");
    const backToChat1 = await app.request(`/v1/conversations/${chat1!.id}/select`, {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const chat1Again = (await backToChat1.json()) as { task: { prompt: string }; earlier: Array<{ prompt: string }> };
    expect(chat1Again.earlier.map((turn) => turn.prompt)).toEqual(["Chat 1 reads the readme"]);
    expect(chat1Again.task.prompt).toBe("still chat 1");
  });

  it("binds the coding agent to the open repository without summarizing its files", () => {
    const note = repositorySessionNote("/Users/example/Demo");
    expect(note).toContain("/Users/example/Demo");
    expect(note).toContain("this project");
    expect(note.length).toBeLessThan(500);
    expect(note).not.toContain("export function");
  });

  it("sees an edit to an already-untracked file and does not treat a bare session end as a missed write", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "hello.txt"), "hello from prentice\n");
    const before = await worktreeFingerprint(repo);
    await writeFile(join(repo, "hello.txt"), "Hello harshit\n");
    const after = await worktreeFingerprint(repo);
    expect(after).not.toBe(before);
    expect(commandWritesRepository("cat > hello.txt <<'EOF'\nHello harshit\nEOF")).toBe(true);
    expect(commandWritesRepository("git status")).toBe(false);
    expect(
      claimedWriteMissed([
        { type: "command.finished", command: "cat > hello.txt", exitCode: 0 },
        { type: "session.completed" },
      ]),
    ).toBe(true);
    expect(claimedWriteMissed([{ type: "session.completed" }])).toBe(false);
  });

  it("returns the latest task and marks a dead running session as stopped", async () => {
    const { app, auth, store } = await harness();
    const repo = await tempRepo();
    const opened = await app.request("/v1/project", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: repo }),
    });
    expect(opened.status).toBe(200);
    const analyzed = await app.request("/v1/tasks/analyze", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "Keep this task" }),
    });
    const analyzedBody = (await analyzed.json()) as { task: { id: string } };
    store.updateTask(analyzedBody.task.id, { status: "running" });
    const latest = await app.request("/v1/tasks/latest", { headers: auth });
    const body = (await latest.json()) as {
      task: { id: string; status: string; error: { message: string } | null };
      earlier: unknown[];
    };
    expect(latest.status).toBe(200);
    expect(body.earlier).toEqual([]);
    expect(body.task.id).toBe(analyzedBody.task.id);
    expect(body.task.status).toBe("interrupted");
    expect(body.task.error?.message).toBe("The runtime is not running this task.");
  });

  it("runs the fixture loop against the local git repo and grades an explain-back answer", async () => {
    const { app, auth } = await harness();
    const repo = await tempRepo();
    const opened = await app.request("/v1/project", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: repo }),
    });
    expect(opened.status).toBe(200);

    const analyzed = await app.request("/v1/tasks/analyze", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "Change the button color to blue" }),
    });
    expect(analyzed.status).toBe(200);
    const analyzedBody = (await analyzed.json()) as {
      task: { id: string; decision: { providerId: string; intensity: string; telemetry: { applied: boolean } } };
    };
    expect(analyzedBody.task.decision.providerId).toBe("fixture");
    expect(analyzedBody.task.decision.intensity).toBe("fast");
    expect(analyzedBody.task.decision.telemetry.applied).toBe(false);

    const denied = await app.request(`/v1/tasks/${analyzedBody.task.id}/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consent: false }),
    });
    expect(denied.status).toBe(400);

    const started = await app.request(`/v1/tasks/${analyzedBody.task.id}/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consent: true }),
    });
    expect(started.status).toBe(202);

    const task = await waitForTerminal(app, auth, analyzedBody.task.id);
    expect(task.status).toBe("completed");
    expect(task.timeline.some((item: { title: string }) => item.title.includes("session-note.ts"))).toBe(true);
    expect(task.understand).toBeTruthy();
    expect(JSON.stringify(task.understand?.observed)).toContain("attachSessionNote");
    expect(JSON.stringify(task.understand?.observed)).toContain("prentice-fixture/session-note.ts");
    expect(task.understand?.agentStated).toEqual([]);
    expect(task.issues).toEqual([]);

    const latest = await app.request("/v1/tasks/latest", { headers: auth });
    const latestBody = (await latest.json()) as { task: { id: string; prompt: string; timeline: unknown[]; understand: unknown; explain: unknown } };
    expect(latest.status).toBe(200);
    expect(latestBody.task.id).toBe(analyzedBody.task.id);
    expect(latestBody.task.prompt).toBe("Change the button color to blue");
    expect(latestBody.task.timeline).toEqual(task.timeline);
    expect(latestBody.task.understand).toEqual(task.understand);

    const explainStart = await app.request(`/v1/tasks/${analyzedBody.task.id}/explain-back`, {
      method: "POST",
      headers: auth,
    });
    expect(explainStart.status).toBe(200);
    const explainBody = (await explainStart.json()) as { explain: { phase: string; learningMessage: string | null } };
    expect(explainBody.explain.phase).toBe("unavailable");
    expect(explainBody.explain.learningMessage).toMatch(/GROQ_API_KEY/);

    const workspace = await app.request("/v1/workspace", { headers: auth });
    const workspaceBody = (await workspace.json()) as {
      changes: Array<{ path: string; change: string }>;
    };
    expect(workspaceBody.changes).toEqual(
      expect.arrayContaining([{ path: "prentice-fixture/session-note.ts", change: "added" }]),
    );
    const diff = await app.request("/v1/workspace/diff?path=prentice-fixture/session-note.ts", { headers: auth });
    const diffBody = (await diff.json()) as { patch: string };
    expect(diffBody.patch).toContain("attachSessionNote");
    const escaped = await app.request("/v1/workspace/file?path=../../etc/passwd", { headers: auth });
    expect(escaped.status).toBe(400);
  });

  it("teaches the fixture file and not a dirty file the turn left alone", async () => {
    const { app, auth } = await harness();
    const repo = await tempRepo();
    await writeFile(join(repo, "README.md"), "seed\nOLD_DIRT from another conversation\n");
    await writeFile(join(repo, "scratch.txt"), "untracked before the task\n");
    const opened = await app.request("/v1/project", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: repo }),
    });
    expect(opened.status).toBe(200);
    const analyzed = await app.request("/v1/tasks/analyze", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ prompt: "Add the session note" }),
    });
    const analyzedBody = (await analyzed.json()) as { task: { id: string } };
    const started = await app.request(`/v1/tasks/${analyzedBody.task.id}/start`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ consent: true }),
    });
    expect(started.status).toBe(202);
    const task = await waitForTerminal(app, auth, analyzedBody.task.id);
    const evidence = JSON.stringify(task.understand?.observed);
    expect(evidence).toContain("prentice-fixture/session-note.ts");
    expect(evidence).not.toContain("OLD_DIRT");
    expect(evidence).not.toContain("scratch.txt");
    expect(evidence).not.toContain("README.md");
  });
});

async function harness() {
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "home-"));
  directories.push(home);
  const db = openDatabase(join(home, "prentice.db"));
  migrate(db);
  const store = new Store(db);
  const secrets = new SecretStore(join(home, "secrets.json"));
  const accounts = disconnectedAccounts();
  const connector = createConnector({ store, secrets, accounts });
  const app = createApp({
    store,
    secrets,
    token: "test-token",
    allowedOrigins: ["http://localhost:3000"],
    accounts,
  });
  return {
    connector,
    app,
    store,
    auth: { authorization: "Bearer test-token", "content-type": "application/json", origin: "http://localhost:3000" },
  };
}

async function tempRepo() {
  const repo = await mkdtemp(join(scratch, "repo-"));
  directories.push(repo);
  await writeFile(join(repo, "README.md"), "seed\n");
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["-c", "user.email=prentice@local", "-c", "user.name=Prentice", "commit", "-m", "init"], {
    cwd: repo,
  });
  return repo;
}

async function openRepo(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
  path: string,
) {
  const response = await app.request("/v1/project", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ path }),
  });
  expect(response.status).toBe(200);
}

async function analyze(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
  prompt: string,
) {
  const response = await app.request("/v1/tasks/analyze", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ prompt }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { task: { id: string } };
  return body.task.id;
}

async function start(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
  taskId: string,
) {
  const response = await app.request(`/v1/tasks/${taskId}/start`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ consent: true }),
  });
  expect(response.status).toBe(202);
  await waitForTerminal(app, auth, taskId);
}

async function latest(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
) {
  const response = await app.request("/v1/tasks/latest", { headers: auth });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    task: { id: string; prompt: string; timeline: Array<{ title: string }> } | null;
    earlier?: Array<{ prompt: string }>;
    conversations?: Array<{ id: string; title: string }>;
    selectedConversationId?: string | null;
  };
}

function flipCase(name: string): string {
  const first = name[0] ?? "";
  const flipped = first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
  return `${flipped}${name.slice(1)}`;
}

async function sameInode(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(left), stat(right)]);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

async function waitForTerminal(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
  taskId: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.request(`/v1/tasks/${taskId}`, { headers: auth });
    const body = (await response.json()) as {
      task: {
        status: string;
        timeline: Array<{ title: string }>;
        understand: { observed: unknown[]; agentStated: unknown[] } | null;
        issues: unknown[];
        error: { message: string } | null;
      };
    };
    if (body.task.status === "completed" || body.task.status === "failed" || body.task.status === "interrupted") {
      if (body.task.status !== "completed") {
        throw new Error(body.task.error?.message ?? body.task.status);
      }
      return body.task;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the fixture task.");
}
