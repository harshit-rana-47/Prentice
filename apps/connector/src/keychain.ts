import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceKeychain } from "./device.js";
import { windowsCredentialManager } from "./windows-credential.js";

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

/** Private keys stay in the operating system's credential store. The website never receives them. */
export function deviceKeychain(): DeviceKeychain {
  if (process.platform === "darwin") return macOsKeychain();
  if (process.platform === "win32") return windowsCredentialManager();
  throw new Error("Prentice stores the device key on macOS and Windows.");
}
