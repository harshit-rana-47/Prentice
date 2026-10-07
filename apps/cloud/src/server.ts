import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { openDatabase } from "./db.js";
import { createHttpApp } from "./http.js";
import { FrameRelay } from "./relay.js";
import { CloudStore } from "./store.js";

export interface CloudConfig {
  supabaseUrl: string;
  secretKey: string;
  databaseUrl: string;
}

export interface CloudServer {
  port: number;
  url: string;
  store: CloudStore;
  close(): Promise<void>;
}

/** Relay keepalive. Well under common proxy idle timeouts (60–100s). */
export const RELAY_HEARTBEAT_MS = 25_000;

export async function startCloud(
  config: CloudConfig,
  port = 0,
  host = "127.0.0.1",
  options: { devLearningToken?: string; heartbeatMs?: number } = {},
): Promise<CloudServer> {
  const sql = openDatabase(config.databaseUrl);
  await sql`select 1 as ok`;
  const store = new CloudStore(sql, config.supabaseUrl, config.secretKey);
  const relay = new FrameRelay(store);
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const listener = getRequestListener(
    createHttpApp(store, {
      onRevoke: (deviceId) => relay.disconnect(deviceId),
      devLearningToken: loopback ? options.devLearningToken : undefined,
    }).fetch,
  );
  const server = createServer((request, response) => {
    void listener(request, response);
  });
  const sockets = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => relay.heartbeat(sockets.clients), options.heartbeatMs ?? RELAY_HEARTBEAT_MS);
  heartbeat.unref();
  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?")[0];
    if (path !== "/relay/connector" && path !== "/relay/browser") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      relay.attach(ws, path === "/relay/connector" ? "connector" : "browser");
    });
  });
  const listening = await new Promise<CloudServer>((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const bound = address && typeof address === "object" ? address.port : 0;
      const advertised = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      resolve({
        port: bound,
        url: `http://${advertised}:${bound}`,
        store,
        close: async () => {
          clearInterval(heartbeat);
          for (const client of sockets.clients) client.close();
          await new Promise<void>((done) => sockets.close(() => done()));
          await new Promise<void>((done) => server.close(() => done()));
          await sql.end({ timeout: 5 });
        },
      });
    });
  });
  return listening;
}
