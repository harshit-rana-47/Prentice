# Agents

This file is the provider record. `apps/web/AGENTS.md` is the Next.js scaffold warning and is not a second source for how Codex, Claude Code, Cursor, or the fixture work.

Prentice does not ship any coding agent. The person installs Codex, Claude Code, or the Cursor CLI. `apps/connector/src/agents.ts` finds each one outside the shell PATH and resolves the program a task will run. Detection and execution use that same resolution (see ARCHITECTURE.md, Coding agents on the computer). Each agent is `not-installed`, `signed-out`, `ready`, or `error`.

Adapters implement `CodingAgentProvider`: capabilities, `authenticate`, and `startSession`. `startSession` returns an async stream of normalized events plus `interrupt` and `disconnect`. `providerFactory` selects `fixture`, `claude-code`, `codex`, or `cursor`.

Sessions do not receive an API key. `authenticate` on the adapters does not verify a pasted key. Account state comes from `AccountService`.

Capability flags live in `packages/domain/src/capabilities.ts`. Where the adapter does not actually do what the flag suggests, this file says so.

## Common behavior

- The prompt sent to a provider is the user's original prompt. The open repository is the session's working directory. Codex also receives that path as `developer_instructions`, and Claude Code receives it as an appended Claude Code system prompt. That sentence says the open directory is the project and that words like "this project" mean it. It does not include a file summary.
- Events are normalized before they are stored or streamed.
- Git, not the adapter, decides which files changed.
- A destructive command matching push, hard reset, `rm -rf`, sudo, mkfs, shutdown, reboot, or a curl/wget pipe to a shell ends the turn when the agent reports it, with `COMMAND_BLOCKED`. It is not retried. Claude Code also gets `--disallowedTools` deny rules for the common prefixes. The agent's own sandbox is the control that can stop a command before it runs.
- A sign-in problem is `AGENT_SIGNED_OUT`. It is a setup state, not an agent reply and not a Debug issue. A missing agent is `AGENT_NOT_INSTALLED`. An agent that cannot be started is `AGENT_UNAVAILABLE`. Other errors use `PROVIDER_ERROR`.
- A failed command keeps a bounded slice of its own output for Debug. A successful command keeps none.
- Interrupt is `POST /v1/tasks/:id/interrupt`. Continue is a separate consented action, `POST /v1/tasks/:id/continue`. Codex resumes the stored thread for that conversation only. Claude Code and Cursor report that continuation is not available and do not start a new session under that name. A new task starts a new conversation and a new provider thread. One agent may modify a project's working tree at a time. Understand and Explain-back do not call these coding agents. Those steps use the Learning AI: the connector builds the evidence summary, and the Prentice cloud calls Groq. They stay on the turn. The evidence for a turn is the content difference between the worktree snapshot taken before that turn and the snapshot taken after it. Leftover dirty or untracked files are not taught as this turn's work, and an edit to an already-dirty file is taught as only the lines that changed during the turn. Demonstrated concepts stay on the project.

## Claude Code

- Integration: the Claude Code CLI the person installed, run headless: `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,MultiEdit,Glob,Grep,LS,NotebookEdit,TodoWrite --disallowedTools <deny rules> --append-system-prompt <open-repository sentence> --effort <level>`. The prompt goes on stdin. The binary is not modified and is not bundled. Anthropic documents this mode as the Agent SDK's CLI form.
- Auth: Prentice reads `claude auth status` (JSON `loggedIn`). It does not start `claude auth login` and never handles credentials. A signed-out Claude Code shows "Open Terminal on this computer, run claude, and sign in with /login." Anthropic's terms say sign-in must complete through Anthropic's own flow, and a third party must not offer Claude.ai login in its own app. Prentice also does not sign Claude Code out.
- Streaming: `createClaudeStreamNormalizer` pairs each Bash `tool_use` with its `tool_result`, reads `Exit code N`, and keeps a failed command's bounded output. Claude Code reports a missing sign-in as a synthetic assistant reply ("Not logged in · Please run /login"). That becomes one `AGENT_SIGNED_OUT` failure, not an agent reply.
- Interrupt: SIGINT, so Claude Code can end the turn, then SIGTERM after 4 seconds, then SIGKILL. The child is not detached, so it does not outlive the connector.
- Verified on 2026-09-28 with Claude Code 2.1.283 from the official installer in `~/.local/bin`: discovery under the Finder PATH, `signed-out` state, and a real headless run while signed out, which gave exactly one `AGENT_SIGNED_OUT` and no agent reply. All flags above were accepted. An authenticated run is **unverified**: no Claude account was signed in.
- Continuation stays unavailable. The CLI has `--resume`, but a live resume has not been verified.

## Codex

- Auth: `codex login`, `codex login status`, `codex logout`, run through the same resolved native binary a task uses. No API key is passed.
- Discovery: a Homebrew or standalone `codex` is used as is. An npm `codex`, a Node launcher, is resolved to the native binary in `@openai/codex-<platform>/vendor/<triple>/bin/codex`. The Codex SDK, bundled into the connector, gets that binary through `codexPathOverride`. The SDK's own lookup found a binary only inside the monorepo.
- Verified on 2026-09-28 from the packaged app outside the repo, under the Finder PATH, with `@openai/codex` installed to `~/.npm-global`: `ready` (the existing ChatGPT login was reused), a real task through the relay (a real `ERR_INVALID_PACKAGE_CONFIG` failure with its bounded output in Debug), Explain-back, Continue in the same thread, Stop to `interrupted`, and a connector crash mid-turn that left no Codex process and no further edits.
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

- Integration: the official Cursor CLI (`agent`, legacy `cursor-agent`), from `curl https://cursor.com/install -fsS | bash`, which installs to `~/.local/bin`, or the Windows PowerShell installer, which installs to `%LOCALAPPDATA%\cursor-agent`. Prentice runs `agent -p --output-format stream-json --force --trust --workspace <repo> <prompt>`. The CLI runs its own bundled Node, so no Cursor native code loads into the connector. The `@cursor/sdk` native addon crashed Node 22.13.0 with SIGSEGV. That crash path is gone.
- The Cursor editor's sign-in is not shared with the CLI. A person with only Cursor.app sees "The Cursor CLI is not installed".
- Auth: `agent status --format json` (`isAuthenticated`), `agent login` (opens Cursor's page on this computer), `agent logout`. Prentice does not pass `--api-key` and does not store a key.
- Streaming: `createCursorStreamNormalizer` reads `system/init`, `assistant`, `tool_call` started and completed, and `result`. From tool payloads it reads only the shell command, `exitCode`, and a failure's stdout and stderr. Absolute paths are shown relative to the repository.
- Model: Prentice does not choose one. Cursor chooses the model and depth.
- Interrupt: SIGINT, then SIGTERM, then SIGKILL. The CLI also starts its own long-lived `worker-server` process. That process is Cursor's, is not a Prentice child, and did not edit the repository after an interrupt.
- Verified on 2026-09-28 with CLI 2026.09.26-dd393fe, from the packaged app outside the repo and under the Finder PATH: `signed-out` and then `ready`, a real task (git-confirmed `multiply`, `npm test` exit 1 with its bounded output in Debug, tests 1 passed and 1 failed read from the runner), interrupt to `interrupted` in about 1 second with no further edits, Understand and Explain-back through the Learning AI, and Continue refused with a clear message.
- Continuation stays unavailable.

## Fixture

- No vendor call and no account. `authenticate` always succeeds locally.
- `startSession` writes `prentice-fixture/session-note.ts` exporting `attachSessionNote`, then yields `fixtureEvents`. Those events are status, not assistant text, so agent-stated claims stay empty.
- `interrupt()` is empty. The generator stops if the abort signal is set between events.
- No model selection, effort control, command events, usage, read-only completion, or session continuation.
- This is the path CI and `npm run dev` use when no real account is connected. `npm run connect` does not put the fixture in the routing pool.
