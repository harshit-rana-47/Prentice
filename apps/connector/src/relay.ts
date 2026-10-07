import { RELAY_CLOSE, parseFrame, type Frame } from "@prentice/protocol";
import type { ConnectorApi } from "./connector.js";
import { dispatchRequest } from "./dispatch.js";
import { log } from "./log.js";
import { assertSecureRelayUrl } from "./pair.js";

export interface RelayConnection {
  close(): void;
  /** Task ids with a live subscription on this connection. For diagnostics and tests. */
  watching(): string[];
}

/** How often a stream of task updates is flushed. Bursts of agent events become one frame. */
export const TASK_FLUSH_MS = 150;
/** Application keepalive toward the relay. */
export const CONNECTOR_KEEPALIVE_MS = 25_000;

interface Subscription {
  stop(): void;
}

/** Outbound client. It connects only to the URL it is given, and it redials after a network drop. */
export function connectRelay(options: {
  url: string;
  connector: ConnectorApi;
  token?: string;
  keepaliveMs?: number;
  flushMs?: number;
  onRevoked?: () => void;
  /** Called on every successful auth, including after a redial. */
  onConnected?: () => void;
}): RelayConnection {
  assertSecureRelayUrl(options.url);
  let closed = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const subscriptions = new Map<string, Subscription>();

  const dial = () => {
    if (closed) return;
    const current = new WebSocket(options.url);
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      log("info", "Relay connected");
      if (options.token) current.send(JSON.stringify({ kind: "auth", role: "connector", token: options.token }));
      options.onConnected?.();
      if (keepalive) clearInterval(keepalive);
      keepalive = setInterval(() => {
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ kind: "ping" }));
      }, options.keepaliveMs ?? CONNECTOR_KEEPALIVE_MS);
    });
    current.addEventListener("message", (event) => {
      void onMessage(current, String(event.data)).catch((error: unknown) => {
        log("error", "Relay frame failed", { error: error instanceof Error ? error.message : "unknown" });
      });
    });
    current.addEventListener("close", (event) => {
      if (socket !== current) return;
      stopStreams();
      if (closed) return;
      if (event.code === RELAY_CLOSE.REVOKED) {
        closed = true;
        log("error", "The relay says this device was revoked. Pair the computer again.");
        options.onRevoked?.();
        return;
      }
      const delayMs = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      attempt += 1;
      log("warn", "Relay connection closed. Reconnecting.", { delayMs, code: event.code, reason: event.reason || undefined });
      retry = setTimeout(dial, delayMs);
    });
    current.addEventListener("error", () => {
      log("warn", "Relay socket error");
    });
  };

  async function onMessage(current: WebSocket, raw: string) {
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = parseFrame(input);
    if (frame.kind !== "request") return;
    if (frame.method === "tasks.events") {
      watch(current, frame);
      return;
    }
    if (frame.method === "tasks.unwatch") {
      subscriptions.get(frame.params.taskId)?.stop();
      send(current, { kind: "response", id: frame.id, ok: true, status: 200, body: { unsubscribed: true } });
      return;
    }
    send(current, await dispatchRequest(options.connector, frame));
  }

  /**
   * One subscription per task on this connection. Watching the same task again (another tab, a reconnect)
   * sends the current task once and reuses the subscription. It ends when the task stops running or on unwatch.
   */
  function watch(current: WebSocket, frame: Extract<Frame, { kind: "request"; method: "tasks.events" }>) {
    const taskId = frame.params.taskId;
    const opened = options.connector.watchTask(taskId);
    if (!opened.ok) {
      send(current, { kind: "response", id: frame.id, ok: false, status: opened.status, error: opened.error });
      return;
    }
    send(current, { kind: "response", id: frame.id, ok: true, status: 200, body: { subscribed: true } });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const task = opened.body.presented();
      if (!task) return;
      send(current, { kind: "event", method: "tasks.events", taskId, event: "task", data: task });
      if (task.status !== "running" && task.status !== "analyzed") subscriptions.get(taskId)?.stop();
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, options.flushMs ?? TASK_FLUSH_MS);
    };
    if (subscriptions.has(taskId)) {
      flush();
      return;
    }
    const unsubscribe = opened.body.subscribe(() => schedule());
    subscriptions.set(taskId, {
      stop() {
        unsubscribe();
        if (timer) clearTimeout(timer);
        timer = null;
        subscriptions.delete(taskId);
      },
    });
    flush();
  }

  function send(current: WebSocket, frame: Frame) {
    if (current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(frame));
      return;
    }
    log("error", "The relay connection closed before this result could be delivered.", { kind: frame.kind });
  }

  function stopStreams() {
    for (const subscription of [...subscriptions.values()]) subscription.stop();
    subscriptions.clear();
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
  }

  dial();
  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      stopStreams();
      socket?.close();
    },
    watching() {
      return [...subscriptions.keys()];
    },
  };
}
