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
- `packages/protocol` holds the versioned request, response, and event frames for the current `/v1` workspace and Home routes. It does not import `@prentice/domain`, and its source does not use `.js` specifiers, so the Next bundler can load it. The dev HTTP adapter still validates those calls itself. The outbound relay client parses the same frames. `/health` stays a local bind check and is not a frame.
- `apps/connector` is the local connector. It owns git, account-scoped SQLite, account probes, provider adapters, Tree-sitter, and the in-process connector API. Dev HTTP starts only when `PRENTICE_DEV_HTTP=1`. `npm run dev` sets that flag, starts the website, and opens `http://127.0.0.1:3000`. The localhost pairing/switch page can accept a new code or activate a saved account connection. It opens automatically only when the packaged connector has no active account. An outbound WebSocket client then speaks `@prentice/protocol`.
- `apps/cloud` is the control plane. Prentice accounts are Supabase Auth users. Paired devices and pairing codes are in the Prentice Supabase Postgres project. Account-owned cloud projections store only project names and dates, recent task outcomes and aggregate file/test counts, and concept labels with explored/understood state. The relay forwards protocol frames in memory and does not store them. `npm run dev` starts a loopback cloud when Supabase configuration is present; otherwise Learning AI is unavailable.
- `apps/web` is a Next.js client. It does not import the vendor SDKs, and it does not import `@prentice/domain`. The public root offers sign-in; the signed-in site uses a Supabase magic link, then shows a small account overview and offers a selected computer's live workspace over the relay. `NEXT_PUBLIC_PRENTICE_DEV_LOCAL=1` uses a verified Prentice session to activate the matching local account store; the bootstrap token in `runtime.json` is not returned to the browser. The runtime returns task views including `issues` and local journal summaries for Home.

The website transpiles `@prentice/protocol` and consumes JSON from the runtime. Domain implementation and vendor SDKs remain outside the browser dependency graph.

## Local connector

`createConnector` in `apps/connector/src/connector.ts` is the in-process API. `server.ts` is the dev HTTP adapter over it: bearer auth, the origin check, CORS, JSON status codes, and SSE framing. The connector validates input and calls git, the store, accounts, and the session. A caller in this process does not present the bearer token.

Home's `home.get`, `home.pin`, and `home.visit` requests follow the existing protocol, relay authorization, and dev HTTP adapter. The connector derives Home from saved local tasks, conversations, typed Understand claims, Explain-back feedback, and real Debug events. Journal search and category/day filters run before pagination; UTC dates describe task activity. Pins and the previous Home visit timestamp use the local settings table. No Home record is stored in the cloud. An open journal result selects its real project and conversation; recovery of interrupted work still uses Send Again as a new run.

`npm run dev` and `npm start` set `PRENTICE_DEV_HTTP=1`, so the browser still reaches the connector through HTTP on `127.0.0.1`. The bootstrap token file remains `~/.prentice/runtime.json`, but the website server exchanges it plus a valid Supabase session for a short local session token. The connector rechecks that Supabase session on requests. `npm run connect` does not set the dev HTTP flag, so it does not open the workspace HTTP port. That process leaves the fixture provider out of routing.

`npm run package:mac` and `npm run package:win` build the desktop apps. Each bundles the connector (including the Codex SDK library) and a pinned Node runtime, Node 24.21.0 LTS, downloaded from nodejs.org and checked against its published SHA-256. The Mac app carries a universal arm64 + x86_64 binary. Only the Tree-sitter N-API addons ship as native modules. The app never loads anything from the monorepo's `node_modules`. Coding agents are not bundled. The Mac app copies itself to `~/Applications` and registers a Login Item. The production Windows WiX MSI installs per-user under `%LOCALAPPDATA%\Programs\Prentice` and owns an HKCU Run entry plus a Start Menu shortcut. Its background launcher disables legacy self-registration; the development ZIP retains its older self-copy/sign-in-task behavior. MSI lifecycle is not yet verified on Windows. Both configs contain the cloud and website addresses only. They use the same pairing page and relay client. A paired computer reconnects without a new code. The website asks the app to open the system folder dialog instead of accepting a typed path. The Windows package is 64-bit.

The connector generates an Ed25519 device key for each paired Prentice account on this computer. On macOS the private key is written to the login keychain (`prentice-device-key`) first. A bounded, quoted command is piped to `/usr/bin/security -q -i` without a shell; secrets are absent from process arguments and temporary files, and credential-operation errors omit child output. The existing service, account names, and trusted executable are preserved. On Windows it is written to Credential Manager through PowerShell, with the secret on stdin. `~/.prentice/accounts/<account-id>/device.json` stores the device id and public key. An existing root device identity is associated with an account only after the cloud verifies its saved token; the old root database is never associated by inference.

`connectRelay` dials outward and answers protocol request frames, including `workspace.get` for the workspace snapshot. It does not open an inbound port for the workspace. `tasks.events` becomes event frames with the same task payload the dev HTTP stream sends. The connector reuses the active account's device token from secure storage after checking its owner with the cloud. The small page on `127.0.0.1:4732` accepts a pairing code or switches to a previously paired account after rechecking its credential. That page is not the workspace and is not opened automatically during `npm run dev`. `PRENTICE_PAIRING_CODE` still pairs without the page. A pairing failure does not stop dev HTTP.

A relay on localhost may use `ws`. Any other host must be `wss`. If the socket drops, the connector redials with jittered backoff. Only the close code `REVOKED` (4001) means the active account's device credential is gone: the connector then stops dialing, deletes that token from secure storage, and reveals the pairing page. Other accounts' credentials remain intact. Every other close redials, including an auth timeout or a relay-side database or auth error. A result that cannot be sent is logged as undelivered. It is not treated as a completed delivery.

## Coding agents on the computer

Prentice does not ship Codex, Claude Code, or Cursor. The person installs them. `apps/connector/src/agents.ts` finds each one and resolves the exact program a task will run. The status check and the task use that same resolution.

A packaged app started from Finder, a Login Item, or Windows startup gets a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS). Discovery therefore searches PATH, then the official installer and package-manager locations: `~/.local/bin`, `~/.claude/local`, Homebrew, npm and `~/.npm-global`, bun, volta, pnpm, yarn, asdf, mise, nvm and fnm version directories, and on Windows `%LOCALAPPDATA%\cursor-agent`, `%APPDATA%\npm`, scoop and WinGet. A PATH read once from the login shell, with a 3-second timeout, adds places to look. Discovery does not depend on it.

- Codex: the npm `codex` command is a Node launcher. Prentice resolves it to the native binary in its platform package, so no `node` is needed on PATH. A Homebrew or standalone `codex` is already native. The SDK executes the native guardian through `codexPathOverride`; the guardian starts that discovered binary with its required PATH directories.
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

The signed-in website can show the account's small cloud overview before any connector is online. It can also select a paired computer and open `/relay/browser` for live workspace calls. Full conversations and repository work remain in that account's local SQLite database; the browser does not read the repository directly. Linking a cloud project to a checkout requires a folder choice on the selected computer.

Understand and Explain-back are a separate Learning AI. The connector sends a bounded evidence summary to the paired cloud's `POST /v1/learning`. Local Tree-sitter analysis retains symbol evidence for diagnostics and extracts an allowlisted set of API-use changes, without bodies, arguments, literals, or comments. API presence proves syntax only, not runtime behavior or security. Helper-symbol inventories are omitted from the remote summary. Canonical observed facts cover Git changes, API use, command outcomes, tests and failures. Successful command output is discarded after extracting test tallies; failure output is bounded to 1,500 characters in the learning summary and marked command-output. Inline-code and heredoc commands are omitted from remote command text. Agent stated excerpts prioritize the last six messages, cap each at 1,200 characters and all excerpts at 3,000, and remove fenced code and exact echoed original requests. No unrestricted file content, diff, original prompt, or full transcript is uploaded.

The connector derives task scope locally. The explanation call receives that scope, bounded agent statements and selected behavioral evidence rather than an inventory of files or functions. Lessons explain mechanisms, tradeoffs and transfer, and remain Prentice inference with validated canonical Observed or Agent stated anchors. Unknown citations and unsupported helper-name behavior are rejected. Syntactic evidence is never relabeled as proof of runtime behavior. Evidence details stay collapsed in the primary lesson UI. Discussion can cite canonical facts; only locally resolved fact text becomes Observed. Coding completion and the project lock do not wait for teaching; the artifact exposes a pending state and updates when teaching finishes.

The cloud allows 120 Learning AI calls per computer per 10 minutes and gives Groq 30 seconds. It calls Groq with its private `GROQ_API_KEY`, default model `openai/gpt-oss-120b`. The key is not read by the website or connector. If learning is unavailable or no useful grounded lesson is returned, Prentice shows that limitation without manufacturing a trivia quiz. Codex, Claude Code and Cursor are not asked to teach.

### Learning AI in development

`npm run dev` (`scripts/dev.mjs`) starts the connector, the website, and the cloud on `127.0.0.1:4740`. It creates a random `PRENTICE_DEV_LEARNING_TOKEN` for that run and gives it to both processes. The cloud accepts that token on `/v1/learning` only when it is bound to loopback. An unpackaged dev-HTTP connector that is not paired uses it. The Groq key stays in the cloud process. A production cloud never sets the token, and a packaged connector ignores it.

## Hosted backend

The hosted database and Prentice account login are a Supabase project: Postgres plus Supabase Auth. The Next.js app can be deployed on Vercel. `/download/mac` and `/download/windows` redirect to `PRENTICE_DOWNLOAD_BASE_URL` (object storage, a CDN, or a release page). In production they never serve a zip from the web server's filesystem. Local development still serves `dist/`. The relay stays a long-lived Prentice process, because Supabase Realtime is a database and broadcast channel, not a private socket between one browser and one connector.

The schema lives in `supabase/migrations` and is applied to the hosted Prentice project. The cloud process reads that project from `.env`. `npm run dev` starts the connector and website, and also starts the local Prentice cloud when complete Supabase configuration is available. Each verified account has its own local SQLite file at `~/.prentice/accounts/<account-id>/prentice.db`. The old `~/.prentice/prentice.db` has no verifiable owner and remains untouched and unavailable to signed-in accounts. Tasks, prompts, transcripts, diffs, detailed evidence, explain-back answers, command output, paths, and credentials are not synchronized.

Remote PostgreSQL connections always verify the certificate chain and the hostname in `DATABASE_URL`, even if the URL requests a weaker SSL mode. Node's trusted roots are used by default. If the endpoint requires Supabase's project CA, obtain it from that project's Database Settings over HTTPS and mount the PEM file on the cloud host; set `PRENTICE_DATABASE_CA_FILE` to its path (or use `sslrootcert` in `DATABASE_URL`). A configured unreadable or invalid CA fails closed. Do not download or trust the certificate presented by a failing connection. The CA and database credentials belong only on the cloud host. Loopback `localhost`/`127.0.0.1` development retains plaintext by default; configuring a CA or requesting SSL there enables the same verified TLS. Pool size, timeouts, and disabled prepared statements are unchanged.

For staging, use a separate Supabase project and apply all repository migrations before starting the cloud. Set the website's build-time `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_PRENTICE_CLOUD_URL`; keep database credentials, Supabase secret keys and Groq keys off that host. Configure Supabase's Site URL/redirect allow-list and SMTP for the actual staging website. Serve the website and relay over HTTPS/WSS, set the cloud's exact `PRENTICE_WEB_ORIGINS`, and package the connector with those public URLs. Run one persistent relay process: its socket routing is in memory and independent replicas cannot route between each other's connections. Verify the deployed login, pairing, reconnect, sign-out/revocation and learning flows before release; local tests do not establish remote configuration.

A signed-in user can read their own device names through row-level security. Token hashes and pairing codes have row-level security and no client policy, and they are not in the Data API. GitHub sign-in stays disabled until `SUPABASE_AUTH_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_GITHUB_SECRET` are set. The website gets the publishable key. The connector gets neither key.

A browser frame carries the current Supabase access token and a device id. A connector frame carries the account's device token from pairing. Access tokens expire, so the browser sends a fresh one when it reconnects. Pairing stays an action of the cloud process. A returning account can activate its saved device credential from the connector's localhost page; a revoked or invalid credential requires a new code. Switching interrupts active work before another account's store opens. Device private keys and provider credentials stay in the operating system's credential store. The cloud summary API accepts only account-owned project names/dates, the latest 50 task outcomes with aggregate change/test counts, and explored/understood concept labels/dates. Uploads are idempotent by account and record ID; task updates are accepted only from their originating device, while understood concepts merge monotonically. The connector resends recent summaries on reconnect and periodically while online. Conversation titles and Home preferences remain local.

Production security for this phase is TLS on the relay connection, plus the rule that the cloud does not store repository contents. The relay process can still see a frame while it forwards it. End-to-end encryption of those frames is not part of this phase.

## In-process connector

The dev HTTP adapter and the relay client share one store, one account service, and one event hub when both are enabled.

## Browser to runtime

The runtime binds to `127.0.0.1`. It writes a new bearer token to `~/.prentice/runtime.json` with mode `0600` only after the port accepts connections. The home directory is `0700`. A failed bind leaves the existing token file alone. `/health` is public; account data requests require the verified account’s local session token. The bootstrap bearer token can activate an account only with a valid Supabase session. When an Origin header is present it must be `http://localhost:3000` or `http://127.0.0.1:3000`; CORS uses that allowlist.

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
7. `POST /v1/tasks/:id/interrupt` aborts the in-process session. A stopped run, and a run that was still going when the connector exited, carries `recovery: { kind: "send-again", prompt }`. The page offers Send Again, which puts the prompt in a new conversation without running it. It also says that files the agent already changed are still in the working tree. `POST /v1/tasks/:id/continue` resumes a Codex thread or Claude Code session for the same conversation. Cursor reports that continuation is unavailable and does not start a replacement session.

The primary UI is Home and Workspace at `/`.

## Routing

The router is deterministic. It uses task intent, category, named technologies, named files, project structure, likely breadth, and whether the task touches architecture, data, auth, or tests. Prompt length can nudge a small task up one step only when the prompt also names files and more than one technology. It never raises complexity by itself.

Connected providers are scored by capability fit. A single connected provider is used. A pin or an explicit override wins. An explicit unavailable/disconnected provider, including a disabled fixture provider, is refused at launch rather than falling back to another provider. In local development the fixture provider is the pool only when no real account is connected. A connector started with `npm run connect` leaves the fixture out, so a task requires Codex, Claude Code, or Cursor. Tests inject disconnected accounts and still allow the fixture so a host login cannot steal the fixture route.

Historical telemetry is stored in SQLite and is not applied. One run cannot move the router.

`fast` / `balanced` / `deep` / `maximum` is an internal intensity. Claude Code and Codex map it onto effort. Maximum maps to `xhigh`, not the provider's highest setting, unless the user explicitly asks for that. Cursor has model params such as `fast`, not the same effort scale. If the catalog cannot satisfy the preference, the note says Cursor is choosing depth.

## Normalized events and the activity stream

Adapters yield one event shape: session start and completion, status, assistant text, tool start and finish, file change, command start and finish, usage, failure, and interrupt. `toTimeline` turns that into the panel the UI shows. Git-confirmed file events replace an agent report for the same path. Long assistant text is kept in the session record and is not dumped into the timeline.

SSE subscribers receive events as they are stored. A client abort of that stream is not a task failure.

## Git and Tree-sitter

Git is the file-change record. After a session, the runtime diffs the before and after worktree snapshots. If either snapshot is missing, file attribution is unavailable; there is no HEAD/base-commit fallback. Commands, structured test results, and attributed agent statements are still retained. Agent `file.changed` events are activity. They do not define what changed.

Tree-sitter parses TypeScript, TSX, and JavaScript with the Node bindings, not WASM, because those bindings load the grammars in this process. It compares function and class names before and after. Other files stay at path and diff size, and the understand notes say they were not parsed. If Tree-sitter fails to load, those files stay at file level too.

## Understand

`assembleUnderstand` builds three separate lists:

- Observed: git files, Tree-sitter symbols, commands, tests.
- Agent stated: text the coding agent actually emitted.
- Prentice inference: a claim that cites an evidence id in the packet. Claims without a valid citation are rejected.

A change map is a directory grouping. It is omitted when fewer than two files changed or those files sit in one directory. Before/after architecture diagrams are not generated. The artifact says they are omitted unless a later analysis can derive them. The fixture writes one file, so it has no map and no diagram.

The UI can open a cited path as a file or a unified diff. The editor stays read-only.

## Explain-back

Questions come only from accepted conceptual lessons and test causal reasoning, behavior, tradeoffs or transfer. Symbol-name and filename recall have no fallback path. Previously demonstrated concepts are omitted.

- Tiny: at most one initial question and one follow-up (`low` complexity and at most 2 changed files).
- Moderate: at most 2 initial questions and 2 follow-ups.
- Deep: at most 4 initial questions and 3 follow-ups (`high` complexity or at least 6 changed files).

Skip is available at every scope. Helper count does not increase the workload. The default tutor uses source-grounded semantic assessment rather than requiring one of six exact statement grammars. The cloud retrieves a bounded set of maintained general reference principles by topic. The tutor proposes feedback and a structured criterion assessment; a different Groq model grades the original question and complete bounded answer without seeing that feedback or its verdict. Both models must return question-specific criterion decisions with exact learner spans and reference IDs. The server resolves canonical maintained principles from those IDs; models cannot manufacture source quotations. The source/rubric review checks entailment and completeness separately from learner correctness. A separate prose review checks the reply after the blind grade is fixed. Mastery requires adequate reference coverage, complete reasoning, agreement between the two source-grounded criterion assessments, valid evidence spans and binding, and successful prose review. Partial reasoning and explicit misconceptions use the existing bounded attempt/coaching flow; ambiguous answers, disagreements, unsupported criteria, unavailable reviews and incomplete context remain provisional without attempts or mastery. The connector validates the authenticated cloud certificate against the local question/answer digest, source catalog, revision and evidence before recording it; it does not independently repeat semantic inference. Teaching, hints, examples, questions and acknowledgments remain unassessed. Explicit practice, next, revisit, skip and finish retain their existing lifecycle. The legacy deterministic six-question path is retained only when independent review is disabled or configured to use the tutor itself; it cannot expand mastery through a same-model verdict.

The existing answer endpoint also accepts local `practice`, `revisit`, `next`, `skip` and `finish` choices with stable message IDs. Navigation works without model inference. Free-text navigation requires explicit intent as well as a matching model classification. A temporary revisit saves the interrupted topic's attempts and coaching and returns there on advancement. Completed sessions retain discussion and an explicit concept selector for reopening practice. Per-topic progress and the return target extend the existing locally persisted session JSON; no new database, service or provider is introduced.

The hybrid teaching catalog supplies maintained general principles across outbox/idempotency, transactions/isolation, cookies/CSRF, process interruption, authorization, indexes, HTTP caching, TypeScript runtime boundaries, promises, SQL parameterization, and retry/backoff behavior. These are topic references, not per-question answer rules. A lexical retrieval match is not sufficient grounding: the examiner must establish full conceptual coverage. Initial covered teaching retains maintained explanations but can use independently reviewed, varied questions and criteria. Normal follow-ups and hints are generated contextually and reviewed by a different configured model. For available maintained/state-derived examples, the renderer uses their checked trace instead of an arbitrary model-generated scenario; additional cross-boundary and scope guards conservatively withhold unsupported atomic external effects and unqualified guarantees. These guards are limited safeguards, not a general theorem prover. When review cannot establish reliability, a sourced starting point, staged hint or maintained example remains available without consuming an attempt. Disagreeing assessments cannot publish definitive praise or criticism; the reply retains a reviewed contextual clue and acknowledges the provisional result. Exhausted fallback hints progress into a maintained example. Uncovered topics can still receive reviewed conversational help but cannot award mastery without adequate assessment grounding. No runtime web query, additional provider or new infrastructure is required. The two models can still share misconceptions; source material and retrieval require maintenance. Passing review does not prove technical correctness. Live evaluations have still found false negatives for correct paraphrases and technically incorrect prose approved by both models. Maintained examples and conservative provisional outcomes reduce these observed failures without proving general correctness.

Learning turns are stored locally with stable message IDs, the question they belong to, pending/replied/failed status, and the tutor reply. The same conversational endpoint handles explanations, questions, clarifications and evaluation review. Models see only the existing last six bounded exchanges, six bounded review candidates, current concept and bounded evidence; no original task prompt, repository bodies or unrestricted transcript is added. Review is anchored to the original saved answer, with truncation marked. A provisional, partial or conflicting review preserves existing mastery. Only a reliable explicit incorrect reassessment retracts that answer's judgment; another valid answer or another task's retained mark protects concept mastery. Clarification alone cannot justify negative retraction. Correcting an earlier evaluation does not reset or replace the current question. Assessment evidence, source spans and model/binding proof stay in the local transcript and are omitted from public views and subsequent remote history metadata. Replies remain Prentice interpretation; general sources never certify repository behavior.

Submissions serialize per task, save the learner message before inference, and emit snapshot notifications for pending and completed replies. Retried message IDs do not duplicate or regrade a successful turn. Failed/stale pending messages can retry, including after restart; an older failed answer remains attached to its original question even after the learner advances. A late model reply does not undo Skip. The browser applies the acknowledged explain state directly rather than depending on a second GET; unsent transport failures retain their draft and inline error. The learning composer uses the same conversation for answers and discussion, and discussion remains reachable after completion or Skip. Composer state is keyed by task so a late request cannot erase another conversation's draft.


Mechanically invalid assessment records may be repaired once before blind grading, without exposing the examiner's result or changing the tutor's proposed outcome to force agreement. Missing reasoning carries no evidence quotation. A unique sentence-initial article capitalization mismatch can resolve to the actual learner substring; identifiers and the rest of a claim are never case-folded. Validation applies to the reply after lifecycle rules remove incidental teaching and select maintained examples. A discussion reviewer that returns a learner-understanding grade is rejected. The blind grader's unchecked rationale is not a second channel of learner-facing technical prose: assessment summaries describe agreement/status, while the reviewed reply supplies feedback and local criterion evidence remains available.

Observed cookie-scope failures use existing maintained progressive hints or the maintained same-origin XSS example for the affected advice. Other replies remain conversational model output subject to review and scope checks. Retrieval includes the XSS/CSRF dependency and distinguishes security ownership from partition ownership. Inconclusive source feedback prefers the focused teaching unit over the first lexical reference. The guarantee guard recognizes typographic negative contractions. Qwen's compact grading and prose-review calls have output budgets of 600 and 250 tokens within the existing overall deadline; provider limits or unusable output still yield provisional help. These safeguards cover observed failure modes, not arbitrary technical correctness.

An unambiguous first-answer review request is resolved locally to the original saved answer. That answer replaces a recent candidate within the same six-candidate, bounded-excerpt budget; the cloud constrains the review route/ID without preselecting a grade. A truncated original answer remains ineligible for conclusive reassessment. Existing mastery preservation, independently justified retraction, navigation and local transcript behavior are unchanged.

## Debug

Debug issues are computed in `publicTask` from the stored timeline and from the exact observed sentence `Tests reported N passed and M failed.` when `M` is greater than zero. An interrupt is a stop, not an issue. A Debug issue requires a recorded nonzero command exit, an explicit failed tool result, or structured failed test counts. All session/provider/setup/auth/crash failures and unknown command exits are excluded. The UI shows the issue only when that list is non-empty.

A failed command keeps a bounded slice of its own stdout and stderr, as the agent's tool run reported it. Codex supplies `aggregated_output`, Claude Code the Bash `tool_result`, and Cursor the shell tool result. `boundFailureOutput` keeps the last 80 lines and 4,000 characters, strips terminal colour codes, and redacts common secret shapes. A command that succeeded keeps no output. Debug shows the slice as Command output and says when earlier lines were cut. When that output contains a test runner's own pass and fail counts (node:test, vitest, jest, pytest), the evidence packet records the counts as observed test results.

The help ladder reveals stored text one step at a time. It does not invent a root cause or a fix. Levels 5 and 6 say none was recorded. This is the current task only. There is no engineering memory, retrieval index, or knowledge graph.

## Persistence

SQLite is Node's built-in `node:sqlite` at `~/.prentice/accounts/<account-id>/prentice.db`, WAL mode, behind one query module. The runtime starts with `--experimental-sqlite`. Tables cover projects, tasks, routing decisions, activity events, evidence packets, understand artifacts, explain sessions, telemetry, and settings. The root-level legacy database remains quarantined.

A project row is one git repository. Opening a path uses the repository root, then the on-disk path, so a different capitalization or a symlink to that directory is the same project. Its tasks stay on that row. A conversation is a stable record on that project. Its turns are the task chain, titled by the first prompt. The project remembers which conversation is selected. Switching repositories changes the working tree and which conversations are listed. Conversations in one project share that working tree. Understand and Explain-back compare the worktree snapshot taken before the turn with the snapshot taken after it. Line counts and symbols come from that pair. A file that was already dirty, or already untracked, is included only for the content that changed during the turn. When both snapshots exist, Prentice does not teach the diff against the last commit. One coding agent may run in a project at a time. Concepts already demonstrated stay on the project.

Provider connection is each agent's own sign-in on this computer. Codex uses `codex login status` / `codex login`, and Cursor uses `agent status` / `agent login`. Disconnect persists a Prentice-only disabled setting; it never runs vendor logout. Prentice can start those official sign-ins, and they open the vendor's page on this computer. Claude Code sign-in stays in Anthropic's own flow: Prentice only reads `claude auth status` and tells the person to run `claude` and `/login`. It never starts, stores, or intermediates that sign-in. Prentice stores connection order. It does not ask for or store a coding-agent API key. Legacy coding-agent API-key storage and authenticate APIs have been removed.

## Decisions that are in the code

**Hosted learning, local work.** Sign-in, pairing, and the live relay are the Prentice cloud. The repo, git, and detailed session record stay on the user's computer in an account-specific database. Supabase stores the account, device registry, and the restricted project/activity/concept summary projection. It does not store the repository, prompts, transcripts, or explain-back answers. Vendor inference is hosted only when a connected provider needs it.

**SQLite, not Drizzle.** Drizzle was the original plan. It was not added. The MVP is a handful of statements, and the built-in driver avoids a native SQLite addon.

**Provider adapters.** Domain defines the event shape and capabilities. Runtime adapters map each SDK into that shape. The UI and the learning flow do not branch on vendor payloads.

**Git as the change record.** Provider file events are not stable across tools. Codex reports some file changes. Claude and Cursor capabilities mark file-change events as not the record. The diff is.

**SSE.** The session is a stream of normalized events. SSE matches that without a second realtime service.

**Tree-sitter.** Symbol claims need a parse of the files that actually changed. A model summary is not that evidence. Languages other than TypeScript and JavaScript are left unparsed on purpose.

**Fixture provider.** Local development, with no connected account, writes `prentice-fixture/session-note.ts` and emits Prentice status events. It does not call a model. The hosted connector command does not offer that provider. CI uses recorded event fixtures and does not call live providers.

**Not in this version.** RAG, a vector database, a persistent learning graph, repository sync, Redis, and BullMQ are not dependencies and have no code path. The editor is a read-only viewer of the repo and the diff, not the place the user is expected to write the change. An account may pair multiple computers and select one for live work; full conversations do not synchronize.

## Authorization and process lifetime

Supabase validates the browser token and the cloud checks its `session_id` against `auth.sessions`. Prentice Sign Out calls the global Supabase session endpoint and immediately closes that user's live relay browsers. Devices and connectors remain paired. Relay authorization is checked on requests, delivery, and heartbeats; temporary auth/DB errors close with a retryable code. A replaced connector closes with SUPERSEDED and cannot redial or forward queued frames. Responses use unique relay IDs and return only to the requester. Per-tab watchers share a task subscription; pending requests have deadlines. Authenticated frames share in-flight authorization checks without queuing responses behind streamed events. An Interrupted status does not end a subscription while confirmed partial Understand is still being prepared.

Coding tasks launch through a native guardian connected to a private owner channel. EOF on connector death stops the agent. macOS/POSIX agents run in a dedicated session/process group; Stop escalates INT → TERM → KILL and completion kills remaining group members. Windows creates the agent suspended, assigns it to a kill-on-close Job Object without breakaway, then resumes it. Packaged builds ship the guardian; absence fails closed. Worktree lease records block a replacement connector until recorded guardians exit, before taking a new baseline. A deliberately daemonized POSIX process that escapes its group is outside this guarantee; Windows behavior still needs execution on Windows.

Interrupted turns keep confirmed partial changes and command/test evidence, explicitly mark the outcome, and never claim completion. File reads reject traversal and symlink components and use verified file descriptors. Pairing requires the bound loopback host, a same-origin request, a per-surface nonce, and a bounded body. Shared redaction runs before evidence storage, SSE/relay/HTTP transmission, logs, and Learning AI calls. Historical evidence is scrubbed on loading; historical model prose is retired when upgrading to deterministic grounding. Original task prompts remain local for execution.
