# Agents

This file is the provider record. `apps/web/AGENTS.md` is the Next.js scaffold warning and is not a second source for how Codex, Claude Code, Cursor, or the fixture work.

Adapters implement `CodingAgentProvider`: capabilities, `authenticate`, and `startSession`. `startSession` returns an async stream of normalized events plus `interrupt` and `disconnect`. `providerFactory` selects `fixture`, `claude-code`, `codex`, or `cursor`.

Sessions do not receive an API key. `authenticate` on the adapters does not verify a pasted key. Account state comes from `AccountService`.

Capability flags live in `packages/domain/src/capabilities.ts`. Where the adapter does not actually do what the flag suggests, this file says so.

## Common behavior

- The prompt sent to a provider is the user's original prompt.
- Events are normalized before they are stored or streamed.
- Git, not the adapter, decides which files changed.
- A destructive command matching push, hard reset, `rm -rf`, sudo, mkfs, shutdown, reboot, or a curl/wget pipe to a shell is blocked for Claude in `canUseTool`, and fails the Codex turn if Codex reports that command. It is not retried.
- `describeProviderFailure` maps a missing SDK, an auth-looking error, and a network error onto `session.failed`. Other errors use `PROVIDER_ERROR`.
- Interrupt is `POST /v1/tasks/:id/interrupt`. There is no resume API. `sessionContinuation: true` on the real providers is a router scoring flag only. Continuing a vendor thread is **not currently supported**.

## Claude Code

- Auth: `claude auth login`, `claude auth status`, `claude auth logout`. A missing CLI is a failed login job, not a connected account.
- SDK: `@anthropic-ai/claude-agent-sdk` `query`, loaded with a dynamic import. `cwd` is the open repo. `permissionMode` is `acceptEdits`. Effort is `nativeEffort` (`low` / `medium` / `high` / `xhigh`, or the provider max only when the user asks).
- Streaming: the SDK async iterable is normalized with `normalizeClaudeMessage`.
- Interrupt: abort the controller and call `handle.interrupt` when the SDK exposes it.
- File changes: capability `fileChangeEvents` is false. Git is the record.
- Read-only completion and usage are declared on the capability object. A separate no-tools prose call is **not currently supported** in the adapter. Usage events appear only if the normalizer emits them.
- Live behavior against a logged-in Claude account is **unverified** in this repository's tests. Tests use recorded events.

## Codex

- Auth: `codex login`, `codex login status`, `codex logout`.
- SDK: `@openai/codex-sdk`. `new Codex()` with no key. `startThread` sets `workingDirectory`, `skipGitRepoCheck: false`, `modelReasoningEffort` from `codexEffort`, and `sandboxMode: "workspace-write"`.
- Streaming: `thread.runStreamed(prompt)`, normalized with `normalizeCodexEvent`.
- The app-server JSON-RPC API is not used.
- File-change events are declared. Git is still the record the understand flow uses.
- Interrupt: `interrupt()` is an empty function. The generator checks `AbortSignal` between events and can yield `session.interrupted`, but it does not cancel the Codex thread. Treat reliable Codex interrupt as **not currently supported**.
- Live behavior against a logged-in Codex account is **unverified** here. A recorded `command_execution` with `exit_code: 1` is what the debug tests use.

## Cursor

- Auth: `Cursor.auth.login`, `Cursor.auth.status`, `Cursor.auth.logout` from `@cursor/sdk`. Status `logged-in` means connected. A missing package is disconnected and is not logged as a warning. The status probe times out after 8 seconds.
- Session: `Agent.create` with `local: { cwd }` and no `apiKey`. `agent.send(prompt)` then `run.stream()`. `Cursor.models.list()` picks a model. Fast intensity uses a catalog `fast` param when present. A stronger intensity uses another listed model id when present. Otherwise the note says Cursor is choosing depth. If the catalog call fails, the id `composer-2.5` is used.
- Interrupt: `run.cancel()` when `run.supports("cancel")` is true.
- Tool-call payloads are not read. `fileChangeEvents` is false. Git is the record.
- Requires Node.js 22.13 or newer, which is also the repo `engines` field.
- Cursor cloud is not used.
- Live behavior against a logged-in Cursor account is **unverified** here. The SDK is not installed in this runtime, so the account probe reports disconnected.

## Fixture

- No vendor call and no account. `authenticate` always succeeds locally.
- `startSession` writes `prentice-fixture/session-note.ts` exporting `attachSessionNote`, then yields `fixtureEvents`. Those events are status, not assistant text, so agent-stated claims stay empty.
- `interrupt()` is empty. The generator stops if the abort signal is set between events.
- No model selection, effort control, command events, usage, read-only completion, or session continuation.
- This is the path CI and the local demo use when no real account is connected.
