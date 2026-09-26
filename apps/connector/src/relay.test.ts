import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Frame } from "@prentice/protocol";
import { cloudConfigFromEnv, forgetUser, signIn } from "../../cloud/src/local-supabase.js";
import { startCloud } from "../../cloud/src/server.js";
import type { ConnectorApi } from "./connector.js";
import { assertSecureRelayUrl } from "./pair.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { disconnectedAccounts } from "./accounts.js";
import { createConnector } from "./connector.js";
import { migrate, openDatabase } from "./db.js";
import { connectRelay } from "./relay.js";
import { SecretStore } from "./secrets.js";
import { Store } from "./store.js";

const exec = promisify(execFile);
const directories: string[] = [];
const users: string[] = [];

afterEach(async () => {
  await Promise.all(users.splice(0).map((userId) => forgetUser(userId)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("connector relay", () => {
  it("answers workspace.get through a localhost stub", async () => {
    const home = await mkdtemp(join(tmpdir(), "prentice-relay-"));
    directories.push(home);
    const repo = await mkdtemp(join(tmpdir(), "prentice-repo-"));
    directories.push(repo);
    await writeFile(join(repo, "README.md"), "seed\n");
    await exec("git", ["init"], { cwd: repo });
    await exec("git", ["add", "README.md"], { cwd: repo });
    await exec("git", ["-c", "user.email=prentice@local", "-c", "user.name=Prentice", "commit", "-m", "init"], { cwd: repo });
    await mkdir(join(home, "empty"), { recursive: true });
    const db = openDatabase(join(home, "prentice.db"));
    migrate(db);
    const connector = createConnector({
      store: new Store(db),
      secrets: new SecretStore(join(home, "secrets.json")),
      accounts: disconnectedAccounts(),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await new Promise<string>((resolve) => {
      server.on("listening", () => {
        const bound = server.address();
        if (!bound || typeof bound === "string") throw new Error("Stub relay did not bind.");
        resolve(`ws://127.0.0.1:${bound.port}`);
      });
    });
    const socketPromise = new Promise<import("ws").WebSocket>((resolve) => server.on("connection", resolve));
    const client = connectRelay({ url: address, connector, pingMs: 60_000 });
    const socket = await socketPromise;
    const frames = incoming(socket);

    socket.send(JSON.stringify({ kind: "request", id: "open", method: "project.open", params: { path: repo } }));
    const opened = await frames.next();
    expect(opened).toMatchObject({ id: "open", ok: true, status: 200 });

    socket.send(JSON.stringify({ kind: "request", id: "snap", method: "workspace.get" }));
    const snapshot = await frames.next();
    expect(snapshot).toMatchObject({
      kind: "response",
      id: "snap",
      ok: true,
      status: 200,
    });
    await expectSameRepo((snapshot as { body: { project: { path: string } } }).body.project.path, repo);

    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("pairs with the cloud and answers workspace.get over the relay", async () => {
    const home = await mkdtemp(join(tmpdir(), "prentice-cloud-link-"));
    directories.push(home);
    const repo = await mkdtemp(join(tmpdir(), "prentice-repo-"));
    directories.push(repo);
    await writeFile(join(repo, "README.md"), "seed\n");
    await exec("git", ["init"], { cwd: repo });
    await exec("git", ["add", "README.md"], { cwd: repo });
    await exec("git", ["-c", "user.email=prentice@local", "-c", "user.name=Prentice", "commit", "-m", "init"], { cwd: repo });
    const db = openDatabase(join(home, "prentice.db"));
    migrate(db);
    const connector = createConnector({
      store: new Store(db),
      secrets: new SecretStore(join(home, "secrets.json")),
      accounts: disconnectedAccounts(),
    });
    const cloud = await startCloud(cloudConfigFromEnv());
    const signed = await signIn(`link-${randomUUID()}@prentice.dev`);
    users.push(signed.userId);
    const session = signed.accessToken;
    const deviceId = `device-link-${randomUUID()}`;
    const codeResponse = await fetch(`${cloud.url}/v1/pairing-codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${session}` },
    });
    const code = ((await codeResponse.json()) as { code: string }).code;
    const paired = await fetch(`${cloud.url}/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceId, publicKey: "public-key" }),
    });
    const deviceToken = ((await paired.json()) as { deviceToken: string }).deviceToken;
    const client = connectRelay({
      url: `ws://127.0.0.1:${cloud.port}/relay/connector`,
      connector,
      token: deviceToken,
      pingMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await new Promise<void>((resolve) => browser.once("open", () => resolve()));
    browser.send(JSON.stringify({ kind: "auth", role: "browser", token: session, deviceId }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    browser.send(JSON.stringify({ kind: "request", id: "open", method: "project.open", params: { path: repo } }));
    const opened = await browserFrame(browser);
    expect(opened).toMatchObject({ id: "open", ok: true });
    browser.send(JSON.stringify({ kind: "request", id: "snap", method: "workspace.get" }));
    const snapshot = await browserFrame(browser);
    expect(snapshot).toMatchObject({ id: "snap", ok: true });
    await expectSameRepo((snapshot as { body: { project: { path: string } } }).body.project.path, repo);
    client.close();
    browser.close();
    await cloud.close();
  }, 30_000);

  it("redials after a network drop and stops when the device is refused", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await new Promise<string>((resolve) => {
      server.on("listening", () => {
        const bound = server.address();
        if (!bound || typeof bound === "string") throw new Error("Stub relay did not bind.");
        resolve(`ws://127.0.0.1:${bound.port}`);
      });
    });
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      if (connections === 1) socket.close(1011, "drop");
      if (connections === 2) setTimeout(() => socket.close(4001, "revoked"), 30);
    });
    const client = connectRelay({ url: address, connector: {} as ConnectorApi, pingMs: 60_000 });
    await waitUntil(() => connections >= 2);
    await wait(700);
    expect(connections).toBe(2);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 15_000);

  it("refuses an unencrypted relay that is not on this machine", () => {
    expect(() => assertSecureRelayUrl("ws://example.com/relay/connector")).toThrow(/https/);
    expect(() => assertSecureRelayUrl("ws://127.0.0.1:9/relay/connector")).not.toThrow();
    expect(() => assertSecureRelayUrl("wss://example.com/relay/connector")).not.toThrow();
  });
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(ready: () => boolean) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 4_000) throw new Error("Timed out waiting for the relay to reconnect.");
    await wait(50);
  }
}

async function expectSameRepo(actual: string, repo: string) {
  expect(basename(actual)).toBe(basename(repo));
  const [left, right] = await Promise.all([stat(actual), stat(repo)]);
  expect(left.ino).toBe(right.ino);
  expect(left.dev).toBe(right.dev);
}

function browserFrame(socket: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for a browser relay frame.")), 5_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Frame);
    });
  });
}

function incoming(socket: import("ws").WebSocket) {
  const queued: Frame[] = [];
  const waiting: Array<(frame: Frame) => void> = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    const next = waiting.shift();
    if (next) next(frame);
    else queued.push(frame);
  });
  return {
    next: () =>
      new Promise<Frame>((resolve, reject) => {
        const queuedFrame = queued.shift();
        if (queuedFrame) {
          resolve(queuedFrame);
          return;
        }
        const timer = setTimeout(() => reject(new Error("Timed out waiting for a relay frame.")), 5_000);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
  };
}
