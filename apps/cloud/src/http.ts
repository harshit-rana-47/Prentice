import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { completeLearning } from "./learning.js";
import type { CloudStore } from "./store.js";

const forbiddenProjectFields = ["path", "prompt", "diff", "content", "answer", "secret", "token", "patch"];

/** Learning AI calls allowed per paired computer in one window. Explain-back makes a few calls per turn. */
export const LEARNING_RATE = { limit: 120, windowMs: 10 * 60_000 };

export function createHttpApp(
  store: CloudStore,
  options: {
    onRevoke?: (deviceId: string) => void;
    /** Local development only: a per-run secret shared with the dev connector. main.ts sets it only on a loopback bind. */
    devLearningToken?: string;
  } = {},
) {
  const app = new Hono();
  const learningCalls = new Map<string, number[]>();
  app.use("*", async (c, next) => {
    const origin = allowedWebOrigin(c.req.header("origin"));
    if (origin) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-headers", "authorization, content-type");
      c.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, role: "cloud" }));

  app.get("/v1/session", async (c) => {
    const user = await userFrom(c.req.header("authorization"), store);
    if (!user) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in again.", retryable: false } }, 401);
    return c.json({ user, devices: await store.listDevices(user.id) });
  });

  app.post("/v1/pairing-codes", async (c) => {
    const user = await userFrom(c.req.header("authorization"), store);
    if (!user) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in again.", retryable: false } }, 401);
    return c.json(await store.createPairingCode(user.id));
  });

  app.delete("/v1/devices/:id", async (c) => {
    const user = await userFrom(c.req.header("authorization"), store);
    if (!user) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in again.", retryable: false } }, 401);
    const revoked = await store.revokeDevice(user.id, c.req.param("id"));
    if ("error" in revoked) return c.json({ error: { code: "NOT_FOUND", message: revoked.error, retryable: false } }, 404);
    options.onRevoke?.(c.req.param("id"));
    return c.json({ revoked: true });
  });

  app.post("/v1/devices/pair", async (c) => {
    const body = await readJson(c);
    if (typeof body.code !== "string" || typeof body.deviceId !== "string" || typeof body.publicKey !== "string") {
      return c.json({ error: { code: "INVALID_INPUT", message: "Provide a pairing code, device id, and public key.", retryable: false } }, 400);
    }
    const paired = await store.pairDevice({
      code: body.code,
      deviceId: body.deviceId,
      publicKey: body.publicKey,
      name: typeof body.name === "string" ? body.name : undefined,
    });
    if ("error" in paired) return c.json({ error: { code: "PAIRING_FAILED", message: paired.error, retryable: false } }, 400);
    return c.json({ deviceToken: paired.deviceToken });
  });

  app.post("/v1/learning", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: { code: "UNAUTHORIZED", message: "This computer is not paired.", retryable: false } }, 401);
    let caller: string;
    if (options.devLearningToken && sameSecret(token, options.devLearningToken)) {
      caller = "dev";
    } else {
      let device: { id: string } | undefined;
      try {
        device = await store.deviceForToken(token);
      } catch {
        return c.json({ error: { code: "TEMPORARILY_UNAVAILABLE", message: "Prentice could not check this computer. Try again.", retryable: true } }, 503);
      }
      if (!device) return c.json({ error: { code: "UNAUTHORIZED", message: "This computer is not paired.", retryable: false } }, 401);
      caller = device.id;
    }
    const now = Date.now();
    const recent = (learningCalls.get(caller) ?? []).filter((at) => now - at < LEARNING_RATE.windowMs);
    if (recent.length >= LEARNING_RATE.limit) {
      learningCalls.set(caller, recent);
      return c.json({ error: { code: "RATE_LIMITED", message: "The Learning AI is busy for this computer. Try again in a few minutes.", retryable: true } }, 429);
    }
    recent.push(now);
    learningCalls.set(caller, recent);
    const raw = await c.req.text();
    if (raw.length > 80_000) {
      return c.json({ error: { code: "INVALID_INPUT", message: "The learning summary is too large.", retryable: false } }, 413);
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    const result = await completeLearning(body);
    if (!result.ok) return c.json({ error: { code: "LEARNING_UNAVAILABLE", message: result.message, retryable: true } }, 503);
    return c.json({ result: result.json });
  });

  app.post("/v1/projects", async (c) => {
    const user = await userFrom(c.req.header("authorization"), store);
    if (!user) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in again.", retryable: false } }, 401);
    const body = await readJson(c);
    const extra = forbiddenProjectFields.find((field) => field in body);
    if (extra) {
      return c.json(
        { error: { code: "NOT_STORED", message: "The cloud does not store repository contents.", retryable: false } },
        400,
      );
    }
    if (typeof body.deviceId !== "string" || typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
      return c.json({ error: { code: "INVALID_INPUT", message: "Provide a device and a display name.", retryable: false } }, 400);
    }
    const saved = await store.saveProject({ userId: user.id, deviceId: body.deviceId, displayName: body.displayName });
    if ("error" in saved) return c.json({ error: { code: "NOT_FOUND", message: saved.error, retryable: false } }, 404);
    return c.json({ id: saved.id });
  });

  return app;
}

async function userFrom(header: string | undefined, store: CloudStore) {
  const token = bearer(header);
  if (!token) return undefined;
  return store.userForSession(token);
}

function allowedWebOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const allowed = (process.env.PRENTICE_WEB_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
