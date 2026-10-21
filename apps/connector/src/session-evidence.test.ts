import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
const mode=vi.hoisted(()=>({baseline:true,interrupted:false, captured: [] as Array<{prompt:string;activeFile?:string;resumeThreadId?:string}>}));
vi.mock("./git.js",async importOriginal=>{
  const original=await importOriginal<typeof import("./git.js")>();
  return {...original,captureWorktree:async(repo:string)=>{if(!mode.baseline)throw new Error("snapshot unavailable");return original.captureWorktree(repo);}};
});
vi.mock("./providers.js",async importOriginal=>{
  const original=await importOriginal<typeof import("./providers.js")>();
  return {...original,providerFactory:()=>({startSession:async(input:{repoPath:string;prompt:string;activeFile?:string;resumeThreadId?:string})=>{ mode.captured.push(input); return ({
    events:(async function*(){
      await writeFile(join(input.repoPath,"new.txt"),"confirmed partial change");
      yield {type:"assistant",text:"I intended to finish the task"};
      yield {type:"command.finished",command:"npm test",exitCode:1,output:{source:"command-output",text:"# pass 1\n# fail 1",truncated:false}};
      yield mode.interrupted?{type:"session.interrupted"}:{type:"session.completed"};
    })(),interrupt:async()=>{},disconnect:async()=>{}
  }); }})};
});
import { disconnectedAccounts } from "./accounts.js";
import { migrate, openDatabase } from "./db.js";
import { Store } from "./store.js";
import { analyzeTask, startTask, continueTask, beginExplain, EventHub, taskIsRunning } from "./session.js";
import { setLearningEndpoint } from "./learning.js";
const fetchBefore = globalThis.fetch;
const exec=promisify(execFile);const roots:string[]=[];
afterEach(async()=>{setLearningEndpoint(null);globalThis.fetch=fetchBefore;await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function turn(baseline:boolean,interrupted:boolean,activeFile?:string){
  mode.captured=[];
  mode.baseline=baseline;mode.interrupted=interrupted;
  const repo=await mkdtemp(join(tmpdir(),"prentice-partial-"));roots.push(repo);
  await exec("git",["init"],{cwd:repo});await exec("git",["config","user.email","test@example.test"],{cwd:repo});await exec("git",["config","user.name","Test"],{cwd:repo});
  await writeFile(join(repo,"tracked.txt"),"original");await exec("git",["add","."],{cwd:repo});await exec("git",["commit","-m","initial"],{cwd:repo});
  await writeFile(join(repo,"tracked.txt"),"already dirty");await writeFile(join(repo,"preexisting.txt"),"already untracked");
  const db=openDatabase(":memory:");migrate(db);const store=new Store(db);store.upsertProject(repo,"test");
  const accounts=(await disconnectedAccounts().list()).accounts;
  const analyzed=await analyzeTask(store,accounts,"Add a file");const taskId=analyzed.task!.id;
  const started=await startTask(store,accounts,new EventHub(),taskId,{consent:true,activeFile});
  for(let i=0;i<100;i++){if(!taskIsRunning(taskId))break;await new Promise(resolve=>setTimeout(resolve,30));}
  return {store,started,task:store.getTask(taskId)!,packet:store.getPacket(taskId)!,artifact:store.getUnderstand(taskId)!};
}
it("attributes only new turn changes and retains confirmed interrupted commands/tests",async()=>{
  const {task,packet,artifact}=await turn(true,true);
  expect(task.status).toBe("interrupted");expect(packet.outcome).toBe("interrupted");expect(packet.files.map(f=>f.path)).toEqual(["new.txt"]);
  expect(packet.tests).toMatchObject({passed:1,failed:1});expect(artifact.agentStated[0]?.text).toContain("intended");
  expect(artifact.insufficientEvidence.join(" ")).toContain("interrupted");
});
it("never falls back to HEAD when the baseline is unavailable",async()=>{
  const {packet,artifact}=await turn(false,false);
  expect(packet.attribution).toBe("unavailable");expect(packet.files).toEqual([]);expect(packet.tests).toMatchObject({failed:1});
  expect(artifact.insufficientEvidence.join(" ")).toContain("unavailable");expect(artifact.observed.some(f=>f.text.includes("preexisting.txt"))).toBe(false);
});

it.each([
  ["claude-code", "signed-out", "AGENT_SIGNED_OUT"],
  ["codex", "not-installed", "AGENT_UNAVAILABLE"],
  ["cursor", "error", "AGENT_UNAVAILABLE"],
  ["claude-code", "ready", "AGENT_UNAVAILABLE"],
  ["fixture", "ready", "PROVIDER_REQUIRED"],
] as const)("refuses unavailable selection %s (%s) instead of another ready provider", async (providerId, state, code) => {
  const repo = await mkdtemp(join(tmpdir(), "prentice-auth-routing-"));
  roots.push(repo);
  await exec("git", ["init"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "original");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"], { cwd: repo });
  const db = openDatabase(":memory:");
  migrate(db);
  const store = new Store(db);
  const project = store.upsertProject(repo, "test");
  const accounts = (await disconnectedAccounts().list()).accounts;
  accounts.codex = { installed: true, connected: true, state: "ready", message: "" };
  accounts.cursor = { installed: true, connected: true, state: "ready", message: "" };
  if (providerId !== "fixture") accounts[providerId] = { installed: state !== "not-installed", connected: false, state, message: "Selected agent is unavailable." };
  const analyzed = await analyzeTask(store, accounts, "Authentication setup check", false);
  const id = analyzed.task!.id;
  const result = await startTask(store, accounts, new EventHub(), id, { consent: true, override: { providerId } }, false);
  expect(result).toMatchObject({ error: { code } });
  expect(store.getTask(id)?.status).toBe("analyzed");
  expect(taskIsRunning(id)).toBe(false);
  expect(store.listEvents(id)).toEqual([]);
  expect(store.getPacket(id)).toBeUndefined();
  expect(store.listConversations(project.id)).toEqual([]);
});

it("forwards exact prompt and a validated open file to the selected adapter", async () => {
  const {task}=await turn(true,false,"tracked.txt");
  expect(task.status).toBe("completed");
  expect(mode.captured[0]).toMatchObject({prompt:"Add a file",activeFile:"tracked.txt"});
  expect(mode.captured[0]?.resumeThreadId).toBeUndefined();
});
it("refuses escaped or missing file context before an agent can start", async () => {
  const result=await turn(true,false,"../../outside.txt");
  expect(result.started).toMatchObject({error:{code:"FILE_CONTEXT_UNAVAILABLE"}});
  expect(result.task.status).toBe("analyzed");
  expect(mode.captured).toEqual([]);
});

it("finishes coding and exposes files while the concept lesson is still pending", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
  setLearningEndpoint({cloudUrl:"http://127.0.0.1:4740",token:"synthetic"});
  const {store,task,artifact}=await turn(true,false);
  expect(task.status).toBe("completed");
  expect(taskIsRunning(task.id)).toBe(false);
  expect(artifact.learning?.pending).toBe(true);
  expect(artifact.observed.some(claim=>claim.text.includes("new.txt"))).toBe(true);
  expect(await beginExplain(store,task.id)).toBeNull();
  finish(Response.json({result:{concepts:[]}}));
  for(let i=0;i<20 && store.getUnderstand(task.id)?.learning?.pending;i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(store.getUnderstand(task.id)?.learning?.pending).not.toBe(true);
});

it("continues Claude in its recorded session without rerouting to Codex", async () => {
  const {store,task}=await turn(true,false,"tracked.txt");
  store.updateTask(task.id,{provider_id:"claude-code",provider_session_id:"recorded-claude-session"});
  const result=await continueTask(store,new EventHub(),task.id,{prompt:"Continue this work",consent:true,activeFile:"tracked.txt"});
  expect(result.task?.providerId).toBe("claude-code");
  const id=result.task!.id;
  for(let i=0;i<100&&taskIsRunning(id);i++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(mode.captured.at(-1)).toMatchObject({prompt:"Continue this work",activeFile:"tracked.txt",resumeThreadId:"recorded-claude-session"});
  expect(store.getTask(id)?.provider_id).toBe("claude-code");
});
