import { randomUUID } from "node:crypto";
import { RELAY_CLOSE } from "@prentice/protocol";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { cloudConfigFromEnv, forgetUser, signIn } from "./local-supabase.js";
import { startCloud } from "./server.js";

const users: string[] = [];

afterEach(async () => {
  await Promise.all([...new Set(users.splice(0))].map((userId) => forgetUser(userId)));
});

describe("cloud control plane", () => {
  it("pairs a device to an account and refuses to store repository contents", async () => {
    const cloud = await startCloud(cloudConfigFromEnv());
    const email = `ada-${randomUUID()}@prentice.dev`;
    const signed = await signIn(email);
    users.push(signed.userId);
    const again = await signIn(email);
    expect(again.userId).toBe(signed.userId);
    users.push(again.userId);

    const code = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const deviceId = `device-${randomUUID()}`;
    const paired = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId,
      publicKey: "public-key",
    });
    expect(paired.status).toBe(200);
    expect(typeof paired.body.deviceToken).toBe("string");
    const reused = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId: `device-${randomUUID()}`,
      publicKey: "other",
    });
    expect(reused.status).toBe(400);

    const other = await signIn(`other-${randomUUID()}@prentice.dev`);
    users.push(other.userId);
    const otherCode = await post(cloud.url, "/v1/pairing-codes", undefined, other.accessToken);
    const stolen = await post(cloud.url, "/v1/devices/pair", {
      code: otherCode.body.code,
      deviceId,
      publicKey: "public-key",
    });
    expect(stolen.status).toBe(400);

    const sessionView = await fetch(`${cloud.url}/v1/session`, {
      headers: { authorization: `Bearer ${signed.accessToken}` },
    });
    const sessionBody = (await sessionView.json()) as { devices: Array<{ id: string }> };
    expect(sessionBody.devices.map((device) => device.id)).toEqual([deviceId]);

    const rejected = await post(
      cloud.url,
      "/v1/projects",
      { deviceId, displayName: "Notes", prompt: "change hello.txt", path: "/secret" },
      signed.accessToken,
    );
    expect(rejected.status).toBe(400);
    const saved = await post(cloud.url, "/v1/projects", { deviceId, displayName: "Notes" }, signed.accessToken);
    expect(saved.status).toBe(200);
    const stored = await cloud.store.storedText();
    expect(stored).not.toContain(paired.body.deviceToken as string);
    expect(stored).not.toContain("change hello.txt");
    expect(stored).not.toContain("/secret");
    await cloud.close();
  }, 30_000);

  it("lets each account read only its own devices", async () => {
    const config = cloudConfigFromEnv();
    const cloud = await startCloud(config);
    const owner = await signIn(`owner-${randomUUID()}@prentice.dev`);
    const other = await signIn(`stranger-${randomUUID()}@prentice.dev`);
    users.push(owner.userId, other.userId);
    const code = await post(cloud.url, "/v1/pairing-codes", undefined, owner.accessToken);
    const deviceId = `device-${randomUUID()}`;
    const paired = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId,
      publicKey: "public-key",
    });
    expect(paired.status).toBe(200);

    const ownerRows = await restDevices(config, owner.accessToken);
    const otherRows = await restDevices(config, other.accessToken);
    expect(ownerRows.map((row) => row.id)).toEqual([deviceId]);
    expect(otherRows).toEqual([]);

    const credentials = await fetch(`${config.supabaseUrl}/rest/v1/device_credentials?select=token_hash`, {
      headers: { apikey: config.publishableKey, authorization: `Bearer ${owner.accessToken}` },
    });
    expect(credentials.ok).toBe(false);
    const body = await credentials.text();
    expect(body).not.toContain(paired.body.deviceToken as string);
    await cloud.close();
  }, 30_000);

  it("re-pairs a revoked computer with a new code and lets it connect again", async () => {
    const cloud = await startCloud(cloudConfigFromEnv());
    const signed = await signIn(`repair-${randomUUID()}@prentice.dev`);
    users.push(signed.userId);
    const deviceId = `device-${randomUUID()}`;
    const first = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const paired = await post(cloud.url, "/v1/devices/pair", { code: first.body.code, deviceId, publicKey: "public-key" });
    const revoked = await fetch(`${cloud.url}/v1/devices/${deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${signed.accessToken}` },
    });
    expect(revoked.status).toBe(200);
    const reused = await post(cloud.url, "/v1/devices/pair", { code: first.body.code, deviceId, publicKey: "public-key" });
    expect(reused.status).toBe(400);
    expect(String((reused.body.error as { message: string }).message)).toMatch(/already used/);
    const second = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const repaired = await post(cloud.url, "/v1/devices/pair", { code: second.body.code, deviceId, publicKey: "public-key-2" });
    expect(repaired.status).toBe(200);
    expect(repaired.body.deviceToken).not.toBe(paired.body.deviceToken);

    const connector = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(connector, "open");
    let closedWith: number | null = null;
    connector.once("close", (code) => {
      closedWith = code;
    });
    connector.send(JSON.stringify({ kind: "auth", role: "connector", token: repaired.body.deviceToken }));
    const browser = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await once(browser, "open");
    const presence = nextFrame(browser);
    browser.send(JSON.stringify({ kind: "auth", role: "browser", token: signed.accessToken, deviceId }));
    expect(await presence).toEqual({ kind: "presence", online: true });
    expect(closedWith).toBeNull();
    const sessionView = await fetch(`${cloud.url}/v1/session`, { headers: { authorization: `Bearer ${signed.accessToken}` } });
    const sessionBody = (await sessionView.json()) as { devices: Array<{ id: string; revokedAt: string | null }> };
    expect(sessionBody.devices.find((device) => device.id === deviceId)?.revokedAt).toBeNull();

    const old = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(old, "open");
    const refused = onceClose(old);
    old.send(JSON.stringify({ kind: "auth", role: "connector", token: paired.body.deviceToken }));
    expect(await refused).toBe(4001);
    connector.close();
    browser.close();
    await cloud.close();
  }, 30_000);

  it("revokes a device and tells the browser the connector is gone", async () => {
    const cloud = await startCloud(cloudConfigFromEnv());
    const signed = await signIn(`revoke-${randomUUID()}@prentice.dev`);
    users.push(signed.userId);
    const code = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const deviceId = `device-${randomUUID()}`;
    const paired = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId,
      publicKey: "public-key",
    });
    const connector = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(connector, "open");
    connector.send(JSON.stringify({ kind: "auth", role: "connector", token: paired.body.deviceToken }));
    const browser = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await once(browser, "open");
    browser.send(JSON.stringify({ kind: "auth", role: "browser", token: signed.accessToken, deviceId }));
    const forwarded = nextFrame(connector);
    browser.send(JSON.stringify({ kind: "request", id: "snap", method: "workspace.get" }));
    expect(await forwarded).toMatchObject({ id: "snap", method: "workspace.get" });
    const closed = onceClose(connector);
    const dropped = nextFrame(browser);
    const revoked = await fetch(`${cloud.url}/v1/devices/${deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${signed.accessToken}` },
    });
    expect(revoked.status).toBe(200);
    expect(await dropped).toMatchObject({
      id: "snap",
      ok: false,
      error: { code: "DEVICE_OFFLINE" },
    });
    expect(await closed).toBe(4001);
    const again = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(again, "open");
    const refused = onceClose(again);
    again.send(JSON.stringify({ kind: "auth", role: "connector", token: paired.body.deviceToken }));
    expect(await refused).toBe(4001);
    const sessionView = await fetch(`${cloud.url}/v1/session`, {
      headers: { authorization: `Bearer ${signed.accessToken}` },
    });
    const sessionBody = (await sessionView.json()) as { devices: Array<{ id: string; revokedAt: string | null }> };
    expect(sessionBody.devices.find((device) => device.id === deviceId)?.revokedAt).toEqual(expect.any(String));
    const stored = await cloud.store.storedText();
    expect(stored).not.toContain(paired.body.deviceToken as string);
    again.close();
    browser.close();
    await cloud.close();
  }, 30_000);

  it("keeps the browser connected when the connector drops and does not store the prompt", async () => {
    const cloud = await startCloud(cloudConfigFromEnv());
    const signed = await signIn(`drop-${randomUUID()}@prentice.dev`);
    users.push(signed.userId);
    const code = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const deviceId = `device-${randomUUID()}`;
    const paired = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId,
      publicKey: "public-key",
    });
    const connector = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(connector, "open");
    connector.send(JSON.stringify({ kind: "auth", role: "connector", token: paired.body.deviceToken }));
    const browser = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await once(browser, "open");
    browser.send(JSON.stringify({ kind: "auth", role: "browser", token: signed.accessToken, deviceId }));
    await wait(50);
    const prompt = "explain-back answer stays on the computer";
    const frames = collect(browser);
    browser.send(JSON.stringify({ kind: "request", id: "task", method: "tasks.analyze", params: { prompt } }));
    connector.close();
    await waitFor(() => frames.some((frame) => frame.kind === "response"));
    expect(frames).toContainEqual({ kind: "presence", online: false });
    expect(frames.find((frame) => frame.kind === "response")).toMatchObject({
      id: "task",
      ok: false,
      error: { code: "DEVICE_OFFLINE", retryable: true },
    });
    expect(browser.readyState).toBe(WebSocket.OPEN);
    const stored = await cloud.store.storedText();
    expect(stored).not.toContain(prompt);
    browser.close();
    await cloud.close();
  }, 30_000);

  it("forwards a workspace request only after both sockets authenticate", async () => {
    const cloud = await startCloud(cloudConfigFromEnv());
    const signed = await signIn(`relay-${randomUUID()}@prentice.dev`);
    users.push(signed.userId);
    const code = await post(cloud.url, "/v1/pairing-codes", undefined, signed.accessToken);
    const deviceId = `connector-${randomUUID()}`;
    const paired = await post(cloud.url, "/v1/devices/pair", {
      code: code.body.code,
      deviceId,
      publicKey: "public-key",
    });
    const connector = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/connector`);
    await once(connector, "open");
    connector.send(JSON.stringify({ kind: "auth", role: "connector", token: paired.body.deviceToken }));
    const browser = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await once(browser, "open");
    browser.send(JSON.stringify({ kind: "auth", role: "browser", token: "not-a-session", deviceId }));
    const rejected = await onceClose(browser);
    // A token the auth service rejects is a session problem, not a revoked computer.
    expect(rejected).toBe(RELAY_CLOSE.SESSION_EXPIRED);
    const browserOk = new WebSocket(`ws://127.0.0.1:${cloud.port}/relay/browser`);
    await once(browserOk, "open");
    browserOk.send(JSON.stringify({ kind: "auth", role: "browser", token: signed.accessToken, deviceId }));
    await wait(50);
    const incoming = nextFrame(connector);
    browserOk.send(JSON.stringify({ kind: "request", id: "snap", method: "workspace.get" }));
    expect(await incoming).toMatchObject({ id: "snap", method: "workspace.get" });
    connector.send(
      JSON.stringify({
        kind: "response",
        id: "snap",
        ok: true,
        status: 200,
        body: { project: { path: "/Users/example/secret-repo", marker: "do-not-store" } },
      }),
    );
    const snapshot = await nextFrame(browserOk);
    expect(snapshot).toMatchObject({ id: "snap", ok: true });
    const stored = await cloud.store.storedText();
    expect(stored).not.toContain("do-not-store");
    expect(stored).not.toContain("secret-repo");
    connector.close();
    browserOk.close();
    await cloud.close();
  }, 30_000);
});

async function post(url: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function once(socket: WebSocket, event: "open"): Promise<void> {
  return new Promise((resolve) => socket.once(event, () => resolve()));
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for a relay frame.")), 5_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

function collect(socket: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  return frames;
}

async function waitFor(ready: () => boolean) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 5_000) throw new Error("Timed out waiting for relay frames.");
    await wait(20);
  }
}

function onceClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restDevices(config: { supabaseUrl: string; publishableKey: string }, token: string) {
  const client = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const result = await client.from("devices").select("id,name");
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}
