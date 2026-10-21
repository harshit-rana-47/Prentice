import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";

const surfaces: PairSurface[] = [];

afterEach(async () => {
  await Promise.all(surfaces.splice(0).map((surface) => surface.close()));
});

describe("pairing window", () => {
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