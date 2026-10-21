import { createServer, type Socket } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync, renameSync, writeFileSync, lstatSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** A native guardian owns the process group/job, with a private connection to this connector. */
export async function processGuard(command: string, env: NodeJS.ProcessEnv, workspace: string) {
  const release = await claimWorkspace(workspace);
  const directory = await mkdtemp(join(tmpdir(), "prentice-guard-"));
  const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\prentice-${token}` : join(directory, "owner.sock");
  const sockets = new Set<Socket>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    let authenticated = false;
    let cleanExit = false;
    const timeout = setTimeout(() => socket.destroy(), 5_000);
    socket.on("data", (chunk) => {
      input += String(chunk);
      if (input.length > 256) { socket.destroy(); return; }
      while (input.includes("\n")) {
        const newline = input.indexOf("\n");
        const line = input.slice(0,newline); input = input.slice(newline+1);
        if (!authenticated) {
          const [nonce,pidText] = line.split(" "); const pid = Number(pidText);
          clearTimeout(timeout);
          if (nonce !== token || stopping || !Number.isInteger(pid) || pid <= 0) { socket.destroy(); return; }
          release.record(pid); authenticated = true; socket.write("R");
        } else if (/^G [0-9]+$/.test(line)) {
          release.group(Number(line.slice(2))); socket.write(stopping ? "S" : "A");
        } else if (line === "D") cleanExit = true;
        else { socket.destroy(); return; }
      }
    });
    socket.once("close", () => { if (authenticated && !cleanExit) release.unclean(); });
    socket.on("error", () => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  } catch (error) {
    release.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
  let executable: string;
  try { executable = guardExecutable(); } catch (error) { server.close(); release.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    executable,
    env: { ...env, PRENTICE_GUARD_ENDPOINT: endpoint, PRENTICE_GUARD_TOKEN: token, PRENTICE_GUARD_COMMAND: command },
    close(): Promise<void> {
      closing ??= (async () => {
        stopping = true;
        for (const socket of sockets) socket.end("S");
        // Native guardian closes its channel only after killing the group/job.
        await new Promise<void>((resolve) => server.close(() => resolve()));
        release.close();
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

function guardExecutable(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const binary = join(base, process.platform === "win32" ? "process-guard.exe" : "process-guard");
  if (existsSync(binary)) return binary;
  if (process.platform === "win32" && process.env.PRENTICE_PACKAGED !== "1") {
    const development = join(base, "../../../dist/native/process-guard.exe");
    if (existsSync(development)) return development;
  }
  if (process.env.PRENTICE_PACKAGED === "1" || process.platform === "win32") {
    throw new Error("Process containment is unavailable. Prentice did not launch the coding agent.");
  }
  const source = join(base, "../native/process-guard.c");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const cache = join(tmpdir(), `prentice-process-guards-${process.getuid?.() ?? "dev"}`);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const info = lstatSync(cache);
  if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("The process guardian cache is not private.");
  const target = join(cache, digest);
  if (!existsSync(target)) {
    const staged = `${target}-${process.pid}-${randomBytes(4).toString("hex")}`;
    execFileSync("cc", ["-O2", "-Wall", "-Wextra", source, "-o", staged], { stdio: "pipe" });
    renameSync(staged, target);
  }
  return target;
}

/** A replacement connector cannot launch a turn until recorded guardians from the old owner have exited. */
async function claimWorkspace(workspace: string) {
  const canonical = await realpath(workspace);
  const digest = createHash("sha256").update(canonical).digest("hex");
  const path = join(tmpdir(), `prentice-worktree-${process.getuid?.() ?? "user"}-${digest}.lock`);
  const record = { owner: process.pid, guardians: [] as number[], groups: [] as number[] };
  let safe = true;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const fd = openSync(path,"wx",0o600); closeSync(fd);
      writeFileSync(path,JSON.stringify(record),{ mode:0o600 });
      return {
        record(pid: number) { record.guardians.push(pid); writeFileSync(path,JSON.stringify(record),{ mode:0o600 }); },
        group(pid: number) { record.groups.push(pid); writeFileSync(path,JSON.stringify(record),{ mode:0o600 }); },
        unclean() { safe = false; },
        close() { if (safe) { try { unlinkSync(path); } catch { /* Already cleaned. */ } } },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: typeof record;
      try { previous = JSON.parse(readFileSync(path,"utf8")); } catch { throw new Error("The worktree containment record is unreadable. Prentice did not launch an overlapping agent."); }
      const groupsAlive = (previous.groups ?? []).some(pid => alive(-pid));
      if (alive(previous.owner) && previous.owner !== process.pid) throw new Error("Another Prentice turn still owns this worktree.");
      if (!previous.guardians.some(alive) && !groupsAlive) { try { unlinkSync(path); } catch {} continue; }
      await new Promise((resolve) => setTimeout(resolve,100));
    }
  }
  throw new Error("The previous coding agent has not been confirmed stopped. Prentice did not launch another agent.");
}

export async function awaitWorktreeIdle(workspace: string): Promise<void> {
  const canonical = await realpath(workspace);
  const digest = createHash("sha256").update(canonical).digest("hex");
  const path = join(tmpdir(), `prentice-worktree-${process.getuid?.() ?? "user"}-${digest}.lock`);
  for (let attempt=0; attempt<100; attempt++) {
    if (!existsSync(path)) return;
    const record = JSON.parse(readFileSync(path,"utf8")) as {owner:number;guardians:number[];groups?:number[]};
    const alive = (pid: number) => { try { process.kill(pid,0); return true; } catch(error) { return (error as NodeJS.ErrnoException).code!=="ESRCH"; } };
    if (alive(record.owner) && record.owner !== process.pid) throw new Error("Another Prentice turn still owns this worktree.");
    if (!record.guardians.some(alive) && !(record.groups ?? []).some(pid=>alive(-pid))) return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("The previous agent has not been confirmed stopped. Prentice cannot establish a new turn baseline yet.");
}
