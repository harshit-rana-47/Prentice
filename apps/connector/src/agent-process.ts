import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonLineProcess {
  /** Each stdout line that parsed as JSON, in order. Ends when the process exits. */
  lines: AsyncIterable<unknown>;
  /** Resolves with the exit code (null when killed by a signal) and the tail of stderr. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string }>;
  /** Ends the run: SIGINT so the agent can close the turn, then SIGTERM, then SIGKILL. */
  interrupt(): Promise<void>;
  child: ChildProcess;
}

const STDERR_TAIL = 8_000;

/**
 * Spawns a local coding-agent CLI without a shell, so a prompt is never parsed by one.
 * The child is not detached: when Prentice exits, the agent does not keep editing the repository on its own.
 */
export function runJsonLines(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): JsonLineProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
  });
  child.stdin?.on("error", () => undefined);
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  else child.stdin?.end();

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string }>((resolve) => {
    let spawnError: string | undefined;
    child.once("error", (error) => {
      spawnError = error.message;
      resolve({ code: null, signal: null, stderr, spawnError });
    });
    child.once("close", (code, signal) => resolve({ code, signal, stderr, spawnError }));
  });

  const lines = (async function* () {
    if (!child.stdout) return;
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        yield JSON.parse(trimmed) as unknown;
      } catch {
        // A partial or non-JSON line is not an event.
      }
    }
  })();

  let interrupting: Promise<void> | null = null;
  async function interrupt(): Promise<void> {
    if (interrupting) return interrupting;
    interrupting = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const gone = exited.then(() => true);
      const wait = (ms: number) => Promise.race([gone, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
      child.kill("SIGINT");
      if (await wait(4_000)) return;
      child.kill("SIGTERM");
      if (await wait(4_000)) return;
      child.kill("SIGKILL");
      await wait(2_000);
    })();
    return interrupting;
  }

  return { lines, exited, interrupt, child };
}

/** Runs a short status command and returns its exit code and output. Never throws. */
export function runQuick(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error: error instanceof Error ? error.message : "spawn failed", timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({ code: null, error: "timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-16_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-16_000);
    });
    child.once("error", (error) => finish({ code: null, error: error.message }));
    child.once("close", (code) => finish({ code }));
  });
}
