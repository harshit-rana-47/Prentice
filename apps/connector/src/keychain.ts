import { execFile } from "node:child_process";
import type { DeviceKeychain } from "./device.js";
import { windowsCredentialManager } from "./windows-credential.js";

const service = "prentice-device-key";

/** Keep secrets off argv and disk. One quoted command goes to security's non-TTY stdin. */
function securityCommand(args: string[]): Promise<string> {
  // SecurityTool's interactive reader has a 4096-byte line buffer. Never allow a truncated command
  // or a control character to turn credential data into a second command.
  const command = args.map(value => {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Keychain credential input.");
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }).join(" ") + "\n";
  if (Buffer.byteLength(command, "utf8") >= 4096) throw new Error("Keychain credential input is too long.");
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", ["-q", "-i"], { encoding: "utf8", maxBuffer: 16_384, timeout: 30_000, killSignal: "SIGKILL" }, (error, stdout) => {
      // Never propagate child-process errors, stdout or stderr: they can contain credential data.
      if (error) reject(new Error("macOS Keychain could not complete the credential operation."));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {
      reject(new Error("macOS Keychain could not accept the credential operation."));
    });
    child.stdin?.end(command);
  });
}

/** Retains the existing service, account names and /usr/bin/security access control. */
export function macOsKeychain(): DeviceKeychain {
  return {
    async writePrivateKey(account, pkcs8) {
      await securityCommand(["add-generic-password", "-U", "-s", service, "-a", account, "-w", pkcs8, "-T", "/usr/bin/security"]);
    },
    async readPrivateKey(account) {
      try {
        const value = (await securityCommand(["find-generic-password", "-s", service, "-a", account, "-w"])).trim();
        return value || null;
      } catch {
        return null;
      }
    },
    async deletePrivateKey(account) {
      await securityCommand(["delete-generic-password", "-s", service, "-a", account]);
    },
  };
}

/** Private keys stay in the operating system's credential store. The website never receives them. */
export function deviceKeychain(): DeviceKeychain {
  if (process.platform === "darwin") return macOsKeychain();
  if (process.platform === "win32") return windowsCredentialManager();
  throw new Error("Prentice stores the device key on macOS and Windows.");
}
