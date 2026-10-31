import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { macLauncher } from "./mac-launcher.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "prentice-launcher-test-"));
  try {
    const home = join(root, "home"), bin = join(root, "bin");
    mkdirSync(home); mkdirSync(bin);
    writeFileSync(join(bin, "ditto"), '#!/bin/sh\n[ "${FAIL_COPY:-0}" = 0 ] || exit 1\nexec /bin/cp -R "$1" "$2"\n', { mode: 0o755 });
    writeFileSync(join(bin, "codesign"), '#!/bin/sh\n[ "${FAIL_VERIFY:-0}" = 0 ]\n', { mode: 0o755 });
    const app = path => {
      mkdirSync(join(path, "Contents/MacOS"), { recursive: true }); mkdirSync(join(path, "Contents/Resources"));
      writeFileSync(join(path, "Contents/MacOS/Prentice"), macLauncher(), { mode: 0o755 });
      writeFileSync(join(path, "Contents/Resources/node"), '#!/bin/sh\nprintf "%s" "$PRENTICE_APP_PATH" > "$HOME/ran"\n', { mode: 0o755 });
      return join(path, "Contents/MacOS/Prentice");
    };
    const launch = (exe, env = {}) => spawnSync("/bin/bash", [exe], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
    run({ root, home, app, launch });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the installed app survives equivalent HOME/filesystem aliases", () => fixture(({ root, home, app, launch }) => {
  const target = join(home, "Applications/Prentice.app"), exe = app(target), alias = join(root, "alias");
  symlinkSync(home, alias);
  const result = launch(exe, { HOME: alias });
  assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(exe)); assert.ok(existsSync(join(home, "ran")));
}));
test("a new app is copied and verified before replacement and enters the installed runtime once", () => fixture(({ root, home, app, launch }) => {
  const target = join(home, "Applications/Prentice.app"); app(target); writeFileSync(join(target, "old"), "previous");
  const exe = app(join(root, "download/Prentice.app")); const result = launch(exe);
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(join(home, "ran"), "utf8"), target);
  assert.ok(!existsSync(join(target, "old"))); assert.deepEqual(readdirSync(join(home, "Applications")), ["Prentice.app"]);
}));
for (const key of ["FAIL_COPY", "FAIL_VERIFY"]) test(`${key} preserves the original application`, () => fixture(({ root, home, app, launch }) => {
  const target = join(home, "Applications/Prentice.app"); app(target); writeFileSync(join(target, "old"), "previous");
  const result = launch(app(join(root, "download/Prentice.app")), { [key]: "1" });
  assert.notEqual(result.status, 0); assert.equal(readFileSync(join(target, "old"), "utf8"), "previous");
  assert.ok(!existsSync(join(home, "ran"))); assert.deepEqual(readdirSync(join(home, "Applications")), ["Prentice.app"]);
}));
