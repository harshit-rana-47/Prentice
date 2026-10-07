import { RELAY_CLOSE } from "@prentice/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_DISCONNECTED, COMPUTER_NO_ANSWER, COMPUTER_OFFLINE, SIGNED_OUT, connectComputer } from "./relay-browser";

/** A fake relay socket. Tests push frames in and read what the page sent. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Array<(event: unknown) => void>>();
  constructor(public url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.open());
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  frame(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.emit("close", { code });
  }
  lastRequest(method?: string) {
    return [...this.sent].reverse().find((frame) => frame.kind === "request" && (!method || frame.method === method));
  }
  private emit(type: string, event: unknown) {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function link(overrides: Partial<Parameters<typeof connectComputer>[0]> = {}) {
  const statuses: Array<string | null> = [];
  const computer = connectComputer({
    cloudUrl: "http://127.0.0.1:4740",
    deviceId: "dev1",
    accessToken: "token-1",
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  });
  computer.onStatus((message) => statuses.push(message));
  return { computer, statuses };
}

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe("browser relay link", () => {
  it("authenticates, then waits for presence before calling the computer online", async () => {
    const { statuses } = link();
    await tick();
    const socket = FakeSocket.all[0]!;
    expect(socket.sent[0]).toEqual({ kind: "auth", role: "browser", token: "token-1", deviceId: "dev1" });
    socket.frame({ kind: "presence", online: false });
    expect(statuses.at(-1)).toBe(COMPUTER_OFFLINE);
    socket.frame({ kind: "presence", online: true });
    expect(statuses.at(-1)).toBeNull();
  });

  it("restores task streams and refreshes the page when the computer comes back", async () => {
    const { computer } = link();
    await tick();
    const socket = FakeSocket.all[0]!;
    socket.frame({ kind: "presence", online: true });
    const reconnected = vi.fn();
    computer.session.onReconnect?.(reconnected);
    const seen: unknown[] = [];
    const watching = computer.session.watch!("t1", (task) => seen.push(task), new AbortController().signal);
    const subscribe = socket.lastRequest("tasks.events")!;
    socket.frame({ kind: "response", id: subscribe.id, ok: true, status: 200, body: { subscribed: true } });
    await watching;
    socket.frame({ kind: "presence", online: false });
    socket.frame({ kind: "presence", online: true });
    const again = socket.sent.filter((frame) => frame.method === "tasks.events");
    expect(again).toHaveLength(2);
    expect(reconnected).toHaveBeenCalledTimes(1);
    socket.frame({ kind: "event", method: "tasks.events", taskId: "t1", event: "task", data: { id: "t1", n: 2 } });
    expect(seen).toEqual([{ id: "t1", n: 2 }]);
  });

  it("refreshes an expired access token and redials instead of reporting the computer gone", async () => {
    const refresh = vi.fn(async () => "token-2");
    const { statuses } = link({ refreshAccessToken: refresh });
    await tick();
    FakeSocket.all[0]!.drop(RELAY_CLOSE.SESSION_EXPIRED);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]!.sent[0]).toMatchObject({ kind: "auth", token: "token-2" });
    expect(statuses).not.toContain(COMPUTER_DISCONNECTED);
  });

  it("says the sign-in ended when no fresh token is available", async () => {
    const { statuses } = link({ refreshAccessToken: async () => null });
    await tick();
    FakeSocket.all[0]!.drop(RELAY_CLOSE.SESSION_EXPIRED);
    await tick();
    await tick();
    expect(statuses.at(-1)).toBe(SIGNED_OUT);
  });

  it("stops only on REVOKED, and redials after any other close", async () => {
    vi.useFakeTimers();
    const first = link();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.drop(RELAY_CLOSE.TEMPORARY);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.drop(RELAY_CLOSE.REVOKED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(first.statuses.at(-1)).toBe(COMPUTER_DISCONNECTED);
  });

  it("keeps redialing through failed attempts while the relay is down, then recovers", async () => {
    vi.useFakeTimers();
    const { statuses } = link();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.frame({ kind: "presence", online: true });
    expect(statuses.at(-1)).toBeNull();
    FakeSocket.all[0]!.drop(1006);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(31_000);
      const socket = FakeSocket.all[attempt]!;
      expect(socket).toBeDefined();
      socket.drop(1006);
    }
    await vi.advanceTimersByTimeAsync(31_000);
    const last = FakeSocket.all.at(-1)!;
    last.frame({ kind: "presence", online: true });
    expect(statuses.at(-1)).toBeNull();
  });

  it("redials immediately when the network comes back instead of waiting out the backoff", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: () => undefined });
    try {
      link();
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.all[0]!.drop(1006);
      await vi.advanceTimersByTimeAsync(1_000);
      FakeSocket.all[1]!.drop(1006);
      const before = FakeSocket.all.length;
      listeners.get("online")!();
      expect(FakeSocket.all.length).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails a request that the computer never answers instead of hanging", async () => {
    vi.useFakeTimers();
    const { computer } = link({ requestTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.frame({ kind: "presence", online: true });
    const call = computer.session.call!("/v1/workspace");
    const assertion = expect(call).rejects.toThrow(COMPUTER_NO_ANSWER);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("rejects immediately while the computer is known to be offline", async () => {
    const { computer } = link();
    await tick();
    FakeSocket.all[0]!.frame({ kind: "presence", online: false });
    await expect(computer.session.call!("/v1/workspace")).rejects.toThrow(COMPUTER_OFFLINE);
  });

  it("unwatches a task when the page stops showing it", async () => {
    const { computer } = link();
    await tick();
    const socket = FakeSocket.all[0]!;
    socket.frame({ kind: "presence", online: true });
    const controller = new AbortController();
    const watching = computer.session.watch!("t9", () => undefined, controller.signal);
    const subscribe = socket.lastRequest("tasks.events")!;
    socket.frame({ kind: "response", id: subscribe.id, ok: true, status: 200, body: {} });
    await watching;
    controller.abort();
    expect(socket.lastRequest("tasks.unwatch")).toMatchObject({ params: { taskId: "t9" } });
  });
});
