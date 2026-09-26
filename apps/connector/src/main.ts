import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AccountService } from "./accounts.js";
import { createConnector } from "./connector.js";
import { migrate, openDatabase } from "./db.js";
import { ensureDeviceIdentity } from "./device.js";
import { macOsKeychain } from "./keychain.js";
import { log } from "./log.js";
import { assertSecureRelayUrl, pairWithCloud, relayUrlFor } from "./pair.js";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";
import { connectRelay, type RelayConnection } from "./relay.js";
import { SecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { loadConnectorEnv } from "./env.js";
import { DEFAULT_GROQ_MODEL, readGroqConfig } from "./groq.js";
import { EventHub } from "./session.js";
import { Store } from "./store.js";

loadConnectorEnv();
const learning = readGroqConfig();
if (learning.ok) log("info", "Learning AI configured", { model: learning.config.model || DEFAULT_GROQ_MODEL });
else log("error", learning.message);

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
const keychain = macOsKeychain();
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
const connector = createConnector({ store, secrets, hub, accounts });

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
      void keychain.deletePrivateKey(`${identity.id}:relay`).catch(() => {
        log("error", "Could not remove the revoked device token from the keychain.");
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
      dialRelay(paired.relayUrl, paired.deviceToken);
      log("info", "Prentice device paired", { deviceId: identity.id });
    },
  });
  if (shouldRevealPairingPage(devHttp)) {
    log("info", "Opening the connector pairing page", { url: pairSurface.url });
    execFile("open", [pairSurface.url], () => undefined);
    return;
  }
  log("info", "Connector pairing page is available and was not opened", { url: pairSurface.url, website: websiteUrl || undefined });
}

if (!devHttp && !relayUrl && !cloudUrl) {
  log("error", "Connector has nothing to serve. Set PRENTICE_DEV_HTTP=1 or PRENTICE_CLOUD_URL.");
  process.exit(1);
}

if (relayUrl) {
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
  const app = createApp({ store, secrets, token, allowedOrigins: origins, hub, accounts });
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
