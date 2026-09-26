import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceKeychain } from "./device.js";

const exec = promisify(execFile);
const service = "prentice-device-key";

/** macOS login keychain. The secret is passed to `security` as an argument, so it can appear briefly in a process listing. */
export function macOsKeychain(): DeviceKeychain {
  return {
    async writePrivateKey(account, pkcs8) {
      await exec("security", [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        pkcs8,
        "-T",
        "/usr/bin/security",
      ]);
    },
    async readPrivateKey(account) {
      try {
        const { stdout } = await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
        const value = stdout.trim();
        return value || null;
      } catch {
        return null;
      }
    },
    async deletePrivateKey(account) {
      await exec("security", ["delete-generic-password", "-s", service, "-a", account]);
    },
  };
}
