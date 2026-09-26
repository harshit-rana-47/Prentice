import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDeviceIdentity, memoryKeychain, type DeviceKeychain } from "./device.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("device identity", () => {
  it("writes the public key only after the keychain accepts the private key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prentice-device-"));
    directories.push(directory);
    const failing: DeviceKeychain = {
      async writePrivateKey() {
        throw new Error("keychain unavailable");
      },
      async readPrivateKey() {
        return null;
      },
      async deletePrivateKey() {},
    };
    await expect(ensureDeviceIdentity({ directory, keychain: failing })).rejects.toThrow(/keychain unavailable/);
    await expect(readFile(join(directory, "device.json"), "utf8")).rejects.toThrow();

    const keychain = memoryKeychain();
    const identity = await ensureDeviceIdentity({ directory, keychain });
    const stored = JSON.parse(await readFile(join(directory, "device.json"), "utf8")) as {
      id: string;
      publicKey: string;
      privateKey?: string;
    };
    expect(stored.id).toBe(identity.id);
    expect(stored.publicKey).toBe(identity.publicKey);
    expect(stored.privateKey).toBeUndefined();
    expect(await keychain.readPrivateKey(identity.id)).toBeTruthy();
    const again = await ensureDeviceIdentity({ directory, keychain });
    expect(again.id).toBe(identity.id);
  });
});
