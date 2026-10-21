import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { accountStore } from "./account-home.js";
import { migrate, openDatabase } from "./db.js";
import { Store } from "./store.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("activates only the verified account and invalidates the previous local session", async () => {
  const home = mkdtempSync(join(tmpdir(), "prentice-runtime-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const legacyDb = openDatabase(join(home, "prentice.db")); migrate(legacyDb);
  new Store(legacyDb).upsertProject("/private/tmp/unowned", "Legacy private project");
  const accountA = "00000000-0000-4000-8000-000000000001";
  const accountB = "00000000-0000-4000-8000-000000000002";
  const refreshedA = `header.${Buffer.from(JSON.stringify({ sub: accountA, session_id: "00000000-0000-4000-8000-000000000010", exp: 2 })).toString("base64url")}.signature`;
  const originalA = `header.${Buffer.from(JSON.stringify({ sub: accountA, session_id: "00000000-0000-4000-8000-000000000010", exp: 1 })).toString("base64url")}.signature`;
  const newSignInA = `header.${Buffer.from(JSON.stringify({ sub: accountA, session_id: "00000000-0000-4000-8000-000000000011", exp: 3 })).toString("base64url")}.signature`;
  let accountASessionValid = true;
  const cloud = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    const id = ["account-a-session", originalA, refreshedA, newSignInA].includes(token ?? "") && accountASessionValid ? accountA : token === "account-b-session" ? accountB : null;
    response.writeHead(id ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(id ? { user: { id, email: "member@example.test" }, devices: [] } : { error: "signed out" }));
  });
  await new Promise<void>(resolve => cloud.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => cloud.close(() => resolve())));
  const cloudPort = (cloud.address() as { port: number }).port;
  const child: ChildProcess = spawn(process.execPath, ["--import=tsx", "src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PRENTICE_HOME: home, PRENTICE_DEV_HTTP: "1", PRENTICE_PORT: "0", PRENTICE_PAIR_PORT: "0",
      PRENTICE_CLOUD_URL: `http://127.0.0.1:${cloudPort}`, PRENTICE_REVEAL_PAIRING: "0", PRENTICE_WEBSITE_URL: "http://127.0.0.1:3000" },
    stdio: "ignore",
  });
  cleanup.push(async () => { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); });
  const runtime = await waitRuntime(home);
  const base = `http://127.0.0.1:${runtime.port}`;
  async function activate(accessToken: string) {
    const response = await fetch(`${base}/v1/local/activate`, { method: "POST", headers: { "x-prentice-bootstrap": runtime.token, "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }
  const [aToken, secondTabToken] = await Promise.all([activate(originalA), activate(originalA)]);
  expect(secondTabToken).toBe(aToken);
  expect((await (await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${aToken}` } })).text())).not.toContain("Legacy private project");
  const aStore = accountStore(home, accountA);
  const aProject = aStore.upsertProject("/private/tmp/a", "Account A project");
  const aTask = aStore.insertTask(aProject.id, "private prompt");
  expect((await (await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${aToken}` } })).text())).toContain("Account A project");
  const events = await fetch(`${base}/v1/tasks/${aTask.id}/events`, { headers: { authorization: `Bearer ${aToken}` } });
  expect(events.status).toBe(200);
  const reader = events.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  const waitingEvent = reader.read();
  expect(await activate(refreshedA)).toBe(aToken);
  expect((await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${aToken}` } })).status).toBe(200);
  expect(await Promise.race([waitingEvent.then(result => result.done ? "closed" : "event"), new Promise(resolve => setTimeout(() => resolve("open"), 60))])).toBe("open");
  const bToken = await activate("account-b-session");
  expect((await Promise.race([waitingEvent, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Old account event stream stayed open")), 2000))])).done).toBe(true);
  expect((await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${aToken}` } })).status).toBe(401);
  expect((await (await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${bToken}` } })).text())).not.toContain("Account A project");
  const resumed = await activate("account-a-session");
  expect((await (await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${resumed}` } })).text())).toContain("Account A project");
  const newSignIn = await activate(newSignInA);
  expect(newSignIn).not.toBe(resumed);
  expect((await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${resumed}` } })).status).toBe(401);
  accountASessionValid = false;
  expect((await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${newSignIn}` } })).status).toBe(401);
});

async function waitRuntime(home: string): Promise<{ token: string; port: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { token: string; port: number }; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error("Connector did not start");
}
