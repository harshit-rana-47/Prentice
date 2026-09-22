# Architecture

Prentice is one local user, one open git repository, and a browser workspace that talks only to a runtime on `127.0.0.1`.

```text
Browser workspace
        ↓
Next.js UI (apps/web)
        ↓
Hono runtime (apps/runtime) on 127.0.0.1:4731
        ↓
Local git repository
        ↓
Provider adapter, only when a real account is connected
        ↓
Vendor-hosted inference, when that provider requires it
```

The repository stays on this machine. Inference does not. Cursor cloud and Codex cloud are not used, because those clone the project onto another machine.

This file describes what the code does now. Update it when the architecture changes.

## Layout

- `packages/domain` holds the provider contract, routing, event normalizers, evidence rules, explain-back policy, and debug-issue detection. It does not import a vendor SDK.
- `apps/runtime` is a Hono process. It owns git, SQLite, account probes, provider adapters, Tree-sitter, and the HTTP API.
- `apps/web` is a Next.js client. It does not import the vendor SDKs, and it does not import `@prentice/domain`. The runtime returns the task view the UI needs, including `issues`.

`apps/web/next.config.ts` still lists `transpilePackages: ["@prentice/domain"]`. That setting does not make the package importable. Domain source uses `.js` specifiers for TypeScript files, and the Next bundler cannot resolve them. The client stays on JSON from the runtime.

## Browser to runtime

The runtime binds to `127.0.0.1`. On start it writes a new bearer token to `~/.prentice/runtime.json` with mode `0600`, and the home directory is `0700`. Every request except `/health` needs that bearer token and an `Origin` of `http://localhost:3000` or `http://127.0.0.1:3000`. CORS is that same allowlist.

The browser does not read `runtime.json`. `GET /api/local-session` on the Next server reads it, and only when the request `Host` is `localhost` or `127.0.0.1`.

Live activity is `GET /v1/tasks/:id/events` as SSE. The client also loads `GET /v1/tasks/:id` for the stored task. There is no general filesystem or shell endpoint. Workspace reads are `GET /v1/workspace`, `/v1/workspace/file`, and `/v1/workspace/diff`, and paths must stay inside the opened repository.

A hosted website talking to this runtime is out of scope.

## Task flow

1. `POST /v1/project` opens a git repository that already has at least one commit.
2. `POST /v1/tasks/analyze` classifies the prompt and returns a routing decision. The original prompt is stored and is what the provider receives.
3. The UI shows the decision. The user can keep it or override provider, intensity, or provider-maximum effort, then consents.
4. `POST /v1/tasks/:id/start` runs the adapter. Events are normalized, stored, and published on the SSE hub.
5. When the session completes, the runtime collects the git diff against the base commit, extracts symbols, and stores an understand artifact.
6. Explain-back is `POST /v1/tasks/:id/explain-back`, then answer or skip.
7. `POST /v1/tasks/:id/interrupt` aborts the in-process session. There is no resume endpoint.

The primary UI is the workspace at `/`. `/tasks/[id]` still renders the earlier task screen. Both read the same runtime task.

## Routing

The router is deterministic. It uses task intent, category, named technologies, named files, project structure, likely breadth, and whether the task touches architecture, data, auth, or tests. Prompt length can nudge a small task up one step only when the prompt also names files and more than one technology. It never raises complexity by itself.

Connected providers are scored by capability fit. A single connected provider is used. A pin or an explicit override wins. The fixture provider is the pool only when no real account is connected, unless the user overrides to it. Tests inject disconnected accounts so a host login cannot steal the fixture route.

Historical telemetry is stored in SQLite and is not applied. One run cannot move the router.

`fast` / `balanced` / `deep` / `maximum` is an internal intensity. Claude Code and Codex map it onto effort. Maximum maps to `xhigh`, not the provider's highest setting, unless the user explicitly asks for that. Cursor has model params such as `fast`, not the same effort scale. If the catalog cannot satisfy the preference, the note says Cursor is choosing depth.

## Normalized events and the activity stream

Adapters yield one event shape: session start and completion, status, assistant text, tool start and finish, file change, command start and finish, usage, failure, and interrupt. `toTimeline` turns that into the panel the UI shows. Git-confirmed file events replace an agent report for the same path. Long assistant text is kept in the session record and is not dumped into the timeline.

SSE subscribers receive events as they are stored. A client abort of that stream is not a task failure.

## Git and Tree-sitter

Git is the file-change record. After a session, the runtime diffs against the task's base commit. Agent `file.changed` events are activity. They do not define what changed.

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

Debug issues are computed in `publicTask` from the stored timeline and from the exact observed sentence `Tests reported N passed and M failed.` when `M` is greater than zero. An interrupt is a stop, not an issue. The UI shows the issue only when that list is non-empty.

The help ladder reveals stored text one step at a time. It does not invent a root cause or a fix. Levels 5 and 6 say none was recorded. This is the current task only. There is no engineering memory, retrieval index, or knowledge graph.

## Persistence

SQLite is Node's built-in `node:sqlite` at `~/.prentice/prentice.db`, WAL mode, behind one query module. The runtime starts with `--experimental-sqlite`. Tables cover projects, tasks, routing decisions, activity events, evidence packets, understand artifacts, explain sessions, telemetry, and settings.

Provider connection is the official local login: `claude auth status` / `claude auth login` / `claude auth logout`, `codex login status` / `codex login` / `codex logout`, and `Cursor.auth.status` / `login` / `logout` from `@cursor/sdk`. Prentice stores connection order. It does not ask for a pasted API key. A leftover secrets file is cleared on disconnect and is not the connection path. A missing Cursor package is treated as disconnected.

## Decisions that are in the code

**Local-first.** The repo, git, and session record stay on this machine. Vendor inference is hosted only when a connected provider needs it. A hosted multi-user service is not built.

**SQLite, not Drizzle.** Drizzle was the original plan. It was not added. The MVP is a handful of statements, and the built-in driver avoids a native SQLite addon.

**Provider adapters.** Domain defines the event shape and capabilities. Runtime adapters map each SDK into that shape. The UI and the learning flow do not branch on vendor payloads.

**Git as the change record.** Provider file events are not stable across tools. Codex reports some file changes. Claude and Cursor capabilities mark file-change events as not the record. The diff is.

**SSE.** The session is a stream of normalized events. SSE matches that without a second realtime service.

**Tree-sitter.** Symbol claims need a parse of the files that actually changed. A model summary is not that evidence. Languages other than TypeScript and JavaScript are left unparsed on purpose.

**Fixture provider.** With no connected account, the fixture writes `prentice-fixture/session-note.ts` and emits Prentice status events. It does not call a model. CI uses recorded event fixtures and does not call live providers.

**Not in this version.** RAG, a vector database, a persistent learning graph, hosted sync, multi-user learning, Redis, and BullMQ are not dependencies and have no code path. The editor is a read-only viewer of the repo and the diff, not the place the user is expected to write the change.
