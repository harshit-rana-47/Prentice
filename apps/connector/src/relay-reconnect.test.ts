import { createServer, type Server } from "node:http";
import { RELAY_CLOSE, type Frame } from "@prentice/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FrameRelay } from "../../cloud/src/relay.js";
import type { ConnectorApi } from "./connector.js";
import { connectRelay, type RelayConnection } from "./relay.js";

/**
 * Regression tests for relay bugs confirmed in the audit. They use the real cloud FrameRelay and the real
 * connector relay client over localhost sockets, with an in-memory store.
 */

interface Harness {
  url: (path: string) => string;
  relay: FrameRelay;
  wss: WebSocketServer;
  connectorSockets: import("ws").WebSocket[];
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(store: ConstructorParameters<typeof FrameRelay>[0]): Promise<Harness> {
  const relay = new FrameRelay(store);
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  const connectorSockets: import("ws").WebSocket[] = [];
  wss.on("connection", (socket, request) => {
    const role = request.url?.includes("connector") ? "connector" : "browser";
    if (role === "connector") connectorSockets.push(socket);
    relay.attach(socket, role);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const h: Harness = {
    url: (path) => `ws://127.0.0.1:${port}${path}`,
    relay,
    wss,
    connectorSockets,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(() => h.close());
  return h;
}

function goodStore(overrides: Partial<ConstructorParameters<typeof FrameRelay>[0]> = {}) {
  return {
    deviceForToken: async (token: string) => (token === "device-token" ? { id: "dev1", userId: "u1" } : undefined),
    userForSession: async (token: string) => (token === "fresh" ? { id: "u1", email: "a@b.c" } : undefined),
    deviceForUser: async (deviceId: string) => (deviceId === "dev1" ? { id: "dev1", userId: "u1", name: "Mac", pairedAt: "", revokedAt: null } : undefined),
    ...overrides,
  } as ConstructorParameters<typeof FrameRelay>[0];
}

function fakeConnector() {
  const listeners = new Map<string, Set<() => void>>();
  const state = { status: "running", n: 0, watches: 0 };
  const connector = {
    watchTask(taskId: string) {
      state.watches += 1;
      return {
        ok: true,
        status: 200,
        body: {
          replay: () => Array.from({ length: 40 }, (_, index) => ({ id: `e${index}` })),
          subscribe: (listener: () => void) => {
            const set = listeners.get(taskId) ?? new Set();
            set.add(listener);
            listeners.set(taskId, set);
            return () => set.delete(listener);
          },
          presented: () => ({ id: taskId, status: state.status, n: state.n }),
        },
      };
    },
  } as unknown as ConnectorApi;
  const emit = (taskId: string) => {
    for (const listener of listeners.get(taskId) ?? []) listener();
  };
  const listenerCount = (taskId: string) => listeners.get(taskId)?.size ?? 0;
  return { connector, state, emit, listenerCount };
}

function track(client: RelayConnection) {
  cleanups.push(() => client.close());
  return client;
}

async function browser(h: Harness, token = "fresh") {
  const socket = new WebSocket(h.url("/relay/browser"));
  const frames: Frame[] = [];
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(JSON.stringify({ kind: "auth", role: "browser", token, deviceId: "dev1" }));
  cleanups.push(() => socket.terminate());
  return { socket, frames, closed };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 5_000) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > ms) throw new Error("Timed out");
    await wait(20);
  }
}

describe("relay reconnection regressions", () => {
  it("does not unpair a computer when the relay's database check fails temporarily", async () => {
    let failures = 1;
    const h = await harness(
      goodStore({
        deviceForToken: async () => {
          if (failures-- > 0) throw new Error("connection terminated unexpectedly");
          return { id: "dev1", userId: "u1" };
        },
      }),
    );
    let revoked = false;
    let connected = 0;
    track(
      connectRelay({
        url: h.url("/relay/connector"),
        connector: fakeConnector().connector,
        token: "device-token",
        onRevoked: () => {
          revoked = true;
        },
        onConnected: () => {
          connected += 1;
        },
      }),
    );
    await until(() => h.relay.isOnline("dev1"));
    expect(revoked).toBe(false);
    expect(connected).toBeGreaterThanOrEqual(2);
  });

  it("closes a revoked or unknown device with REVOKED, and only then does the connector unpair", async () => {
    const h = await harness(goodStore());
    let revoked = false;
    track(
      connectRelay({
        url: h.url("/relay/connector"),
        connector: fakeConnector().connector,
        token: "revoked-token",
        onRevoked: () => {
          revoked = true;
        },
      }),
    );
    await until(() => revoked);
  });

  it("tells a browser with an expired access token to refresh, not that the computer is gone", async () => {
    const h = await harness(goodStore());
    const b = await browser(h, "expired");
    expect(await b.closed).toBe(RELAY_CLOSE.SESSION_EXPIRED);
  });

  it("closes with TEMPORARY when the browser's auth check itself fails", async () => {
    const h = await harness(goodStore({ userForSession: async () => Promise.reject(new Error("auth service down")) }));
    const b = await browser(h);
    expect(await b.closed).toBe(RELAY_CLOSE.TEMPORARY);
  });

  it("notifies the browser when the connector drops and returns, and the re-watched task streams again", async () => {
    const h = await harness(goodStore());
    const fake = fakeConnector();
    const client = track(connectRelay({ url: h.url("/relay/connector"), connector: fake.connector, token: "device-token", flushMs: 10 }));
    await until(() => h.relay.isOnline("dev1"));
    const b = await browser(h);
    await until(() => b.frames.some((frame) => frame.kind === "presence"));
    expect(b.frames.find((frame) => frame.kind === "presence")).toEqual({ kind: "presence", online: true });

    b.socket.send(JSON.stringify({ kind: "request", id: "w1", method: "tasks.events", params: { taskId: "t1" } }));
    await until(() => b.frames.some((frame) => frame.kind === "event"));

    h.connectorSockets[0]!.terminate();
    await until(() => b.frames.some((frame) => frame.kind === "presence" && !frame.online));
    expect(client.watching()).toEqual([]);
    await until(() => b.frames.filter((frame) => frame.kind === "presence" && frame.online).length >= 2);

    // The browser re-watches after presence returns (relay-browser.ts does this); updates flow again.
    const before = b.frames.filter((frame) => frame.kind === "event").length;
    b.socket.send(JSON.stringify({ kind: "request", id: "w2", method: "tasks.events", params: { taskId: "t1" } }));
    await until(() => client.watching().includes("t1"));
    fake.state.n = 7;
    fake.emit("t1");
    await until(() => b.frames.some((frame) => frame.kind === "event" && (frame.data as { n: number }).n === 7));
    expect(b.frames.filter((frame) => frame.kind === "event").length).toBeGreaterThan(before);
  });

  it("sends a watched task once instead of once per stored event, and coalesces bursts", async () => {
    const h = await harness(goodStore());
    const fake = fakeConnector();
    track(connectRelay({ url: h.url("/relay/connector"), connector: fake.connector, token: "device-token", flushMs: 40 }));
    await until(() => h.relay.isOnline("dev1"));
    const b = await browser(h);
    b.socket.send(JSON.stringify({ kind: "request", id: "w1", method: "tasks.events", params: { taskId: "t1" } }));
    await until(() => b.frames.some((frame) => frame.kind === "event"));
    await wait(100);
    expect(b.frames.filter((frame) => frame.kind === "event")).toHaveLength(1);
    for (let index = 0; index < 25; index += 1) fake.emit("t1");
    await wait(150);
    expect(b.frames.filter((frame) => frame.kind === "event").length).toBeLessThanOrEqual(3);
  });

  it("keeps one subscription per task and removes it on unwatch or when the task finishes", async () => {
    const h = await harness(goodStore());
    const fake = fakeConnector();
    const client = track(connectRelay({ url: h.url("/relay/connector"), connector: fake.connector, token: "device-token", flushMs: 10 }));
    await until(() => h.relay.isOnline("dev1"));
    const b = await browser(h);
    for (const id of ["a", "b", "c"]) {
      b.socket.send(JSON.stringify({ kind: "request", id, method: "tasks.events", params: { taskId: "t1" } }));
    }
    await until(() => b.frames.filter((frame) => frame.kind === "response").length >= 3);
    expect(fake.listenerCount("t1")).toBe(1);
    b.socket.send(JSON.stringify({ kind: "request", id: "u", method: "tasks.unwatch", params: { taskId: "t1" } }));
    await until(() => fake.listenerCount("t1") === 0);
    expect(client.watching()).toEqual([]);

    b.socket.send(JSON.stringify({ kind: "request", id: "w2", method: "tasks.events", params: { taskId: "t2" } }));
    await until(() => client.watching().includes("t2"));
    fake.state.status = "completed";
    fake.emit("t2");
    await until(() => !client.watching().includes("t2"));
  });

  it("terminates a socket that stops answering keepalive pings", async () => {
    const h = await harness(goodStore());
    const raw = new WebSocket(h.url("/relay/browser"), { autoPong: false } as never);
    cleanups.push(() => raw.terminate());
    const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
    await new Promise<void>((resolve) => raw.once("open", () => resolve()));
    raw.send(JSON.stringify({ kind: "auth", role: "browser", token: "fresh", deviceId: "dev1" }));
    await wait(50);
    h.relay.heartbeat(h.wss.clients);
    h.relay.heartbeat(h.wss.clients);
    await closed;
  });

  it("fails a request to an offline computer immediately instead of leaving it waiting", async () => {
    const h = await harness(goodStore());
    const b = await browser(h);
    await until(() => b.frames.some((frame) => frame.kind === "presence"));
    expect(b.frames.find((frame) => frame.kind === "presence")).toEqual({ kind: "presence", online: false });
    b.socket.send(JSON.stringify({ kind: "request", id: "r1", method: "workspace.get" }));
    await until(() => b.frames.some((frame) => frame.kind === "response"));
    expect(b.frames.find((frame) => frame.kind === "response")).toMatchObject({ ok: false, error: { code: "DEVICE_OFFLINE" } });
  });
});
