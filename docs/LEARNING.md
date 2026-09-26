# Learning

This file is for Harshit, while building Prentice. A topic is listed because it is in the implementation. "What I currently understand" is filled only from something Harshit specified or explained. It is not filled from the fact that the code exists.

When a new technical subject shows up, add it. When Harshit's understanding of it changes, update that section.

## Product loop and evidence

Why I encountered it:
The stage briefs define Prentice as build, understand, explain-back, and debug on a real failure, with observed, agent-stated, and inferred claims kept apart.

What I need to understand:
How those rules constrain the runtime and the panel, and which parts are still only the current task.

What I currently understand:
The product rules themselves. They were specified directly: no numeric score, no fake bugs, no invented rationale, git as the change record, fixture as the demo when no account is connected, and engineering memory left out.

What is still unclear:
Nothing recorded about how the domain functions implement those rules, beyond the rules.

Where it appears in Prentice:
`packages/domain/src/evidence.ts`, `explain-back.ts`, `debug.ts`, and the Prentice panel.

Relevant implementation:
`assembleUnderstand`, `explainBackPolicy`, `debugIssuesFromTimeline`.

## Provider adapters and account login

Why I encountered it:
Codex, Claude Code, Cursor, and the fixture all have to look like one session to the UI.

What I need to understand:
The adapter interface, what each official login actually checks, and which capability flags are not backed by a runtime behavior.

What I currently understand:
The decision to use official account login instead of a pasted API key, and to keep the fixture when nothing is connected. That was specified. The SDK call shapes were not explained back.

What is still unclear:
Claude and Cursor live sessions are still unverified. A Codex login and one local session were observed on 2026-09-23: the bundled CLI reported `Logged in using ChatGPT`, a disposable repo gained `hello.txt`, and aborting the SDK signal stopped a second turn. That observation is recorded in `docs/AGENTS.md`. It has not been explained back here as an understanding of the SDK.

Where it appears in Prentice:
`apps/connector/src/providers.ts`, `apps/connector/src/accounts.ts`, `packages/domain/src/capabilities.ts`.

Relevant implementation:
`CodingAgentProvider`, `AccountService`, `providerFactory`.

## Localhost boundary and SSE

Why I encountered it:
The browser has to reach a runtime that holds the repo without exposing that runtime to other sites.

What I need to understand:
Why the token lives in `runtime.json`, why the Next route is the only reader, what the origin check is for, and why closing a task aborts the event stream.

What I currently understand:
The requirement that the runtime stay on `127.0.0.1` with a bearer token and an origin allowlist. That was specified. The failure mode where a restarted runtime rewrites the token is recorded as a bug, not as a concept that has been explained.

What is still unclear:
No recorded walkthrough of SSE framing or of `timingSafeEqual`.

Where it appears in Prentice:
`apps/connector/src/auth.ts`, `apps/connector/src/main.ts`, `apps/web/app/api/local-session/route.ts`, `apps/web/lib/prentice.ts`.

Relevant implementation:
`authMiddleware`, `readTaskStream`.

## Git diff

Why I encountered it:
Understand and the editor both depend on the diff, not on what the agent says it wrote.

What I need to understand:
`git status` and `git diff` against the base commit, including an added file that diffs against `/dev/null`, and why a path must stay inside the repo.

What I currently understand:
The product rule that git confirms the change. The fixture demo showed an added `prentice-fixture/session-note.ts` with `+4 -0`. The git commands themselves have not been explained back.

What is still unclear:
No recorded check of the diff parser or the path sandbox.

Where it appears in Prentice:
`apps/connector/src/git.ts`, `apps/connector/src/workspace.ts`.

Relevant implementation:
`gitText`, `workspaceSnapshot`, `readWorkspaceDiff`.

## Tree-sitter

Why I encountered it:
Symbol claims need a parse of the changed TypeScript or JavaScript.

What I need to understand:
What the Node bindings parse, which names count as symbols, and what happens for every other language.

What I currently understand:
The decision to use Tree-sitter for structure and to refuse invented structure when a file is not parsed. That was specified. The grammar walk has not been explained back.

What is still unclear:
No recorded check of the parse or of the before/after name sets.

Where it appears in Prentice:
`apps/connector/src/symbols.ts`.

Relevant implementation:
`extractSymbolChanges`.

## SQLite

Why I encountered it:
Tasks, events, evidence, understand artifacts, and explain-back state have to survive a reload on one machine.

What I need to understand:
Why this is `node:sqlite` without an ORM, which tables exist, and what is deliberately not stored.

What I currently understand:
The decision to use a local SQLite file and not Drizzle, Redis, or a hosted database. That was specified. The schema has not been explained back.

What is still unclear:
No recorded check of WAL mode or of the query module.

Where it appears in Prentice:
`apps/connector/src/db.ts`, `apps/connector/src/store.ts`.

Relevant implementation:
`openDatabase`, `migrate`.

## Next.js and the domain package

Why I encountered it:
The web app could not import `@prentice/domain` even with `transpilePackages`.

What I need to understand:
Why a TypeScript package whose imports end in `.js` fails in the Next bundler, and why the client now consumes `task.issues` from the runtime instead.

What I currently understand:
Nothing recorded. The failure and the workaround are in `docs/BUGS.md`. They were found while implementing, not explained as a concept.

What is still unclear:
The bundler rule itself.

Where it appears in Prentice:
`packages/domain` exports, `apps/web/next.config.ts`, `apps/connector/src/session.ts` `publicTask`.

Relevant implementation:
`publicTask` attaches `issues` so the client does not import domain.
