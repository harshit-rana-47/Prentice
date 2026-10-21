# Windows installer and release

The approved production format is a signed WiX MSI. `npm run package:win` builds an MSI candidate; `--release` requires signing and production HTTPS configuration. This implementation has not yet built or installed an MSI on a real Windows host. It must not be described as release-ready. The hosted Windows download stays disabled until `PRENTICE_WINDOWS_MSI_READY=1` is deliberately supplied after Windows lifecycle validation and publication of a signed artifact.

## Installation model

The MSI uses WiX Toolset 7.0.0 with no extensions, service, bootstrapper or custom actions. It is x64 and per-user, without administrator elevation, installing to `%LOCALAPPDATA%\Programs\Prentice`. The connector operates with the interactive user's vendor logins, repository access and Credential Manager entries. The authoring is `scripts/windows/Prentice.wxs`; `scripts/windows-msi.mjs` generates explicit file components with stable path-derived identities, HKCU key paths and empty-directory removal entries. This avoids the per-user ICE validation problem documented for automatic `Files` harvesting. [WiX scope](https://docs.firegiant.com/wix/schema/wxs/packagescopetype/), [Files harvesting](https://docs.firegiant.com/wix/schema/wxs/files/).

Payload: background `Prentice.exe`, bundled official Node 24.21.0 `node.exe`, bundled `connector.mjs`, compiled `process-guard.exe`, Windows x64 Tree-sitter N-API modules and their runtime dependencies, and public relay/website configuration. No agent binaries, vendor credentials, user state, repository or API keys are included. Visual C compiles the launcher and guardian with `/MT`; only Windows x64 native parser prebuilds ship. Packaging validates all executable/native payloads as x64 PE files. A missing or wrong-platform guardian aborts packaging; the installed connector also refuses agent execution without its guardian.

The MSI owns a Start Menu shortcut and HKCU `Software\Microsoft\Windows\CurrentVersion\Run\Prentice`, targeting the installed background launcher. Launch Prentice from the Start Menu after installation/upgrade; later sign-ins reconnect automatically. It does not run unattended coding tasks at startup. The launcher suppresses the connector's legacy scheduled-task registration, creates no self-copy and uses a hidden window to receive Restart Manager shutdown messages. The existing single-instance check prevents duplicate connectors. Node owner death causes the agent guardian to terminate its Job Object. Shutdown while a real agent edits, and nested process behavior, still require Windows execution.

## Upgrade and uninstall

The stable UpgradeCode is `792f9eec-9810-4c64-b71b-95803658550e`. Every product version must increment the three-part MSI version (major/minor <=255, build <=65535). WiX generates a new ProductCode per build. A larger version is a major upgrade; same-version builds should be repaired/reinstalled rather than used as upgrades. Downgrades are blocked. `RemoveExistingProducts` runs after `InstallInitialize`, so failed upgrades can roll back the previous application. [MajorUpgrade scheduling](https://docs.firegiant.com/wix/schema/wxs/majorupgrade/).

Uninstall removes MSI-owned application files, HKCU startup/component values and the shortcut/empty installation directories. It has no recursive delete of a user directory, no project paths and no credential deletion. `%USERPROFILE%\.prentice` and Windows Credential Manager entries remain across upgrades and uninstall, allowing a later reinstall to reconnect. Deleting this saved state is a separate user action.

Windows Installer Restart Manager remains enabled; the launcher accepts its shutdown messages and stops its connector. Automatic restart during uninstall/upgrade is disabled (`MSIDISABLERMRESTART=1`) to avoid resurrecting a removed application. Launch the new version from the Start Menu after upgrading. If processes cannot close, Windows Installer may require a restart; do not label an exit 3010 as failure or ignore a required reboot. Validate this with active sessions on Windows before release. [Restart Manager](https://learn.microsoft.com/en-us/windows/win32/msi/using-windows-installer-with-restart-manager), [restart suppression](https://learn.microsoft.com/en-us/windows/win32/msi/msidisablermrestart).

An old development ZIP is unmanaged by MSI. Stop its connector and remove its legacy `Prentice` scheduled task before adopting the MSI; the installer does not silently delete an unmanaged installation or task. The development ZIP remains available through `npm run package:win:zip`, requires `PRENTICE_WIN_GUARD_EXE`, and cannot use `--release`. It is recorded separately as `windows-development`, never as the production download.

## Build and signing

Use an x64 Windows host, Node >=22.13, a hydrated `npm ci` checkout, Visual Studio Build Tools with the x64 Native Tools environment, Windows SDK (SignTool), built-in `tar`, and .NET SDK with WiX 7.0.0 (`dotnet tool install --global wix --version 7.0.0`). Confirm the WiX binary-release license/OSMF requirements for your organization before installing or using that toolchain. The script checks the version; it does not install tooling or accept license terms. [WiX requirements](https://docs.firegiant.com/wix/).

Set `PRENTICE_CLOUD_URL` and `PRENTICE_WEBSITE_URL` to the intended public HTTPS endpoints. These are the only values embedded in the public configuration. For an unsigned local candidate, run `npm run package:win`. Unsigned candidate output is `dist/Prentice-Windows-unsigned.msi` (release output is `dist/Prentice-Windows.msi`, promoted only after signature verification); intermediate/generated authoring stays under ignored `dist/windows-stage`. Unsigned candidates are recorded separately as `windows-candidate`; the release manifest initially records `releaseReady: false`, because a build is not an installation test.

Signing requires an organization-owned code-signing certificate. No identity or timestamp authority is hardcoded. The built-in adapter `scripts/sign-windows.mjs` uses:

- `PRENTICE_WIN_CERT_SHA1`: certificate thumbprint from the current user's Personal certificate store.
- `PRENTICE_WIN_CERT_MACHINE_STORE=1`: only if the provisioned certificate is in the machine store.
- `PRENTICE_WIN_TIMESTAMP_URL`: operator-selected HTTPS RFC3161 timestamp endpoint.
- `PRENTICE_SIGNTOOL_EXE`: optional absolute SignTool executable; otherwise the SDK's `signtool` on PATH.

CI should provision the certificate/private key using its protected signing environment, set those variables plus the production public URLs, then invoke `npm run package:win -- --release`. PFX passwords and private keys never belong in the checkout or command arguments. No CI provider, certificate purchase or cloud signing service is chosen here.

All `.exe`, `.dll` and `.node` payloads are signed/verified before WiX embeds them: the launcher, Job Object guardian, Node runtime and native parser modules. The adapter appends signatures to preserve any official Node vendor signature. After WiX creates the embedded-cabinet MSI, the MSI itself is signed/verified. MSI signing authenticates the container; it does not replace executable signatures. The default verification is `signtool verify /pa /all /v`; any failure aborts the release and prevents its manifest entry. [WiX signing](https://docs.firegiant.com/wix/tools/signing/).

For a different existing signing facility, supply `PRENTICE_WIN_SIGNER` as an executable adapter. It receives `sign <absolute-file>` then `verify <absolute-file>`, using structured arguments without a shell. The adapter must fail nonzero for unsuccessful signing or invalid/untrusted Authenticode and must use SHA256 plus trusted timestamping. This is an interface, not an implemented cloud-signing integration.

## Windows validation before publication

Build the candidate and signed release on Windows; inspect the MSI tables and run its ICE validation (the build does not suppress ICEs). Verify fresh per-user install, Start Menu launch/pairing, subsequent sign-in/reconnect, singleton behavior, real provider execution and guardian Stop/connector-crash containment. Test a greater-version upgrade with paired state and credentials, downgrade refusal, repair, rollback on install failure, and uninstall with the connector/agent running. Confirm no further edits, no startup entry/task/shortcut left, all installed files removed, saved state/credentials preserved and user repositories untouched. Exercise reboot-required paths and inspect native addon/runtime dependency loading on a clean Windows machine.

Use disposable user state and repositories. Standard logging commands are `msiexec /i Prentice-Windows.msi /passive /norestart /L*v install.log` and `msiexec /x Prentice-Windows.msi /passive /norestart /L*v uninstall.log`; logs stay outside the repository. Preserve exit codes: 0 success, 3010 success with reboot required, other errors need investigation. Keep the full log when diagnosing an installer failure.

Only after build/signature/lifecycle checks pass, publish the signed MSI through the existing download-artifact location, retain its SHA256 manifest, and enable `PRENTICE_WINDOWS_MSI_READY=1` on the website. `/download/windows` redirects to `Prentice-Windows.msi`, never a ZIP. There is no automatic update service: upgrades are explicitly installing a newer signed MSI. Packaging does not deploy infrastructure.
