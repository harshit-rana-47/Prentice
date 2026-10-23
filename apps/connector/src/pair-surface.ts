import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface PairSurface {
  url: string;
  close(): Promise<void>;
}

/** Non-secret ownership check when another process already holds the loopback port. */
export async function isPairSurfaceRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1_000), redirect: "error" });
    const ours = response.ok && response.headers.get("x-prentice-connector") === "pairing-v1";
    await response.body?.cancel();
    return ours;
  } catch { return false; }
}

/** Local development already has the website. Opening this page then hides the workspace. */
export function shouldRevealPairingPage(devHttp: boolean): boolean {
  return !devHttp;
}

/** A localhost page for the pairing code. It is not the workspace and it does not accept internet connections. */
export function startPairSurface(options: {
  pair: (code: string) => Promise<void>;
  savedAccounts?: () => Array<{ id: string; label: string }>;
  activateSaved?: (userId: string) => Promise<void>;
  port?: number;
  websiteUrl?: string;
}): Promise<PairSurface> {
  const nonce = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : options.port;
    const expectedHost = `127.0.0.1:${port}`;
    const expectedOrigin = `http://${expectedHost}`;
    const path = request.url?.split("?")[0];
    // The hosted website links here from another origin. Opening this read-only
    // document is safe: other sites cannot read its nonce, and mutations below
    // still require a local origin, same-origin Fetch Metadata, and that nonce.
    const opensLocalPage = request.method === "GET" && path === "/"
      && request.headers["sec-fetch-mode"] === "navigate"
      && request.headers["sec-fetch-dest"] === "document";
    const foreignSite = request.headers["sec-fetch-site"]
      && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]));
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== expectedOrigin) || (foreignSite && !opensLocalPage)) {
      send(response, 403, "Pairing requires the local Prentice page."); return;
    }
    const websiteUrl = safeWebsiteUrl(options.websiteUrl);
    if (request.method === "GET" && path === "/health") {
      send(response, 200, "Prentice local connector");
      return;
    }
    if (request.method === "GET" && path === "/") {
      send(response, 200, page("", websiteUrl, nonce, options.savedAccounts?.() ?? []));
      return;
    }
    if (request.method === "POST" && path === "/pair") {
      void readBody(request).then(async (raw) => {
        const form = new URLSearchParams(raw);
        const submitted = Buffer.from(form.get("nonce") ?? "");
        const expected = Buffer.from(nonce);
        if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) {
          send(response, 403, "Open the local pairing page and try again."); return;
        }
        const code = form.get("code")?.trim() ?? "";
        if (!code) {
          send(response, 400, page("Enter the code from the Prentice website.", websiteUrl, nonce, options.savedAccounts?.() ?? []));
          return;
        }
        try {
          await options.pair(code);
          send(response, 200, page("This computer is connected. Return to the Prentice website.", websiteUrl, nonce, options.savedAccounts?.() ?? []));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Pairing failed.";
          send(response, 400, page(message, websiteUrl, nonce, options.savedAccounts?.() ?? []));
        }
      }).catch(() => send(response, 413, "Pairing request is too large or incomplete."));
      return;
    }
    if (request.method === "POST" && path === "/activate" && options.activateSaved) {
      void readBody(request).then(async raw => {
        const form = new URLSearchParams(raw);
        const submitted = Buffer.from(form.get("nonce") ?? "");
        const expected = Buffer.from(nonce);
        if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) { send(response, 403, "Open the local Prentice page and try again."); return; }
        try {
          await options.activateSaved!(form.get("account") ?? "");
          send(response, 200, page("This account is active. Return to the Prentice website.", websiteUrl, nonce, options.savedAccounts?.() ?? []));
        } catch (error) {
          send(response, 400, page(error instanceof Error ? error.message : "Could not switch account.", websiteUrl, nonce, options.savedAccounts?.() ?? []));
        }
      }).catch(() => send(response, 413, "Switch request is too large or incomplete."));
      return;
    }
    send(response, 404, "Not found");
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
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

function page(notice: string, websiteUrl: string, nonce: string, accounts: Array<{ id: string; label: string }> = []): string {
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
      <input type="hidden" name="nonce" value="${nonce}" />
      <label for="code">Pairing code</label>
      <input id="code" name="code" autocomplete="one-time-code" />
      <button type="submit">Connect</button>
    </form>
    ${accounts.length ? `<form method="post" action="/activate"><input type="hidden" name="nonce" value="${nonce}" /><label for="account">Previously paired account</label><select id="account" name="account">${accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`).join("")}</select><button type="submit">Use saved connection</button></form>` : ""}
  </main>
</body>
</html>`;
}

function send(response: import("node:http").ServerResponse, status: number, body: string): void {
  response.setHeader("x-prentice-connector", "pairing-v1");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 4_096) { reject(new Error("BODY_TOO_LARGE")); return; }
      chunks.push(Buffer.from(chunk));
    });
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
