import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("native cleanup trashes only an exact verified download copy, retaining the installed app and unrelated/tampered apps", {
  skip: process.platform !== "darwin" || process.env.PRENTICE_TEST_MAC_INSTALLER !== "1",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "prentice-cleanup-test-"));
  const prefix = `Prentice Installer Test ${randomUUID()}`;
  const downloads = join(homedir(), "Downloads"); mkdirSync(downloads, { recursive: true });
  const copies = ["exact", "unrelated", "tampered"].map(name => join(downloads, `${prefix} ${name}.app`));
  const app = join(root, "Prentice.app"); const helper = join(root, "mac-service");
  let moved = [];
  try {
    execFileSync(process.execPath, ["scripts/build-mac-service.mjs", helper]);
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const plist = id => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0.0</string></dict></plist>`;
    mkdirSync(join(app, "Contents/Resources")); writeFileSync(join(app, "Contents/Resources/nonce"), prefix);
    writeFileSync(join(app, "Contents/Info.plist"), plist("com.prentice.connector"));
    writeFileSync(join(app, "Contents/MacOS/fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    execFileSync("codesign", ["--force", "--sign", "-", app]);
    for (const copy of copies) cpSync(app, copy, { recursive: true });
    writeFileSync(join(copies[1], "Contents/Info.plist"), plist("example.unrelated"));
    execFileSync("codesign", ["--force", "--sign", "-", copies[1]]);
    writeFileSync(join(copies[2], "Contents/MacOS/fixture"), "#!/bin/sh\nexit 1\n");
    const result = JSON.parse(execFileSync(helper, ["finish-install", app], { encoding: "utf8" })); moved = result.movedCopies;
    assert.equal(moved.length, 1); assert.equal(existsSync(copies[0]), false);
    assert.ok(existsSync(app)); assert.ok(existsSync(copies[1])); assert.ok(existsSync(copies[2]));
    assert.ok(moved[0].includes(prefix));
  } finally {
    for (const path of [...copies, ...moved]) if (path.includes(prefix)) rmSync(path, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
