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
Debug issues are computed in `publicTask` in `apps/connector/src/session.ts`. The client reads `task.issues`. The web workspace dependency on `@prentice/domain` was removed. The `transpilePackages` entry is still in the Next config and does not make the import work.

Lesson:
A workspace package that Node and `tsx` can run is not automatically a Next client dependency.

Status:
Fixed

## Runtime token no longer matches the process that is listening

Date:
2026-09-23

Context:
`apps/connector/src/main.ts` writes a new bearer token to `~/.prentice/runtime.json` every time the process starts. The UI loads that file through `/api/local-session`.

Symptoms:
The workspace showed the runtime as offline, with "The local runtime session is missing or expired." A second `npm run dev` logged `EADDRINUSE` on port 4731.

Evidence:
An old runtime kept port 4731. A new process rewrote `runtime.json` and then exited because it could not bind. The UI token and the token checked by the surviving listener were different. Reloading after a single listener was started made the workspace work again.

Root cause:
The token file is replaced at process start, before a successful bind is the only listener. Two starts desynchronize the file from the process that still holds the port.

Fix:
`apps/connector/src/main.ts` writes `runtime.json` inside the listen callback. A second process that fails with `listen EADDRINUSE` exits without replacing the file. Checked on port 4741: the first token was unchanged after the failed start.

Lesson:
Do not publish a new runtime token until the process is the one listening.

Status:
Fixed

## Sandbox cannot create git hooks during tests

Date:
2026-09-23

Context:
`apps/connector/src/server.test.ts` runs the fixture loop in a temporary git repository.

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
`cursorLoggedIn` in `apps/connector/src/accounts.ts` stays silent when the message includes `Cannot find package`, and returns disconnected. Other auth failures are still logged.

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

## Untracked file line count was one higher than the diff

Date:
2026-09-23

Context:
The verified Codex session added `hello.txt` and did not commit it.

Symptoms:
Understand said `Added hello.txt (+2 / -0)`. The unified diff showed one added line.

Evidence:
`git diff --no-index` against `/dev/null` showed `hello from prentice` as a single `+` line. `collectDiff` counted `content.split("\n").length` for untracked files. A trailing newline made that 2.

Root cause:
The empty string after the final newline was counted as a line.

Fix:
`lineCount` in `apps/connector/src/git.ts` drops that empty trailing piece.

Lesson:
An untracked-file counter has to match the diff hunk, because that is the change record the user sees.

Status:
Fixed

## Opening an earlier repository left the previous one active

Date:
2026-09-23

Context:
The explorer opens a local git path with `POST /v1/project`. The workspace reads `latestProject()`, which is the row with the newest `opened_at`.

Symptoms:
Opening a new folder worked. Opening `/Users/harshitrana/Desktop/Prentice-test` again, after another folder was opened, left the explorer on the other folder.

Evidence:
With Lumen already open, the post for Prentice-test logged `openedName: Prentice-test`, `latestName: Lumen`, `openedIsLatest: false`. The next workspace refresh still applied Lumen. After the fix, the same post logged `openedIsLatest: true` and the refresh applied Prentice-test. Switching Lumen → Prentice-test → Lumen → Prentice-test in the explorer followed each path.

Root cause:
`upsertProject` returned an existing row and did not update `opened_at`, so an earlier repository never became the latest one.

Fix:
`upsertProject` in `apps/connector/src/store.ts` sets `opened_at` to the current time when that path is opened again. `server.test.ts` opens two repositories and opens the first one again, then checks `GET /v1/workspace`.

Lesson:
"Open" has to change which saved project is current, including a project that was opened before.

Status:
Fixed
