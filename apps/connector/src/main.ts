import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AccountService } from "./accounts.js";
import { accountDirectory, accountStore } from "./account-home.js";
import { createConnector } from "./connector.js";
import { ensureDeviceIdentity } from "./device.js";
import type { DeviceIdentity } from "./device.js";
import { claimSingleInstance } from "./instance.js";
import { deviceKeychain } from "./keychain.js";
import { openLocalPage } from "./open-page.js";
import { installLoginItem } from "./startup.js";
import { loadPackagedConfig } from "./packaged.js";
import { log } from "./log.js";
import { assertSecureRelayUrl, pairWithCloud, pairingOwner, relayUrlFor } from "./pair.js";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";
import { connectRelay, type RelayConnection } from "./relay.js";
import { createApp } from "./server.js";
import { loadConnectorEnv } from "./env.js";
import { sameVerifiedSignIn } from "./local-session.js";
import { setLearningEndpoint } from "./learning.js";
import { EventHub, stopAllTasks } from "./session.js";
import { pushSummary } from "./sync.js";
import type { ConnectorApi } from "./connector.js";
import type { Store } from "./store.js";

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
const cloudUrl = process.env.PRENTICE_CLOUD_URL?.trim() || "";

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
const pairingCode = process.env.PRENTICE_PAIRING_CODE?.trim() || "";
let activeUserId = "";
let activeConnector: ConnectorApi | null = null;
let activeToken = "";
let activeIdentity: DeviceIdentity | null = null;
let devApp: ReturnType<typeof createApp> | null = null;
let activeLocalToken = "";
let activeDevAccessToken = "";
let activeStore: Store | null = null;
let activeAccounts: AccountService | null = null;
let activeHub: EventHub | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let revocationCleanup: Promise<void> | null = null;
let relayConnection: RelayConnection | null = null;
let pairSurface: PairSurface | null = null;
let activationChain: Promise<void> = Promise.resolve();
const devStreamAborters = new Set<() => void>();
const registerDevStream = (abort: () => void) => { devStreamAborters.add(abort); return () => devStreamAborters.delete(abort); };

async function verifiedDevice(token: string): Promise<{ id: string; userId: string } | null> {
  if (!cloudUrl || !token) return null;
  const response = await fetch(new URL("/v1/device/self", cloudUrl), { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Prentice could not verify this computer. Try again when the cloud is reachable.");
  const body = await response.json() as { id?: string; userId?: string };
  return body.id && body.userId ? { id: body.id, userId: body.userId } : null;
}

function activate(userId: string, identity: DeviceIdentity | null, token: string, localToken = ""): Promise<void> {
  const next = activationChain.then(() => activateInternal(userId, identity, token, localToken));
  activationChain = next.catch(() => {});
  return next;
}

/** Serialize the reuse decision with activation: two tabs may bootstrap at the same time. */
function activateLocal(userId: string, accessToken: string): Promise<string> {
  const next = activationChain.then(async () => {
    if (activeUserId === userId && activeLocalToken && devApp && sameVerifiedSignIn(activeDevAccessToken, accessToken)) {
      activeDevAccessToken = accessToken;
      return activeLocalToken;
    }
    const localToken = randomBytes(32).toString("hex");
    await activateInternal(userId, null, "", localToken);
    activeDevAccessToken = accessToken;
    return localToken;
  });
  activationChain = next.then(() => undefined, () => undefined);
  return next;
}

async function activateInternal(userId: string, identity: DeviceIdentity | null, token: string, localToken: string) {
  if (activeUserId !== userId) {
    await stopAllTasks();
    for (const abort of devStreamAborters) abort();
    devStreamAborters.clear();
    relayConnection?.close(); relayConnection = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    devApp = null; activeLocalToken = ""; activeConnector = null; activeUserId = ""; activeToken = ""; activeIdentity = null;
    activeDevAccessToken = "";
    activeStore = accountStore(home, userId);
    activeAccounts = new AccountService(activeStore);
    activeHub = new EventHub();
    activeConnector = createConnector({ store: activeStore, hub: activeHub, accounts: activeAccounts, allowFixture: devHttp });
    activeUserId = userId;
    if (localToken) { activeLocalToken = localToken; devApp = createApp({ store: activeStore, hub: activeHub, accounts: activeAccounts, token: localToken, allowedOrigins: origins, allowFixture: true,
      isActive: () => activeUserId === userId && activeLocalToken === localToken && activeDevAccessToken !== "", registerStream: registerDevStream }); }
  } else if (localToken) {
    for (const abort of devStreamAborters) abort();
    devStreamAborters.clear();
    activeLocalToken = localToken; devApp = createApp({ store: activeStore!, hub: activeHub!, accounts: activeAccounts!, token: localToken, allowedOrigins: origins, allowFixture: true,
      isActive: () => activeUserId === userId && activeLocalToken === localToken && activeDevAccessToken !== "", registerStream: registerDevStream });
  }
  if (identity) activeIdentity = identity;
  if (token) activeToken = token;
  if (identity && token && cloudUrl) {
    writeFileSync(join(home, "active-account.json"), JSON.stringify({ userId }), { mode: 0o600 });
    publishLearning(token);
    dialRelay(relayUrlFor(cloudUrl), token);
    void pushSummary(cloudUrl, token, activeStore!).catch(error =>
      log("warn", "Account summary has not synchronized yet", { error: error instanceof Error ? error.message : "unknown" }));
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      if (activeUserId === userId && activeStore && activeToken === token) void pushSummary(cloudUrl, token, activeStore).catch(error =>
        log("warn", "Account summary has not synchronized yet", { error: error instanceof Error ? error.message : "unknown" }));
    }, 30_000);
    syncTimer.unref();
  } else publishLearning(activeToken);
}

function dialRelay(url: string, token: string) {
  assertSecureRelayUrl(url);
  relayConnection?.close();
  if (!activeConnector || !activeIdentity) throw new Error("A verified account is required before connecting.");
  const identity = activeIdentity;
  relayConnection = connectRelay({
    url,
    connector: activeConnector,
    token: token || undefined,
    onRevoked: () => {
      if (activeIdentity?.id !== identity.id) return;
      activeToken = "";
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      publishLearning("");
      revocationCleanup = keychain.deletePrivateKey(`${identity.id}:relay`).catch(() => {
        log("error", "Could not remove the revoked device token from secure storage.");
      });
      log("error", "This computer was disconnected from Prentice. Enter a new pairing code.");
      if (pairSurface) revealPairing(pairSurface.url);
      else void openPairSurface();
    },
  });
  log("info", "Prentice connector dialing relay");
}

async function openPairSurface() {
  if (!cloudUrl || pairSurface) return;
  pairSurface = await startPairSurface({
    websiteUrl: websiteUrl || undefined,
    pair: async (code) => {
      if (revocationCleanup) await revocationCleanup;
      const owner = await pairingOwner(cloudUrl, code);
      const userId = owner.userId;
      const directory = accountDirectory(home, userId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const identity = await ensureDeviceIdentity({ directory, keychain });
      const paired = await pairWithCloud({ cloudUrl, code, identity });
      if (paired.userId !== userId) throw new Error("The pairing account changed. Get a new code.");
      await keychain.writePrivateKey(`${identity.id}:relay`, paired.deviceToken);
      writeFileSync(join(directory, "account.json"), JSON.stringify({ email: owner.email }), { mode: 0o600 });
      await activate(userId, identity, paired.deviceToken);
      log("info", "Prentice device paired", { deviceId: identity.id });
    },
    savedAccounts: () => {
      try { return readdirSync(join(home, "accounts"), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(home, "accounts", entry.name, "device.json"))).map(entry => {
        let label = entry.name;
        try { label = (JSON.parse(readFileSync(join(home, "accounts", entry.name, "account.json"), "utf8")) as { email?: string }).email || label; } catch { /* older pair */ }
        return { id: entry.name, label };
      }); }
      catch { return []; }
    },
    activateSaved: async (userId) => {
      if (revocationCleanup) await revocationCleanup;
      const directory = accountDirectory(home, userId);
      if (!existsSync(join(directory, "device.json"))) throw new Error("This account has not been paired on this computer.");
      const identity = await ensureDeviceIdentity({ directory, keychain });
      const token = await keychain.readPrivateKey(`${identity.id}:relay`);
      const verified = token ? await verifiedDevice(token) : null;
      if (!verified || verified.id !== identity.id || verified.userId !== userId) throw new Error("This account needs a new pairing code.");
      await activate(userId, identity, token!);
    },
  });
  writeFileSync(pairingUrlFile, pairSurface.url, { mode: 0o600 });
  if (shouldRevealPairingPage(devHttp) && !activeConnector) {
    log("info", "Opening the connector pairing page", { url: pairSurface.url });
    revealPairing(pairSurface.url);
    return;
  }
  log("info", "Connector pairing page is available and was not opened", { url: pairSurface.url, website: websiteUrl || undefined });
}

if (!devHttp && !cloudUrl) {
  log("error", "Connector has nothing to serve. Set PRENTICE_DEV_HTTP=1 or PRENTICE_CLOUD_URL.");
  process.exit(1);
}

if (cloudUrl) {
  const activeFile = join(home, "active-account.json");
  let savedUserId = "";
  try { savedUserId = (JSON.parse(readFileSync(activeFile, "utf8")) as { userId?: string }).userId ?? ""; } catch { /* first use */ }
  if (savedUserId) {
    try {
      const directory = accountDirectory(home, savedUserId);
      const identity = await ensureDeviceIdentity({ directory, keychain });
      const token = await keychain.readPrivateKey(`${identity.id}:relay`);
      const verified = token ? await verifiedDevice(token) : null;
      if (verified?.id === identity.id && verified.userId === savedUserId) await activate(savedUserId, identity, token!);
    } catch (error) { log("warn", "Saved Prentice account could not be resumed", { error: error instanceof Error ? error.message : "unknown" }); }
  } else if (existsSync(join(home, "device.json"))) {
    // Preserve the legacy database; only a verified device identity can move into an account namespace.
    try {
      const identity = await ensureDeviceIdentity({ directory: home, keychain });
      const token = await keychain.readPrivateKey(`${identity.id}:relay`);
      const verified = token ? await verifiedDevice(token) : null;
      if (verified?.id === identity.id) {
        const directory = accountDirectory(home, verified.userId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!existsSync(join(directory, "device.json"))) copyFileSync(join(home, "device.json"), join(directory, "device.json"));
        await activate(verified.userId, identity, token!);
      }
    } catch (error) { log("warn", "Legacy device authorization could not be verified", { error: error instanceof Error ? error.message : "unknown" }); }
  }
  await openPairSurface();
  if (pairingCode) {
    try { const owner = await pairingOwner(cloudUrl, pairingCode); const userId = owner.userId; const directory = accountDirectory(home, userId); mkdirSync(directory, { recursive: true, mode: 0o700 }); const identity = await ensureDeviceIdentity({ directory, keychain }); const paired = await pairWithCloud({ cloudUrl, code: pairingCode, identity }); await keychain.writePrivateKey(`${identity.id}:relay`, paired.deviceToken); writeFileSync(join(directory, "account.json"), JSON.stringify({ email: owner.email }), { mode: 0o600 }); await activate(userId, identity, paired.deviceToken); }
    catch (error) { log("error", "Prentice pairing failed", { error: error instanceof Error ? error.message : "unknown" }); }
  }
}
publishLearning(activeToken);

if (devHttp && websiteUrl) log("info", "Prentice website", { url: websiteUrl });

if (devHttp) {
  const token = randomBytes(32).toString("hex");
  const runtimeFile = join(home, "runtime.json");
  const server = serve({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/v1/local/activate" && request.method === "POST") {
      if (request.headers.get("x-prentice-bootstrap") !== token || !cloudUrl) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body = await request.json().catch(() => null) as { accessToken?: string } | null;
      if (!body?.accessToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const response = await fetch(new URL("/v1/session", cloudUrl), { headers: { authorization: `Bearer ${body.accessToken}` } }).catch(() => null);
      if (!response?.ok) return Response.json({ error: "Prentice account could not be verified." }, { status: 401 });
      const session = await response.json() as { user?: { id?: string } };
      if (!session.user?.id) return Response.json({ error: "Prentice account could not be verified." }, { status: 401 });
      const localToken = await activateLocal(session.user.id, body.accessToken);
      return Response.json({ token: localToken });
    }
    if (!devApp || !activeDevAccessToken || !cloudUrl) return Response.json({ error: { message: "Sign in to Prentice first." } }, { status: 401 });
    const sessionResponse = await fetch(new URL("/v1/session", cloudUrl), { headers: { authorization: `Bearer ${activeDevAccessToken}` } }).catch(() => null);
    if (!sessionResponse?.ok) { devApp = null; activeLocalToken = ""; activeDevAccessToken = ""; return Response.json({ error: { message: "Prentice session ended. Sign in again." } }, { status: 401 }); }
    const session = await sessionResponse.json() as { user?: { id?: string } };
    if (session.user?.id !== activeUserId) return Response.json({ error: { message: "Account changed. Sign in again." } }, { status: 401 });
    return devApp.fetch(request);
  }, hostname: "127.0.0.1", port }, (info) => {
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
