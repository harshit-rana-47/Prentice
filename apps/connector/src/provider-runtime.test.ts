import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent, ResolvedProfile } from "@prentice/domain";
import { afterEach, describe, expect, it } from "vitest";
import { probeAgent, readSignedIn } from "./accounts.js";
import { codexNativeBinary, findInstalledExecutable, resolveAgent, type ResolvedAgent } from "./agents.js";
import { claudeArgs, createClaudeProvider, createCursorProvider, cursorArgs } from "./providers.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempHome() {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "prentice-agents-")));
  directories.push(home);
  return home;
}

async function script(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

/** Finder and Login Items start apps with this PATH. Discovery must not depend on anything else. */
const finderEnv = (home: string) => ({ HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });

const profile: ResolvedProfile = { intensity: "balanced", delegated: false, summary: "Balanced.", useProviderMax: false };

async function collect(events: AsyncIterable<NormalizedEvent>) {
  const out: NormalizedEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe.skipIf(process.platform === "win32")("agent discovery outside the shell PATH", () => {
  it("finds official installs in ~/.local/bin even when PATH is the Finder default", async () => {
    const home = await tempHome();
    await script(join(home, ".local", "bin", "claude"), "exit 0");
    const versioned = join(home, ".local", "share", "cursor-agent", "versions", "1", "cursor-agent");
    await script(versioned, "exit 0");
    await symlink(versioned, join(home, ".local", "bin", "agent"));
    const options = { home, env: finderEnv(home), platform: "darwin" as const };
    expect(findInstalledExecutable("claude-code", options)).toBe(join(home, ".local", "bin", "claude"));
    expect(findInstalledExecutable("cursor", options)).toBe(join(home, ".local", "bin", "agent"));
    expect(findInstalledExecutable("codex", options)).toBeNull();
  });

  it("does not mistake an unrelated program named agent for the Cursor CLI", async () => {
    const home = await tempHome();
    await script(join(home, ".local", "bin", "agent"), "exit 0");
    expect(findInstalledExecutable("cursor", { home, env: finderEnv(home), platform: "darwin" })).toBeNull();
  });

  it("resolves an npm Codex launcher to its native binary, so no node on PATH is needed", async () => {
    const home = await tempHome();
    const pkg = join(home, ".npm-global", "lib", "node_modules", "@openai", "codex");
    await script(join(pkg, "bin", "codex.js"), "");
    await writeFile(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\nimport './x.js'\n");
    await mkdir(join(home, ".npm-global", "bin"), { recursive: true });
    await symlink(join(pkg, "bin", "codex.js"), join(home, ".npm-global", "bin", "codex"));
    const vendor = join(pkg, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
    await script(join(vendor, "bin", "codex"), "exit 0");
    await mkdir(join(vendor, "codex-path"), { recursive: true });
    const resolved = resolveAgent("codex", { home, env: finderEnv(home), platform: "darwin", arch: "arm64" });
    expect(resolved && "command" in resolved ? resolved.command : resolved).toBe(join(vendor, "bin", "codex"));
    expect(resolved && "command" in resolved ? resolved.pathDirs : []).toEqual([join(vendor, "codex-path")]);
  });

  it("reports an npm Codex whose native package is missing as an error, not as ready", async () => {
    const home = await tempHome();
    const pkg = join(home, ".npm-global", "lib", "node_modules", "@openai", "codex");
    await mkdir(join(pkg, "bin"), { recursive: true });
    await writeFile(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
    await mkdir(join(home, ".npm-global", "bin"), { recursive: true });
    await symlink(join(pkg, "bin", "codex.js"), join(home, ".npm-global", "bin", "codex"));
    const resolved = resolveAgent("codex", { home, env: finderEnv(home), platform: "darwin", arch: "arm64" });
    expect(resolved).toMatchObject({ error: expect.stringContaining("Reinstall Codex") });
    const state = await probeAgent("codex", null, { home, env: finderEnv(home), platform: "darwin", arch: "arm64" });
    expect(state.state).toBe("error");
  });

  it("uses a native Homebrew-style codex as is", () => {
    expect(codexNativeBinary("/bin/sh", { platform: "darwin", arch: "arm64" })).toEqual({ executable: "/bin/sh", pathDirs: [] });
  });
});

describe.skipIf(process.platform === "win32")("agent states from each agent's own status command", () => {
  it("distinguishes not installed, signed out, ready, and error", async () => {
    const home = await tempHome();
    const env = finderEnv(home);
    const options = { home, env, platform: "darwin" as const };
    expect((await probeAgent("claude-code", null, options)).state).toBe("not-installed");

    await script(join(home, ".local", "bin", "claude"), `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`);
    const signedOut = await probeAgent("claude-code", null, options);
    expect(signedOut).toMatchObject({ installed: true, connected: false, state: "signed-out" });
    expect(signedOut.message).toContain("Prentice does not sign in to Claude for you");

    await script(join(home, ".local", "bin", "claude"), `echo '{"loggedIn": true}'`);
    expect((await probeAgent("claude-code", null, options)).state).toBe("ready");

    await script(join(home, ".local", "bin", "claude"), "echo 'something unexpected'; exit 3");
    expect((await probeAgent("claude-code", null, options)).state).toBe("error");
  });

  it("reads the Cursor CLI's JSON status", () => {
    const status = (stdout: string) => readSignedIn("cursor", { code: 0, stdout, stderr: "" });
    expect(status('{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}')).toBe(false);
    expect(status('{"status":"authenticated","isAuthenticated":true}')).toBe(true);
    expect(readSignedIn("codex", { code: 0, stdout: "Logged in using ChatGPT", stderr: "" })).toBe(true);
    expect(readSignedIn("codex", { code: 1, stdout: "Not logged in", stderr: "" })).toBe(false);
  });
});

function fakeAgent(command: string): ResolvedAgent {
  return { id: "claude-code", command, prefixArgs: [], installed: command, env: { PATH: "/usr/bin:/bin" }, pathDirs: [] };
}

describe.skipIf(process.platform === "win32")("CLI coding agents", () => {
  it("runs Claude Code headless with Prentice's permission rules and keeps a failed command's output", async () => {
    const home = await tempHome();
    const argsFile = join(home, "args.txt");
    const stream = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1\n# pass 1\n# fail 1\nAssertionError: 8 !== 2" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "The subtract test fails." }] } },
      { type: "result", subtype: "success", is_error: false, result: "The subtract test fails." },
    ];
    await writeFile(join(home, "stream.jsonl"), stream.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await script(join(home, "claude"), `printf '%s\\n' "$@" > "${argsFile}"; cat > "${home}/stdin.txt"; cat "${home}/stream.jsonl"`);
    const session = await createClaudeProvider().startSession({
      prompt: "Run the tests",
      repoPath: home,
      profile,
      signal: new AbortController().signal,
      agent: fakeAgent(join(home, "claude")),
    });
    const events = await collect(session.events);
    const finished = events.find((event) => event.type === "command.finished");
    expect(finished).toMatchObject({ command: "npm test", exitCode: 1, output: { source: "command-output" } });
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
    const args = (await import("node:fs")).readFileSync(argsFile, "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["-p", "stream-json", "acceptEdits", "--disallowedTools"]));
    expect((await import("node:fs")).readFileSync(join(home, "stdin.txt"), "utf8")).toBe("Run the tests");
    expect(claudeArgs({ prompt: "x", repoPath: home, profile, signal: new AbortController().signal })).not.toContain("x");
  });

  it("reports a signed-out Claude Code as a sign-in state, not as an agent reply", async () => {
    const home = await tempHome();
    const lines = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
      { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" },
    ];
    await writeFile(join(home, "stream.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    await script(join(home, "claude"), `cat > /dev/null; cat "${home}/stream.jsonl"; exit 1`);
    const session = await createClaudeProvider().startSession({
      prompt: "hi",
      repoPath: home,
      profile,
      signal: new AbortController().signal,
      agent: fakeAgent(join(home, "claude")),
    });
    const events = await collect(session.events);
    expect(events.filter((event) => event.type === "assistant")).toEqual([]);
    expect(events.filter((event) => event.type === "session.failed")).toEqual([expect.objectContaining({ code: "AGENT_SIGNED_OUT" })]);
  });

  it("maps the Cursor CLI's sign-in error on stderr to a sign-in state", async () => {
    const home = await tempHome();
    await script(join(home, "cursor-agent"), `echo "Error: Authentication required. Please run 'agent login' first." >&2; exit 1`);
    const session = await createCursorProvider().startSession({
      prompt: "hi",
      repoPath: home,
      profile,
      signal: new AbortController().signal,
      agent: { ...fakeAgent(join(home, "cursor-agent")), id: "cursor" },
    });
    const events = await collect(session.events);
    expect(events.at(-1)).toMatchObject({ type: "session.failed", code: "AGENT_SIGNED_OUT" });
    expect(cursorArgs({ prompt: "p", repoPath: "/r", profile, signal: new AbortController().signal })).toEqual(
      expect.arrayContaining(["-p", "--output-format", "stream-json", "--force", "--trust", "--workspace", "/r"]),
    );
  });

  it("interrupts a running CLI agent and reports an interrupt, not a failure", async () => {
    const home = await tempHome();
    await script(join(home, "claude"), `echo '{"type":"system","subtype":"init","session_id":"s"}'; trap 'exit 130' INT; while true; do sleep 0.1; done`);
    const abort = new AbortController();
    const session = await createClaudeProvider().startSession({
      prompt: "long",
      repoPath: home,
      profile,
      signal: abort.signal,
      agent: fakeAgent(join(home, "claude")),
    });
    const collecting = collect(session.events);
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    await session.interrupt();
    const events = await collecting;
    expect(events.at(-1)).toEqual({ type: "session.interrupted" });
  }, 15_000);

  it("stops the turn when the agent starts a destructive command", async () => {
    const home = await tempHome();
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "git push origin main" } }] } });
    await script(join(home, "claude"), `cat > /dev/null; echo '${line}'; sleep 5`);
    const session = await createClaudeProvider().startSession({
      prompt: "x",
      repoPath: home,
      profile,
      signal: new AbortController().signal,
      agent: fakeAgent(join(home, "claude")),
    });
    const events = await collect(session.events);
    expect(events.at(-1)).toMatchObject({ type: "session.failed", code: "COMMAND_BLOCKED" });
  }, 15_000);

  it("fails clearly when the agent was not found", async () => {
    const session = await createCursorProvider().startSession({ prompt: "x", repoPath: "/tmp", profile, signal: new AbortController().signal });
    expect(await collect(session.events)).toEqual([expect.objectContaining({ type: "session.failed", code: "AGENT_NOT_INSTALLED" })]);
  });
});

describe("agent paths", () => {
  it("shows an absolute agent path relative to the open repository, including macOS /private", async () => {
    const { repoRelative } = await import("./providers.js");
    const event = repoRelative(
      { type: "tool.started", name: "edit", title: "Editing /private/tmp/r/src/a.ts", path: "/private/tmp/r/src/a.ts" },
      "/tmp/r",
    );
    expect(event).toMatchObject({ path: "src/a.ts", title: "Editing src/a.ts" });
    expect(repoRelative({ type: "tool.started", name: "edit", title: "x", path: "/etc/hosts" }, "/tmp/r")).toMatchObject({ path: "/etc/hosts" });
  });
});
