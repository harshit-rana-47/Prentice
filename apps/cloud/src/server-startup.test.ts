import { expect, it, vi } from "vitest";
import { startCloud } from "./server.js";
import { createServer } from "node:net";
import { WebSocket } from "ws";

const { sql } = vi.hoisted(() => ({ sql: Object.assign(vi.fn(), { end: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("./db.js", () => ({ openDatabase: () => sql }));

it("does not expose connection credentials or peer certificates in a startup exception", async () => {
  sql.mockRejectedValue(Object.assign(new Error("password=private-test-password"), { cert: { raw: "private-test-certificate" } }));
  const error = await startCloud({ supabaseUrl: "unused", secretKey: "unused", databaseUrl: "unused" }).catch(error => error);
  expect(error.message).toBe("Cloud database connection failed. Check database connectivity and trusted CA configuration.");
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("cert");
  expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
});

it("rejects an occupied listening port and closes the database connection", async () => {
  sql.mockResolvedValue([]);
  sql.end.mockClear();
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    const port = (occupied.address() as { port: number }).port;
    await expect(startCloud({ supabaseUrl: "https://example.supabase.co", secretKey: "test", databaseUrl: "unused" }, port))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

it("survives malformed unauthenticated WebSocket text", async () => {
  sql.mockResolvedValue([]);
  const cloud = await startCloud({ supabaseUrl: "https://example.supabase.co", secretKey: "test", databaseUrl: "unused" });
  try {
    const peer = new WebSocket(cloud.url.replace("http:", "ws:") + "/relay/browser");
    await new Promise<void>((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
    const closed = new Promise<void>(resolve => peer.once("close", () => resolve()));
    peer.send(Buffer.from([0xff]), { binary: false });
    await closed;
    expect((await fetch(cloud.url + "/health")).status).toBe(200);
  } finally { await cloud.close(); }
});
