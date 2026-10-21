# Coding agents

Prentice does not ship coding agents. Users install Codex, Claude Code, or the Cursor CLI and sign in through the vendor's supported flow. `apps/connector/src/agents.ts` resolves each executable for both discovery and execution, including installations outside the shell PATH. Agent state is `not-installed`, `signed-out`, `ready`, or `error`.

Adapters implement `CodingAgentProvider` in `packages/domain`: `startSession` returns normalized events, `interrupt`, and `disconnect`. `providerFactory` selects the adapter. Capability flags in `packages/domain/src/capabilities.ts` describe the implemented integration, rather than everything the vendor supports.

## Shared behavior

- The open repository is the working directory. A validated active-file path and the user's original request are passed as editor context and prompt. Codex and Claude Code also receive an instruction identifying the open repository. Prentice does not invent a file summary.
- Only ready agents are routed. An explicitly chosen unavailable agent is refused rather than silently replaced. One coding task may modify a project's working tree at a time.
- Events are normalized before storage and streaming. Git's before/after worktree snapshots determine the change attributable to a turn; pre-existing dirty files are not taught as that turn's work.
- A reported destructive command matching Prentice's deny rules ends the turn with `COMMAND_BLOCKED`. Event inspection occurs after the agent reports a command; it is not a substitute for the agent's sandbox. Claude Code also receives tool deny rules.
- Failed commands retain bounded, redacted output for Debug. Successful commands do not retain output. Missing installation and sign-in are setup states, not Debug failures.
- Understand and Explain-back use the separate Learning AI through Prentice cloud. They do not invoke coding agents. Detailed transcripts and assessment proof remain local; approved summary fields may synchronize.
- Disconnect affects Prentice's connection state, preserving the vendor's credentials. Claude sign-in stays external; Prentice never handles Claude credentials. Prentice does not collect coding-agent API keys; the agent can still read its own vendor configuration.
- Prentice's Groq, Supabase, database, and development/device tokens are removed from the environment passed to agent execution and login/status subprocesses. Vendor configuration remains available.

See [ARCHITECTURE.md](ARCHITECTURE.md) for account isolation, relay authorization, evidence boundaries, and process lifetime.

## Codex

The adapter uses `@openai/codex-sdk`. It starts or resumes a saved thread with the open working directory, Git checks enabled, and `workspace-write` sandboxing. The SDK launches the discovered native Codex executable through Prentice's process guardian. An npm installation is resolved from its Node launcher to the platform package's native executable.

Authentication uses `codex login` and `codex login status`. Automatic model selection tries visible models from `codex debug models` in catalog order; an explicit choice, when supplied, is sent alone. The configured reasoning effort is forwarded.

Completed agent messages are shown in full. Reasoning events, todo lists, and web-search events are not stored as replies. Provider file-change events are activity; Git remains the change record. Command exit status and bounded failure output are normalized separately.

Continue resumes the recorded thread. If it is unavailable, Prentice reports failure rather than starting a replacement conversation. Stop aborts the SDK request and stops the guarded process group.

## Claude Code

The installed CLI runs headlessly with `claude -p --output-format stream-json --verbose`, edit permissions, the supported tool allowlist and destructive-command deny rules, an open-repository system instruction, and the selected effort. The prompt is supplied on stdin. The executable is neither modified nor bundled.

Authentication is inspected through `claude auth status`. Signed-out users are directed to run Claude in Terminal and use its own login flow. Prentice does not sign Claude Code in or out.

The normalizer pairs Bash tool uses with results and recognizes a missing-login assistant reply as setup failure. Continue uses the recorded session with `--resume`; it retains Claude Code as the provider. Model selection is not implemented by this adapter.

## Cursor

Prentice uses the official Cursor CLI (`agent`, or legacy `cursor-agent`), not the Cursor editor or a native SDK addon. Tasks run with print/stream-JSON output, force/trust flags, and the selected workspace. On Windows the command shim is resolved to the CLI's bundled Node executable and entry point, keeping the prompt outside shell parsing.

Authentication uses `agent status --format json` and `agent login`. The editor's sign-in does not establish CLI sign-in. Cursor chooses its model and depth. The normalizer reads initialization, assistant, tool-call, and result events; shell failures retain bounded output.

Continuation is unavailable. Prentice refuses it rather than substituting a new session.

## Development fixture

The fixture writes `prentice-fixture/session-note.ts` and emits normalized fixture status events without vendor calls or authentication. It does not supply model selection, effort control, command events, usage, or continuation. Local development uses it only when no real account is connected; `npm run connect` excludes it from routing.

## Verification boundaries

Provider contract tests use recorded events and fake executables. Opt-in live tests require an installed, authenticated agent and may modify a disposable repository. A passing contract test does not establish vendor behavior on every version or platform.

On macOS/POSIX the native guardian owns a dedicated session/process group and escalates Stop from SIGINT to SIGTERM to SIGKILL. Connector death closes the owner channel. A descendant deliberately escaping that group is outside this guarantee. The Windows Job Object implementation requires execution on Windows; signing, installation, upgrade, and process containment must be validated on the target OS before release. See [WINDOWS_INSTALLER.md](WINDOWS_INSTALLER.md).
