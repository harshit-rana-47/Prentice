import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AccountService } from "./accounts.js";
import { createConnector } from "./connector.js";
import { migrate, openDatabase } from "./db.js";
import { ensureDeviceIdentity } from "./device.js";
import { claimSingleInstance } from "./instance.js";
import { deviceKeychain } from "./keychain.js";
import { openLocalPage } from "./open-page.js";
import { installLoginItem } from "./startup.js";
import { loadPackagedConfig } from "./packaged.js";
import { log } from "./log.js";
import { assertSecureRelayUrl, pairWithCloud, relayUrlFor } from "./pair.js";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";
import { connectRelay, type RelayConnection } from "./relay.js";
import { SecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { loadConnectorEnv } from "./env.js";
import { setLearningEndpoint } from "./learning.js";
import { EventHub } from "./session.js";
import { Store } from "./store.js";

const packaged = process.env.PRENTICE_PACKAGED === "1";
if (packaged) loadPackagedConfig();
else loadConnectorEnv();

const home = process.env.PRENTICE_HOME ?? join(homedir(), ".prentice");
const port = Number(process.env.PRENTICE_PORT ?? 4731);
const origins = (process.env.PRENTICE_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const devHttp = process.env.PRENTICE_DEV_HTTP === "1";
const websiteUrl = process.env.PRENTICE_WEBSITE_URL?.trim() || (devHttp ? "http://127.0.0.1:3000" : "");
let relayUrl = process.env.PRENTICE_RELAY_URL?.trim() || "";
let relayToken = process.env.PRENTICE_RELAY_TOKEN?.trim() || "";

mkdirSync(home, { recursive: true });
await chmod(home, 0o700);
const pairingUrlFile = join(home, "pairing.url");
if (packaged && !claimSingleInstance(home)) {
  revealPairing(readPairingUrl(pairingUrlFile));
  process.exit(0);
}
const appExecutable = packagedExecutable();
if (packaged && appExecutable && process.env.PRENTICE_INSTALL_LOGIN_ITEM !== "0") {
  try {
    installLoginItem(appExecutable);
  } catch (error) {
    log("error", "Could not start Prentice when this computer signs in", { error: error instanceof Error ? error.message : "unknown" });
  }
}
const keychain = deviceKeychain();
const identity = await ensureDeviceIdentity({ directory: home, keychain });
log("info", "Prentice device ready", { deviceId: identity.id });
const pairingCode = process.env.PRENTICE_PAIRING_CODE?.trim() || "";
const cloudUrl = process.env.PRENTICE_CLOUD_URL?.trim() || "";
if (!relayToken && cloudUrl) {
  const saved = await keychain.readPrivateKey(`${identity.id}:relay`);
  if (saved) {
    relayToken = saved;
    relayUrl = relayUrlFor(cloudUrl);
  }
}
if (pairingCode && cloudUrl) {
  try {
    const paired = await pairWithCloud({ cloudUrl, code: pairingCode, identity });
    await keychain.writePrivateKey(`${identity.id}:relay`, paired.deviceToken);
    relayUrl = paired.relayUrl;
    relayToken = paired.deviceToken;
    log("info", "Prentice device paired", { deviceId: identity.id });
    publishLearning(paired.deviceToken);
  } catch (error) {
    log("error", "Prentice pairing failed", { error: error instanceof Error ? error.message : "unknown" });
  }
}

const db = openDatabase(join(home, "prentice.db"));
migrate(db);
const store = new Store(db);
const secrets = new SecretStore(join(home, "secrets.json"));
const accounts = new AccountService(secrets);
const hub = new EventHub();
const connector = createConnector({ store, secrets, hub, accounts, allowFixture: devHttp });

let relayConnection: RelayConnection | null = null;
let pairSurface: PairSurface | null = null;

function dialRelay(url: string, token: string) {
  assertSecureRelayUrl(url);
  relayConnection?.close();
  relayConnection = connectRelay({
    url,
    connector,
    token: token || undefined,
    onRevoked: () => {
      publishLearning("");
      void keychain.deletePrivateKey(`${identity.id}:relay`).catch(() => {
        log("error", "Could not remove the revoked device token from secure storage.");
      });
      log("error", "This computer was disconnected from Prentice. Enter a new pairing code.");
      void openPairSurface();
    },
  });
  log("info", "Prentice connector dialing relay");
}

async function openPairSurface() {
  if (!cloudUrl || pairSurface) return;
  pairSurface = await startPairSurface({
    websiteUrl: websiteUrl || undefined,
    pair: async (code) => {
      const paired = await pairWithCloud({ cloudUrl, code, identity });
      await keychain.writePrivateKey(`${identity.id}:relay`, paired.deviceToken);
      try {
        unlinkSync(pairingUrlFile);
      } catch {
        // The pairing window can close without the url file.
      }
      publishLearning(paired.deviceToken);
      dialRelay(paired.relayUrl, paired.deviceToken);
      log("info", "Prentice device paired", { deviceId: identity.id });
    },
  });
  writeFileSync(pairingUrlFile, pairSurface.url, { mode: 0o600 });
  if (shouldRevealPairingPage(devHttp)) {
    log("info", "Opening the connector pairing page", { url: pairSurface.url });
    revealPairing(pairSurface.url);
    return;
  }
  log("info", "Connector pairing page is available and was not opened", { url: pairSurface.url, website: websiteUrl || undefined });
}

if (!devHttp && !relayUrl && !cloudUrl) {
  log("error", "Connector has nothing to serve. Set PRENTICE_DEV_HTTP=1 or PRENTICE_CLOUD_URL.");
  process.exit(1);
}

publishLearning(relayToken);

if (relayUrl) {
  try {
    unlinkSync(pairingUrlFile);
  } catch {
    // No pairing window is waiting.
  }
  try {
    dialRelay(relayUrl, relayToken);
  } catch (error) {
    log("error", "Prentice relay URL was rejected", { error: error instanceof Error ? error.message : "unknown" });
    if (!devHttp) process.exit(1);
  }
} else if (cloudUrl) {
  await openPairSurface();
}

if (devHttp && websiteUrl) log("info", "Prentice website", { url: websiteUrl });

if (devHttp) {
  const token = randomBytes(32).toString("hex");
  const runtimeFile = join(home, "runtime.json");
  const app = createApp({ store, secrets, token, allowedOrigins: origins, hub, accounts, allowFixture: true });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    const boundPort = typeof info === "object" && info ? info.port : port;
    writeFileSync(runtimeFile, JSON.stringify({ token, port: boundPort, origins }), { mode: 0o600 });
    void chmod(runtimeFile, 0o600);
    log("info", "Prentice dev HTTP listening", { host: "127.0.0.1", port: boundPort });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    log("error", "Prentice dev HTTP failed to bind", { error: error.message, port });
    process.exit(1);
  });
}

function publishLearning(token: string) {
  const devToken = devHttp && !packaged ? process.env.PRENTICE_DEV_LEARNING_TOKEN?.trim() : "";
  if (cloudUrl && !token && devToken) {
    // Local development: the dev stack starts a loopback cloud that accepts this per-run token.
    // The Groq key stays in that cloud process.
    setLearningEndpoint({ cloudUrl, token: devToken });
    log("info", "Learning AI uses the local development cloud");
    return;
  }
  if (!cloudUrl || !token) {
    setLearningEndpoint(null);
    if (devHttp) log("warn", "Learning AI is off: this computer is not paired and no development cloud is running. Use npm run dev.");
    return;
  }
  setLearningEndpoint({ cloudUrl, token });
  log("info", "Learning AI uses Prentice");
}

function packagedExecutable(): string {
  const root = process.env.PRENTICE_APP_PATH?.trim();
  if (!root) return "";
  if (process.platform === "darwin") return join(root, "Contents", "MacOS", "Prentice");
  if (process.platform === "win32") return join(root, "Prentice.cmd");
  return "";
}

function revealPairing(url: string) {
  if (!url || process.env.PRENTICE_REVEAL_PAIRING === "0") return;
  openLocalPage(url);
}

function readPairingUrl(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}
