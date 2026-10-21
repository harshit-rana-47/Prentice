import { expect, it, vi } from "vitest";
import { createHttpApp } from "./http.js";
import type { CloudStore } from "./store.js";

it("rejects private or unknown sync fields before writing and scopes reads to the session", async () => {
  const saveSync = vi.fn(async () => undefined);
  const syncOverview = vi.fn(async (userId: string) => ({ projects: [{ id: userId }], activity: [], concepts: [] }));
  const store = {
    deviceForToken: async (token: string) => token === "device-a" ? { id: "device-1", userId: "account-a" } : undefined,
    userForSession: async (token: string) => token === "browser-b" ? { id: "account-b", email: "b@example.test" } : undefined,
    saveSync, syncOverview,
  } as unknown as CloudStore;
  const app = createHttpApp(store);
  const response = await app.request("/v1/sync", { method: "POST", headers: { authorization: "Bearer device-a", "content-type": "application/json" },
    body: JSON.stringify({ projects: [], activity: [], concepts: [], prompt: "private request" }) });
  expect(response.status).toBe(400);
  expect(saveSync).not.toHaveBeenCalled();
  const noDevice = await app.request("/v1/sync", { method: "POST", headers: { authorization: "Bearer browser-b", "content-type": "application/json" }, body: JSON.stringify({ projects: [], activity: [], concepts: [] }) });
  expect(noDevice.status).toBe(401);
  const overview = await app.request("/v1/overview", { headers: { authorization: "Bearer browser-b" } });
  expect(overview.status).toBe(200);
  expect(syncOverview).toHaveBeenCalledWith("account-b");
  expect(await overview.json()).toEqual({ projects: [{ id: "account-b" }], activity: [], concepts: [] });
});
