import { parseFrame, type Frame } from "@prentice/protocol";
import type { WebSocket } from "ws";
import type { CloudStore } from "./store.js";

/** Forwards protocol frames in memory. Frame bodies are not written to the database or the log. */
export class FrameRelay {
  private connectors = new Map<string, WebSocket>();
  private browsers = new Map<string, Set<WebSocket>>();
  private pending = new Map<string, Map<string, WebSocket>>();

  constructor(private readonly store: CloudStore) {}

  attach(socket: WebSocket, role: "connector" | "browser"): void {
    let deviceId: string | undefined;
    let chain = Promise.resolve();
    const timer = setTimeout(() => {
      if (!deviceId) socket.close(4001, "auth timeout");
    }, 5_000);
    socket.on("message", (data) => {
      chain = chain.then(() => this.onMessage(socket, role, data, () => deviceId, (id) => {
        deviceId = id;
      })).catch(() => undefined);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!deviceId) return;
      if (this.connectors.get(deviceId) === socket) {
        this.connectors.delete(deviceId);
        this.failPending(deviceId);
      }
      this.browsers.get(deviceId)?.delete(socket);
      this.dropBrowser(deviceId, socket);
    });
  }

  /** Closes the live connector socket after its credential has been removed. */
  disconnect(deviceId: string): void {
    const socket = this.connectors.get(deviceId);
    this.failPending(deviceId);
    if (socket && socket.readyState === socket.OPEN) socket.close(4001, "revoked");
    for (const browser of this.browsers.get(deviceId) ?? []) {
      if (browser.readyState === browser.OPEN) browser.close(4001, "revoked");
    }
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
    const deviceId = current();
    if (!deviceId) {
      const authenticated = await this.authenticate(socket, role, frame);
      if (authenticated) setDevice(authenticated);
      return;
    }
    if (role === "connector") this.fromConnector(deviceId, frame, String(data));
    else this.fromBrowser(deviceId, frame, String(data), socket);
  }

  private async authenticate(socket: WebSocket, role: "connector" | "browser", frame: Frame): Promise<string | undefined> {
    if (frame.kind !== "auth" || frame.role !== role) {
      socket.close(4001, "auth required");
      return undefined;
    }
    if (frame.role === "connector") {
      const device = await this.store.deviceForToken(frame.token);
      if (!device || socket.readyState !== socket.OPEN) {
        if (socket.readyState === socket.OPEN) socket.close(4001, "unknown device");
        return undefined;
      }
      this.connectors.set(device.id, socket);
      return device.id;
    }
    const user = await this.store.userForSession(frame.token);
    const device = user ? await this.store.deviceForUser(frame.deviceId, user.id) : undefined;
    if (!device) {
      socket.close(4001, "unknown device");
      return undefined;
    }
    const set = this.browsers.get(device.id) ?? new Set();
    set.add(socket);
    this.browsers.set(device.id, set);
    return device.id;
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
    error: { code: "DEVICE_OFFLINE", message: "The connector is not connected.", retryable: true },
  });
}
