# Prentice

Prentice is a local development layer around Codex, Claude Code, and Cursor. It routes a task, forwards the original prompt, watches the session, and explains the real diff.

The repository stays on your machine. Model inference is hosted by the provider when that provider requires it.

## Run

```bash
npm install
npm run dev
```

The runtime listens on `127.0.0.1:4731`. The UI is at [http://localhost:3000](http://localhost:3000).

Open a git repository that already has at least one commit. With no provider account connected, Prentice uses the fixture provider and labels it as a demo. That provider writes `prentice-fixture/session-note.ts` so the workspace can show the real file change and diff.

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
