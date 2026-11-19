# Phone app readiness

Notes from the `feat/mobile-ready` pass (2026-11-11): what the phone app is, how it stays in step with the desktop app
and the account service, every bug found and fixed, the App Store checklist item by item, and what is left for the
owner. Status words used below: **pass** (was already right, checked), **fixed** (wrong, changed on this branch),
**needs owner** (needs an account, a key, a decision or another branch), **unverified** (could not be checked here).

The short version: the app now builds, pairs by camera on an iPhone, recovers its connection, notices when it is
removed, and keeps read state honest. **It must not be submitted yet**: the release gate
fails on copied material that other branches are replacing, the account service the sign-in screen talks to is not
deployed, and nothing here ran on a real iPhone or in a simulator. The ordered list is under "What blocks submission".

## 1. Architecture

The phone app is the React app's phone layer (`src/mobile/`) inside a Capacitor shell (`apps/mobile/`). The web bundle
is built into the app; the app never loads its interface from a server.

```text
 phone app (WKWebView, bundled UI)
   AccountGate ........ the hosted account (dusk.bot), optional by build flag
   ConnectionGate ..... picks the saved workspace, installs its transport, or shows pairing / unreachable
   MobileApp .......... the shared store (same reducer as the desktop) under the phone's own screens
        |
        |  one of four transports, all behind the page's own fetch and EventSource
        v
   https .............. the workspace's public address (your server, a hosted address, a Dusk Cloud computer)
   companion .......... the Mac's sidecar on the same Wi-Fi or tailnet (http, port 8810, allowlisted routes)
   relay .............. link.dusk.bot, frames sealed on the phone (AES-GCM, key from X25519) and opened on your server
```

### What each side keeps

| Where | What | Notes |
|---|---|---|
| Phone, preferences | Saved workspaces (label, routes, device id), which one is active, the outbox per workspace, the push registration it last sent, haptics, intro seen | Not secret |
| Phone, Keychain | The session token per workspace, the relay key pair per workspace, the account grant | `@aparajita/capacitor-secure-storage` |
| Workspace (your computer or server) | Bots, chats, files, routines, approvals; the list of paired phones with each one's session, relay channel and push token; who is away | The only copy of the content |
| Link relay | Channel ids and verifiers, queued sealed frames | Cannot read frames; keeps nothing after delivery |
| Account service | The account, its sessions (one per signed-in phone), enrolled workspaces | Deployed by the owner; not live today |

### How the three stay in step

- **One store, one stream.** The phone runs the same store as the desktop. It reads a snapshot (`GET /api/bots`) and
  then follows the workspace's event stream (`/api/events`) from the snapshot's cursor. A stream that cannot resume says
  so and the store reads a fresh snapshot. Everything a person sees on either client is a frame from the same stream.
- **Sends are idempotent.** Each message carries a `sendId`; the workspace stores a `sendId` once. The phone's outbox
  keeps what has not been answered and sends it again with the same id.
- **Read state lives on the workspace.** A client marks a chat read when the chat is in front of the person
  (`src/lib/chat-in-front.ts`).
- **Removal lives on the workspace.** Removing a phone revokes its session and deletes its relay channel.
- **Push is decided by the workspace** from the phone's presence beats (docs/phone-push.md).
- **The account** is checked at launch and each time the app returns to the front.

## 2. Sync: what was checked, what was wrong, what is still open

Two runs drive real clients:

- `node --experimental-strip-types scripts/mobile-two-client-e2e.ts` (new): the desktop renderer and the phone app, each
  in its own headless Chrome, on one isolated fixture. **33/33 checks pass.**
- `node --experimental-strip-types scripts/mobile-sync-e2e.ts` (existing): a stand-in phone through the relay and
  through the companion sidecar, including removal. **34/34 checks pass.**

| Area | Status | Evidence |
|---|---|---|
| Phone to desktop, desktop to phone, bot reply on both | pass | two-client run: "it shows on the desktop", "it shows on the phone", replies on both, each stored once |
| Read and unread, list order and preview | **fixed** | bug 4 below; two-client run fails on exactly the two unread checks without the fix |
| Bots renamed or deleted on one side | pass | two-client run (rename and delete reach both). Create from the phone: unit tested only |
| Outbox while offline | pass | two-client run: written offline, not on the server, then on the server and the desktop exactly once. Unit tests in `src/mobile/outbox.test.ts` cover retries and the give-up |
| Back from the background | pass (browser) | two-client run freezes the phone page, sends meanwhile, wakes it. **Unverified on a device**, where iOS suspends the web view |
| Network change, sleeping Mac, workspace restart over the relay | **fixed** | bug 2 below (unit tests). Not driven end to end |
| Phone removed from the desktop | **fixed** | bug 3 below (unit tests, plus the existing run proves the server side) |
| Signing out or deleting the account elsewhere | **fixed** | bug 11 below (unit tests) |
| Pairing a second phone | pass | each pairing is its own device and session on the workspace (`server/mobile/link.ts`); not driven with two phones |
| Push for the right bot, opening the right chat | **unverified** | the tap target is parsed and opened (`MobileApp.tsx`, `notificationTarget`); needs APNs keys and a device |
| Permission asks answered once | **unverified here** | the phone renders the shared approval card and the workspace refuses a second answer (server tests). Not driven with two clients: the fake engine's approval recipe was not wired into the run |
| Group chats, attachments and file cards across two clients | **unverified here** | rooms render and send on the phone (fixture); file upload and download are in the existing run. Not driven with two clients |
| Routines switched on or off | **unverified here** | the routines sheet reads the same store; not driven |
| A Dusk Cloud computer that is asleep | **fixed** (wording), **unverified** | the store stops reconnecting to a sleeping Cloud by design, and the phone's home said "Reconnecting" though it was not trying. It now says "Asleep · wakes when you type", then "Waking up", from the same power state the desktop reads (`src/lib/cloud-power.ts`). Not checked against a real Cloud computer |

### Bugs found and fixed

1. **The phone bundle did not build.** `src/mobile/account/account-client.ts` imports the sign-in helpers from
   `electron/cloud-signin.mjs`, which gained a `node:crypto` import on 2026-11-10. `pnpm mobile:build` failed, so no
   store build was possible. The node-only function moved to `electron/cloud-signin-link.mjs`. CI only typechecked the
   phone app; it now builds it too (`.github/workflows/ci.yml`).
2. **A phone on the relay never reconnected.** Any failed poll or post closed the relay channel for good
   (`src/mobile/transport/relay.ts`), so backgrounding the app, a change of network or a relay restart left it on
   "Reconnecting" until it was force-quit. A link (epoch, sequence, poll loop) now ends alone and the next request starts
   another, which the relay already reads as the writer restarting. Three new tests in `relay.test.ts`.
3. **A phone removed on the computer did not notice until its next cold start.** Only the desktop shell listened for the
   ended session. The connection gate now hears it (a refused request, or a refused event stream), checks the session
   once, and leaves for pairing with "This phone was unlinked". Over the relay, removal deletes the phone's channel, so
   a relay answer of "no such channel" now means removed, not offline (`RelayGoneError`). Tests in
   `ConnectionGate.test.ts`, `pair.test.ts`, `transport.test.ts`, `relay.test.ts`.
4. **The last chat opened was always marked read.** Leaving a chat on the phone left it selected in the store, which
   marks every reply to the selected chat read while the app has focus. The chat never showed unread on the phone, lost
   its unread dot on the desktop too, and its notification was dropped. One predicate now decides whether the selected
   chat is in front of the person; the phone's list covers it. Found by the two-client run.
5. **No QR scanner on iPhone.** `@capacitor-mlkit/barcode-scanning` ships for CocoaPods only and the iOS project links
   plugins as Swift packages, so the plugin was never in the app and pairing fell back to typed codes. The app now has
   its own scanner on AVFoundation (`ios/App/App/QrScannerPlugin.swift`), behind the same viewfinder. No scanning SDK
   ships on iOS. Tests for the session logic in `camera.test.ts`; the camera itself is **unverified** (no device).
6. **Template art.** The app icon and launch image were Capacitor's own. They are now drawn from the brand vector by
   `apps/mobile/scripts/make-icons.mjs` (iOS icon without alpha, light and dark launch images, Android icons and launch
   images).
7. **Pairing with a Mac on the same Wi-Fi or over Tailscale could not work on iOS.** Plain http to a local address was
   blocked by App Transport Security and there was no local network purpose string. Info.plist now allows local
   networking and http to `ts.net` names, and explains the local network prompt. **Unverified** on a device.
8. **No push entitlement, no privacy manifest, no export compliance answer.** Added (section 4).
9. **Dead end and plan link in Settings.** "All settings" closed the sheet and opened nothing (the phone never draws
   the desktop's settings window). It is gone. "Account dashboard" opened the page that sells plans; it no longer shows
   in the iOS or Android app. A shared card that asks for the computer app's settings ("Connect your subscription" on a
   failed reply) now opens a short note saying where that lives.
10. **Sign-in buttons that led nowhere.** The phone showed Google, Apple and X whether or not the service had them
    switched on. It now asks the service, shows none when it cannot ask, and on an iPhone shows another company's
    sign-in only beside Sign in with Apple (guideline 4.8).
11. **An account signed out or deleted elsewhere stayed signed in** until the app was relaunched. The account is checked
    again each time the app comes back; a refused token returns to sign-in, a network failure keeps the account.
12. **The status bar did not follow the look.** Changing Appearance, or the system changing it, left the clock and
    battery in the old colour. It follows now.
13. **Pairing ids without the fallback** (`crypto.randomUUID()` on a page that is not a secure context); the repo's own
    guard test was red on this. Uses the shared helper.
14. **Declared but unsupported:** iPad and landscape were declared and never designed; the photo library purpose string
    had no use; `armv7` was the required capability. Now iPhone only, portrait, `arm64`.
15. **Android:** cloud backup of app data was on (the saved workspace list would travel to a new phone without its
    keys); no portrait lock; template icons. Fixed in the manifest and resources; the debug build succeeds. Not run on a device or emulator.
16. **Development leftovers in a build:** the phone preview page was built into the bundle, and the installed app read
    the preview's URL switches. The page is no longer an entry of the build; the installed app ignores the switches.

### Observed, not changed

- The desktop renderer keeps two visible text boxes on a fresh fixture ("Describe any job..." beside the composer) and a
  full-screen welcome layer until the welcome flow is done. Test drivers must mark the welcome done and aim at the
  composer by its placeholder. Not a phone matter.
- Message action buttons in a chat row (reply, copy, more, react) measure 36 x 36 css px in the phone layout
  (`src/components/`, shared with the desktop). WCAG 2.5.5 asks for 44. Fix: give them `min-width: 44px;
  min-height: 44px` inside `.dusk-mobile [data-mobile-chat]`, as `mobile.css` already does for the composer's buttons.
  Left alone because it changes the shared transcript's row layout.
- `docs/ios-companion.md` and `docs/ios-privacy.md` describe an earlier Swift companion ("DuskMobile": a Share
  extension, Bonjour discovery, Password AutoFill credential entry). The Capacitor app has none of those. Read them as
  history until someone rewrites them.

## 3. Quality pass

| Item | Status | Evidence |
|---|---|---|
| Safe areas, home indicator | pass | `viewport-fit=cover`; every bar and sheet pads with `env(safe-area-inset-*)` (`mobile.css`) |
| Keyboard in chat | **unverified** | native will/did events drive the transcript and composer (`keyboard.ts`); needs a device |
| Swipe back, pull to refresh, sheet drag | pass (code), **unverified** (feel) | springs carry release velocity (`NavStack.tsx`, `Sheet.tsx`, `gesture.ts`) |
| Long threads at 60fps | **unverified** | the page mounts offscreen and slides once it has painted (`NavStack.tsx`); needs a device and a long thread |
| Haptics | pass | one tap as a message leaves, one as a reply lands, a tick on switches, an error buzz; collapsed within 40 ms; a Settings switch turns them off |
| Dark and light | **fixed** (status bar) | screenshots in `docs/store/ios/*/04-dark.png` and the light set |
| Larger Text | **fixed**, **unverified** on device | the page's text zoom follows the system body size, 90 to 135 percent (`text-scale.ts`). Checked at 135 percent in headless Chrome: home, chat and settings hold, nothing clips |
| VoiceOver names | pass | a sweep of intro, pairing, code entry, sign-in, home, room, create and search found no control without a name and no image without alt text |
| Touch targets | **fixed** (one of mine) and one finding | the demo pill was 32 tall, now 44. Message action buttons: see "Observed" |
| Reduced motion | pass | `MotionConfig reducedMotion="user"`, CSS branches, the nav stack cross-fades instead of sliding |
| Orientation, iPad | **fixed** | portrait only; iPhone only (`TARGETED_DEVICE_FAMILY = 1`) |
| Empty and error states | pass | empty home, skeleton, unreachable screen with retry and countdown, pairing errors by cause |
| First run | pass (browser) | intro, pairing by camera or 12 character code or pasted link, sign in to Dusk Cloud |
| Dead ends, placeholder text, debug UI | **fixed** | bugs 9, 10 and 16 |

## 4. App Store checklist

### 2.1 App completeness

| Item | Status | Notes |
|---|---|---|
| Builds | **fixed** | bug 1. `xcodebuild -sdk iphonesimulator -configuration Debug` succeeds |
| Crashes | **unverified** | nothing was launched on iOS |
| Placeholder art and text | **fixed** | bug 6 |
| Links work | **needs owner** | https://dusk.bot/privacy, /terms and /docs must be live and final (the legal pages are marked "Draft for legal review" in docs/LAUNCH.md) |
| Reviewer can use it without a Mac | **needs owner** | the built-in demo workspace was removed. App Review needs a live review workspace (a long-lived typed code in the notes) or a review account with a dusk cloud. Steps are in docs/store/ios-listing.md |
| Demo account | **needs owner** | give a review account and a way to get its code, or a review workspace kept running for the whole review |

### 4.2 Minimum functionality

| Item | Status | Notes |
|---|---|---|
| Not a web page in a wrapper | pass | the interface is bundled; navigation is a native-feeling stack with interactive swipe back, bottom sheets, long-press menus |
| Works offline | pass | the outbox; the unreachable screen |
| Push | **needs owner** | the entitlement is in; APNs keys go on the link service (docs/phone-push.md) |
| Haptics, share sheet | pass | `@capacitor/haptics`, `@capacitor/share` ("Open on desktop" in a row's menu) |
| Camera QR pairing | **fixed**, **unverified** on device | bug 5 |
| Needs another product to be useful | note | it is a companion to the desktop app; say so in the description (done in the draft) and give reviewers a live review workspace |

### 3.1.1 In-app purchase

| Item | Status | Notes |
|---|---|---|
| Prices, upgrade buttons | pass | every plan, price and upgrade card in the shared code renders only with the desktop bridge (`window.duskDesktop.cloudAccount`), which the phone does not have. Checked by walking the phone's import graph for the components that carry plan or price strings |
| External purchase links | **fixed** | the dashboard link is off in the store apps (`accountRows` in `SettingsSheet.tsx`, tested) |
| Wording | pass | the phone says "Bot API comes with a higher plan" and similar status lines with no link or price. Acceptable as status text; reword if a reviewer objects |
| Account deletion page | **needs owner** | "Delete account" opens `dusk.bot/account#delete` in the in-app Safari view. That page's sidebar links to "Plans & billing". Ask the dashboard branch for a page with the delete section alone, or a delete call the app's own token may make (today `POST /v1/account/delete` needs a website session) |

### 4.8 Sign in with Apple, 5.1.1 accounts

| Item | Status | Notes |
|---|---|---|
| Third-party sign-in offered | conditional | Google shows only if the service has it on |
| Sign in with Apple beside them | **fixed** in the app, **needs owner** on the service | the iPhone app hides Google unless Apple is on too (`providersFor`, tested). Configure Apple on the account service before turning the others on |
| Apple's button | **fixed** | Apple's mark, "Continue with Apple", white fill, first in the list on iPhone |
| Account creation in the app | yes | the email code creates an account when sign-up is open |
| Account deletion in the app | **fixed** to the allowed minimum, **needs owner** for better | Settings, Account, Delete account: a confirm page, then the account page's delete section on the web (Apple allows finishing on the web with a direct link). See the 3.1.1 row above |
| Login required | **needs owner (decision)** | the app is built to require an account before pairing. Pairing a phone with your own computer does not need one, and 5.1.1(v) says apps should not require a login for features that do not need it. See "Owner decisions" |

### 5.1 Privacy

| Item | Status | Notes |
|---|---|---|
| Privacy manifest | **fixed** | `ios/App/App/PrivacyInfo.xcprivacy`: no tracking; UserDefaults reason CA92.1 (the Preferences plugin, which ships no manifest of its own); collected data types as in the label draft |
| SDK manifests | pass | Capacitor and Cordova frameworks and `keychain-swift` ship their own. Searched every plugin's iOS source for the required-reason APIs: only Preferences uses one |
| Camera string | **fixed** | covers the pairing scan and taking a photo to attach |
| Microphone string | pass | dictation, voice notes and voice calls use `getUserMedia` audio |
| Local network string | **fixed** | bug 7 |
| Bonjour | pass (not declared) | the app never browses for services; it dials the address in the pairing code |
| Photo library string | **fixed** (removed) | attachments use the system picker, which needs no permission |
| Tracking | pass | none; no App Tracking Transparency prompt needed |
| Privacy policy link in the app | **fixed** | on the sign-in screen and in Settings, About |
| Nutrition label | drafted | docs/store/ios-listing.md |
| AI data sharing (5.1.2) | note | the phone sends messages only to the person's own workspace; the AI is the one they connected there. Said in the review notes; make sure the privacy policy says it too |

### Build settings and capabilities

| Item | Value | Status |
|---|---|---|
| Bundle ID | `bot.dusk.mobile` | pass |
| Version, build | 1.0, 1 | pass; raise the build per upload |
| Minimum iOS | 17.0 | **fixed** (was 15): the relay needs X25519 in WebCrypto, which arrived in iOS 17. On 15 and 16 a server reached through the relay could not pair |
| Devices | iPhone | **fixed** |
| Orientation | portrait | **fixed** |
| `ITSAppUsesNonExemptEncryption` | `false` | **fixed**; reasoning in docs/store/ios-listing.md, owner confirms |
| Background modes | none | pass: alert pushes need none, and the app does no background work |
| Push entitlement | `aps-environment` | **fixed**; Xcode switches it to production when it exports for the store |
| Associated domains | `applinks:dusk.bot`, `applinks:dusk.bot` | **fixed** in the app, **needs owner** on the site |
| App icon | 1024, no alpha, our own art | **fixed** |
| Launch screen | light and dark, our own art | **fixed** |
| Private APIs | none | pass: the app's own Swift is `QrScannerPlugin.swift` (AVFoundation) and the two delegates |
| Web bundle logging | off | pass: `loggingBehavior: "none"` keeps tokens out of device logs |

**Universal links.** The app reads `https://dusk.bot/m/open?bot=...&thread=...` and `https://dusk.bot/m/pair#...` (also
on `dusk.bot`) as the `duskbot://` link each stands for (`appLinkFromUniversal`, tested). A pairing secret is only
taken from after the `#`, which a browser never sends to the site. The site needs:

1. `docs/store/apple-app-site-association.json` served as `https://dusk.bot/.well-known/apple-app-site-association` and
   the same on `dusk.bot`: content type `application/json`, no redirect, no file extension, with `TEAMID` replaced
   by your Apple team id.
2. Pages at `/m/open` and `/m/pair` for someone without the app ("Get Metal for iPhone"). The `/m/pair` page must
   never read, log or send the part after the `#`.

Nothing on the desktop makes these links yet; pairing codes and notifications still use `duskbot://`.

### Legal: copied material

The audit (`GROK-COPY-AUDIT.md`) found xAI's typefaces, Anysphere's icon font, six sounds, the mascot engine, captured
mascot bodies, file glyphs and app logos in the app, all of them in the phone bundle. I did not replace any of them
(branch `chore/own-assets` and the mascot work do); the phone layer uses the avatar and icon components only through
their public interfaces, and refers to the default skins through `THEME_SKINS`, so those swaps land underneath.

**The release gate.** `apps/mobile/scripts/release-gate.mjs` inspects a built bundle and fails on:

- any file whose content matches a flagged file (61 SHA-1 hashes in `flagged-assets.txt`: the three fonts, six sounds,
  51 logo PNGs and `1password.svg`), whatever it is renamed to;
- the flagged font families (`XVF`, `X VF`, `X Mono VF`, `Grok Icons`, `Cursor Icons`) named in CSS or script, and their
  file names;
- literals that survive minifying from the copied engine (`mascot-motion-engine.js`), the captured bodies
  (`shared/grok-bodies.ts`) and the file-kind glyphs (`file-kind-glyphs.ts`);
- development leftovers: the preview page, source maps, a live-reload address in `capacitor.config.json`.

It also reads `scripts/testing/third-party-asset-hashes.txt` once `chore/own-assets` has merged, so the two guards share
one list. The Xcode **Release** configuration runs it as its first build phase (`ios/App/release-gate.sh`); there is no
switch to skip it. `pnpm mobile:gate` runs it by hand and `pnpm mobile:release` builds, gates and syncs.

Evidence: on this branch `xcodebuild -configuration Release` stops with "release gate: this bundle must not go to a
store (53 findings)", and `scripts/testing/mobile-release-gate.test.ts` (7 tests) covers each rule.

**What must merge before a store build is allowed** (the gate turns green only when all of it has):

1. `chore/own-assets`: the two xAI typefaces, the icon font and its glyph map, the six sounds, the file-kind glyphs, the
   app logos.
2. The mascot engine and bodies (the audit's package B): `src/components/mascot-motion-engine.js` and
   `shared/grok-bodies.ts` replaced by our own engine and shapes.
3. Then run `node apps/mobile/scripts/release-gate.mjs --record` only if new flagged files were found; it never drops a
   hash it already knows.

Not enforced by the gate, and still the owner's call before a public release (the audit's medium findings): the default
skins named and measured from Grok (`grok`, `grok-dark`), the per-hue palette tables, the onboarding strings that match
Grok's, and the Grok Bot logo in the import dialog. The skin ids are visible in the bundle as plain strings.

### Store listing and screenshots

- Listing drafts, age rating answers, privacy label answers, export compliance and review notes:
  `docs/store/ios-listing.md`.
- Screenshots: `docs/store/ios/6.9/` (1320 x 2868) and `docs/store/ios/6.5/` (1284 x 2778), five each: the team, a chat,
  a room, dark, pairing. They are the app's real screens against an isolated fixture with the test bots, drawn by
  `apps/mobile/scripts/store-shots.ts` in a headless Chrome at the store sizes. **They are not simulator captures**: a
  browser draws no status bar and no home indicator. Retake them in
  the simulator before submitting (steps below).

## 5. Android, quick check

| Item | Status |
|---|---|
| Target SDK 36, minimum 24 | pass for Play's current target requirement |
| Permissions | INTERNET, CAMERA, VIBRATE, POST_NOTIFICATIONS. **Gap:** no RECORD_AUDIO, so dictation, voice notes and calls cannot work in the Android app; add it (with MODIFY_AUDIO_SETTINGS) or hide those controls |
| Cleartext | **Gap:** http to a Mac on the same Wi-Fi is blocked on Android 9 and later; needs a network security config that allows local addresses, as iOS now has |
| Backup | **fixed**: `allowBackup="false"` |
| Orientation | **fixed**: portrait |
| Icons and launch images | **fixed**: our own |
| Payments policy | pass: same build rule as iOS, no purchase link |
| Account deletion | **needs owner**: Play also wants a web address where an account can be deleted without the app; the account page serves |
| Data safety form | **needs owner**: the same answers as the iOS label, plus what Google's ML Kit scanner module collects (the Android scanner is ML Kit; iOS has none) |
| Push | **needs owner**: `google-services.json` and an FCM service account (docs/phone-push.md) |
| Release signing, minification | **needs owner**: no signing config; `minifyEnabled false` |
| Build | pass: `./gradlew assembleDebug` succeeds with these changes (debug APK only; nothing was installed or run) |

## 6. What was proven, and how

| Check | Command | Result |
|---|---|---|
| Phone bundle builds | `pnpm mobile:build` | pass |
| iOS app compiles for the simulator | `xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED |
| Release build stops at the gate | same with `-configuration Release` | BUILD FAILED at "Release gate", 53 findings (intended) |
| Typecheck | `pnpm typecheck`, `pnpm --filter @metal/mobile typecheck` | pass |
| Lint | `pnpm lint` | 0 warnings in files this branch touched; the command still exits 1 on 6 warnings that are on `main` in files this branch did not touch (`src/components/chat-bubble.ts`, `server/first-message-job.ts`, `apps/dashboard/server/pages/*`, `apps/cloud-service/scripts/lifecycle-sim.ts`) |
| Tests for everything this branch changed | `pnpm exec vitest run src/mobile shared/mobile-link.test.ts src/lib/chat-in-front.test.ts src/lib/random-uuid.test.ts scripts/testing/mobile-release-gate.test.ts scripts/ci-workflow.test.ts src/components/account-gate` | 22 files, 295 tests, all pass |
| Renderer, shared, Electron, companion and link service tests | `pnpm exec vitest run src shared electron apps/companion apps/link-service` | 937 of 952 files pass (9676 tests pass, 24 fail). The same 24 tests in the same 15 files fail on the base commit `b40320d40` (run there from an export of it), so none is new; the `random-uuid` guard that was red on the base is green here |
| Electron node tests | `pnpm test:electron`, `pnpm check:electron` | 1662 tests, 0 fail; 396 modules syntax-checked |
| Whole `pnpm test` | `pnpm exec vitest run && pnpm broker:test && pnpm test:electron && pnpm test:packaged-server` | **not completed.** The full vitest run (2398 files, with the slow `server/*.e2e` files) was stopped after about an hour on a busy machine. This branch changes nothing under `server/`. Of the server files that did run: `server/drivers/agents-proxy.test.ts` fails 3 of 160 (also on the base), `server/index.test.ts` fails 3 of 307 when run alone (165 under load). `broker:test` and `test:packaged-server` were not run |
| Android debug build | `cd apps/mobile/android && ./gradlew assembleDebug` | BUILD SUCCESSFUL |
| Two real clients | `node --experimental-strip-types scripts/mobile-two-client-e2e.ts` | 33/33 |
| Relay and companion routes | `node --experimental-strip-types scripts/mobile-sync-e2e.ts` | 34/34 |
| Screens at phone size | headless Chrome, 390 x 844 and the store sizes | home, chat, room, create, search, notifications, settings, sign-in, pairing; light, dark, 135 percent text |

**Not done: the simulator run.** This Mac has Xcode 27.2 and the simulator SDK but no simulator runtime
(`xcrun simctl list runtimes` is empty). I started `xcodebuild -downloadPlatform iOS` (noted, several GB); it sat at
"Preparing to download" for the whole session and never produced a runtime, so nothing was booted, no flow was walked
on iOS and no `simctl` screenshot exists. There is also no signing identity on this Mac
(`security find-identity -p codesigning` lists none), so no archive was made.

To do the simulator pass once a runtime is in:

```sh
xcodebuild -downloadPlatform iOS                       # once; check with: xcrun simctl list runtimes
cd apps/mobile && pnpm build && npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/dusk-dd CODE_SIGNING_ALLOWED=NO build
UDID=$(xcrun simctl create "Dusk 6.9" "iPhone 17 Pro Max")   # headless: never open Simulator.app
xcrun simctl boot "$UDID"
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl install "$UDID" /tmp/dusk-dd/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch "$UDID" bot.dusk.mobile
xcrun simctl io "$UDID" screenshot docs/store/ios/6.9/01-your-team.png
xcrun simctl openurl "$UDID" "duskbot://open?view=settings"          # a deep link
xcrun simctl push "$UDID" bot.dusk.mobile payload.apns               # a push, with a payload file
```

Taps cannot be sent with `simctl`; walk the flows by deep link and by building with
`DUSK_MOBILE_DEV_URL=http://localhost:5320` so a headless driver can reach the page, or do the tap-through on a device.

## 7. What blocks submission today, in order

1. **Copied material.** The release gate fails until `chore/own-assets` and the mascot engine replacement merge.
2. **The account service is not deployed** (dusk.bot is a placeholder), so the sign-in screen cannot sign anyone in.
   Deploy it, or ship the phone app without the sign-in screen (decision 1 below).
3. **Nothing ran on iOS.** Install a simulator runtime and do the pass above, then a real iPhone pass: camera scan, the
   local network prompt, the keyboard in chat, Larger Text, haptics, a push opening its chat, a universal link.
4. **Apple developer setup** (owner only): the app id `bot.dusk.mobile` with Push Notifications and Associated Domains,
   an APNs key on the link service, the App Store Connect record, signing.
5. **Legal pages final**: the privacy policy and terms are drafts with placeholders.
6. **The delete-account page** should not show plan links (dashboard branch), and Sign in with Apple must be configured
   before Google or X are switched on.
7. **Screenshots** retaken in the simulator.
8. **Site**: the association file and the `/m/` pages, if universal links are wanted for 1.0 (they can wait: the
   entitlement is harmless without the file).

## 8. Owner decisions

1. **Should the phone need an account?** Today the native app shows sign-in before pairing unless it is built with
   `VITE_DUSK_ALLOW_SIGNED_OUT=1`. Pairing with your own computer needs no account. Shipping 1.0 signed-out removes
   blockers 2 and 6, the demo-account question, and two rows of the privacy label; the account can come back when Dusk
   Cloud needs it on the phone. My recommendation is to ship 1.0 signed-out.
2. **Minimum iOS 17.** Needed for the relay. Lower it only if relay pairing is given another key agreement.
3. **Links in the in-app Safari view** raise the age rating answer for web access. Opening them in Safari itself avoids
   that.
4. **The Grok-named default skins and palette** in a public build (not gated).
5. **Android microphone**: add the permission or hide voice on Android.

## 9. Steps left for the owner

1. Merge `chore/own-assets` and the mascot work; run `pnpm mobile:release` until the gate prints "is clean".
2. Decide 1 to 5 above. For a signed-out build: `VITE_DUSK_ALLOW_SIGNED_OUT=1 pnpm mobile:release`.
3. In the Apple developer account: register `bot.dusk.mobile`, turn on Push Notifications and Associated Domains, make
   an APNs key (docs/phone-push.md), and let Xcode manage signing for the App target.
4. Open `apps/mobile/ios/App/App.xcodeproj` in Xcode, select your team, Product, Archive. The Release gate runs first.
   Validate, then upload from the Organizer. (This pass uploaded nothing.)
5. In App Store Connect: create the app, paste the fields from docs/store/ios-listing.md, answer App Privacy and the
   age rating from the same file, upload the retaken screenshots, fill the review notes and contact, attach the build.
6. Test the build from TestFlight on a real iPhone against your own Mac before you press Submit.
7. Android, when wanted: fix the two gaps in section 5, add signing, build an AAB, fill the Data safety form.
