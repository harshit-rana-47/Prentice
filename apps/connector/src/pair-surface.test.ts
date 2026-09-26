import { afterEach, describe, expect, it } from "vitest";
import { shouldRevealPairingPage, startPairSurface, type PairSurface } from "./pair-surface.js";

const surfaces: PairSurface[] = [];

afterEach(async () => {
  await Promise.all(surfaces.splice(0).map((surface) => surface.close()));
});

describe("pairing window", () => {
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
    expect(html).toContain("Pairing code");
    expect(html).toContain("not the Prentice workspace");
    expect(html).toContain('href="http://127.0.0.1:3000/"');
    const rejected = await fetch(`${surface.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=BAD",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("not valid");
    const accepted = await fetch(`${surface.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=GOODCODE",
    });
    expect(accepted.status).toBe(200);
    expect(codes).toEqual(["BAD", "GOODCODE"]);
  });
});