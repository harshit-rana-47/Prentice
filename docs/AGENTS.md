# Agents

This file is the provider record. `apps/web/AGENTS.md` is the Next.js scaffold warning and is not a second source for how Codex, Claude Code, Cursor, or the fixture work.

Adapters implement `CodingAgentProvider`: capabilities, `authenticate`, and `startSession`. `startSession` returns an async stream of normalized events plus `interrupt` and `disconnect`. `providerFactory` selects `fixture`, `claude-code`, `codex`, or `cursor`.

Sessions do not receive an API key. `authenticate` on the adapters does not verify a pasted key. Account state comes from `AccountService`.

Capability flags live in `packages/domain/src/capabilities.ts`. Where the adapter does not actually do what the flag suggests, this file says so.

## Common behavior

- The prompt sent to a provider is the user's original prompt. The open repository is the session's working directory. Codex also receives that path as `developer_instructions`, and Claude Code receives it as an appended Claude Code system prompt. That sentence says the open directory is the project and that words like "this project" mean it. It does not include a file summary.
- Events are normalized before they are stored or streamed.
- Git, not the adapter, decides which files changed.
- A destructive command matching push, hard reset, `rm -rf`, sudo, mkfs, shutdown, reboot, or a curl/wget pipe to a shell is blocked for Claude in `canUseTool`, and fails the Codex turn if Codex reports that command. It is not retried.
- `describeProviderFailure` maps a missing SDK, an auth-looking error, and a network error onto `session.failed`. Other errors use `PROVIDER_ERROR`.
- Interrupt is `POST /v1/tasks/:id/interrupt`. Continue is a separate consented action, `POST /v1/tasks/:id/continue`. Codex resumes the stored thread for that conversation only. Claude Code and Cursor report that continuation is not available and do not start a new session under that name. A new task starts a new conversation and a new provider thread. One agent may modify a project's working tree at a time. Understand and Explain-back do not call these coding agents. Those steps use the Learning AI inside the connector and stay on the turn. The evidence for a turn is the content difference between the worktree snapshot taken before that turn and the snapshot taken after it. Leftover dirty or untracked files are not taught as this turn's work, and an edit to an already-dirty file is taught as only the lines that changed during the turn. Demonstrated concepts stay on the project.

## Claude Code

- Auth: `claude auth login`, `claude auth status`, `claude auth logout`. A missing CLI is a failed login job, not a connected account.
- SDK: `@anthropic-ai/claude-agent-sdk` `query`, loaded with a dynamic import. `cwd` is the open repo. The Claude Code preset system prompt is kept, with the open-repository sentence appended. `permissionMode` is `acceptEdits`. Effort is `nativeEffort` (`low` / `medium` / `high` / `xhigh`, or the provider max only when the user asks).
- Streaming: the SDK async iterable is normalized with `normalizeClaudeMessage`.
- Interrupt: abort the controller and call `handle.interrupt` when the SDK exposes it.
- File changes: capability `fileChangeEvents` is false. Git is the record.
- Read-only completion and usage are declared on the capability object. A separate no-tools prose call is **not currently supported** in the adapter. Usage events appear only if the normalizer emits them.
- Live behavior against a logged-in Claude account is **unverified** in this repository's tests. Tests use recorded events.

## Codex

- Auth: `codex login`, `codex login status`, `codex logout`. Prentice uses a `codex` binary on `PATH` when one exists. Otherwise it uses the CLI shipped with `@openai/codex`, which `@openai/codex-sdk` also spawns. No API key is passed.
- On this machine, `codex` was not on `PATH`. `login status` through the bundled CLI returned `Logged in using ChatGPT`. The runtime account probe then reported Codex connected.
- SDK: `@openai/codex-sdk` `0.156.1`. `new Codex()` with no key. `startThread` and `resumeThread` set `workingDirectory` to the open repository, `skipGitRepoCheck: false`, `modelReasoningEffort` from `codexEffort`, and `sandboxMode: "workspace-write"`. The Codex process also gets `developer_instructions` naming that repository as the open project. A `developer_instructions` value already in `~/.codex/config.toml` is kept in front of that sentence. The original prompt is passed unchanged to `runStreamed`. Prentice has no model picker. Automatic sessions pass a model from `codex debug models` with `visibility: "list"`, in catalog priority order, once each. They do not start from the model in `~/.codex/config.toml`. That configured slug is logged for diagnostics. An explicit Prentice model choice, when one exists, is sent alone. Rejected attempts are written to the runtime log. A status event names only the model that actually ran.
- Streaming: `thread.runStreamed(prompt, { signal })`, normalized with `normalizeCodexEvent`.
- A verified local session on 2026-09-23, in a disposable git repo, emitted `thread.started`, `turn.started`, `item.completed` `agent_message`, `item.started` and `item.completed` `file_change`, `command_execution`, `turn.completed` with `input_tokens` and `output_tokens`, then the runtime's git `file.changed`. `turn.started` is not shown. An in-progress `file_change` is not treated as a change. A completed `file_change` uses `changes: [{ path, kind }]`, and `kind` is `add`, `delete`, or `update`. The SDK sent an absolute path. The adapter stores it relative to the open repo.
- A completed `agent_message` is the user-facing reply and is shown in the conversation in full. `item.started` for that message is not shown, so a partial reply is not stored twice. A `reasoning` item is not stored and is not shown. `todo_list` and `web_search` are not shown. Commands and file changes stay compact activity.
- The task was "Create a file named hello.txt...". Git status showed `?? hello.txt`. The diff was one added line, `hello from prentice`. Understand reported that add, quoted the agent messages, and left inference empty. Explain-back asked what git recorded for `hello.txt` and accepted an answer that named the file.
- The app-server JSON-RPC API is not used.
- File-change events are activity. Git is still the record the understand flow uses. The timeline keeps the git line when both exist.
- Interrupt: `interrupt()` aborts the `AbortSignal` passed to `runStreamed`. A second live turn was stopped with `POST /v1/tasks/:id/interrupt` and the task status became `interrupted`. Continue calls `resumeThread` with the stored Codex thread id. If that thread is gone, the turn fails and Prentice does not start a different conversation.
- A recorded `command_execution` with `exit_code: 1` remains what the debug tests use. This live session's commands exited 0. Claude Code and Cursor live runs are still **unverified**.

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
- This is the path CI and `npm run dev` use when no real account is connected. `npm run connect` does not put the fixture in the routing pool.
