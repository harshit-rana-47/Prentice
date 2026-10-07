import { RELAY_CLOSE, parseFrame, type Frame } from "@prentice/protocol";
import type { WebSocket } from "ws";
import type { CloudStore } from "./store.js";

type RelayStore = Pick<CloudStore, "deviceForToken" | "userForSession" | "deviceForUser">;

const AUTH_TIMEOUT_MS = 5_000;

/**
 * Forwards protocol frames in memory. Frame bodies are not written to the database or the log.
 *
 * Close codes follow RELAY_CLOSE. Only REVOKED tells a connector its credential is gone. A database or auth
 * service error closes with TEMPORARY, so a hiccup never unpairs a computer.
 */
export class FrameRelay {
  private connectors = new Map<string, WebSocket>();
  private browsers = new Map<string, Set<WebSocket>>();
  private pending = new Map<string, Map<string, WebSocket>>();
  private alive = new WeakMap<WebSocket, boolean>();

  constructor(private readonly store: RelayStore) {}

  attach(socket: WebSocket, role: "connector" | "browser"): void {
    let deviceId: string | undefined;
    let chain = Promise.resolve();
    this.alive.set(socket, true);
    socket.on("pong", () => this.alive.set(socket, true));
    const timer = setTimeout(() => {
      if (!deviceId && socket.readyState === socket.OPEN) socket.close(RELAY_CLOSE.AUTH_TIMEOUT, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    socket.on("message", (data) => {
      chain = chain
        .then(() =>
          this.onMessage(socket, role, data, () => deviceId, (id) => {
            deviceId = id;
            clearTimeout(timer);
          }),
        )
        .catch(() => {
          if (!deviceId && socket.readyState === socket.OPEN) socket.close(RELAY_CLOSE.TEMPORARY, "temporarily unavailable");
        });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!deviceId) return;
      if (this.connectors.get(deviceId) === socket) {
        this.connectors.delete(deviceId);
        this.failPending(deviceId);
        this.announce(deviceId, false);
      }
      this.browsers.get(deviceId)?.delete(socket);
      this.dropBrowser(deviceId, socket);
    });
  }

  /**
   * Pings every socket. A socket that did not answer the previous ping is closed, which also keeps idle proxies
   * from dropping healthy connections. Browsers and Node's WebSocket answer pings on their own.
   */
  heartbeat(sockets: Iterable<WebSocket>): void {
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (this.alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }

  /** Closes the live connector socket after its credential has been removed. */
  disconnect(deviceId: string): void {
    const socket = this.connectors.get(deviceId);
    this.failPending(deviceId);
    if (socket && socket.readyState === socket.OPEN) socket.close(RELAY_CLOSE.REVOKED, "revoked");
    for (const browser of this.browsers.get(deviceId) ?? []) {
      if (browser.readyState === browser.OPEN) browser.close(RELAY_CLOSE.REVOKED, "revoked");
    }
  }

  isOnline(deviceId: string): boolean {
    const socket = this.connectors.get(deviceId);
    return Boolean(socket && socket.readyState === socket.OPEN);
  }

  private async onMessage(
    socket: WebSocket,
    role: "connector" | "browser",
    data: unknown,
    current: () => string | undefined,
    setDevice: (id: string) => void,
  ): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(String(data));
    } catch {
      return;
    }
    let frame: Frame;
    try {
      frame = parseFrame(input);
    } catch {
      return;
    }
    if (frame.kind === "ping") return;
    const deviceId = current();
    if (!deviceId) {
      const authenticated = await this.authenticate(socket, role, frame);
      if (authenticated) setDevice(authenticated);
      return;
    }
    if (role === "connector") this.fromConnector(deviceId, frame, String(data));
    else this.fromBrowser(deviceId, frame, String(data), socket);
  }

  /** Store errors propagate to attach(), which closes with TEMPORARY rather than REVOKED. */
  private async authenticate(socket: WebSocket, role: "connector" | "browser", frame: Frame): Promise<string | undefined> {
    if (frame.kind !== "auth" || frame.role !== role) {
      socket.close(RELAY_CLOSE.AUTH_TIMEOUT, "auth required");
      return undefined;
    }
    if (frame.role === "connector") {
      const device = await this.store.deviceForToken(frame.token);
      if (socket.readyState !== socket.OPEN) return undefined;
      if (!device) {
        socket.close(RELAY_CLOSE.REVOKED, "unknown device");
        return undefined;
      }
      this.connectors.set(device.id, socket);
      this.announce(device.id, true);
      return device.id;
    }
    const user = await this.store.userForSession(frame.token);
    if (socket.readyState !== socket.OPEN) return undefined;
    if (!user) {
      socket.close(RELAY_CLOSE.SESSION_EXPIRED, "session expired");
      return undefined;
    }
    const device = await this.store.deviceForUser(frame.deviceId, user.id);
    if (socket.readyState !== socket.OPEN) return undefined;
    if (!device) {
      socket.close(RELAY_CLOSE.REVOKED, "unknown device");
      return undefined;
    }
    const set = this.browsers.get(device.id) ?? new Set();
    set.add(socket);
    this.browsers.set(device.id, set);
    socket.send(JSON.stringify({ kind: "presence", online: this.isOnline(device.id) }));
    return device.id;
  }

  /** Tells every browser watching this computer whether its connector is connected. */
  private announce(deviceId: string, online: boolean): void {
    const frame = JSON.stringify({ kind: "presence", online });
    for (const browser of this.browsers.get(deviceId) ?? []) {
      if (browser.readyState === browser.OPEN) browser.send(frame);
    }
  }

  private fromConnector(deviceId: string, frame: Frame, raw: string): void {
    if (frame.kind !== "response" && frame.kind !== "event") return;
    if (frame.kind === "response") this.pending.get(deviceId)?.delete(frame.id);
    for (const browser of this.browsers.get(deviceId) ?? []) {
      if (browser.readyState === browser.OPEN) browser.send(raw);
    }
  }

  private fromBrowser(deviceId: string, frame: Frame, raw: string, browser: WebSocket): void {
    if (frame.kind !== "request") return;
    const connector = this.connectors.get(deviceId);
    if (!connector || connector.readyState !== connector.OPEN) {
      browser.send(offlineFrame(frame.id));
      return;
    }
    let waiting = this.pending.get(deviceId);
    if (!waiting) {
      waiting = new Map();
      this.pending.set(deviceId, waiting);
    }
    waiting.set(frame.id, browser);
    connector.send(raw);
  }

  private failPending(deviceId: string): void {
    const waiting = this.pending.get(deviceId);
    if (!waiting) return;
    for (const [id, browser] of waiting) {
      if (browser.readyState === browser.OPEN) browser.send(offlineFrame(id));
    }
    this.pending.delete(deviceId);
  }

  private dropBrowser(deviceId: string, browser: WebSocket): void {
    const waiting = this.pending.get(deviceId);
    if (!waiting) return;
    for (const [id, socket] of waiting) {
      if (socket === browser) waiting.delete(id);
    }
  }
}

function offlineFrame(id: string): string {
  return JSON.stringify({
    kind: "response",
    id,
    ok: false,
    status: 409,
    error: { code: "DEVICE_OFFLINE", message: "This computer is not connected to Prentice right now.", retryable: true },
  });
}
