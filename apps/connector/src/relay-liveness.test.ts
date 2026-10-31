import { afterEach, expect, it, vi } from "vitest";
import { RELAY_CLOSE } from "@prentice/protocol";
import type { ConnectorApi } from "./connector.js";
import { connectRelay, type RelayConnection } from "./relay.js";

class Socket extends EventTarget {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(_url: string) { super(); Socket.all.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  drop(code = 1006) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" })); }
}
const clients: RelayConnection[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  Socket.all = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function start() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const connected = vi.fn(), revoked = vi.fn();
  const client = connectRelay({ url: "ws://127.0.0.1/relay/connector", token: "saved-token", connector: {} as ConnectorApi,
    connectTimeoutMs: 100, idleTimeoutMs: 100, keepaliveMs: 25, onConnected: connected, onRevoked: revoked });
  clients.push(client);
  return { connected, revoked };
}

it("reports online only after an authenticated relay frame, not a TCP upgrade", async () => {
  const { connected } = start();
  Socket.all[0]!.open();
  expect(connected).not.toHaveBeenCalled();
  Socket.all[0]!.frame({ kind: "ping" });
  expect(connected).toHaveBeenCalledOnce();
  Socket.all[0]!.frame({ kind: "ping" });
  expect(connected).toHaveBeenCalledOnce();
});

it.each([false, true])("retires a stalled connection (upgraded=%s), redials, and ignores its late events", async upgraded => {
  const { connected, revoked } = start();
  const old = Socket.all[0]!;
  if (upgraded) old.open();
  await vi.advanceTimersByTimeAsync(101);
  expect(old.readyState).toBe(3);
  await vi.advanceTimersToNextTimerAsync();
  const next = Socket.all.at(-1)!;
  expect(next).not.toBe(old);
  next.open(); next.frame({ kind: "ping" });
  old.frame({ kind: "ping" }); old.drop(RELAY_CLOSE.REVOKED);
  expect(connected).toHaveBeenCalledOnce();
  expect(revoked).not.toHaveBeenCalled();
});

it("reconnects an open socket when the network silently stops delivering acknowledgements", async () => {
  const { connected } = start();
  const old = Socket.all[0]!;
  old.open(); old.frame({ kind: "ping" });
  for (let n = 0; n < 4; n++) {
    await vi.advanceTimersByTimeAsync(50);
    old.frame({ kind: "ping" });
  }
  expect(Socket.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(101);
  expect(old.readyState).toBe(3);
  await vi.advanceTimersToNextTimerAsync();
  Socket.all.at(-1)!.open(); Socket.all.at(-1)!.frame({ kind: "ping" });
  expect(connected).toHaveBeenCalledTimes(2);
});

it("does not retry after revocation or supersession and does not delete credentials on supersession", async () => {
  for (const code of [RELAY_CLOSE.SUPERSEDED, RELAY_CLOSE.REVOKED]) {
    const { revoked } = start();
    const count = Socket.all.length;
    Socket.all.at(-1)!.open(); Socket.all.at(-1)!.drop(code);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(Socket.all).toHaveLength(count);
    expect(revoked).toHaveBeenCalledTimes(code === RELAY_CLOSE.REVOKED ? 1 : 0);
  }
});
