import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const children: ChildProcess[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function start(home: string, port: number) {
  const child = spawn(process.execPath, ["--import=tsx", "src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PRENTICE_HOME: home, PRENTICE_PACKAGED: "1", PRENTICE_CONFIG: "", PRENTICE_DEV_HTTP: "0",
      PRENTICE_PAIR_PORT: String(port), PRENTICE_CLOUD_URL: "http://127.0.0.1:1", PRENTICE_WEBSITE_URL: "https://example.test",
      PRENTICE_REVEAL_PAIRING: "0", PRENTICE_INSTALL_LOGIN_ITEM: "0", PRENTICE_PAIRING_CODE: "", PRENTICE_APP_PATH: "" },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function exitCode(child: ChildProcess) {
  return child.exitCode !== null ? child.exitCode : (await once(child, "exit"))[0];
}

async function page(home: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const url = readFileSync(join(home, "pairing.url"), "utf8").trim();
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok && response.headers.get("x-prentice-connector") === "pairing-v1") return { url, html: await response.text() };
    } catch { /* wait for the process's real HTTP listener */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Local pairing page did not start");
}

it("ignores a stale PID belonging to a live process, rejects duplicate instances, and restarts after a crash", async () => {
  const home = mkdtempSync(join(tmpdir(), "prentice-lifecycle-")); homes.push(home);
  // Reproduces PID reuse after reboot: the old lock points to a live unrelated process.
  writeFileSync(join(home, "connector.lock"), String(process.pid));
  const first = start(home, 0);
  const before = await page(home);
  expect(before.html).toContain('name="code"');
  const port = Number(new URL(before.url).port);
  const duplicate = start(home, port);
  expect(await exitCode(duplicate)).toBe(0);
  expect(first.exitCode).toBeNull();
  expect((await page(home)).html).toBe(before.html);
  first.kill("SIGKILL"); await once(first, "exit");
  start(home, port);
  const after = await page(home);
  expect(after.html).toContain('name="code"');
  expect(after.html).not.toBe(before.html); // fresh nonce proves a new server owns the port
}, 15_000);

it("reports an occupied port owned by another app instead of silently pretending Prentice is running", async () => {
  const home = mkdtempSync(join(tmpdir(), "prentice-lifecycle-")); homes.push(home);
  const other = createServer((_request, response) => response.end("another app"));
  await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
  try {
    const child = start(home, (other.address() as { port: number }).port);
    expect(await exitCode(child)).not.toBe(0);
  } finally {
    other.closeAllConnections();
    await new Promise<void>(resolve => other.close(() => resolve()));
  }
}, 10_000);
