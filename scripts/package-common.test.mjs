import { test } from "node:test";
import assert from "node:assert/strict";
import { publicConfig } from "./package-common.mjs";

test("unsigned beta uses hosted addresses and refuses localhost or unencrypted services", () => {
  const keys = ["PRENTICE_CLOUD_URL", "PRENTICE_WEBSITE_URL", "PRENTICE_RELEASE"];
  const before = keys.map(key => process.env[key]);
  process.argv.push("--beta");
  try {
    process.env.PRENTICE_RELEASE = "";
    process.env.PRENTICE_CLOUD_URL = "https://relay.example.test";
    process.env.PRENTICE_WEBSITE_URL = "https://site.example.test";
    assert.equal(publicConfig().channel, "beta");
    for (const key of keys.slice(0, 2)) {
      const original = process.env[key];
      for (const unsafe of ["http://127.0.0.1:4740", "http://relay.example.test", "https://localhost"]) {
        process.env[key] = unsafe;
        assert.throws(() => publicConfig(), /public https/);
      }
      process.env[key] = original;
    }
  } finally {
    process.argv.pop();
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});
