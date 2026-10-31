# Mac connector recovery: investigation and rollout

## Confirmed failure mechanism

The hosted website remembers a paired computer in Supabase, but its online status comes from the authenticated connector WebSocket in the cloud relay. Visiting the website cannot start a native Mac process. A healthy Render HTTP endpoint therefore does not imply that a paired computer is reachable.

The previous Mac startup path ran `installLoginItem()` and then continued starting a foreground connector. Registering the login item also started another connector. Both attempted to bind `127.0.0.1:4732`. If the foreground process won, the launchd process detected the existing Prentice page and exited with status 0. Its `KeepAlive.SuccessfulExit = false` configuration then left it stopped. After the foreground process ended, no supervised connector remained. Later launches treated a loaded registration as healthy even when it had no PID.

This mechanism was reproduced with the actual connector as subprocesses: start a foreground connector, start the managed connector on the same port, and observe the managed process exit with code 0. The regression failed before the fix and passes afterward. A separate test reproduced the installer returning without starting an exited job. These explain the previously observed `not running`, `last exit code = 0`, and absent port 4732. No historical process log was retained, so the precise event that stopped the user's earlier foreground instance cannot be established.

Additional confirmed defects:

- macOS Keychain read errors were all converted to `null`. A locked/unavailable Keychain or timeout could be interpreted as a permanently missing relay credential, ending automatic resume. Reads now return `null` only for a missing/empty item and propagate temporary errors to the existing retry loop. A real diagnostic lookup confirmed that missing items return shell status 44.
- Relay clients had no deadline for a stalled connection/authentication and no application acknowledgement deadline for a socket that stayed open while traffic stopped. The connector also reported connected before its authentication completed.
- The website discarded connection-error details and rendered every non-null status as an offline Mac, including a dropped connection to the cloud.

## Resulting behavior

- Opening the packaged Mac app registers or starts the launchd job, waits for its local health endpoint, opens its local page, and exits. It does not become another connector. A managed launch skips registration entirely.
- The job uses `KeepAlive = true`; macOS supervises recovery after a clean exit or a crash. Reopening the app starts a registered job with no PID without killing a running job.
- If an older foreground instance owns the pairing port, the managed process stays alive, logs the conflict, and takes over when the port is released. It never kills the older instance's tasks.
- Existing identity files, active-account selection, Keychain service/account names and access permissions, device tokens, and SQLite history are preserved. Revoked credentials still require pairing; temporary network/database/Keychain failures do not erase credentials.
- After WebSocket authentication, an application `ping` is acknowledged by the relay. Clients retry a connection/authentication that exceeds 15 seconds, and an authenticated connection with no valid incoming frames for 75 seconds. Keepalive runs every 25 seconds. Reconnects use exponential backoff capped at 30 seconds. Old socket events cannot affect a replacement connection.
- Connector online logging occurs only after an authenticated relay acknowledgement or request. Browser online status still requires the relay's device-presence frame; a ping acknowledgement alone does not mark the Mac online.

## Logs and intentional stopping

Packaged Macs retain JSON logs under `~/.prentice/logs/`:

- `connector.log` and `connector.log.1`: managed process startup, authenticated connection, reconnection reason, temporary resume failures, signals and normal exit. Each file is limited to approximately 1 MiB for ordinary log records and has mode 0600.
- `launcher.log` and `.1`: app-open/registration failures and readiness checks, with the same rotation.
- `startup.log`: launchd stdout/stderr, including errors that happen before the structured logger starts. This fallback file is not rotated by the structured logger.

To intentionally stop the service, unload its job instead of killing the process (which macOS now restarts):

```bash
launchctl bootout "gui/$(id -u)/com.prentice.connector"
```

Open the installed app to register/start it again. To disable future login startup, use macOS Login Items & Extensions. Do not delete `~/.prentice` or Keychain items when updating or diagnosing this issue.

## Required rollout order

**The backend, Mac application, and website all need their corresponding changes deployed.** The backend update is backward compatible with older clients. The updated clients expect application ping acknowledgements, so deploy the backend first.

1. Review and commit the intended source changes, preserving unrelated work already present in the checkout, and push the fixed revision to the branch deployed by Render and Vercel. No database migration or credential reset is required.
2. In [the Prentice Render service](https://dashboard.render.com/web/srv-dbd1vh7b9u1s73d8nc50), select **Manual Deploy → Deploy latest commit** (automatic deployment was disabled during the investigation). Wait for **Live**, and verify:

   ```bash
   curl --fail --max-time 20 https://prentice-cloud.onrender.com/health
   ```

   Expect `{"ok":true,"role":"cloud"}`. This checks HTTP health only; the client acknowledgement/recovery tests verify the WebSocket behavior.
3. Deploy the same fixed source to the Vercel production project serving [prentice-peach.vercel.app](https://prentice-peach.vercel.app). Keep its existing public Supabase and cloud settings. This publishes the browser watchdog and accurate connecting/reconnecting status. Follow the project's normal Git production deployment or run `vercel --prod` from its linked project.
4. Build the updated Mac beta on macOS, using a fully downloaded checkout outside iCloud if dependencies or cached archives are evicted:

   ```bash
   npm ci
   PRENTICE_CLOUD_URL=https://prentice-cloud.onrender.com \
   PRENTICE_WEBSITE_URL=https://prentice-peach.vercel.app \
   npm run package:mac -- --beta
   ```

   Outputs: `dist/Prentice-Mac.zip` and `dist/release-manifest.json`. The beta has an ad-hoc integrity signature; it is not Apple notarized. The package contains both ARM64 and Intel Node runtime slices. Verify the archive hash against the manifest before distributing it.
5. Publish the ZIP and manifest under a **new release tag**, and set Vercel's production `PRENTICE_DOWNLOAD_BASE_URL` to that release's asset directory, then redeploy the website. Example directory shape: `https://github.com/harshit-rana-47/Prentice/releases/download/NEW_TAG/`. The website's existing default download still points to beta 4; it will not serve this fix until the override or default is updated. Do not overwrite an old release artifact.

## Apply and verify on MacBook Air M1

The verified build from this investigation is saved at `dist/connector-recovery/Prentice-Mac.zip`, with `dist/connector-recovery/release-manifest.json`. Deploy the backend first, then use this ZIP for the steps below. Its SHA-256 is `0fe3d944ca7d578fef7fe0d4baaa7ec5cdb212c2e3c9e9641897a602c6269d7d`. It was built from the current workspace, including work that was already uncommitted before this investigation.

1. Finish any running coding tasks before updating. Extract the newly built ZIP into a new temporary folder and open **that** `Prentice.app`. Its launcher replaces the application under `~/Applications`, updates the job registration, and starts the managed service. Follow the existing per-app approval flow for this unsigned beta if macOS requests it. Do not remove the saved account or pair again unless the credential was actually revoked.
2. Check the installed job and local page:

   ```bash
   launchctl print "gui/$(id -u)/com.prentice.connector"
   curl --fail http://127.0.0.1:4732/health
   tail -n 30 "$HOME/.prentice/logs/connector.log"
   ```

   Expect a running job with a PID, `Prentice local connector`, and `Relay authenticated; connector is online`. An occupied-port warning means an older foreground connector still owns the port; identify and quit that instance after its tasks finish. The managed process should then take over automatically.
3. Open the hosted website with the previously paired account. Confirm it reaches your existing workspace/projects. Close and reopen the website repeatedly, and open `~/Applications/Prentice.app` several times. The managed PID should remain the same during these repeated app opens.
4. With no active tasks, test crash recovery. Use **only the PID shown by the Prentice launchctl job**, then run `kill -KILL PID`. Within the launchd throttle interval plus startup time, expect a new PID, a successful local health request and the hosted workspace reconnecting without re-pairing.
5. Turn Wi-Fi off and back on, then sleep/wake the Mac. Verify reconnection and an authenticated-online log entry without re-pairing. A backend or authentication service outage may extend recovery until that service is healthy.
6. Log out/in or restart the Mac with Prentice allowed under Login Items & Extensions. Verify the service starts before opening the native app, and that the hosted workspace is usable. Verify your previous project/history remains present.

## Verification boundaries

Automated checks include subprocess ownership/port takeover, loaded-but-stopped registration, Keychain failure classification, bounded redacted logging, stalled authentication, silent connections, stale socket events, temporary backend failures, revocation/supersession, browser presence and end-to-end browser → relay → connector → SQLite/Git recovery.

An opt-in macOS test registers a uniquely named temporary launchd job running the actual updated connector, verifies restart after clean exit and SIGKILL, and removes the job afterward:

```bash
PRENTICE_TEST_LAUNCHD=1 NODE_OPTIONS=--experimental-sqlite \
node_modules/.bin/vitest run apps/connector/src/launchd.integration.test.ts
```

This test passed during the investigation. It does not establish reboot/login behavior, Wi-Fi switching, sleep/wake behavior, or end-to-end operation of a released artifact with the user's real Supabase session. Those remain the explicit Mac acceptance checks above. The user's installed app and production deployments were not replaced as part of verification.

### Recorded results — 1 November 2026

The original dependency tree and cached runtime archive contained iCloud `dataless` files that stalled reads. Final broad checks used a copy of the current source under `/tmp/prentice-verify.cNu8zC`, with a successful clean `npm ci` using the existing lockfile. The workspace's dependency tree was not replaced.

| Check | Result |
| --- | --- |
| Connector/cloud/protocol tests excluding three Supabase-dependent files | 370 passed; two opt-in/platform tests skipped |
| Latest packaged lifecycle tests, including repeated app bootstrap | 4 passed |
| Existing localhost `workspace.get` relay contract | Passed; Supabase cases not selected |
| Full web suite | 62 passed |
| Actual macOS launchd clean-exit and SIGKILL recovery | Passed with isolated job/data/port; job removed afterward |
| Packaging contract tests | 6 passed |
| Root `npm run typecheck` | Passed for domain, protocol, connector, cloud, and web |
| Production Next.js 16.4.3 build | Passed |
| Web ESLint | Zero errors; one existing internal-navigation warning |
| Mac beta packaging | Passed, including deep/strict code-signature verification |
| Extracted beta smoke test | Bundled Node v24.21.0 on ARM64; managed mode; local health HTTP 200; clean exit 0 |
| Bundled Node architectures | ARM64 and x86_64; execution tested on ARM64 only |
| Copied release ZIP checksum | Matches release manifest |

Supabase-dependent tests were not run because the local Docker daemon was unavailable. No production account was created or deleted to substitute for an isolated test database. No production deployment, real-app replacement, logout/reboot, sleep/wake, or physical Wi-Fi change was performed.
