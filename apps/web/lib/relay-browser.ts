import { frameFromHttp, parseFrame, type Frame } from "@prentice/protocol";
import { holdRelaySession, type LocalSession, type PrenticeError, type TaskPayload } from "@/lib/prentice";

export const COMPUTER_OFFLINE = "This computer is offline.";
export const COMPUTER_DISCONNECTED = "This computer was disconnected from Prentice.";
export const COMPUTER_DROPPED = "The connection to this computer dropped.";

export interface ComputerLink {
  session: LocalSession;
  close(): void;
  updateAccessToken(accessToken: string): void;
  onStatus(listener: (message: string | null) => void): () => void;
}

/** Browser side of the relay. Requests are the same workspace calls the local runtime already serves. */
export function connectComputer(options: { cloudUrl: string; deviceId: string; accessToken: string }): ComputerLink {
  const pending = new Map<string, { resolve: (body: unknown) => void; reject: (error: Error) => void }>();
  const watches = new Map<string, (task: TaskPayload) => void>();
  const listeners = new Set<(message: string | null) => void>();
  let socket: WebSocket | null = null;
  let accessToken = options.accessToken;
  let closed = false;
  let attempt = 0;
  let opened = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const reconnectListeners = new Set<() => void>();

  const session: LocalSession = {
    token: options.accessToken,
    runtimeUrl: options.cloudUrl,
    mode: "relay",
    call: (path, init) => request(path, init),
    watch: (taskId, onTask, signal) => watch(taskId, onTask, signal),
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };

  function notify(message: string | null) {
    for (const listener of listeners) listener(message);
  }

  function failPending(message: string) {
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(message));
      pending.delete(id);
    }
  }

  function dial() {
    if (closed) return;
    const current = new WebSocket(relayUrl(options.cloudUrl));
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      current.send(JSON.stringify({ kind: "auth", role: "browser", token: accessToken, deviceId: options.deviceId }));
      void request("/v1/providers")
        .then(() => {
          notify(null);
          if (opened) {
            for (const listener of reconnectListeners) listener();
          }
          opened = true;
        })
        .catch(() => notify(COMPUTER_OFFLINE));
      for (const taskId of watches.keys()) void request(`/v1/tasks/${taskId}/events`).catch(() => undefined);
    });
    current.addEventListener("message", (event) => {
      let frame: Frame;
      try {
        frame = parseFrame(JSON.parse(String(event.data)));
      } catch {
        return;
      }
      if (frame.kind === "response") {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        if (!waiter) return;
        if (!frame.ok) {
          const error = frame.error as PrenticeError;
          if (error.code === "DEVICE_OFFLINE") notify(COMPUTER_OFFLINE);
          waiter.reject(new Error(error.message));
          return;
        }
        waiter.resolve(frame.body);
        return;
      }
      if (frame.kind === "event" && frame.event === "task") {
        const task = frame.data as TaskPayload;
        watches.get(frame.taskId)?.(task);
      }
    });
    current.addEventListener("close", (event) => {
      if (socket !== current || closed) return;
      const refused = event.code === 4001;
      const message = refused ? COMPUTER_DISCONNECTED : COMPUTER_DROPPED;
      notify(message);
      failPending(message);
      if (refused) {
        closed = true;
        return;
      }
      const delayMs = Math.min(30_000, 500 * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(dial, delayMs);
    });
  }

  function request(path: string, init?: RequestInit): Promise<unknown> {
    const id = crypto.randomUUID();
    const httpMethod = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
    const frame = frameFromHttp(httpMethod, path, body, id);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        pending.delete(id);
        reject(new Error(COMPUTER_OFFLINE));
        return;
      }
      socket.send(JSON.stringify(frame));
    });
  }

  async function watch(taskId: string, onTask: (task: TaskPayload) => void, signal: AbortSignal): Promise<void> {
    watches.set(taskId, onTask);
    const stop = () => {
      if (watches.get(taskId) === onTask) watches.delete(taskId);
    };
    signal.addEventListener("abort", stop);
    try {
      await request(`/v1/tasks/${taskId}/events`);
    } catch (error) {
      stop();
      throw error;
    }
    if (signal.aborted) stop();
  }

  dial();
  holdRelaySession(session);
  return {
    session,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      holdRelaySession(null);
    },
    updateAccessToken(next: string) {
      accessToken = next;
      session.token = next;
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function relayUrl(cloudUrl: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/browser";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function cloudConfig(): { url: string; supabaseUrl: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_PRENTICE_CLOUD_URL ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!url || !supabaseUrl || !publishableKey) {
    throw new Error("Prentice website is missing its cloud or Supabase settings.");
  }
  return { url, supabaseUrl, publishableKey };
}
