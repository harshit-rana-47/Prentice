import { processGuard } from "./process-guard.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { redactCredentials } from "@prentice/domain";

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
 * A native guardian owns the process group/job and terminates it when the connector owner channel closes.
 */
export async function runJsonLines(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<JsonLineProcess> {
  const guard = await processGuard(options.command, options.env, options.cwd);
  const child = spawn(guard.executable, options.args, {
    cwd: options.cwd,
    env: guard.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stderrOmitted = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrOmitted) return;
    stderr += String(chunk);
    if (stderr.length > STDERR_TAIL) { stderr = "Provider diagnostic output omitted because it exceeded the privacy limit."; stderrOmitted = true; }
  });
  child.stdin?.on("error", () => undefined);
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  else child.stdin?.end();

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string }>((resolve) => {
    let spawnError: string | undefined;
    child.once("error", (error) => {
      spawnError = error.message;
      void guard.close().then(() => resolve({ code: null, signal: null, stderr: redactCredentials(stderr), spawnError }));
    });
    child.once("close", (code, signal) => { void guard.close().then(() => resolve({ code, signal, stderr: redactCredentials(stderr), spawnError })); });
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
      await guard.close();
      await exited;
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
    let stdoutOmitted = false;
    let stderrOmitted = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: redactCredentials(stdout), stderr: redactCredentials(stderr), timedOut });
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
      if (stdoutOmitted) return;
      stdout += String(chunk);
      if (stdout.length > 16_000) { stdout = "Status output omitted because it exceeded the privacy limit."; stdoutOmitted = true; }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrOmitted) return;
      stderr += String(chunk);
      if (stderr.length > 16_000) { stderr = "Status output omitted because it exceeded the privacy limit."; stderrOmitted = true; }
    });
    child.once("error", (error) => finish({ code: null, error: error.message }));
    child.once("close", (code) => finish({ code }));
  });
}
