import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudStore } from "./store.js";
import { createHttpApp, LEARNING_RATE } from "./http.js";

const originalKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Learning AI on the cloud", () => {
  it("calls Groq for a paired computer and does not return the key", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer cloud-key");
      const sent = JSON.parse(String(init?.body));
      expect(sent.messages[1].content).toContain("src/note.ts");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: "Git added src/note.ts." }) } }] });
    }) as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [{ path: "src/note.ts" }] } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { explanation: string } };
    expect(body.result.explanation).toContain("src/note.ts");
    expect(JSON.stringify(body)).not.toContain("cloud-key");
  });

  it("refuses a caller that is not a paired computer", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [] } }),
    });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Groq when Prentice has no key", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [] } }),
    });
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(/GROQ_API_KEY/);
  });
});

describe("Learning AI access", () => {
  it("accepts the per-run development token only when the server was given one", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "{\"observed\":[]}" } }] })) as typeof fetch;
    const body = JSON.stringify({ action: "explain", evidence: { observed: {}, agentStated: [] } });
    const headers = { authorization: "Bearer dev-run-token", "content-type": "application/json" };
    expect((await createHttpApp(storeFor("device-token")).request("/v1/learning", { method: "POST", headers, body })).status).toBe(401);
    const dev = createHttpApp(storeFor("device-token"), { devLearningToken: "dev-run-token" });
    expect((await dev.request("/v1/learning", { method: "POST", headers, body })).status).toBe(200);
  });

  it("answers 503, not 401, when the device lookup itself fails", async () => {
    const failing = { deviceForToken: async () => Promise.reject(new Error("db down")) } as unknown as CloudStore;
    const response = await createHttpApp(failing).request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
  });

  it("rate-limits one computer without calling Groq past the limit", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: "{\"observed\":[]}" } }] }));
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const call = () =>
      app.request("/v1/learning", {
        method: "POST",
        headers: { authorization: "Bearer device-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "explain", evidence: { observed: {} } }),
      });
    for (let index = 0; index < LEARNING_RATE.limit; index += 1) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(LEARNING_RATE.limit);
  });
});

function storeFor(token: string): CloudStore {
  return {
    async deviceForToken(candidate: string) {
      return candidate === token ? { id: "device", userId: "user" } : undefined;
    },
  } as CloudStore;
}
