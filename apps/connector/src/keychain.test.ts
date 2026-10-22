import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { macOsKeychain } from "./keychain.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function processResult(stdout = "", failure?: Error, pipeFailure = false) {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    stdin.end.mockImplementation(() => {
      if (pipeFailure) stdin.emit("error", new Error("PRIVATE_PIPE_DETAIL"));
      else done(failure ?? null, stdout, "PRIVATE_STDERR_DETAIL");
    });
    return { stdin } as unknown as ReturnType<typeof execFile>;
  });
  return stdin;
}

it("updates credential data without changing access permissions or exposing secrets in process arguments", async () => {
  const secret = 'private "quoted" \\ value';
  const stdin = processResult(secret);
  await macOsKeychain().writePrivateKey('account "quoted"', secret);
  const [command, args, options] = vi.mocked(execFile).mock.calls[0]!;
  expect(command).toBe("/usr/bin/security");
  expect(args).toEqual(["-q", "-i"]);
  expect(inspect([command, args, options])).not.toContain("private");
  expect(options).not.toHaveProperty("env");
  expect(options).not.toHaveProperty("shell");
  expect(options).toMatchObject({ timeout: 30_000, killSignal: "SIGKILL" });
  expect(stdin.end).toHaveBeenCalledTimes(2);
  expect(stdin.end).toHaveBeenNthCalledWith(1, '"add-generic-password" "-U" "-s" "prentice-device-key" "-a" "account \\"quoted\\"" "-w" "private \\"quoted\\" \\\\ value"\n');
  expect(stdin.end).toHaveBeenNthCalledWith(2, '"find-generic-password" "-s" "prentice-device-key" "-a" "account \\"quoted\\"" "-w"\n');
});

it.each(["", "old-credential"])("rejects an unpersisted write even when security exits zero", async stored => {
  processResult(stored);
  await expect(macOsKeychain().writePrivateKey("account", "new-credential")).rejects.toThrow("Keychain did not save the credential");
});

it.each(["\n", "\r", "\0", "\x1b"])("refuses control character %j before spawning", async char => {
  await expect(macOsKeychain().writePrivateKey("account", `secret${char}help`)).rejects.toThrow("Invalid Keychain credential input");
  await expect(macOsKeychain().writePrivateKey(`account${char}help`, "secret")).rejects.toThrow("Invalid Keychain credential input");
  expect(execFile).not.toHaveBeenCalled();
});

it("checks the escaped UTF-8 byte length before spawning", async () => {
  await expect(macOsKeychain().writePrivateKey("account", "鍵".repeat(1400))).rejects.toThrow("too long");
  await expect(macOsKeychain().writePrivateKey("account", '"'.repeat(2200))).rejects.toThrow("too long");
  expect(execFile).not.toHaveBeenCalled();
});

it("never forwards a command failure's private message, output or stderr", async () => {
  const secret = "PRIVATE_SECRET_DETAIL";
  processResult(secret, Object.assign(new Error(secret), { stdout: secret, stderr: secret, cmd: secret }));
  const failure = await macOsKeychain().writePrivateKey("account", secret).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(inspect(failure)).not.toContain(secret);
  expect(inspect(failure)).not.toContain("PRIVATE_STDERR_DETAIL");
  expect(failure.message).toContain("Keychain");
});

it("sanitizes pipe failures too", async () => {
  processResult("", undefined, true);
  await expect(macOsKeychain().writePrivateKey("account", "secret")).rejects.toThrow("could not accept");
});

it("reads a credential only from captured stdout and keeps a missing item null", async () => {
  processResult("secret-value\n");
  expect(await macOsKeychain().readPrivateKey("account")).toBe("secret-value");
  processResult("", new Error("not found"));
  expect(await macOsKeychain().readPrivateKey("missing")).toBeNull();
});

it("deletes only the named account from the existing service", async () => {
  const stdin = processResult();
  await macOsKeychain().deletePrivateKey("account");
  expect(stdin.end).toHaveBeenCalledExactlyOnceWith('"delete-generic-password" "-s" "prentice-device-key" "-a" "account"\n');
});
