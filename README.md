# Prentice

Prentice is a hosted learning surface around Codex, Claude Code, and Cursor. The website is the conversation. The repository and the coding agent stay on one computer. Prentice calls the Learning AI.

## Run locally

```bash
npm install
npm run dev
```

The local runtime listens on `127.0.0.1:4731`. The UI is at [http://127.0.0.1:3000](http://127.0.0.1:3000). This path skips computer pairing after sign-in. `npm run dev` also starts the Prentice cloud on `127.0.0.1:4740`, so Understand and Explain-back reach the Learning AI. The Groq key stays in that cloud process. The connector reaches it with a random token made for that run, and the cloud accepts that token only on loopback.

Open a git repository that already has at least one commit. With no provider account connected, local development uses the fixture provider. That provider writes `prentice-fixture/session-note.ts` so the workspace can show the real file change and diff.

## Desktop app

A person using the hosted site downloads Prentice for the computer they are on. The apps are built with:

```bash
npm run package:mac -- --release
npm run package:win -- --release
```

Both read `PRENTICE_CLOUD_URL` and `PRENTICE_WEBSITE_URL` from the environment or `.env`. With `--release`, both must be public `https` addresses. Without it, the build is a development build and prints a warning. The app contains the connector, its Tree-sitter addons, and a pinned Node runtime (24.21.0 LTS) downloaded from nodejs.org and verified against its SHA-256. The Mac app carries a universal binary. The build copies no secret, and it does not bundle Codex, Claude Code, or Cursor. People install those themselves, and Prentice finds them even though Finder and Login Items give apps no shell PATH. `dist/release-manifest.json` records each zip's SHA-256.

Signing: set `PRENTICE_MAC_SIGN_IDENTITY` (a Developer ID Application identity) to sign the Node runtime, the addons, and the app with the hardened runtime. Also set `PRENTICE_MAC_NOTARY_PROFILE` (a `notarytool` keychain profile) to notarize and staple. The Windows zip is unsigned. Authenticode signs executables and installers, not `.cmd` files, so a signed Windows release needs an installer.

Downloads: set `PRENTICE_DOWNLOAD_BASE_URL` on the website to the place the zips are hosted. `/download/mac` and `/download/windows` redirect there. In production the website never serves a zip from its own disk.

The first open installs Prentice for that person, starts it, and starts it again at sign-in. On macOS that is a copy in `~/Applications` and a Login Item. On Windows that is a copy in `%LOCALAPPDATA%\Prentice` and a sign-in task. If the computer is not paired, a window opens for the code shown on the website. Later sign-ins reconnect while that computer is available. The app does not ask for a repository path. Choosing a project opens the computer's folder window.

`npm run connect` remains the way to run that same connector from this checkout during development.

## Tests

```bash
npm test
```

Provider contract tests use recorded events and fake agent executables. They do not call Codex, Claude Code, or Cursor. The cloud tests use the Supabase project in `.env`. `npm run typecheck` and `npm test` include the website.

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
