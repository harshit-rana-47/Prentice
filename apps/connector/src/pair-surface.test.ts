import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";

const surfaces: PairSurface[] = [];

afterEach(async () => {
  await Promise.all(surfaces.splice(0).map((surface) => surface.close()));
});

describe("pairing window", () => {
  it("opens from the hosted website without allowing cross-site reads or submissions", async () => {
    let paired = 0;
    let activated = 0;
    const surface = await startPairSurface({ port: 0, pair: async () => { paired++; }, activateSaved: async () => { activated++; } });
    surfaces.push(surface);
    const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const page = await browserRequest(surface.url, navigation);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const nonce = /name="nonce" value="([^"]+)"/.exec(page.html)![1];
    for (const destination of ["iframe", "image", "empty"]) {
      expect((await browserRequest(surface.url, { ...navigation, "sec-fetch-dest": destination })).status).toBe(403);
    }
    expect((await browserRequest(surface.url, { ...navigation, "sec-fetch-mode": "cors" })).status).toBe(403);
    expect((await browserRequest(surface.url, { ...navigation, origin: "https://evil.example" })).status).toBe(403);
    expect((await browserRequest(surface.url, { ...navigation, host: "evil.example" })).status).toBe(403);
    for (const path of ["/pair", "/activate"]) {
      expect((await browserRequest(`${surface.url}${path}`, navigation, `code=VALID&account=saved&nonce=${nonce}`)).status).toBe(403);
    }
    expect(paired).toBe(0);
    expect(activated).toBe(0);
    const localSubmission = await fetch(`${surface.url}/pair`, {
      method: "POST", headers: { origin: surface.url, "sec-fetch-site": "same-origin" }, body: `code=VALID&nonce=${nonce}`,
    });
    expect(localSubmission.status).toBe(200);
    expect(paired).toBe(1);
  });

  it("rejects foreign origins, missing binding, foreign hosts, and oversized bodies", async () => {
    let called = 0;
    const surface = await startPairSurface({ port: 0, pair: async () => { called++; } });
    surfaces.push(surface);
    const html = await (await fetch(surface.url)).text();
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
    const submit = (headers: Record<string, string>, body = `code=VALID&nonce=${nonce}`) => fetch(`${surface.url}/pair`, { method: "POST", headers, body });
    expect((await submit({ origin: "https://evil.example" })).status).toBe(403);
    expect((await submit({}, "code=VALID")).status).toBe(403);
    const hostileHost = await new Promise<number>((resolve,reject) => {
      const call = request(`${surface.url}/pair`, { method:"POST", headers:{ host:"evil.example" } },response=>{ response.resume(); resolve(response.statusCode!); });
      call.on("error",reject); call.end(`code=VALID&nonce=${nonce}`);
    });
    expect(hostileHost).toBe(403);
    expect((await submit({}, "x".repeat(5000))).status).toBe(413);
    expect(called).toBe(0);
  });
  it("stays closed during local development and opens when pairing is the connector's job", () => {
    expect(shouldRevealPairingPage(true)).toBe(false);
    expect(shouldRevealPairingPage(false)).toBe(true);
  });

  it("accepts a code on localhost and reports a rejected code", async () => {
    const codes: string[] = [];
    const surface = await startPairSurface({
      port: 0,
      websiteUrl: "http://127.0.0.1:3000",
      pair: async (code) => {
        codes.push(code);
        if (code === "BAD") throw new Error("That pairing code is not valid.");
      },
    });
    surfaces.push(surface);
    const address = new URL(surface.url);
    expect(address.hostname).toBe("127.0.0.1");
    const page = await fetch(surface.url);
    const html = await page.text();
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
    expect(html).toContain("Pairing code");
    expect(html).toContain("not the Prentice workspace");
    expect(html).toContain('href="http://127.0.0.1:3000/"');
    const rejected = await fetch(`${surface.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=BAD&nonce=${nonce}`,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("not valid");
    const accepted = await fetch(`${surface.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=GOODCODE&nonce=${nonce}`,
    });
    expect(accepted.status).toBe(200);
    expect(codes).toEqual(["BAD", "GOODCODE"]);
  });
});

// fetch() always sets Sec-Fetch-Mode to "cors". Use HTTP to reproduce a browser's
// top-level link navigation accurately, including its Fetch Metadata headers.
function browserRequest(url: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; html: string }>((resolve, reject) => {
    const call = request(url, { method: body === undefined ? "GET" : "POST", headers }, (response) => {
      let html = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { html += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, html }));
      response.on("error", reject);
    });
    call.on("error", reject);
    call.end(body);
  });
}
