import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { awaitWorktreeIdle } from "./process-guard.js";
import { runJsonLines } from "./agent-process.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fake() {
  const dir = await mkdtemp(join(tmpdir(), "prentice-lifetime-")); roots.push(dir);
  const marker = join(dir, "edits"); const agent = join(dir, "agent.mjs");
  await writeFile(agent, `import {spawn} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nconst code = "const fs=require('node:fs'); process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(process.argv[1],'edit\\\\n'),30)";\nconst descendant=spawn(process.execPath,['-e',code,${JSON.stringify(marker)}],{stdio:'ignore'});\nprocess.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});\nconsole.log(JSON.stringify({type:'ready',pid:process.pid,descendant:descendant.pid}));\nsetInterval(()=>{},100);`);
  return { dir, marker, agent };
}
async function confirmStopped(marker: string, pid: number) {
  for (let i=0; i<100; i++) { try { process.kill(pid,0); } catch { break; } await pause(50); }
  // The audit's failure was continued edits after parent death; assert the actual effect.
  const before = await readFile(marker,"utf8"); await pause(250);
  expect(await readFile(marker,"utf8")).toBe(before);
}
async function awaitFirstEdit(marker: string) {
  for (let i=0; i<100; i++) {
    try { if ((await readFile(marker,"utf8")).length > 0) return; } catch { /* The child has not written yet. */ }
    await pause(50);
  }
  throw new Error("The disposable agent did not make its first edit within five seconds.");
}
describe.skipIf(process.platform === "win32")("native process group containment", () => {
  it("Stop ends a signal-resistant agent and its editing descendant", async () => {
    const { dir, marker, agent } = await fake();
    const run = await runJsonLines({ command: process.execPath, args: [agent], cwd: dir, env: process.env });
    const ready = (await run.lines[Symbol.asyncIterator]().next()).value as { descendant: number };
    await awaitFirstEdit(marker); await run.interrupt();
    expect((await run.exited).code).toBe(130);
    await confirmStopped(marker,ready.descendant);
  }, 12_000);
  it("connector SIGKILL closes the guardian owner channel and stops descendant edits", async () => {
    const { dir, marker, agent } = await fake();
    const entry = join(dir,"connector.mts");
    const module = fileURLToPath(new URL("./agent-process.ts",import.meta.url));
    await writeFile(entry,`import {runJsonLines} from ${JSON.stringify(module)}; const run=await runJsonLines({command:process.execPath,args:[${JSON.stringify(agent)}],cwd:${JSON.stringify(dir)},env:process.env}); for await(const line of run.lines) console.log(JSON.stringify(line));`);
    const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs",import.meta.url));
    const owner = spawn(process.execPath,["--import",tsx,entry],{stdio:["ignore","pipe","pipe"]});
    const lines = createInterface({ input: owner.stdout! });
    const ready = await new Promise<{ descendant: number }>((resolve,reject) => { lines.once("line",line=>resolve(JSON.parse(line))); owner.once("exit",code=>reject(new Error(`owner exited ${code}`))); });
    await awaitFirstEdit(marker); owner.kill("SIGKILL");
    await new Promise(resolve=>owner.once("exit",resolve));
    await awaitWorktreeIdle(dir);
    await confirmStopped(marker,ready.descendant); lines.close();
  }, 12_000);
});
