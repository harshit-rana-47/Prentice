# Prentice

Prentice is a hosted learning surface around Codex, Claude Code, and Cursor. The website is the conversation. The repository, the coding agent, and the Learning AI stay on one computer.

## Run locally

```bash
npm install
npm run dev
```

The local runtime listens on `127.0.0.1:4731`. The UI is at [http://127.0.0.1:3000](http://127.0.0.1:3000). This path skips computer pairing after sign-in.

Open a git repository that already has at least one commit. With no provider account connected, local development uses the fixture provider. That provider writes `prentice-fixture/session-note.ts` so the workspace can show the real file change and diff.

## Desktop app

A person using the hosted site downloads Prentice for the computer they are on. The apps are built with:

```bash
npm run package:mac
npm run package:win
```

Both commands read `PRENTICE_CLOUD_URL` and `PRENTICE_WEBSITE_URL` from the environment or `.env` and write only those addresses into the app. They do not copy the Groq key, the Supabase secret, or the database URL. The zips are `dist/Prentice-Mac.zip` and `dist/Prentice-Windows.zip`. The Windows package is 64-bit.

The first open installs Prentice for that person, starts it, and starts it again at sign-in. On macOS that is a copy in `~/Applications` and a Login Item. On Windows that is a copy in `%LOCALAPPDATA%\Prentice` and a sign-in task. If the computer is not paired, a window opens for the code shown on the website. Later sign-ins reconnect while that computer is available. The app does not ask for a repository path. Choosing a project opens the computer's folder window.

`npm run connect` remains the way to run that same connector from this checkout during development.

## Tests

```bash
npm test
```

Provider contract tests use recorded events. They do not call Codex, Claude, or Cursor.

## Documents

These are living records of the current project. Update the one that changed. Do not treat them as a plan.

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — what the system does
- [BRAIN.md](docs/BRAIN.md) — what Prentice is for
- [AGENTS.md](docs/AGENTS.md) — provider adapters as implemented
- [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — the workspace UI that exists
- [LEARNING.md](docs/LEARNING.md) — technical subjects encountered while building
- [BUGS.md](docs/BUGS.md) — defects actually hit

## Scope

The current loop is: open a repo, route a task, run the original prompt, watch the activity, understand the diff, explain it back, and return to the agent. Debug is available only when this session recorded a real failure.

Engineering memory and telemetry that changes routing are not in this version.
