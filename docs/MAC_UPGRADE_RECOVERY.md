# Mac background-service upgrade recovery

The 0.1.2 installation on the affected Mac succeeded, but its service upgrade failed. At 2026-10-31T20:41:09Z, the launcher logged `launchctl bootstrap failed (exit 5)`. macOS launchd recorded `Operation already in progress` (37), then removed the previous `com.prentice.connector` job a few milliseconds later. No replacement job or listener remained. This explains why accepting Open Anyway did not restore connectivity.

`launchctl bootout` acknowledges an unload request before the job has actually disappeared. The previous implementation bootstrapped immediately afterward. The original recovery tests exercised crash recovery and an initially unloaded job, so they missed this upgrade transition.

## Behavior in 0.1.3

- Serialize registration across simultaneous app opens with an installation lock. Detect dead owners and PID reuse; write the plist atomically.
- On configuration or app-version changes, request bootout and wait for launchd to report that the old job is absent before bootstrap. This is a bounded state transition check, not a fixed startup delay.
- Include the app version in the job's configuration so replacing a bundle at the same path upgrades the running process too.
- Require a live managed PID and a health response owned by that PID before reporting readiness. An older foreground connector's local page cannot satisfy the new installer's check.
- Keep the existing one-owner architecture, KeepAlive, credential handling, relay recovery, pairing and data locations.
- Log registration phases and preserve launchctl's actual stderr. A native startup error dialog offers retry or directs the user to Login Items when macOS reports `requiresApproval` through `SMAppService.statusForLegacyURL`.
- After the managed connector is ready, move exact integrity-verified copies of the installed release in Downloads to recoverable Trash. Compare complete code-directory seals after strict verification. Keep unrelated apps, modified copies, different releases, symlinks, and the installed app. Persistent Prentice data is never part of this cleanup.

## macOS permissions

Gatekeeper's Open Anyway approval and permission to run in the background are different controls. Prentice cannot override either. If background execution is disabled, enable Prentice in System Settings → General → Login Items & Extensions, then open the installed app. The app now explains this requirement instead of silently exiting. Normal website visits do not launch native software.

This beta is ad-hoc signed, without Developer ID signing or notarization. Distribution without repeated unidentified-developer warnings requires the maintainer to provide a valid Developer ID signing identity and notarization credentials. Packaging already refuses a production release without both. No valid signing identity was available on the affected Mac during this investigation. Do not disable Gatekeeper or clear quarantine as an installation shortcut.

## Regression verification

The opt-in real macOS launchd test starts a legacy fixture whose shutdown is asynchronous. It first reproduces the old immediate-bootstrap failure with exit 5. It then upgrades through the corrected installer and verifies a new managed PID and automatic recovery after clean exit and SIGKILL. It uses a unique job label, disposable data/port and removes its job afterward.

```sh
PRENTICE_TEST_LAUNCHD=1 NODE_OPTIONS=--experimental-sqlite \
  npx vitest run apps/connector/src/launchd.integration.test.ts
PRENTICE_TEST_MAC_INSTALLER=1 npm run test:packaging
```

The native packaging test uses disposable signed apps to verify that exact-copy cleanup moves only the matching download to Trash, preserves installed/unrelated/tampered apps, then removes its own fixtures. Unit/subprocess tests cover concurrent opens, dead/reused lock-owner PIDs, version changes, slow unloads, missing job PIDs, failed registration, and PID-bound health checks.

These tests passed on macOS 27.0.1, Apple Silicon. They do not establish physical reboot/login, sleep/wake, or production-account reconnection until those acceptance checks are actually performed. See the local rollout report for deployment and installed-app results.
