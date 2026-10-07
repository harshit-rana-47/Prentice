# Architecture

Prentice is a hosted learning experience with local-first development. A signed-in user opens the Prentice website, pairs this computer, and the coding work stays on that computer.

```text
Browser on the Prentice website
        ↓
Prentice cloud (accounts, pairing, relay)
        ↓
Outbound relay
        ↓
Local connector (apps/connector)
        ↓
Local git repository
        ↓
Provider adapter, only when a real account is connected
        ↓
Vendor-hosted inference, when that provider requires it
```

`npm run dev` is the development setup. The website talks to the connector's HTTP adapter on `127.0.0.1`. It also starts a loopback cloud so Understand and Explain-back have the Learning AI (see Learning AI in development).

The repository stays on this machine. Inference does not. Cursor cloud and Codex cloud are not used, because those clone the project onto another machine.

This file describes what the code does now. Update it when the architecture changes.

## Layout

- `packages/domain` holds the provider contract, routing, event normalizers, evidence rules, explain-back policy, and debug-issue detection. It does not import a vendor SDK.
- `packages/protocol` holds the versioned request, response, and event frames for the current `/v1` workspace routes. It does not import `@prentice/domain`, and its source does not use `.js` specifiers, so the Next bundler can load it. The dev HTTP adapter still validates those calls itself. The outbound relay client parses the same frames. `/health` stays a local bind check and is not a frame.
- `apps/connector` is the local connector. It owns git, SQLite, account probes, provider adapters, Tree-sitter, and the in-process connector API. Dev HTTP is an adapter over that API and starts only when `PRENTICE_DEV_HTTP=1`. `npm run dev` sets that flag, starts the website, and opens `http://127.0.0.1:3000`. With `PRENTICE_CLOUD_URL` and no saved device token, a localhost pairing page can still accept the code from the website. During `npm run dev` that page is not opened. It is opened only when the connector is started without dev HTTP and still needs a pairing code. An outbound WebSocket client then speaks `@prentice/protocol`.
- `apps/cloud` is the control plane. Prentice accounts are Supabase Auth users. Paired devices, pairing codes, and project display names are in the Prentice Supabase Postgres project. The relay forwards protocol frames in memory and does not store them. `npm run dev` does not start the cloud process.
- `apps/web` is a Next.js client. It does not import the vendor SDKs, and it does not import `@prentice/domain`. The signed-in site uses a Supabase magic link, then the same workspace over the relay. `NEXT_PUBLIC_PRENTICE_DEV_LOCAL=1` keeps the local token path for development. The runtime returns the task view the UI needs, including `issues`.

`apps/web/next.config.ts` still lists `transpilePackages: ["@prentice/domain"]`. That setting does not make the package importable. Domain source uses `.js` specifiers for TypeScript files, and the Next bundler cannot resolve them. The client stays on JSON from the runtime.

## Local connector

`createConnector` in `apps/connector/src/connector.ts` is the in-process API. `server.ts` is the dev HTTP adapter over it: bearer auth, the origin check, CORS, JSON status codes, and SSE framing. The connector validates input and calls git, the store, accounts, and the session. A caller in this process does not present the bearer token.

`npm run dev` and `npm start` set `PRENTICE_DEV_HTTP=1`, so the browser still reaches the connector through HTTP on `127.0.0.1`. The token file remains `~/.prentice/runtime.json`. `npm run connect` does not set that flag, so it does not open the HTTP port. It dials `PRENTICE_CLOUD_URL` and opens the pairing page when this computer still needs a code. That process also leaves the fixture provider out of routing.

`npm run package:mac` and `npm run package:win` build the desktop apps. Each bundles the connector (including the Codex SDK library) and a pinned Node runtime, Node 24.21.0 LTS, downloaded from nodejs.org and checked against its published SHA-256. The Mac app carries a universal arm64 + x86_64 binary. Only the Tree-sitter N-API addons ship as native modules. The app never loads anything from the monorepo's `node_modules`. Coding agents are not bundled. The Mac app copies itself to `~/Applications` and registers a Login Item. The Windows app copies itself to `%LOCALAPPDATA%\Prentice` and registers a sign-in task. Both configs contain the cloud and website addresses only. They use the same pairing page and relay client. A paired computer reconnects without a new code. The website asks the app to open the system folder dialog instead of accepting a typed path. The Windows package is 64-bit.

The connector generates an Ed25519 device key on first launch. On macOS the private key is written to the login keychain (`prentice-device-key`) first, and the `security` CLI receives it as an argument. On Windows it is written to Credential Manager through PowerShell, with the secret on stdin. `~/.prentice/device.json` is written only after that succeeds, and it stores the device id and public key.

`connectRelay` dials outward and answers protocol request frames, including `workspace.get` for the workspace snapshot. It does not open an inbound port for the workspace. `tasks.events` becomes event frames with the same task payload the dev HTTP stream sends. If `PRENTICE_CLOUD_URL` is set, the connector reuses the device token saved in the operating system's credential store. Without one, it serves a small page on `127.0.0.1:4732` where the user enters the pairing code. That page is not the workspace. `npm run dev` leaves it closed and opens the website instead. A connector started without dev HTTP still opens the pairing page when a code is required. `PRENTICE_PAIRING_CODE` still pairs without the page. A pairing failure does not stop dev HTTP.

A relay on localhost may use `ws`. Any other host must be `wss`. If the socket drops, the connector redials with jittered backoff. Only the close code `REVOKED` (4001) means the device credential is gone: the connector then stops dialing, deletes the device token from secure storage, and opens the pairing page. Every other close redials, including an auth timeout or a relay-side database or auth error. A result that cannot be sent is logged as undelivered. It is not treated as a completed delivery.

## Coding agents on the computer

Prentice does not ship Codex, Claude Code, or Cursor. The person installs them. `apps/connector/src/agents.ts` finds each one and resolves the exact program a task will run. The status check and the task use that same resolution.

A packaged app started from Finder, a Login Item, or Windows startup gets a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS). Discovery therefore searches PATH, then the official installer and package-manager locations: `~/.local/bin`, `~/.claude/local`, Homebrew, npm and `~/.npm-global`, bun, volta, pnpm, yarn, asdf, mise, nvm and fnm version directories, and on Windows `%LOCALAPPDATA%\cursor-agent`, `%APPDATA%\npm`, scoop and WinGet. A PATH read once from the login shell, with a 3-second timeout, adds places to look. Discovery does not depend on it.

- Codex: the npm `codex` command is a Node launcher. Prentice resolves it to the native binary in its platform package, so no `node` is needed on PATH. A Homebrew or standalone `codex` is already native. The Codex SDK gets that binary through `codexPathOverride`, plus an environment whose PATH includes the binary's own `codex-path` directory.
- Claude Code: the `claude` program the person installed.
- Cursor: the official Cursor CLI, `cursor-agent` or `agent`. A program named `agent` counts only when it resolves into the Cursor CLI install. On Windows the `.cmd` shim is resolved to the CLI's bundled `node.exe` and `index.js`, so a prompt is never parsed by a shell.

Each agent has four states, read from its own status command: `not-installed`, `signed-out` (installed, the agent says it is not signed in), `ready`, and `error` (Prentice could not start it or read its status). Codex uses `codex login status`, Claude Code `claude auth status`, Cursor `agent status --format json`. States are cached for 15 seconds. A run that reports a missing sign-in clears the cache. Only `ready` agents are routed.

## Cloud control plane

`apps/cloud` binds to `PRENTICE_CLOUD_HOST` or `127.0.0.1`, on `PORT` or `PRENTICE_CLOUD_PORT` or `4740`. A public relay sets the host to `0.0.0.0` and puts TLS in front so browsers and connectors use `https` and `wss`. It reads `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, and `GROQ_API_KEY` from the environment or the repo `.env`. The Groq key stays in that process. Browser origins are `PRENTICE_WEB_ORIGINS`. A browser session is a Supabase access token. `POST /v1/pairing-codes` issues a short-lived code for that account. `POST /v1/devices/pair` binds a device id and public key and returns a device token. The token is stored only as a hash in `prentice_private`. `POST /v1/learning` accepts that device token and the evidence summary, calls Groq, and returns the teaching text. It does not write the summary or the reply.

The relay has two WebSocket paths, `/relay/connector` and `/relay/browser`. Each socket sends an `auth` frame before any workspace frame. The relay checks the Supabase access token and that the device belongs to that account, then forwards request frames to the connector and response and event frames back to the browser. It does not write those frames. If the connector drops while a request is waiting, the browser receives `DEVICE_OFFLINE` instead of a success.

Close codes are in `RELAY_CLOSE` in `@prentice/protocol`:

- `REVOKED` 4001: unknown or revoked device, or a browser asking for a device that is not its own.
- `SESSION_EXPIRED` 4002: the browser's access token was refused. The browser refreshes its Supabase session and redials. If no fresh token is available, or three refreshed tokens are refused, the page says the sign-in ended.
- `AUTH_TIMEOUT` 4008: no auth frame arrived within 5 seconds.
- `TEMPORARY` 4500: the relay could not check the credential because of a database or auth-service error.

The relay sends each browser a `presence` frame, `{ online }`, when the browser authenticates and whenever that computer's connector connects or drops. When the computer comes back, the browser re-subscribes to every task it shows and refreshes the page state. It does this without clearing an unsent draft. The relay pings every socket every 25 seconds and closes one that did not answer the previous ping. The connector also sends a `ping` frame every 25 seconds.

A task stream is one subscription per task per connector connection. Watching again sends the current task once, not once per stored event. Updates within 150 ms are sent as one frame. A subscription ends on `tasks.unwatch` (`DELETE /v1/tasks/:id/events`), which the page sends when it stops showing a task, and it ends when the task stops running. Browser requests time out after 30 seconds, and choosing a folder after 6 minutes. A request to a computer known to be offline fails immediately. When a background tab becomes visible, or the network comes back, the page redials at once instead of waiting out a throttled backoff. `DELETE /v1/devices/:id` revokes that device, deletes its token hash, and closes its live socket. Pairing the same device again with a new code clears `revoked_at` and inserts a new credential. A pairing error says whether the code was unknown, already used, or expired. `POST /v1/projects` accepts a display name only and rejects repository contents.

The signed-in website opens `/relay/browser` and sends the same workspace calls as protocol frames. It uses the one active device for the account. The connector's own SQLite file remains the local learning record. The browser does not read the repository.

Understand and Explain-back are a separate Learning AI. The connector builds the evidence summary. A paired computer sends that summary to `POST /v1/learning`. The summary has two parts. `observed` holds git files, Tree-sitter symbols, commands with exit codes, a failed command's output (1,500 characters at most, marked `command-output`), a test-runner summary, and session failures. `agentStated` holds at most 6 agent messages, each capped at 600 characters and 3,000 in total, each labelled Agent stated. The original prompt, file contents, and diffs are not sent. The Learning AI returns `observed`, `agentStated`, and `notRecorded` sentences. The connector moves an observed sentence into Agent stated when it relies on a detail found only in the agent's words, such as a quoted value, a comparison like `8 !== 2`, or a number. It drops a sentence that names a path Prentice did not record. The cloud allows 120 Learning AI calls per computer per 10 minutes and gives Groq 30 seconds. The cloud calls Groq with `GROQ_API_KEY`, default model `openai/gpt-oss-120b`, and returns the text. The key is not a `NEXT_PUBLIC_` value and is not read by the website or the connector. If the computer is not paired, or Groq cannot be reached, the connector shows the recorded evidence and says the Learning AI is unavailable. Codex, Claude Code, and Cursor are not asked to teach. Prentice does not ship those agents. It looks for them on the computer and says when one still needs to be installed or connected.

### Learning AI in development

`npm run dev` (`scripts/dev.mjs`) starts the connector, the website, and the cloud on `127.0.0.1:4740`. It creates a random `PRENTICE_DEV_LEARNING_TOKEN` for that run and gives it to both processes. The cloud accepts that token on `/v1/learning` only when it is bound to loopback. An unpackaged dev-HTTP connector that is not paired uses it. The Groq key stays in the cloud process. A production cloud never sets the token, and a packaged connector ignores it.

## Hosted backend

The hosted database and Prentice account login are a Supabase project: Postgres plus Supabase Auth. The Next.js app can be deployed on Vercel. `/download/mac` and `/download/windows` redirect to `PRENTICE_DOWNLOAD_BASE_URL` (object storage, a CDN, or a release page). In production they never serve a zip from the web server's filesystem. Local development still serves `dist/`. The relay stays a long-lived Prentice process, because Supabase Realtime is a database and broadcast channel, not a private socket between one browser and one connector.

The schema lives in `supabase/migrations` and is applied to the hosted Prentice project. The cloud process reads that project from `.env`. `npm run dev` still starts only the connector and the website. The connector's own SQLite file (`~/.prentice/prentice.db`) stays the local learning record. Tasks, prompts, diffs, evidence, and explain-back answers are not moved to Supabase.

A signed-in user can read their own device names through row-level security. Token hashes and pairing codes have row-level security and no client policy, and they are not in the Data API. GitHub sign-in stays disabled until `SUPABASE_AUTH_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_GITHUB_SECRET` are set. The website gets the publishable key. The connector gets neither key.

A browser frame carries the current Supabase access token and a device id. A connector frame carries the device token from pairing. Access tokens expire, so the browser sends a fresh one when it reconnects. Pairing stays an action of the cloud process. Project metadata remains a display name, an opaque id, and the owning device. Device private keys and provider credentials stay in the operating system's credential store.

Production security for this phase is TLS on the relay connection, plus the rule that the cloud does not store repository contents. The relay process can still see a frame while it forwards it. End-to-end encryption of those frames is not part of this phase.

## In-process connector

The dev HTTP adapter and the relay client share one store, one account service, and one event hub when both are enabled.

## Browser to runtime

The runtime binds to `127.0.0.1`. It writes a new bearer token to `~/.prentice/runtime.json` with mode `0600` only after the port accepts connections. The home directory is `0700`. A failed bind leaves the existing token file alone. Every request except `/health` needs that bearer token and an `Origin` of `http://localhost:3000` or `http://127.0.0.1:3000`. CORS is that same allowlist.

The browser does not read `runtime.json`. `GET /api/local-session` on the Next server reads it, and only when the request `Host` is `localhost` or `127.0.0.1`.

Live activity is `GET /v1/tasks/:id/events` as SSE. The client also loads `GET /v1/tasks/:id` for the stored task. There is no general filesystem or shell endpoint. Workspace reads are `GET /v1/workspace`, `/v1/workspace/file`, and `/v1/workspace/diff`, and paths must stay inside the opened repository.

The product website does not use this token file. It reaches the connector through the relay. The token file remains the development path.

## Task flow

1. `POST /v1/project` opens a git repository that already has at least one commit.
2. `POST /v1/tasks/analyze` classifies the prompt and returns a routing decision. The original prompt is stored and is what the provider receives.
3. Sending a message records consent and starts the task. Before the first message of a new conversation, the user can override provider, intensity, or provider-maximum effort. The conversation is created only when the start succeeds, so a start refused as busy leaves no empty chat.
4. `POST /v1/tasks/:id/start` runs the adapter. Events are normalized, stored, and published on the SSE hub.
5. When the session completes, the runtime compares the worktree snapshot taken before the turn with the snapshot taken after it. That difference is the understand evidence. Symbols come from those two texts.
6. Explain-back is `POST /v1/tasks/:id/explain-back`, then answer or skip.
7. `POST /v1/tasks/:id/interrupt` aborts the in-process session. A stopped run, and a run that was still going when the connector exited, carries `recovery: { kind: "send-again", prompt }`. The page offers Send Again, which puts the prompt in a new conversation without running it. It also says that files the agent already changed are still in the working tree. `POST /v1/tasks/:id/continue` resumes a Codex thread for the same conversation. Claude Code and Cursor report that continuation is unavailable and do not start a replacement session.

The primary UI is the workspace at `/`. `/tasks/[id]` still renders the earlier task screen. Both read the same runtime task.

## Routing

The router is deterministic. It uses task intent, category, named technologies, named files, project structure, likely breadth, and whether the task touches architecture, data, auth, or tests. Prompt length can nudge a small task up one step only when the prompt also names files and more than one technology. It never raises complexity by itself.

Connected providers are scored by capability fit. A single connected provider is used. A pin or an explicit override wins. In local development the fixture provider is the pool only when no real account is connected. A connector started with `npm run connect` leaves the fixture out, so a task requires Codex, Claude Code, or Cursor. Tests inject disconnected accounts and still allow the fixture so a host login cannot steal the fixture route.

Historical telemetry is stored in SQLite and is not applied. One run cannot move the router.

`fast` / `balanced` / `deep` / `maximum` is an internal intensity. Claude Code and Codex map it onto effort. Maximum maps to `xhigh`, not the provider's highest setting, unless the user explicitly asks for that. Cursor has model params such as `fast`, not the same effort scale. If the catalog cannot satisfy the preference, the note says Cursor is choosing depth.

## Normalized events and the activity stream

Adapters yield one event shape: session start and completion, status, assistant text, tool start and finish, file change, command start and finish, usage, failure, and interrupt. `toTimeline` turns that into the panel the UI shows. Git-confirmed file events replace an agent report for the same path. Long assistant text is kept in the session record and is not dumped into the timeline.

SSE subscribers receive events as they are stored. A client abort of that stream is not a task failure.

## Git and Tree-sitter

Git is the file-change record. After a session, the runtime diffs the before and after worktree snapshots. It falls back to the base commit only when a snapshot is missing. Agent `file.changed` events are activity. They do not define what changed.

Tree-sitter parses TypeScript, TSX, and JavaScript with the Node bindings, not WASM, because those bindings load the grammars in this process. It compares function and class names before and after. Other files stay at path and diff size, and the understand notes say they were not parsed. If Tree-sitter fails to load, those files stay at file level too.

## Understand

`assembleUnderstand` builds three separate lists:

- Observed: git files, Tree-sitter symbols, commands, tests.
- Agent stated: text the coding agent actually emitted.
- Prentice inference: a claim that cites an evidence id in the packet. Claims without a valid citation are rejected.

A change map is a directory grouping. It is omitted when fewer than two files changed or those files sit in one directory. Before/after architecture diagrams are not generated. The artifact says they are omitted unless a later analysis can derive them. The fixture writes one file, so it has no map and no diagram.

The UI can open a cited path as a file or a unified diff. The editor stays read-only.

## Explain-back

Questions come from the evidence packet: added or changed symbols, then a git file change, then a recorded test result, up to the policy cap.

- Tiny: at most one question, skip allowed (`low` complexity, at most 2 files and 3 symbols).
- Moderate: at most 2 initial questions and 2 follow-ups.
- Deep: at most 4 initial questions and 3 follow-ups (`high` complexity, or at least 6 files, or at least 8 symbols).

A follow-up is asked only when the answer misses a point that is in the evidence. Feedback is the lists "You understand" and "Still unclear". There is no numeric score. The first added-symbol question asks which new symbol was added and does not print the name in the prompt.

## Debug

Debug issues are computed in `publicTask` from the stored timeline and from the exact observed sentence `Tests reported N passed and M failed.` when `M` is greater than zero. An interrupt is a stop, not an issue. Setup failures are not issues either: `AGENT_SIGNED_OUT`, `AGENT_NOT_INSTALLED`, `AGENT_UNAVAILABLE`, `CONTINUATION_UNAVAILABLE`, `SESSION_ENDED`, and `RUNTIME_DISCONNECTED`. The UI shows the issue only when that list is non-empty.

A failed command keeps a bounded slice of its own stdout and stderr, as the agent's tool run reported it. Codex supplies `aggregated_output`, Claude Code the Bash `tool_result`, and Cursor the shell tool result. `boundFailureOutput` keeps the last 80 lines and 4,000 characters, strips terminal colour codes, and redacts common secret shapes. A command that succeeded keeps no output. Debug shows the slice as Command output and says when earlier lines were cut. When that output contains a test runner's own pass and fail counts (node:test, vitest, jest, pytest), the evidence packet records the counts as observed test results.

The help ladder reveals stored text one step at a time. It does not invent a root cause or a fix. Levels 5 and 6 say none was recorded. This is the current task only. There is no engineering memory, retrieval index, or knowledge graph.

## Persistence

SQLite is Node's built-in `node:sqlite` at `~/.prentice/prentice.db`, WAL mode, behind one query module. The runtime starts with `--experimental-sqlite`. Tables cover projects, tasks, routing decisions, activity events, evidence packets, understand artifacts, explain sessions, telemetry, and settings.

A project row is one git repository. Opening a path uses the repository root, then the on-disk path, so a different capitalization or a symlink to that directory is the same project. Its tasks stay on that row. A conversation is a stable record on that project. Its turns are the task chain, titled by the first prompt. The project remembers which conversation is selected. Switching repositories changes the working tree and which conversations are listed. Conversations in one project share that working tree. Understand and Explain-back compare the worktree snapshot taken before the turn with the snapshot taken after it. Line counts and symbols come from that pair. A file that was already dirty, or already untracked, is included only for the content that changed during the turn. When both snapshots exist, Prentice does not teach the diff against the last commit. One coding agent may run in a project at a time. Concepts already demonstrated stay on the project.

Provider connection is each agent's own sign-in on this computer. Codex uses `codex login status` / `codex login` / `codex logout`, and Cursor uses `agent status` / `agent login` / `agent logout`. Prentice can start those official sign-ins, and they open the vendor's page on this computer. Claude Code sign-in stays in Anthropic's own flow: Prentice only reads `claude auth status` and tells the person to run `claude` and `/login`. It never starts, stores, or intermediates that sign-in. Prentice stores connection order. It does not ask for or store a coding-agent API key. A leftover secrets file is cleared on disconnect and is not the connection path.

## Decisions that are in the code

**Hosted learning, local work.** Sign-in, pairing, and the live relay are the Prentice cloud. The repo, git, and session record stay on the user's computer. Supabase stores the account, device registry, and project display name. It does not store the repository, prompts, or explain-back answers. Vendor inference is hosted only when a connected provider needs it.

**SQLite, not Drizzle.** Drizzle was the original plan. It was not added. The MVP is a handful of statements, and the built-in driver avoids a native SQLite addon.

**Provider adapters.** Domain defines the event shape and capabilities. Runtime adapters map each SDK into that shape. The UI and the learning flow do not branch on vendor payloads.

**Git as the change record.** Provider file events are not stable across tools. Codex reports some file changes. Claude and Cursor capabilities mark file-change events as not the record. The diff is.

**SSE.** The session is a stream of normalized events. SSE matches that without a second realtime service.

**Tree-sitter.** Symbol claims need a parse of the files that actually changed. A model summary is not that evidence. Languages other than TypeScript and JavaScript are left unparsed on purpose.

**Fixture provider.** Local development, with no connected account, writes `prentice-fixture/session-note.ts` and emits Prentice status events. It does not call a model. The hosted connector command does not offer that provider. CI uses recorded event fixtures and does not call live providers.

**Not in this version.** RAG, a vector database, a persistent learning graph, repository sync, Redis, and BullMQ are not dependencies and have no code path. The editor is a read-only viewer of the repo and the diff, not the place the user is expected to write the change. One computer is connected. There is no device picker.
