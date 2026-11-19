# Releasing

For a normal release, run **Actions → Prepare next release → Run workflow** and
choose a patch, minor, or custom version. It opens a tiny version-bump PR;
merging that PR automatically starts **Release** and assembles a draft from the
exact merge commit. Review and publish the draft when it is ready.

The existing **Actions → Release → Run workflow** button remains available for
reruns and recovery. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
receive it, and assembles the canonical draft in
[Metal releases](https://github.com/parasource-si/metal/releases).
Tick **publish** to publish the release immediately, or leave it unticked to
review the draft first.

The release commit must have passed CI on every platform: the **CI passed on
the release commit** job waits (while the platforms build) for a ci.yml run
whose `CI` check passed with every Linux, Windows and macOS shard, on the
pinned commit or a commit with the same tree, and stops the release before any
draft if the commit's CI failed. A push to main runs the Linux shards only, so
unless the release branch's own CI (started by **Prepare next release**) or a
nightly run covered the same tree, the job runs the full CI on the commit
itself on a temporary `release-ci/v<version>` branch, which takes about as
long as the platform builds. After a flaky failure, re-run the failed CI jobs;
a release still waiting picks up the new attempt, and a release that already
stopped needs only `gh run rerun <id> --failed`. `ship_without_ci` skips the
wait, for emergencies only. See [CI job selection](ci.md#main-and-releases).

The workflow refuses to overwrite an already-published version. Manual Release
runs still require `package.json`'s version to be bumped on the selected ref.
A release is rejected if any installer, stable download
name, size, or digest is absent or inconsistent.

GitHub generates the release body (the changelog) from pull requests since the previous tag. Write PR titles for
people: they become the release notes on the downloads repo.

## Downloads

The [Metal GitHub release](https://github.com/parasource-si/metal/releases) is
the canonical download page. Each release includes the installers, stable
download names, browser archives, and SHA256SUMS.

Run scripts/publish-downloads.sh v<version> to verify a published release
against its build artifact. Set DUSK_DOWNLOADS_REPO only if you also operate
a separate mirror.

### The Mac browser part

The Mac installers leave out the bots' browser (agent-browser and Chromium's headless shell, about 92 MB zipped).
`pnpm package:mac` runs `scripts/pack-browser-part.mjs`, which signs it with the release's Developer ID (hardened
runtime), zips it as `Metal-<version>-browser-darwin-<arch>.zip` in `release/`, and writes the `parts.json` the app
ships, pinning the zip's size and SHA-256 and the signing team. Both release paths notarize the zip and upload it with
the installers. Metal fetches it from the fork release on its first
open (`server/app-parts.ts`) and uses it only after the size, SHA-256 and every Mach-O's signature check out. A release
without these zips leaves new Mac installs without a browser. Windows and Linux still bundle the browser (Linux's
AppArmor profile is bound to its install path).

### Desktop updates

Metal checks the fork's GitHub releases and opens the matching release when
an update is available. Install it from the release page. Automatic updates
require a Metal signing key and configured release feed.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## Bundled browser gates

Desktop builds also stage a pinned engine and Chromium Headless Shell before
packaging. Pre-signing checks validate complete resources and upstream hashes;
native browser smoke tests and macOS signature checks run on the packaged
output. See [browser packaging](browser-packaging.md) for update ownership,
license provenance and Linux sandbox constraints. Missing browser resources
must fail the build, not ship an installer that downloads them on first use.

## One-time setup: release secrets

Set these in **Metal → Settings → Secrets and variables → Actions**.

The **Prepare next release** workflow also needs
**Settings → Actions → General → Workflow permissions → Allow GitHub Actions
to create and approve pull requests** enabled. The workflow only creates the
version PR; it never approves or merges it.

The Mac signing secrets, exactly these names (the Mac job signs, notarizes and staples only when
`MAC_CERT_P12_BASE64` is set; without it the build is ad-hoc signed):

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | base64 of `~/.config/duskbot/apple/developer-id.p12` |
| `MAC_CERT_PASSWORD` | `APPLE_DEVELOPER_ID_P12_PASSWORD` from `~/.config/duskbot/dusk.env` |
| `APPLE_API_KEY_P8_BASE64` | base64 of the App Store Connect API key (`AuthKey_<KEYID>.p8`) |
| `APPLE_API_KEY_ID` | the key's Key ID |
| `APPLE_API_ISSUER_ID` | the Issuer ID for a Team key; leave unset for an Individual key |

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

Use a Developer ID Application certificate for the Metal release. Export the
certificate and its private key as a password-protected PKCS#12 file. Set the
corresponding Actions secrets in the fork.

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI: revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** (Developer role is enough for notarizing; App Manager also covers TestFlight uploads), or an
   Individual Key under your own user
3. Download the `.p8` (one chance only) into `~/.config/duskbot/apple/`, `chmod 600` it, and fill in `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER` (Team keys only) and `APPLE_API_KEY_PATH` in `dusk.env`

```sh
source_env() { sed -n "s/^$1=//p" ~/.config/duskbot/dusk.env; }
base64 -i "$(source_env APPLE_API_KEY_PATH)" | gh secret set APPLE_API_KEY_P8_BASE64 -R parasource-si/metal
source_env APPLE_API_KEY_ID | gh secret set APPLE_API_KEY_ID -R parasource-si/metal
source_env APPLE_API_ISSUER | gh secret set APPLE_API_ISSUER_ID -R parasource-si/metal   # Team keys only
```

### 3. `DUSK_RELEASE_SIGNING_KEY`

The Ed25519 release key (`kid:<pkcs8 base64url>`) whose public half is pinned in
`apps/cloud-service/src/release-signing.ts` and `server/update-check.ts` (a test keeps them equal). The assemble job
can sign `latest.json` with it when a Metal release-signing key is configured. A new key:
`node apps/cloud-service/scripts/keygen.mjs rel-2027-01 ~/.config/duskbot/keys`, pin the printed public key in both
files, ship an app with it, and only then switch the secret.

### Releasing the Mac app from this Mac (no Actions)

`scripts/release-mac-local.sh` does the whole Mac job locally: build both arches, sign with the Developer ID from a
throwaway keychain (deleted on exit; the login keychain is never used, so nothing prompts), check every nested
Mach-O (hardened runtime, team, secure timestamp, no unsigned code inside zips or jars, the expected entitlements),
notarize the apps with `notarytool` and staple them, put each stapled app into its dmg
(`scripts/mac-dmg-swap-app.sh`, which keeps the dmg layout), notarize and staple the dmgs, re-zip the stapled apps for
the updater, then run Gatekeeper the way a downloaded copy meets it (`spctl` on the app and the dmg, `stapler
validate`, the same again with the quarantine flag set, and `syspolicy_check distribution`). On success it sets
`"macNotarized": true` in `apps/site/releases.json`; commit that with the release.

```sh
scripts/release-mac-local.sh --check         # what is present, what is missing, and where to get it
scripts/release-mac-local.sh --dry-run       # ad-hoc signed, every check that needs no Apple credentials
scripts/release-mac-local.sh --no-notarize   # Developer ID signed, not notarized (no API key needed)
scripts/release-mac-local.sh                 # signed, notarized, stapled: release/Metal-<v>-{arm64,x64}.{dmg,zip}
```

Output lands in `release/` (plus `release/notary/*.json`, Apple's notarization logs, and `release/SHA256SUMS-mac`).
Nothing is uploaded; attach the dmgs, zips and the stable `Metal.dmg` / `Metal-intel.dmg` copies to the release.

### Entitlements

`build/entitlements.mac.plist` covers the app and, through `entitlementsInherit`, every nested executable
(Electron helpers, the speech helper, cua-driver, cloudflared, adb, the headless browser, native modules):

| Entitlement | Why |
|---|---|
| `cs.allow-jit` | V8 in the app, its helpers and the headless browser |
| `cs.disable-library-validation` | the server (the app run as Node) loads native modules; bots may load ones they install |
| `device.audio-input` | dictation (the speech helper and the composer) |
| `automation.apple-events` | `osascript`: opening Terminal, reading the screen size, bots driving apps the person allows |

`cs.allow-unsigned-executable-memory` is deliberately absent: the app run as Node with only these entitlements and the
hardened runtime ran optimized JIT code, WebAssembly and DuckDB on arm64 and x64 (2026-11-14). Add it back only with a
crash that proves the need. No camera, location, contacts or calendar access is used on the Mac (`electron/app-permissions.mjs` keeps camera off).
The matching purpose strings are in `mac.extendInfo` in `build/electron-builder.yml`.
