import { RELAY_CLOSE, frameFromHttp, parseFrame, type Frame } from "@prentice/protocol";
import { holdRelaySession, type LocalSession, type PrenticeError, type TaskPayload } from "@/lib/prentice";

export const COMPUTER_OFFLINE = "This computer is offline. Open Prentice on it, and it will reconnect on its own.";
export const COMPUTER_DISCONNECTED = "This computer was disconnected from Prentice.";
export const COMPUTER_DROPPED = "The connection to Prentice dropped. Reconnecting…";
export const COMPUTER_NO_ANSWER = "This computer did not answer in time. It may be busy or offline. Try again.";
export const SIGNED_OUT = "Your Prentice session ended. Sign in again.";

/** How long a request may wait for the computer. Choosing a folder waits for a person at that computer. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const FOLDER_TIMEOUT_MS = 6 * 60_000;

export interface ComputerLink {
  session: LocalSession;
  close(): void;
  updateAccessToken(accessToken: string): void;
  onStatus(listener: (message: string | null) => void): () => void;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState" | "addEventListener">;

export interface ConnectOptions {
  cloudUrl: string;
  deviceId: string;
  accessToken: string;
  /** Asked for a fresh Supabase access token when the relay says the current one expired. */
  refreshAccessToken?: () => Promise<string | null>;
  /** For tests. Defaults to the browser WebSocket. */
  createSocket?: (url: string) => SocketLike;
  requestTimeoutMs?: number;
}

/** Browser side of the relay. Requests are the same workspace calls the local runtime already serves. */
export function connectComputer(options: ConnectOptions): ComputerLink {
  const pending = new Map<string, { resolve: (body: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const watches = new Map<string, (task: TaskPayload) => void>();
  const listeners = new Set<(message: string | null) => void>();
  const reconnectListeners = new Set<() => void>();
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  let socket: SocketLike | null = null;
  let accessToken = options.accessToken;
  let closed = false;
  let attempt = 0;
  let online: boolean | null = null;
  let everOnline = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let status: string | null = null;
  let expiredCloses = 0;

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
    unwatch(taskId) {
      watches.delete(taskId);
      void request(`/v1/tasks/${taskId}/events`, { method: "DELETE" }).catch(() => undefined);
    },
  };

  function notify(message: string | null) {
    status = message;
    for (const listener of listeners) listener(message);
  }

  function failPending(message: string) {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      pending.delete(id);
    }
  }

  /** The computer is reachable again: restore every task stream this page shows, then let the page refresh. */
  function cameOnline() {
    const returning = everOnline;
    expiredCloses = 0;
    online = true;
    everOnline = true;
    notify(null);
    for (const taskId of watches.keys()) void request(`/v1/tasks/${taskId}/events`).catch(() => undefined);
    if (returning) for (const listener of reconnectListeners) listener();
  }

  function dial() {
    if (closed) return;
    const current = createSocket(relayUrl(options.cloudUrl));
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      current.send(JSON.stringify({ kind: "auth", role: "browser", token: accessToken, deviceId: options.deviceId }));
    });
    current.addEventListener("message", (event) => {
      let frame: Frame;
      try {
        frame = parseFrame(JSON.parse(String((event as MessageEvent).data)));
      } catch {
        return;
      }
      if (frame.kind === "presence") {
        if (frame.online) cameOnline();
        else {
          online = false;
          notify(COMPUTER_OFFLINE);
        }
        return;
      }
      if (frame.kind === "response") {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        if (!frame.ok) {
          const error = frame.error as PrenticeError;
          if (error.code === "DEVICE_OFFLINE") {
            online = false;
            notify(COMPUTER_OFFLINE);
          }
          waiter.reject(new Error(error.message));
          return;
        }
        waiter.resolve(frame.body);
        return;
      }
      if (frame.kind === "event" && frame.event === "task") {
        watches.get(frame.taskId)?.(frame.data as TaskPayload);
      }
    });
    current.addEventListener("close", (event) => {
      if (socket !== current || closed) return;
      const code = (event as CloseEvent).code;
      if (code === RELAY_CLOSE.REVOKED) {
        closed = true;
        failPending(COMPUTER_DISCONNECTED);
        notify(COMPUTER_DISCONNECTED);
        return;
      }
      failPending(COMPUTER_DROPPED);
      if (code === RELAY_CLOSE.SESSION_EXPIRED) {
        void refreshAndRedial();
        return;
      }
      notify(COMPUTER_DROPPED);
      const delayMs = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        dial();
      }, delayMs);
    });
  }

  async function refreshAndRedial() {
    const next = options.refreshAccessToken ? await options.refreshAccessToken().catch(() => null) : null;
    if (closed) return;
    expiredCloses += 1;
    // No token, or tokens the relay keeps refusing, means the sign-in itself ended.
    if (!next || expiredCloses > 3) {
      closed = true;
      failPending(SIGNED_OUT);
      notify(SIGNED_OUT);
      return;
    }
    accessToken = next;
    session.token = next;
    attempt += 1;
    retry = setTimeout(dial, Math.min(5_000, 250 * attempt));
  }

  function request(path: string, init?: RequestInit): Promise<unknown> {
    const id = crypto.randomUUID();
    const httpMethod = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
    const frame = frameFromHttp(httpMethod, path, body, id);
    const limit = path.startsWith("/v1/project/choose") ? FOLDER_TIMEOUT_MS : (options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(new Error(status ?? COMPUTER_OFFLINE));
        return;
      }
      if (online === false) {
        reject(new Error(COMPUTER_OFFLINE));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(COMPUTER_NO_ANSWER));
      }, limit);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(frame));
    });
  }

  async function watch(taskId: string, onTask: (task: TaskPayload) => void, signal: AbortSignal): Promise<void> {
    watches.set(taskId, onTask);
    const stop = () => {
      if (watches.get(taskId) !== onTask) return;
      session.unwatch?.(taskId);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await request(`/v1/tasks/${taskId}/events`);
    } catch (error) {
      // Keep the watch registered: it is restored when the computer comes back online.
      if (signal.aborted) stop();
      throw error;
    }
    if (signal.aborted) stop();
  }

  /**
   * Browsers throttle timers in background tabs, which can stretch a reconnect backoff to minutes.
   * When the tab is shown again or the network returns, redial now instead of waiting for the timer.
   */
  const redialNow = () => {
    if (closed || !retry) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    clearTimeout(retry);
    retry = null;
    attempt = 0;
    dial();
  };
  const target = typeof window !== "undefined" ? window : null;
  target?.addEventListener("online", redialNow);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", redialNow);

  dial();
  holdRelaySession(session);
  return {
    session,
    close() {
      closed = true;
      target?.removeEventListener("online", redialNow);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", redialNow);
      if (retry) clearTimeout(retry);
      failPending(COMPUTER_DROPPED);
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
