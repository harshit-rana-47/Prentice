import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

export interface DeviceIdentity {
  id: string;
  publicKey: string;
  createdAt: string;
}

export interface DeviceKeychain {
  writePrivateKey(account: string, pkcs8: string): Promise<void>;
  readPrivateKey(account: string): Promise<string | null>;
  deletePrivateKey(account: string): Promise<void>;
}

export function memoryKeychain(): DeviceKeychain {
  const keys = new Map<string, string>();
  return {
    async writePrivateKey(account, pkcs8) {
      keys.set(account, pkcs8);
    },
    async readPrivateKey(account) {
      return keys.get(account) ?? null;
    },
    async deletePrivateKey(account) {
      keys.delete(account);
    },
  };
}

/** The private key is stored only after the keychain accepts it. The file holds the public key. */
export async function ensureDeviceIdentity(options: { directory: string; keychain: DeviceKeychain }): Promise<DeviceIdentity> {
  const file = join(options.directory, "device.json");
  const existing = readIdentity(file);
  if (existing) {
    const privateKey = await options.keychain.readPrivateKey(existing.id);
    if (!privateKey) {
      throw new Error("The device public key is on disk, but the keychain has no matching private key.");
    }
    return existing;
  }
  const pair = generateKeyPairSync("ed25519");
  const identity: DeviceIdentity = {
    id: randomUUID(),
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  await options.keychain.writePrivateKey(identity.id, privateKey);
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  await chmod(file, 0o600);
  return identity;
}

function readIdentity(file: string): DeviceIdentity | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DeviceIdentity>;
    if (!parsed.id || !parsed.publicKey || !parsed.createdAt) return undefined;
    return { id: parsed.id, publicKey: parsed.publicKey, createdAt: parsed.createdAt };
  } catch {
    return undefined;
  }
}
