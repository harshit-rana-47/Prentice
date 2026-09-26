import { createServer, type Server } from "node:http";

export interface PairSurface {
  url: string;
  close(): Promise<void>;
}

/** Local development already has the website. Opening this page then hides the workspace. */
export function shouldRevealPairingPage(devHttp: boolean): boolean {
  return !devHttp;
}

/** A localhost page for the pairing code. It is not the workspace and it does not accept internet connections. */
export function startPairSurface(options: {
  pair: (code: string) => Promise<void>;
  port?: number;
  websiteUrl?: string;
}): Promise<PairSurface> {
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    const websiteUrl = safeWebsiteUrl(options.websiteUrl);
    if (request.method === "GET" && path === "/") {
      send(response, 200, page("", websiteUrl));
      return;
    }
    if (request.method === "POST" && path === "/pair") {
      void readBody(request).then(async (raw) => {
        const code = new URLSearchParams(raw).get("code")?.trim() ?? "";
        if (!code) {
          send(response, 400, page("Enter the code from the Prentice website.", websiteUrl));
          return;
        }
        try {
          await options.pair(code);
          send(response, 200, page("This computer is connected. Return to the Prentice website.", websiteUrl));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Pairing failed.";
          send(response, 400, page(message, websiteUrl));
        }
      });
      return;
    }
    send(response, 404, "Not found");
  });
  const port = options.port ?? Number(process.env.PRENTICE_PAIR_PORT ?? 4732);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address();
      const listening = bound && typeof bound === "object" ? bound.port : port;
      resolve({
        url: `http://127.0.0.1:${listening}`,
        close: () => closeServer(server),
      });
    });
  });
}

function page(notice: string, websiteUrl: string): string {
  const message = escapeHtml(notice);
  const website = websiteUrl
    ? `<p><a href="${escapeHtml(websiteUrl)}">Open the Prentice website</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#efe6d4">
  <title>Connect this computer</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #efe6d4; color: #24180f; font: 15px/1.5 "Avenir Next", "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100% - 48px)); background: #f6f0e4; border: 1px solid #e4d5bc; border-radius: 16px; padding: 32px 28px; box-shadow: 0 1px 0 rgb(36 24 15 / 4%), 0 24px 48px -28px rgb(36 24 15 / 45%); }
    h1 { font-family: "Iowan Old Style", Palatino, Georgia, serif; font-weight: 400; font-size: 32px; letter-spacing: -0.03em; margin: 0; }
    .rule { height: 1px; width: 64px; margin: 12px 0 16px; background: #e15a22; transform-origin: left center; animation: draw 320ms cubic-bezier(0.22, 1, 0.36, 1); }
    p { color: #5e4e3c; }
    a { color: #e15a22; }
    label { display: block; margin: 16px 0 6px; font: 600 11px/1.4 ui-monospace, "SFMono-Regular", monospace; letter-spacing: 0.14em; text-transform: uppercase; color: #5e4e3c; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #e4d5bc; background: #fffaf2; color: #24180f; border-radius: 8px; padding: 10px 12px; font: inherit; }
    input:focus { outline: 2px solid #e15a22; border-color: #e15a22; }
    button { margin-top: 12px; border: 0; border-radius: 8px; background: #e15a22; color: #fff6ec; font: 600 13px/1.2 "Avenir Next", "Segoe UI", sans-serif; padding: 9px 14px; cursor: pointer; box-shadow: 0 1px 0 rgb(36 24 15 / 16%); transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms cubic-bezier(0.22, 1, 0.36, 1); }
    button:hover { transform: translateY(-1px); background: #c94e1c; }
    button:active { transform: translateY(1px); }
    @keyframes draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @media (prefers-reduced-motion: reduce) { .rule, button { animation: none; transition: none; } }
  </style>
</head>
<body>
  <main>
    <h1>Connect this computer</h1>
    <div class="rule"></div>
    <p>This page only pairs this computer. It is not the Prentice workspace.</p>
    <p>Enter the pairing code shown on the Prentice website.</p>
    ${website}
    ${message ? `<p>${message}</p>` : ""}
    <form method="post" action="/pair">
      <label for="code">Pairing code</label>
      <input id="code" name="code" autocomplete="one-time-code" />
      <button type="submit">Connect</button>
    </form>
  </main>
</body>
</html>`;
}

function send(response: import("node:http").ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function safeWebsiteUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
