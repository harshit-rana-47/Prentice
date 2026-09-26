import { parseFrame, type Frame } from "@prentice/protocol";
import type { ConnectorApi } from "./connector.js";
import { dispatchRequest } from "./dispatch.js";
import { log } from "./log.js";
import { assertSecureRelayUrl } from "./pair.js";

export interface RelayConnection {
  close(): void;
}

/** Outbound client. It connects only to the URL it is given, and it redials after a network drop. */
export function connectRelay(options: {
  url: string;
  connector: ConnectorApi;
  pingMs?: number;
  token?: string;
  onRevoked?: () => void;
}): RelayConnection {
  assertSecureRelayUrl(options.url);
  let closed = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const subscriptions = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  const dial = () => {
    if (closed) return;
    const current = new WebSocket(options.url);
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      log("info", "Relay connected");
      if (!options.token) return;
      current.send(JSON.stringify({ kind: "auth", role: "connector", token: options.token }));
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
      if (event.code === 4001) {
        closed = true;
        log("error", "The relay refused this device. It may have been revoked. Pair the computer again.");
        options.onRevoked?.();
        return;
      }
      const delayMs = Math.min(30_000, 500 * 2 ** attempt);
      attempt += 1;
      log("warn", "Relay connection closed. Reconnecting.", { delayMs, code: event.code });
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
      await streamEvents(current, frame);
      return;
    }
    send(current, await dispatchRequest(options.connector, frame));
  }

  async function streamEvents(current: WebSocket, frame: Extract<Frame, { kind: "request"; method: "tasks.events" }>) {
    const opened = options.connector.watchTask(frame.params.taskId);
    if (!opened.ok) {
      send(current, { kind: "response", id: frame.id, ok: false, status: opened.status, error: opened.error });
      return;
    }
    send(current, { kind: "response", id: frame.id, ok: true, status: 200, body: { subscribed: true } });
    const taskId = frame.params.taskId;
    const publish = () => {
      const task = opened.body.presented();
      if (!task) return;
      send(current, { kind: "event", method: "tasks.events", taskId, event: "task", data: task });
    };
    for (const _event of opened.body.replay()) publish();
    subscriptions.add(opened.body.subscribe(() => publish()));
    const timer = setInterval(() => {
      send(current, { kind: "event", method: "tasks.events", taskId, event: "ping", data: {} });
    }, options.pingMs ?? 15_000);
    timers.add(timer);
  }

  function send(current: WebSocket, frame: Frame) {
    if (current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(frame));
      return;
    }
    log("error", "The relay connection closed before this result could be delivered.", { kind: frame.kind });
  }

  function stopStreams() {
    for (const stop of subscriptions) stop();
    for (const timer of timers) clearInterval(timer);
    subscriptions.clear();
    timers.clear();
  }

  dial();
  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      stopStreams();
      socket?.close();
    },
  };
}
