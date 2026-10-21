# Prentice

Prentice is a browser workspace for learning from the changes made by your coding agent. Run a task with your installed Codex, Claude Code, or Cursor CLI, inspect the actual files and Git diffs, then use **Understand** and **Explain-back** to work through the reasoning behind the change.

The repository and coding agent run on your computer. A separate Prentice cloud handles sign-in, computer pairing, the live relay, and Learning AI requests.

**Release status:** this is source for an early release. This repository does not provide a deployed public service or verified signed desktop downloads. Windows installation still needs validation on Windows. Cloning the repository alone does not provide the cloud accounts or services described below.

## What you can do

- Open a local Git repository and route tasks to an installed, signed-in coding agent.
- Follow agent activity, inspect changed files and diffs, and continue supported agent conversations.
- Separate Git-observed changes, agent statements, and Prentice interpretations in Understand.
- Discuss a change and practise explaining concepts through Explain-back. Uncertain feedback stays provisional; learning can be skipped.
- Inspect Debug help when the current session records a real command or test failure.
- Reopen account-specific projects and conversations, or select another paired computer. Only limited activity and concept summaries synchronize between computers.

## Architecture and privacy

```text
Browser ── HTTPS / WebSocket ── Prentice cloud ── outbound relay ── Local connector
                                  │                                  │
                           Supabase Auth/Postgres              Git + SQLite + agent CLI
                                  │
                             Groq Learning AI
```

The connector initiates the relay connection; the hosted workspace needs no inbound workspace port on your computer. The local pairing page listens on loopback. Repository bodies, prompts, full conversations, and Explain-back answers are not persisted in Supabase. The relay carries live workspace frames in memory. Learning AI receives bounded, redacted evidence and learning exchanges; coding-agent vendors have their own inference and data policies. Local-first does not mean offline.

**Docker is optional developer infrastructure.** End users run a connector and a browser. The planned hosted architecture uses a Next.js website, a long-running Node cloud with WebSocket support, managed Supabase, and Groq; none requires a Docker runtime. The local Supabase integration-test stack does use Docker.

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Next.js landing page, sign-in, Home, and workspace |
| `apps/cloud` | Account authorization, pairing, relay, summary sync, Learning AI |
| `apps/connector` | Local repositories, SQLite, coding agents, desktop packaging |
| `packages/domain` | Routing, evidence, agent normalization, Explain-back rules |
| `packages/protocol` | Shared request, response, and event schemas |
| `supabase/migrations` | Cloud schema and access policies |

## Using a hosted installation

This path requires an operator to deploy the services and publish validated downloads first.

1. Open the operator's Prentice website, choose **Open Prentice**, and request an email sign-in link. Open that link in the same browser.
2. Download the connector for the computer containing your repository. On macOS, extract and open `Prentice.app`; it installs under `~/Applications`. On Windows, install `Prentice-Windows.msi`, then launch Prentice from the Start Menu.
3. Enter the website's one-time pairing code on the local connector page. Codes expire after ten minutes. Paired computers reconnect automatically while the connector is running.
4. Install at least one coding agent separately and use its official sign-in: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup), or [Cursor CLI](https://cursor.com/docs/cli/overview). Open **Agents** in Prentice to check its status. Codex and Cursor Connect can launch their official login; Claude sign-in stays in Terminal (`claude`, then `/login`). The Cursor editor's sign-in alone is insufficient.
5. Open the workspace, choose a folder containing a Git repository **with at least one commit**, and send a task. Review the changed files and diff, open Understand, and try Explain-back. Codex and Claude support continuation; the Cursor adapter currently does not.

Desktop targets are macOS 13+ (Apple Silicon and Intel, universal package) and Windows x64. These are packaging targets, not a claim of validation on every OS/version. There is no Linux desktop installer. End users need Git, an agent installation/account with vendor access, email access, and internet connectivity. Desktop packages include Node; end users do not install Node, Supabase, Groq keys, or Docker.

**Sign-out and cleanup:** Prentice Sign Out ends your Prentice browser sessions; the computer stays paired and vendor logins remain intact. Remove a computer from the account controls to revoke its relay credential. Provider Disconnect disables that provider in Prentice without signing it out at the vendor. Quit the connector before uninstalling it. Local history and secure-storage credentials survive uninstall; deleting those is a separate, deliberate data-removal step. macOS installs a `com.prentice.connector` Login Item; Windows MSI owns its startup entry. See [Windows lifecycle details](docs/WINDOWS_INSTALLER.md).

## Run from source

Development is currently exercised on macOS. The npm development commands use POSIX shell syntax; native Windows development is not validated. Packaging Windows releases requires Windows tooling.

Prerequisites: Node.js **22.13 or newer**, npm, Git, and a C compiler/toolchain for native parser installation and the process guardian (Xcode Command Line Tools on macOS). Tests also use OpenSSL. A coding agent is optional for the local development fixture, but required for real coding work.

```bash
git clone https://github.com/harshit-rana-47/Prentice.git
cd Prentice
npm ci
cp .env.example .env
```

Edit `.env` before starting. Use a dedicated development Supabase project with email/magic-link Auth enabled. Apply the SQL files in `supabase/migrations` in filename order to a **new** project, using Supabase's migration tooling or SQL editor. Do not reset an existing database. Set Auth's Site URL to `http://127.0.0.1:3000` and allow that redirect URL. Hosted email delivery needs a configured SMTP provider.

| Variable | Where to obtain it / purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project API URL |
| `SUPABASE_PUBLISHABLE_KEY` | Project publishable key (legacy anon key also supported) |
| `SUPABASE_SECRET_KEY` | Project backend secret/service-role key; cloud only |
| `DATABASE_URL` | Supabase PostgreSQL connection URL; URL-encode password characters |
| `GROQ_API_KEY` | Groq key for Understand and Explain-back; cloud only |
| `PRENTICE_CLOUD_URL` | `http://127.0.0.1:4740` for local development |
| `PRENTICE_WEBSITE_URL` | `http://127.0.0.1:3000` for local development |

For remote Postgres, certificate and hostname verification are mandatory. If needed, set `PRENTICE_DATABASE_CA_FILE` to the project's trusted CA file; see `.env.example`. Never disable verification. Learning models default to the two distinct models in that example; model availability and quota affect learning. Without a Groq key, coding still works but model teaching is unavailable.

```bash
npm run dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000) and sign in. The website, connector (`4731`), and cloud (`4740`) must have free ports. The local account still requires Supabase sign-in, but skips computer pairing. If cloud configuration is absent, the launcher warns and does not start the cloud; this is not a usable authenticated installation.

Use a disposable committed Git repository for your first task. With no connected real agent, the development fixture writes `prentice-fixture/session-note.ts` and shows its real diff. This verifies plumbing, not agent or model behavior. `npm run connect` runs the production-style paired connector from source, without the fixture or development workspace HTTP API; configure the cloud and website URLs first.

## Hosting and desktop releases

Deploy the website and cloud separately. For the website, set build-time `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_PRENTICE_CLOUD_URL`. Keep `SUPABASE_SECRET_KEY`, `DATABASE_URL`, and `GROQ_API_KEY` on the cloud only. The cloud starts with `npm run start -w @prentice/cloud`, binds to `PRENTICE_CLOUD_HOST=0.0.0.0`, and respects the host's `PORT`. It needs persistent WebSockets through an HTTPS/WSS proxy, database access, and `PRENTICE_WEB_ORIGINS` set to the exact website origin. Configure Supabase's public Site URL, redirect allow-list, and SMTP. The current relay keeps connection state in one process; arbitrary multi-instance routing is not implemented.

Build desktop apps with public HTTPS `PRENTICE_CLOUD_URL` and `PRENTICE_WEBSITE_URL`:

```bash
npm run package:mac -- --release
npm run package:win -- --release   # on x64 Windows with WiX and Visual C
```

macOS release mode requires `PRENTICE_MAC_SIGN_IDENTITY` and `PRENTICE_MAC_NOTARY_PROFILE`; it signs, notarizes, staples, and checks Gatekeeper. Windows requires certificate/timestamp configuration; see [Windows installer requirements](docs/WINDOWS_INSTALLER.md). Unsigned development builds and `npm run package:win:zip` do not establish release readiness. Packaging downloads and verifies a pinned Node runtime, bundles the connector/native parsers, and records SHA-256 hashes in `dist/release-manifest.json`; it copies no cloud secret and bundles no agent executable.

After platform validation, host `Prentice-Mac.zip` and `Prentice-Windows.msi` and configure the website's `PRENTICE_DOWNLOAD_BASE_URL` to their HTTPS directory. Windows downloads remain disabled until `PRENTICE_WINDOWS_MSI_READY=1` is explicitly set. Unconfigured production download routes return 404. Packaging does not deploy anything.

## Checks and tests

```bash
npm ci
npm run typecheck
npm test
npm run lint -w @prentice/web
npm audit
npm audit --omit=dev
npm run build -w @prentice/web
```

Database/auth integration tests default to local Supabase. For that developer-only path, start Docker and run `npx --yes supabase@2.120.0 start` **before** `npm test`. For a dedicated hosted test project instead, set `PRENTICE_TEST_SUPABASE=hosted` and provide `.env.test` with the four Supabase/database variables. Tests create and delete disposable accounts; never point them at production or a shared staging project. `PRENTICE_SUPABASE_CLI` can name an installed CLI. Stop local Supabase only after the checks; preserve its volumes/data.

The production dependency audit currently has no known advisories. The full audit reports eight high-severity entries from the development-only `braces` chain (ESLint/shadcn); upstream has no patched `braces` release. Do not use forced major-version downgrades to hide this finding. Recheck the audit before publishing.

Most provider tests use recorded events and fake executables. The live Learning AI test is opt-in and requires an explicitly configured cloud/device token. `scripts/evaluate-*.mts` are optional quota-consuming model evaluations; keep their output outside this repository. Passing deterministic tests does not establish live agent compatibility, model correctness, email delivery, desktop signing, or installation on another computer.

## Current limitations

- Detailed history and repository paths stay on their original computer; another computer needs its own checkout and explicit project linking.
- Symbol extraction covers JavaScript and TypeScript. Other languages still have Git/file evidence.
- Understand and Explain-back depend on remote model availability. Independent review can still make mistakes; provisional feedback does not award reliable mastery.
- Agent command inspection occurs after reported activity and supplements the vendor sandbox. POSIX descendants that deliberately escape their process group are outside containment guarantees.
- Windows installer, upgrade/uninstall, signing, and process containment need real Windows validation before distribution. macOS release signing needs actual Apple credentials.

See [Architecture](docs/ARCHITECTURE.md) for boundaries and persistence, [Coding agents](docs/AGENTS.md) for adapter behavior, [Product intent](docs/BRAIN.md), and [Design system](docs/DESIGN_SYSTEM.md) for maintainer context.
