import { randomUUID } from "node:crypto";
import { RELAY_CLOSE, parseFrame, type Frame } from "@prentice/protocol";
import type { WebSocket } from "ws";
import type { CloudStore } from "./store.js";

type RelayStore = Pick<CloudStore, "deviceForToken" | "userForSession" | "deviceForUser">;
type Auth = { role: "browser" | "connector"; token: string; deviceId: string; userId: string };
type Pending = { browser: WebSocket; id: string; timer: ReturnType<typeof setTimeout> };

/** In-memory forwarding only. Credentials are checked on requests, delivery, and idle heartbeats. */
export class FrameRelay {
  private connectors = new Map<string, WebSocket>();
  private browsers = new Map<string, Set<WebSocket>>();
  private pending = new Map<string, Map<string, Pending>>();
  private watches = new Map<string, Map<string, Set<WebSocket>>>();
  private authenticated = new Map<WebSocket, Auth>();
  private alive = new WeakMap<WebSocket, boolean>();
  private signOutEpoch = new Map<string, number>();
  private validations = new WeakMap<WebSocket, Promise<boolean>>();

  constructor(private readonly store: RelayStore, private readonly requestTimeoutMs = 30_000) {}

  attach(socket: WebSocket, role: "connector" | "browser"): void {
    // Protocol/UTF-8 errors are emitted by ws before a frame reaches our parser.
    // An unauthenticated peer must not be able to crash the cloud process.
    socket.on("error", () => socket.terminate());
    let chain = Promise.resolve();
    this.alive.set(socket, true);
    socket.on("pong", () => this.alive.set(socket, true));
    const timer = setTimeout(() => {
      if (!this.authenticated.has(socket)) socket.close(RELAY_CLOSE.AUTH_TIMEOUT, "auth timeout");
    }, 5_000);
    socket.on("message", (data) => {
      chain = chain.then(async () => {
        let frame: Frame;
        try { frame = parseFrame(JSON.parse(String(data))); } catch { return; }
        if (!this.authenticated.has(socket)) {
          if (await this.authenticate(socket, role, frame)) clearTimeout(timer);
          return;
        }
        // Only authentication needs serialization. Streamed events must not queue a
        // response or Stop behind one remote authorization round trip per event.
        // validate shares in-flight checks; delivery still rechecks current ownership.
        void (async () => {
          if (!await this.validate(socket)) return;
          const auth = this.authenticated.get(socket);
          if (!auth) return;
          if (role === "connector") await this.fromConnector(auth.deviceId, frame, socket);
          else await this.fromBrowser(auth.deviceId, frame, socket);
        })().catch(() => this.close(socket, RELAY_CLOSE.TEMPORARY, "temporarily unavailable"));
      }).catch(() => this.close(socket, RELAY_CLOSE.TEMPORARY, "temporarily unavailable"));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const auth = this.authenticated.get(socket);
      this.authenticated.delete(socket);
      if (!auth) return;
      if (this.connectors.get(auth.deviceId) === socket) {
        this.connectors.delete(auth.deviceId);
        this.failPending(auth.deviceId);
        this.announce(auth.deviceId, false);
      }
      this.browsers.get(auth.deviceId)?.delete(socket);
      this.dropBrowser(auth.deviceId, socket);
    });
  }

  heartbeat(sockets: Iterable<WebSocket>): void {
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (this.alive.get(socket) === false) { socket.terminate(); continue; }
      this.alive.set(socket, false);
      void this.validate(socket).catch(() => this.close(socket, RELAY_CLOSE.TEMPORARY, "temporarily unavailable"));
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }

  disconnect(deviceId: string): void {
    const connector = this.connectors.get(deviceId);
    this.failPending(deviceId);
    if (connector) this.close(connector, RELAY_CLOSE.REVOKED, "revoked");
    for (const browser of this.browsers.get(deviceId) ?? []) this.close(browser, RELAY_CLOSE.REVOKED, "revoked");
  }

  signOut(userId: string): void {
    this.signOutEpoch.set(userId, (this.signOutEpoch.get(userId) ?? 0) + 1);
    for (const [socket, auth] of this.authenticated) {
      if (auth.role === "browser" && auth.userId === userId) this.close(socket, RELAY_CLOSE.SESSION_EXPIRED, "signed out");
    }
  }

  isOnline(deviceId: string): boolean {
    const socket = this.connectors.get(deviceId);
    return Boolean(socket && socket.readyState === socket.OPEN && this.authenticated.has(socket));
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    // Remove authorization synchronously; a closing socket cannot forward queued frames.
    const auth = this.authenticated.get(socket);
    if (auth?.role === "browser") {
      this.browsers.get(auth.deviceId)?.delete(socket);
      this.dropBrowser(auth.deviceId, socket);
    }
    if (auth?.role === "connector" && this.connectors.get(auth.deviceId) === socket) {
      this.connectors.delete(auth.deviceId);
      this.failPending(auth.deviceId);
      this.announce(auth.deviceId, false);
    }
    this.authenticated.delete(socket);
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  }

  private async authenticate(socket: WebSocket, role: "connector" | "browser", frame: Frame): Promise<boolean> {
    if (socket.readyState !== socket.OPEN) return false;
    if (frame.kind !== "auth" || frame.role !== role) {
      socket.close(RELAY_CLOSE.AUTH_TIMEOUT, "auth required"); return false;
    }
    if (frame.role === "connector") {
      const device = await this.store.deviceForToken(frame.token);
      if (socket.readyState !== socket.OPEN) return false;
      if (!device) { socket.close(RELAY_CLOSE.REVOKED, "unknown device"); return false; }
      const previous = this.connectors.get(device.id);
      if (previous) this.close(previous, RELAY_CLOSE.SUPERSEDED, "replaced by another connector");
      this.authenticated.set(socket, { role, token: frame.token, deviceId: device.id, userId: device.userId });
      this.connectors.set(device.id, socket);
      this.announce(device.id, true);
      return true;
    }
    const user = await this.store.userForSession(frame.token);
    if (socket.readyState !== socket.OPEN) return false;
    if (!user) { socket.close(RELAY_CLOSE.SESSION_EXPIRED, "session expired"); return false; }
    const epoch = this.signOutEpoch.get(user.id) ?? 0;
    const device = await this.store.deviceForUser(frame.deviceId, user.id);
    if (socket.readyState !== socket.OPEN) return false;
    if (!device) { socket.close(RELAY_CLOSE.REVOKED, "unknown device"); return false; }
    if ((this.signOutEpoch.get(user.id) ?? 0) !== epoch || !await this.store.userForSession(frame.token)) { socket.close(RELAY_CLOSE.SESSION_EXPIRED, "signed out"); return false; }
    if (socket.readyState !== socket.OPEN) return false;
    this.authenticated.set(socket, { role, token: frame.token, deviceId: device.id, userId: user.id });
    const set = this.browsers.get(device.id) ?? new Set();
    set.add(socket); this.browsers.set(device.id, set);
    socket.send(JSON.stringify({ kind: "presence", online: this.isOnline(device.id) }));
    return true;
  }

  private validate(socket: WebSocket): Promise<boolean> {
    const existing = this.validations.get(socket);
    if (existing) return existing;
    const check = (async () => {
      const auth = this.authenticated.get(socket);
      if (!auth || socket.readyState !== socket.OPEN) return false;
      if (auth.role === "connector") {
        if (this.connectors.get(auth.deviceId) !== socket) return false;
        const device = await this.store.deviceForToken(auth.token);
        if (!device || device.id !== auth.deviceId) { this.close(socket, RELAY_CLOSE.REVOKED, "revoked"); return false; }
      } else {
        const user = await this.store.userForSession(auth.token);
        if (!user || user.id !== auth.userId) { this.close(socket, RELAY_CLOSE.SESSION_EXPIRED, "session expired"); return false; }
        if (!await this.store.deviceForUser(auth.deviceId, user.id)) { this.close(socket, RELAY_CLOSE.REVOKED, "revoked"); return false; }
      }
      return this.authenticated.get(socket) === auth && socket.readyState === socket.OPEN;
    })();
    this.validations.set(socket, check);
    void check.finally(() => this.validations.delete(socket)).catch(() => undefined);
    return check;
  }

  private announce(deviceId: string, online: boolean): void {
    for (const browser of this.browsers.get(deviceId) ?? []) {
      if (browser.readyState === browser.OPEN) browser.send(JSON.stringify({ kind: "presence", online }));
    }
  }

  private async fromConnector(deviceId: string, frame: Frame, source: WebSocket): Promise<void> {
    if (frame.kind === "response") {
      const waiting = this.pending.get(deviceId);
      const request = waiting?.get(frame.id);
      if (!request) return;
      const valid = await this.validate(request.browser);
      if (this.connectors.get(deviceId) !== source || !this.authenticated.has(source) || waiting?.get(frame.id) !== request) return;
      clearTimeout(request.timer); waiting!.delete(frame.id);
      if (valid) request.browser.send(JSON.stringify({ ...frame, id: request.id }));
    } else if (frame.kind === "event") {
      for (const browser of this.watches.get(deviceId)?.get(frame.taskId) ?? []) {
        if (await this.validate(browser) && this.connectors.get(deviceId) === source && this.authenticated.has(source)) browser.send(JSON.stringify(frame));
      }
    }
  }

  private async fromBrowser(deviceId: string, frame: Frame, browser: WebSocket): Promise<void> {
    if (frame.kind !== "request") return;
    const connector = this.connectors.get(deviceId);
    if (!connector || !this.isOnline(deviceId)) { browser.send(offlineFrame(frame.id)); return; }
    const connectorValid = await this.validate(connector);
    if (!this.authenticated.has(browser) || browser.readyState !== browser.OPEN) return;
    if (!connectorValid) { browser.send(offlineFrame(frame.id)); return; }
    if (frame.method === "tasks.events" || frame.method === "tasks.unwatch") {
      const watches = this.watches.get(deviceId) ?? new Map<string, Set<WebSocket>>();
      this.watches.set(deviceId, watches);
      const set = watches.get(frame.params.taskId) ?? new Set<WebSocket>();
      if (frame.method === "tasks.events") { set.add(browser); watches.set(frame.params.taskId, set); }
      else {
        set.delete(browser);
        if (set.size) { browser.send(JSON.stringify({ kind: "response", id: frame.id, ok: true, status: 200, body: { unsubscribed: true } })); return; }
        watches.delete(frame.params.taskId);
      }
    }
    const id = randomUUID();
    const waiting = this.pending.get(deviceId) ?? new Map<string, Pending>();
    this.pending.set(deviceId, waiting);
    const timer = setTimeout(() => {
      waiting.delete(id);
      if (browser.readyState === browser.OPEN) browser.send(JSON.stringify({ kind: "response", id: frame.id, ok: false, status: 504, error: { code: "REQUEST_TIMEOUT", message: "This computer did not answer in time.", retryable: true } }));
    }, frame.method === "project.choose" ? 6 * 60_000 : this.requestTimeoutMs);
    timer.unref();
    waiting.set(id, { browser, id: frame.id, timer });
    connector.send(JSON.stringify({ ...frame, id }));
  }

  private failPending(deviceId: string): void {
    for (const request of this.pending.get(deviceId)?.values() ?? []) {
      clearTimeout(request.timer);
      if (request.browser.readyState === request.browser.OPEN) request.browser.send(offlineFrame(request.id));
    }
    this.pending.delete(deviceId);
  }

  private dropBrowser(deviceId: string, browser: WebSocket): void {
    for (const [id, request] of this.pending.get(deviceId) ?? []) {
      if (request.browser === browser) { clearTimeout(request.timer); this.pending.get(deviceId)!.delete(id); }
    }
    for (const [taskId, watchers] of this.watches.get(deviceId) ?? []) {
      watchers.delete(browser);
      if (!watchers.size) {
        this.watches.get(deviceId)!.delete(taskId);
        const connector = this.connectors.get(deviceId);
        if (connector && connector.readyState === connector.OPEN) connector.send(JSON.stringify({ kind: "request", id: randomUUID(), method: "tasks.unwatch", params: { taskId } }));
      }
    }
  }
}

function offlineFrame(id: string): string {
  return JSON.stringify({ kind: "response", id, ok: false, status: 409, error: { code: "DEVICE_OFFLINE", message: "This computer is not connected to Prentice right now.", retryable: true } });
}
