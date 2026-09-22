import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { disconnectedAccounts } from "./accounts.js";
import { migrate, openDatabase } from "./db.js";
import { SecretStore } from "./secrets.js";
import { createApp } from "./server.js";
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

    const explainStart = await app.request(`/v1/tasks/${analyzedBody.task.id}/explain-back`, {
      method: "POST",
      headers: auth,
    });
    expect(explainStart.status).toBe(200);
    const answered = await app.request(`/v1/tasks/${analyzedBody.task.id}/explain-back/answer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answer: "added attachSessionNote in session-note.ts" }),
    });
    const answerBody = (await answered.json()) as { explain: { phase: string; feedback: { understood: string[] } } };
    expect(answerBody.explain.phase).toBe("done");
    expect(answerBody.explain.feedback.understood.length).toBeGreaterThan(0);

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
});

async function harness() {
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, "home-"));
  directories.push(home);
  const db = openDatabase(join(home, "prentice.db"));
  migrate(db);
  const app = createApp({
    store: new Store(db),
    secrets: new SecretStore(join(home, "secrets.json")),
    token: "test-token",
    allowedOrigins: ["http://localhost:3000"],
    accounts: disconnectedAccounts(),
  });
  return {
    app,
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
