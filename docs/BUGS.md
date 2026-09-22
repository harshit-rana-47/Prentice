# Bugs

Real defects hit while building Prentice. Do not add a hypothetical bug. Status is Fixed, Open, or Regressed.

## Activity stream aborted while leaving a task

Date:
2026-09-23

Context:
The workspace subscribes to `GET /v1/tasks/:id/events` and aborts that fetch when the task changes.

Symptoms:
Leaving the task surface reported an activity-stream failure.

Evidence:
The client raised `AbortError` with message `BodyStreamBuffer was aborted`. The abort sat outside the read loop's error handling, so it surfaced as an unhandled failure.

Root cause:
A normal client cancellation was treated as an application error.

Fix:
`readTaskStream` in `apps/web/lib/prentice.ts` returns when `signal.aborted` is set or the error name is `AbortError`. The effect also ignores the returned rejection.

Lesson:
Closing an SSE response is not a task failure.

Status:
Fixed

## Web client cannot import the domain package

Date:
2026-09-23

Context:
The learning panel needed debug issues. The first attempt imported `@prentice/domain` from the client.

Symptoms:
Next failed to compile the workspace.

Evidence:
`Module not found: Can't resolve './activity.js'`, and the same failure for the other domain files. `apps/web/next.config.ts` already had `transpilePackages: ["@prentice/domain"]`. Domain source imports its own TypeScript files with `.js` specifiers.

Root cause:
The Next bundler does not map those `.js` specifiers back to the `.ts` sources. `transpilePackages` does not fix that.

Fix:
Debug issues are computed in `publicTask` in `apps/runtime/src/session.ts`. The client reads `task.issues`. The web workspace dependency on `@prentice/domain` was removed. The `transpilePackages` entry is still in the Next config and does not make the import work.

Lesson:
A workspace package that Node and `tsx` can run is not automatically a Next client dependency.

Status:
Fixed

## Runtime token no longer matches the process that is listening

Date:
2026-09-23

Context:
`apps/runtime/src/main.ts` writes a new bearer token to `~/.prentice/runtime.json` every time the process starts. The UI loads that file through `/api/local-session`.

Symptoms:
The workspace showed the runtime as offline, with "The local runtime session is missing or expired." A second `npm run dev` logged `EADDRINUSE` on port 4731.

Evidence:
An old runtime kept port 4731. A new process rewrote `runtime.json` and then exited because it could not bind. The UI token and the token checked by the surviving listener were different. Reloading after a single listener was started made the workspace work again.

Root cause:
The token file is replaced at process start, before a successful bind is the only listener. Two starts desynchronize the file from the process that still holds the port.

Fix:
None in code. The recovery used was to stop the extra listener, leave one runtime running, and reload the UI. The 401 message already says to restart Prentice and reload.

Lesson:
Do not start a second runtime to "refresh" a session. The file update is not tied to a successful bind.

Status:
Open

## Sandbox cannot create git hooks during tests

Date:
2026-09-23

Context:
`apps/runtime/src/server.test.ts` runs the fixture loop in a temporary git repository.

Symptoms:
`npm test` failed in the restricted sandbox.

Evidence:
`Command failed: git init` and `.../.git/hooks/: Operation not permitted`. The same test passed when the command was allowed to leave the sandbox.

Root cause:
`git init` creates `.git/hooks`, and the sandbox blocks that write. The test is written correctly. The environment is what failed.

Fix:
Run the runtime tests outside the sandbox. No product code changed.

Lesson:
A git-based test can fail before the assertion if the environment cannot create a repository.

Status:
Open

## Cursor status probe warned when the SDK was absent

Date:
2026-09-23

Context:
Account status calls `Cursor.auth.status()` through a dynamic import of `@cursor/sdk`.

Symptoms:
The runtime log repeated `Cannot find package @cursor/sdk` while the UI correctly had room to show Cursor as disconnected.

Evidence:
The probe caught the import error and logged a warning for every status check. The package is not installed in this runtime.

Root cause:
A missing optional SDK was logged as an unexpected failure.

Fix:
`cursorLoggedIn` in `apps/runtime/src/accounts.ts` stays silent when the message includes `Cannot find package`, and returns disconnected. Other auth failures are still logged.

Lesson:
An optional integration that is not installed is a disconnected account, not a warning on every poll.

Status:
Fixed

## Learning sidebar used the plural for one file

Date:
2026-09-23

Context:
After the fixture run, Understand summarized the git result in the Prentice checklist.

Symptoms:
The row read "1 files changed" and "1 concepts introduced".

Evidence:
The fixture adds one file and one symbol, `attachSessionNote` in `prentice-fixture/session-note.ts`. The sidebar interpolated the counts with fixed plural nouns.

Root cause:
`LearningSidebar` in `apps/web/components/learning-panel.tsx` did not switch form for a count of one.

Fix:
The detail line uses "file" or "files", and "concept" or "concepts". The workspace showed "1 file changed" and "1 concept introduced" after the change.

Lesson:
A count that comes from the diff has to be grammatical at one, because the fixture path is a one-file change.

Status:
Fixed
