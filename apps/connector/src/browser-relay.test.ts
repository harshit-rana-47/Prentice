import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { FrameRelay } from "../../cloud/src/relay.js";
import { disconnectedAccounts } from "./accounts.js";
import { createConnector } from "./connector.js";
import { migrate, openDatabase } from "./db.js";
import { connectRelay, type RelayConnection } from "./relay.js";
import { Store } from "./store.js";
import { COMPUTER_OFFLINE, connectComputer } from "../../web/lib/relay-browser";

it("recovers browser → relay → connector → SQLite/repository after connector and relay disconnects", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "prentice-full-relay-"))), repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "Persistent project\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init"); git("add", "."); git("-c", "user.name=Prentice", "-c", "user.email=test@example.test", "commit", "-m", "seed");
  const db = openDatabase(join(home, "prentice.db")); migrate(db);
  const connector = createConnector({ store: new Store(db), accounts: disconnectedAccounts() });
  const relay = new FrameRelay({
    deviceForToken: async token => token === "device" ? { id: "mac", userId: "user" } : undefined,
    userForSession: async token => token === "session" ? { id: "user", email: "test@example.test" } : undefined,
    deviceForUser: async (id, user) => id === "mac" && user === "user" ? { id, userId: user, name: "Mac", pairedAt: "", revokedAt: null } : undefined,
  } as ConstructorParameters<typeof FrameRelay>[0]);
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => relay.attach(socket, request.url === "/relay/connector" ? "connector" : "browser"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const cloudUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dial = () => connectRelay({ url: cloudUrl.replace("http:", "ws:") + "/relay/connector", token: "device", connector, keepaliveMs: 25 });
  let client: RelayConnection = dial();
  const computer = connectComputer({ cloudUrl, deviceId: "mac", accessToken: "session", keepaliveMs: 25 });
  const statuses: Array<string | null> = [];
  computer.onStatus(status => statuses.push(status));
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > end) throw new Error("Connection did not recover");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const snapshot = () => computer.session.call!("/v1/workspace");
  try {
    await until(() => statuses.at(-1) === null);
    await computer.session.call!("/v1/project", { method: "POST", body: JSON.stringify({ path: repo }) });
    expect(await snapshot()).toMatchObject({ project: { path: repo } });
    client.close();
    await until(() => statuses.at(-1) === COMPUTER_OFFLINE);
    await expect(snapshot()).rejects.toThrow(COMPUTER_OFFLINE);
    client = dial();
    await until(() => statuses.at(-1) === null);
    expect(await snapshot()).toMatchObject({ project: { path: repo } });
    const before = statuses.length;
    for (const socket of wss.clients) socket.terminate();
    await until(() => statuses.length > before && statuses.at(-1) !== null);
    await until(() => statuses.at(-1) === null);
    expect(await snapshot()).toMatchObject({ project: { path: repo } });
    expect(new Store(db).listProjects()).toHaveLength(1);
  } finally {
    computer.close(); client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
