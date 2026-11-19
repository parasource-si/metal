# Upstream Dusk Bot launch notes

The deployment details below refer to the original Dusk Bot services. See [Releasing Metal](releasing.md) for this fork.

What the launch branch (`w15/launch`) did, and what needs the owner's accounts, keys or decisions. Each owner step is
written to be done in order. **Done** means committed and checked; **Owner** means it needs you.

## At a glance

| Area | Done in code | Owner |
|---|---|---|
| Release pipeline | CI and release workflows, signed update manifest, update notice, download publishing script | Apple and GitHub secrets, public downloads repo, first release |
| Hosted services | Health check, data export, CSP, proxy-safe rate limits, config template, backup, log rotation, uptime checks | Deploy with real keys, install backup and monitor, staging |
| Observability | Scrubbing error reporter in the account service, its page, desktop, server and phone app (all off without a DSN) | Pick and create the error tracker, set the DSN, desktop Settings toggle |
| Legal and trust | Terms, privacy, cookies, refunds, acceptable use, subprocessors, license and security policies (Markdown in `docs/legal`, live on dusk.bot), security.txt, account export | Processor DPAs, privacy@ and security@ mailboxes |
| Product polish | No-AI screen copy, dashboard offline and error states, landing site, installer docs | The items under "Polish not done" |
| Security | Rate-limit bypass, workspace claim takeover, installer https pinning, link service bind, dependency advisories, history secret scan | Redeploy the link service, the CI reds listed below |

## 1. Release pipeline

### Done

- `.github/workflows/`: `ci.yml` (on pushes to main and PRs: CI selection tests, locales, lint, source guards,
  typecheck, Electron syntax, account dashboard and phone typecheck and page tests, UI build, Linux test shards,
  packaged-server smoke; macOS and Windows shards weekly and on demand to save private-repo minutes),
  `release.yml` (macOS arm64 and x64 signed with the Developer ID certificate, notarized and stapled through the App
  Store Connect API key; Windows x64 NSIS; Ubuntu deb and AppImage; every artifact verified; a draft release),
  `prepare-release.yml` (version bump PR, which starts the release when merged), `package-linux.yml`,
  `package-win.yml`, `windows-defender-check.yml`, `ci-stop-closed.yml`. Secrets are read only from GitHub Actions
  secrets. `scripts/ci-workflow.test.ts`, `ci-scope.test.ts` and `release-ci.test.ts` pass against them.
- Versioning: `package.json` version, bumped by **Actions > Prepare next release**. Changelog: GitHub's generated
  release notes from PR titles (docs/releasing.md).
- Update strategy: the desktop server reads `https://dusk.bot/releases/latest.json` (at most hourly; the app asks
  daily), accepts it only when a pinned Ed25519 release key signed a `desktop` manifest, and offers a newer version
  with a link to dusk.bot/download: once per version as a notification, and in the profile menu. Nothing is
  downloaded or installed for the person. The release job writes `SHA256SUMS` and the signed `latest.json` (artifact
  `dusk-site`); `scripts/publish-downloads.sh v<version>` verifies and publishes them.
- Download page: https://dusk.bot/download (links to the public downloads repo's `/releases/latest/download/`).

### Owner

1. **Apple Developer Program** (if not already): a Developer ID Application certificate for bundle id
   `bot.dusk.app`. Export it from Keychain as .p12 with a strong password.
2. **App Store Connect API key** for notarization: Users and Access > Integrations > App Store Connect API >
   Team Key, role Developer. Download the .p8 once; note Key ID and Issuer ID.
3. In **github.com/DuskBotAI/duskbot > Settings > Secrets and variables > Actions** add (as of 12 November 2026 the
   repo's only Actions secret is `DUSK_RELEASE_SIGNING_KEY`, set 13 November 2026, so `release.yml` signs `latest.json`
   but cannot sign or notarize the Mac build yet):
   `MAC_CERT_P12_BASE64` (`base64 -i DeveloperID.p12 | pbcopy`), `MAC_CERT_PASSWORD`,
   `APPLE_API_KEY_P8_BASE64` (`base64 -i AuthKey_XXXX.p8 | pbcopy`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`,
   `DUSK_RELEASE_SIGNING_KEY` (done: the private half of the pinned key `rel-2026-11`, also in dusk.env `[local]`; if it is ever lost, make a new
   one with `node apps/cloud-service/scripts/keygen.mjs rel-2026-12 ~/.config/duskbot/keys`, pin the printed public
   key in `apps/cloud-service/src/release-signing.ts` and `server/update-check.ts`, then set the secret).
   Optional: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit) to let main pushes deploy the Composio broker.
4. **Settings > Actions > General**: allow GitHub Actions to create pull requests (for Prepare next release).
5. **Billing check**: private repos get 2,000 free Actions minutes a month; macOS minutes count 10x, Windows 2x. A
   release costs roughly 300 to 600 counted minutes. Set a spending limit you are comfortable with, or the release
   stops when the quota runs out. Note: `ubuntu-24.04-arm` (one weekly job) may need paid larger runners on a private
   repo; delete that job if it does not start.
6. **Windows signing** (decision): builds are unsigned, so SmartScreen warns "unknown publisher". Options: Azure
   Trusted Signing (about USD 10 a month, needs a verified organization) or an OV/EV certificate. Wire it into
   `release.yml`'s Windows job when chosen.
7. **Public downloads repo**: `gh repo create DuskBotAI/duskbot-releases --public --description "dusk bot downloads"`.
8. **First release**: Actions > Prepare next release > patch; merge the PR; when the draft is ready, review and
   publish it; then on the Mac `DRY_RUN=1 scripts/publish-downloads.sh v<version>` and without `DRY_RUN`. Then
   remove the "Downloads open with the first public release" line from
   `apps/site/pages/download.html` and run `apps/site/deploy.sh landing`.
9. **Store listings** (only if wanted): Mac App Store and Microsoft Store are not set up (the app is distributed
   directly); the phone app (Capacitor, `apps/mobile`) needs an App Store Connect app record for its bundle id, a
   Google Play developer account (one-time USD 25), screenshots, the privacy nutrition label (use
   https://dusk.bot/privacy and `docs/ios-privacy.md`), and push credentials (APNs key, FCM service account).

## 2. Hosted services (dusk.bot, preview.dusk.bot)

### Done

- `GET /v1/health` on the account service (200 while its data folder is writable).
- Rate limits now use the proxy's own `X-Forwarded-For` entry (was the client's, so every per-IP limit could be
  skipped). Cookies: session HttpOnly, SameSite=Lax, Secure on https; CSRF header per session; JSON and same Origin on
  every mutation. A strict CSP on the page (own scripts plus the theme script by hash, `connect-src 'self'`,
  `frame-ancestors 'none'`), Permissions-Policy and COOP.
- `deploy/account/production.env.example`: every setting the service reads, what it does, no values (a test keeps it
  complete).
- `deploy/account/backup.sh` + `dusk-backup@.{service,timer}`: one daily set per instance (`dusk`, `make`): a fresh
  read-only `mongodump`, the listed data folders, encrypted to an age public key, uploaded to every rclone destination
  (Oracle box over SFTP and Cloudflare R2), 7 dailies + 4 weeklies kept. `backup-alert.mjs` sends one email when a set
  starts failing and one when it works again. Env names in `backup.env.example`; `backup-install.sh` installs.
- `deploy/account/logrotate.conf` for the dusk apps' logs.

### Owner: deploy the account service

One public origin, `https://dusk.bot`: the site at `/` (the waitlist page before launch), the dashboard at
`/dashboard`, the owner's admin at `/admin`, the API at `/v1` and `/api`. `preview.dusk.bot` is the staging copy with
the same paths and the full marketing site. `app.dusk.bot`, `dev.dusk.bot` and `www.dusk.bot` point at the same service
and redirect (app to `/dashboard`, dev home, www to the apex); old `/app/...` and `/app/admin/...` links redirect too.

1. On the VPS the service runs on `/opt/node24` (it runs TypeScript directly).
2. Fill the `[production]` part of `~/.config/duskbot/dusk.env` (0600; names from `deploy/account/production.env.example`
   with a `_PRODUCTION` suffix, shared values in `[account]`, see `deploy/env.mjs`): production uses
   `MONGODB_DB=dusk_prod` (its own writer lease) with the `dusk_prod` user, `DUSK_WAITLIST_DB=dusk` for the admin's
   waitlist view, `DUSK_DASHBOARD_PAGE_BASE=/dashboard`, `DUSK_SITE_UPSTREAM=http://127.0.0.1:3103` (dusk-landing).
3. `deploy/account/deploy.sh production` (or `preview`), then `curl -fsS https://dusk.bot/v1/health`.
   The deploy key must be able to read the private repo (a read-only deploy key on the repo).
4. **Brevo**: add and authenticate the domain dusk.bot (its Brevo code, DKIM and a DMARC record
   `v=DMARC1; p=quarantine; rua=mailto:hello@dusk.bot`) in DNS, create an API key.
5. **Dodo Payments**: live mode products for each plan id in `shared/billing-api.ts`; webhook
   `https://dusk.bot/v1/billing/webhooks/dodo` with its secret; business verification and payout details
   (payment details are yours to enter).
6. **Sign in with Google / Apple** (optional): register the callbacks
   `https://dusk.bot/v1/auth/oauth/{google,apple}/callback` (and the preview.dusk.bot ones) and set the client names in the env file.
7. **Mailboxes**: done 2026-11-10: Cloudflare Email Routing forwards every @dusk.bot address (MX on Cloudflare).
8. **Backups**: done 2026-11-13. `dusk-backup@dusk.timer` and `dusk-backup@make.timer` run daily (04:17 UTC + up to
   20 min) on the VPS; config in `/etc/dusk-backup/` (root-only: `<set>.env`, `rclone.conf`, `alert.env`,
   `make-mongo.yaml`). Destinations: the Oracle box (`/srv/dusk-backups/data/<set>/`, SFTP-only chrooted user
   `duskbackup`) and R2 bucket `dusk-backups` (token scoped to that bucket, Object Read & Write). The age private key is
   only on the Mac at `~/.config/duskbot/backup-age.key`; keep a copy in your password manager, without it no backup
   can be opened. Re-install after changing the scripts: `deploy/account/backup-install.sh`. Restore:
   ```sh
   ssh contabo 'RCLONE_CONFIG=/etc/dusk-backup/rclone.conf rclone cat r2-backup:dusk-backups/dusk/daily/<file>' > <file>
   age -d -i ~/.config/duskbot/backup-age.key <file> | tar -xz -C <empty folder>   # files/ and mongo/<set>.archive.gz
   mongorestore --gzip --archive=<folder>/mongo/<set>.archive.gz --uri <a throwaway or stopped service's mongod>
   ```
9. **Log rotation**: `cp deploy/account/logrotate.conf /etc/logrotate.d/dusk && logrotate -d /etc/logrotate.d/dusk`.
10. **Rate limits at the edge** (optional, defence in depth): a `limit_req` zone on `/v1/auth/` in deployd's nginx
    template; the service already limits, an hour, sign-in starts (60 per IP, 15 per email, one per address every
    30 s), code checks (150 per IP; each code dies after 5 wrong tries), OAuth starts (150 per IP), desktop sign-in
    requests (90 per IP), sign-in mail overall (600, `DUSK_AUTH_MAIL_PER_HOUR`), enrolls (30) and page error reports
    (60). The numbers live in `AUTH_LIMITS` (apps/dashboard/server/auth/index.ts) and are set so a real person never
    meets them; the per-code tries and the resend wait are the abuse guard.
11. **Staging on dev.dusk.bot**: the same deploy as `dusk-account-dev` with `--domain dev.dusk.bot`,
    `DUSK_DASHBOARD_PUBLIC_URL=https://dev.dusk.bot`, `DUSK_DASHBOARD_DATA=/var/lib/dusk-account-dev`,
    `DUSK_ENVIRONMENT=staging`, `DUSK_DODO_MODE=test` with test keys, `DUSK_AUTH_SIGNUP_OPEN=0` and your own account,
    its own Resend sender and no `DUSK_MANAGED`. The desktop app's staging Cloud already points at dev.dusk.bot.
12. **Link service**: redeploy `link.dusk.bot` from this branch so it serves the https-pinned installer and listens on
    127.0.0.1 (`HOST` env to override). The live link service still serves the older installer at `/i/<code>`.

## 3. Observability

### Done

- `electron/error-report.mjs`: one scrubbing reporter for a Sentry-compatible endpoint (sentry.io or self-hosted
  GlitchTip). An event holds the error type, a scrubbed message (no secrets, emails, URLs, quoted text, IPs, long ids
  or home paths), app-relative stack frames, component, release and environment; never bodies, users, breadcrumbs,
  headers or env. Hourly dedupe per error, 10 events a minute at most, fatal crashes spooled and sent on next start.
- Wired: account service (process crashes and every 500, `component: dashboard`), its page (`POST /v1/client-error`,
  same origin, rate limited, forwarded through the same scrubber), the desktop app (main process, page and child
  process crashes), the bundled server (inherits the DSN only while the person keeps reports on), the phone app
  (`DUSK_ERROR_DSN` at build time). Without a DSN every one of them sends nothing.
- Owner alert emails ("something's wrong"), see **Alerts** below: downtime from the Oracle box, and every server
  error, crash, failed email, database write failure, cloud `ALERT` line and client error, grouped and throttled.

### Alerts

What sends an email, to `DUSK_ALERT_EMAILS` (empty: `DUSK_ADMIN_EMAILS`), all lowercase, in the shared email layout:

| Trigger | Where it comes from |
| --- | --- |
| a site, dashboard, API, waitlist-count, installer or link check fails twice in a row, from outside | `deploy/monitor/uptime-check.mjs` on the Oracle box, every minute |
| a TLS certificate of dusk.bot, preview.dusk.bot or link.dusk.bot has under 14 days left | same, checked hourly |
| any 5xx answer (thrown errors with their stack, and the billing routes' own 500s, webhooks included) | `apps/dashboard/server/app.ts` |
| the site behind dusk.bot stops answering the proxy (502) | same, as `SiteUpstreamDown` |
| an uncaught exception or unhandled rejection that kills the service | spooled to `<data>/incident-spool`, mailed by the next start |
| MongoDB state writes failing (checked every 30 s) | `incidents/process.ts` |
| any `console.error` line, and `console.warn` lines with `ALERT` or a failure in them: failed emails, lease renewal failures, cloud setup, restore, backup, cost-ceiling and machine `ALERT` lines, the billing duplicate-subscription `ALERT` | console tap in `incidents/process.ts` |
| a page error on the dashboard or /admin, or an error in the desktop app's page or main process | `POST /v1/errors` |
| a new @devs report from an app (one email per report, never repeated, at most 50 a day; all of them at /admin/bug-reports) | `POST /api/bug-reports`, `apps/dashboard/server/bug-reports` |

Throttle rules (`RULES` in `apps/dashboard/server/incidents/index.ts`):

- One problem is one fingerprint: source + error name + newest frame in our code (no line number, no bundle hash) +
  route with ids folded; a line without a stack uses its text with numbers removed.
- A new fingerprint opens an incident and is mailed once, within about 20 seconds (new ones in the same window share
  one email). While it is open it is never mailed again: repeats only raise its `count` in MongoDB, visible at
  `GET /v1/admin/incidents`. It closes after 7 quiet days; if it comes back after that it is new again.
- No digests of repeats. At most 10 alert emails a utc day per service (3 of them for client errors). New problems
  past that wait for one daily email at 08:00 UTC, which lists only problems never mailed and says "more issues
  than the daily email limit, see the health page"; it is skipped when there are none.
- A restart loads the open incidents, so a crash loop re-mails nothing. `/v1/errors` takes 60 reports an hour per
  address and 16 KB each; more than 100 new client fingerprints in an hour fold into one `TooManyClientErrors`.
- A failed alert email is retried every minute for an hour (`DUSK_RESEND_API_KEY` adds a second sender). The
  Oracle checker keeps a failed email in its state file and retries it each run for a day.
- Uptime: per outage one "down" email after 2 misses in a row and one "back up" email with the downtime, nothing in
  between; one TLS warning per certificate until it is renewed; at most 10 emails a day. When the Oracle box cannot
  reach the internet either, it sends nothing.

Privacy: messages are masked before they are stored or mailed (secrets, bearer tokens, sign-in codes, query strings,
connection strings; emails become `si***@gmail.com`). Client text gets the stronger scrub of `error-report.mjs`, and
the desktop app scrubs on the device before sending, without its token or cookies, only while `errorReports` is on.

Incidents live in MongoDB `incidents` (one document per fingerprint, TTL 30 days after last seen). Owner-only routes:
`GET /v1/admin/incidents?limit=50&before=<lastSeen ms>&source=<source>` (newest first, `next` is the keyset cursor),
`POST /v1/admin/incidents/test`, `POST /v1/admin/incidents/<id>/mute` with `{"hours": 24}` (0 unmutes).

Silence or test:

- Mute one problem: the mute route above. Stop all service emails: `DUSK_ALERTS=off` and restart.
- Stop uptime emails: `sudo systemctl disable --now dusk-uptime.timer` on the Oracle box.
- Test a server alert: `POST /v1/admin/incidents/test` as an admin, or on the VPS
  `systemctl kill -s USR2 dusk-account-prod` (`dusk-account` for preview).
- Test a client alert: `curl -X POST https://dusk.bot/v1/errors -H 'content-type: application/json'
  -d '{"source":"web","type":"TestClientError","message":"a test","path":"/dashboard"}'`.
- Test downtime: on the Oracle box, run `sudo systemd-run --wait --pipe -p EnvironmentFile=/etc/dusk-uptime.env
  -E DUSK_UPTIME_STATE=/tmp/uptime-test -E DUSK_UPTIME_TLS= -E DUSK_UPTIME_TARGETS=test=https://dead.invalid/
  /usr/bin/node /opt/dusk-uptime/uptime-check.mjs` twice (down email), then once more with
  `DUSK_UPTIME_TARGETS=test=https://dusk.bot/` (back up email).

### Owner

1. **Error tracker** (pick one): self-hosted GlitchTip on the Oracle box (free; Docker Compose with Postgres and
   Redis, about 1 GB of memory; put it behind a subdomain such as errors.dusk.bot) or sentry.io's free Developer plan
   (5,000 errors a month, one user). Create one project per component or one shared project; copy its DSN.
   sentry.io is a third party: add it to docs/legal/subprocessors.md and privacy.md and drop the "no third-party error
   tracking" lines there before setting the DSN in production (self-hosted GlitchTip on the Oracle box needs Oracle listed).
2. Set `DUSK_ERROR_DSN` in the account service env (and staging's, with `DUSK_ENVIRONMENT=staging`). Turn on the
   tracker's email alerts to your operator address for new issues.
3. Desktop builds: before baking a DSN into release builds, add a Settings switch for the existing `errorReports`
   preference (electron/desktop-prefs.mjs; it defaults to on and is read at launch), then add a release step that
   writes `"duskbot": { "errorDsn": "<dsn>" }` into package.json before packaging. Until then desktop builds send
   nothing.
4. Phone builds: build with `DUSK_ERROR_DSN=<dsn> pnpm mobile:build` once the privacy label says so.
5. **Uptime** (installed on the Oracle VPS 2026-11-12; it watches the Contabo box from outside). To reinstall:
   `install -D -m 0755 deploy/monitor/uptime-check.mjs /opt/dusk-uptime/uptime-check.mjs`,
   `install -m 0644 apps/dashboard/server/email/layout.ts /opt/dusk-uptime/layout.ts`, write `/etc/dusk-uptime.env`
   (root, 0600: `DUSK_BREVO_API_KEY`, `DUSK_ALERT_TO`, `DUSK_ALERT_FROM`, optional `DUSK_RESEND_API_KEY`), copy the
   two units to `/etc/systemd/system/`, `systemctl enable --now dusk-uptime.timer`. Needs Node 23.6 or newer.
6. **Desktop error reports** now reach `POST /v1/errors` from packaged builds while the `errorReports` preference is
   on (it defaults to on and has no Settings switch yet): add the switch and a privacy-policy line before launch.

## 4. Legal and trust

### Done

- Final policies in `docs/legal/{terms,privacy,cookies,refunds,acceptable-use,subprocessors,license,security}.md`, each
  with an effective date (12 November 2026), live at https://dusk.bot/terms, /privacy, /cookies, /refunds,
  /acceptable-use, /subprocessors, /license and /security (built from the Markdown by
  `apps/site/build-pages.mjs`). The privacy policy lists the sub-processors: Contabo, Cloudflare, InstaBox (cloud desktops, on AWS us-west-2), Dodo
  Payments, Brevo, Composio, Apple APNs, Google FCM, Spaceship (registrar), Let's Encrypt and the error tracker; AI model
  providers are the user's own relationship.
- https://dusk.bot/.well-known/security.txt (expires 2027-11-10).
- Data export: **Download your data** on the dashboard's Account page (`GET /v1/account/export`: account, sign-ins,
  sessions, workspaces with their latest report, plans, payments, cloud desktops; no tokens, hashes or keys). Deletion
  already existed (Account > Delete account; cloud desktop data on its own page with a 7-day hold).
- Cookie notice: the account pages set only strictly necessary cookies (session, CSRF, OAuth state) and a theme value
  in local storage. The site's analytics script sets `dusk_vid` and `dusk_sid` only outside the EU, EEA, UK and
  Switzerland and nothing inside them (privacy.md, Product analytics); have the lawyer confirm no banner is needed.

### Owner

1. The policies are final and carry no placeholders. When something they describe changes (a new provider, a new
   retention period, the error tracker choice), edit the Markdown, bump "Last updated" and redeploy the pages.
2. Sign the processors' DPAs (Contabo, Cloudflare, Brevo, Dodo, Composio, InstaBox, the error tracker). InstaBox
   replaced the earlier cloud desktop provider: its DPA is new and still unsigned.
3. Decide whether naming InstaBox publicly on /privacy is fine now (apps/cloud-service/README.md planned it for "once
   there are EU customers"; the privacy page names it today).
4. After any policy edit: run `apps/site/deploy.sh landing`, and bump security.txt's
   Expires yearly.

## 5. Product polish

### Done

- No-AI first run: "Connect an AI to get started" (was "Install a model provider"), no "AI CLI" jargon, remote-host
  copy translated (16 locales).
- Account dashboard: only a 401 signs the page out (offline no longer drops you to sign-in); failed account,
  workspace, cloud, billing and usage loads show a message with Retry instead of endless skeletons; plain fallback
  error text.
- dusk.bot: home, download, docs (getting started, VPS install with `curl -fsSL https://dusk.bot/install.sh | sh -s <code>`
  and a read-first variant with `install.sh.sha256`), pricing (no invented prices; links to the account's Plans
  page), footer with legal links; strict CSP and HSTS.

### Polish not done (owner or a follow-up)

- Renderer settings screens still show raw transport text ("Failed to fetch", "502 Bad Gateway") from `src/state/api.ts`
  in EnginesSettings, KeyPanels, VoiceSettings, LocalComputerSection and AccessSection; route them through
  `src/lib/plain-error.ts` (a change to `api()` itself would alter the chat failure cards another track owns).
- Engine install failures on first run show npm's log tail (`EngineSetup.tsx` with `server/engine-install.ts`); one
  sentence plus "Show details" would read better.
- Before the AI list loads, a fresh window can show "No bots yet / New bot" (`App.tsx`), and a connection that fails
  before first load shows "Connecting to your bots..." with no retry (`BootCover.tsx`).
- `www.dusk.bot` resolves and 301s to the apex (checked 2026-11-12).

## 6. Security review

### Fixed

- **Rate limits bypassable** (blocker): the account service read the first `X-Forwarded-For` entry, which the client
  writes; a new value per request skipped every per-IP limit (sign-in mail, code checks, enroll, claims). Now the
  proxy's own last entry (`apps/dashboard/server/client-ip.ts`), with a regression test.
- **Workspace claim takeover**: an unsigned `/v1/enroll` could rotate the claim link of any workspace whose public key
  the caller knew. Workspaces now sign every enroll; unsigned enrolls can only create a new workspace.
- **Installer transport**: a non-https `LINK_BASE` now stops the installer before it sends the server token or fetches
  root-run code; every request to the link service pins `--proto =https --proto-redir =https`. Packages and kits were
  already sha256-verified; the script is functions-only with `main "$@"` last, so a partial download runs nothing.
  dusk.bot serves `install.sh.sha256` beside it.
- **Link service** listened on 0.0.0.0; it now binds 127.0.0.1 by default (it is only reached through nginx, which
  sets `X-Real-IP` itself).
- **Dependencies**: `pnpm audit --prod` had 9 findings (4 high: undici TLS validation bypass and DoS, the Electron
  intermediate certificate fix); now 1 low (katex, needs a 0.16 to 0.18 upgrade). Dev-only findings remain in
  electron-builder's dependencies (xmldom, brace-expansion, js-yaml, minimatch) and wrangler (sharp); they do not ship.
- **Dashboard CSP**: full policy on the page, not only `frame-ancestors`.

### Checked and sound

Session cookies, CSRF, CORS on app routes, OAuth state and PKCE, email code limits, the Dodo webhook signature
(raw body, 5-minute window, constant-time compare, replay ids kept 30 days), the ops token, workspace report
signatures, static file serving, cloud-service claims and release signatures, link token hashing, the Slack callback.
History secret scan over every commit on every ref: no live keys (all matches were redaction code, PEM format checks
and identifiers); `.env*`, `.dev.vars.*` are ignored.

### Owner or follow-up

- Sign the link agent and docker gate (`agent.mjs.sig` is already served at `/v1/release`) and have the installer
  verify them with the pinned release key; today they rely on TLS to link.dusk.bot.
- App sessions renew for 90 days on each use with no absolute cap; consider a one-year cap.
- Account deletion needs a session, CSRF and the typed email, not a fresh sign-in (cloud data deletion does).
- katex 0.18 upgrade (low).

## CI on main today

A local dry run of `ci.yml`'s static job on this branch passes: CI selection tests, locales, typecheck, Electron
syntax, dashboard and phone checks, UI build and dashboard build. This branch also fixed reds that were already on
`main` (about 38 lint warnings, 13 stale Electron node tests, the clipboard guard). Still red on `main` and on this
branch alike, so the first CI run will fail until they are fixed:

- `pnpm lint`: two warnings in `src/components/chat-bubble.ts` (a chat file the chat track owns; use `\u` escapes in
  its emoji character class).
- Source guards: `src/lib/random-uuid.test.ts` (`apps/mobile`'s `src/mobile/connection/pair.ts` calls
  `crypto.randomUUID()` without the fallback), `src/locales/vocabulary.test.ts` and `scripts/testing/analytics-docs.test.ts`
  (read the removed `apps/docs`).
- Linux shards: UI e2e tests whose clicks land on a fixed full-screen layer (`control-dusk-ui`, `presets-ui`,
  `sidebar-scroll-ui` and others), `ConnectAppsWindow.dom.test.ts`, `local-computer`, `setup-import`, `github-refs`,
  `scripts/packaged-native-modules.test.mjs` (docs/LICENSING.md and the removed `deploy/podman`), the file-size
  ratchet (main.mjs, codex.ts and three more files over their listed sizes), and slow `server/*.e2e.test.ts` timeouts.
  Each was compared against `main` on the same machine: none is new on this branch.
