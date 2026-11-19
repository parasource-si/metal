# Metal account dashboard

One hosted web app for everyone's Metal workspaces. A person signs in with their Metal account and sees
each of their workspaces (their Mac, each VPS) side by side: bots, usage, the machine and its bot computers, devices.

```
 workspace (a Metal server)            dashboard service (apps/dashboard/server)          browser (apps/dashboard/src)
 ---------------------------------            ------------------------------------          -----------------------
 POST /api/dashboard/link  (app menu)  ---->  POST /v1/enroll {ed25519 public key}
   opens the claim link in the browser        <---- {workspaceId, claimUrl}
                                                                                            /claim#token, signed in
                                              POST /v1/claim  <---------------------------  "Connect"
 every 5 s while watched, 3 min otherwise:
 POST /v1/report (signed)  ----------------->  keeps the newest of each section  --------->  GET /v1/workspaces/:id
 GET  /v1/wait   (signed, long poll)  <-----  commands, "someone is watching"  <---------  POST .../commands
 runs the command on its own routes,
 sends the result in the next report  ---->   command done / failed  ------------------->  toast + new state
```

- **Protocol.** `shared/dashboard-protocol.ts`, version 1: the report sections, the commands, the signature
  (`ed25519` over method, path, time and the body's sha256), timings and the discovery path. Reports carry counts and
  states only: machine stats, bot names, colours and models, computer states, device names, daily usage totals. Never
  messages, prompts, files or secrets.
- **Transport.** Plain HTTPS from the workspace to the service, so it does not depend on any relay. A relay can name
  its dashboard at `/.well-known/duskbot/dashboard` (`DUSK_LINK_DASHBOARD_URL` on the link service); a workspace
  uses, in order, the URL it is given, `DUSK_DASHBOARD_URL`, its relay's discovery answer, then `DEFAULT_DASHBOARD_URL`.
- **Accounts.** The service owns email-code sign-in, accounts and browser/app sessions (`shared/account-api.ts`).
  Accounts and token hashes live in `auth.json`; codes and one-time grants stay in memory. Browser mutations echo
  the `dusk_csrf` cookie in `x-dusk-csrf`. Apps use the existing Admin contract v1 bearer routes. Social providers are
  unavailable for now, with coming-soon buttons only in development.
  - *Web handoff* (the app opening the plans page already signed in): `POST /v1/app/web-handoff` with the app's bearer
    and `{ next: "plans", plan?: "plus"|"pro", source? }` answers `{ v: 1, url, expiresAt }`, where `url` is
    `${publicUrl}${pageBase}/handoff#t=<token>`. The token is in the fragment only (never in a server log, proxy or
    Referer), stored as a sha256 hash in memory, single use, 120 seconds, at most 5 unredeemed per account and 20
    issued an hour per app session, apart from enroll grants (neither redeems as the other). The page strips the
    fragment before anything renders and posts `POST /v1/auth/handoff { token, confirm?, replace? }`, which needs the service's
    own `Origin` (403 otherwise, also for a missing one or `sec-fetch-site` other than same-origin). It works only while
    the issuing app session and the account still exist, and answers `{ account, csrfToken, next }` with the usual
    session cookies; `next` is built by the service from the issued fields (`/billing?plan=..&src=..`), never taken
    from the request. Against login CSRF (anyone with an app session can mint a link) a browser is never signed in
    without its own click: signed out it gets 409 `{ code: "confirm", email }`, signed in to another account 409
    `{ code: "other_account", email }`; neither spends the link, and the page posts again with `confirm: true` (plus
    `replace: true`, which ends the old browser session). The same account already signed in just uses the link up.
    Every other failure is a plain 410 `expired`. The new web session counts as signed in when the app session was, so
    it never passes a "signed in recently" check, and it carries the app session as its parent (`parentId`, server
    only): revoking, signing out, expiring or deleting that app session ends it too.
- **Workspaces.** The server makes its key on first link (`dashboard-link.json` in its data folder, mode 0600). The
  claim link is one-time and lasts 30 minutes; an unclaimed workspace is dropped after a day. Removing a workspace in
  Settings stops its key working.
- **Commands.** Wake or sleep a bot computer, revoke a phone or a signed-in session, pause or resume a routine. The
  workspace runs each one through its own existing routes and confirms it; one not picked up in 10 minutes expires.

## Slack while a cloud desktop sleeps

Opt-in per desktop ("Wake for Slack" on its Cloud desktop page) and off unless the service runs with
`DUSK_SLACK_EDGE=1` (which then needs `DUSK_CLOUD_SEAL_KEY` outside loopback development). It is the one exception to
"Slack traffic stays between the harness and Slack": a bot's Socket Mode connection needs its app-level token, so a
desktop that wants to answer while asleep lends that token to this service.

```
 cloud desktop (repo server/slack/handover.ts)     this service (server/slack-edge)                Slack
 every 60 s and at boot: signed POST /v1/slack-edge/sync
   {x25519 public key, bots: id + token hash, acks}  ---->  remembers the key, asks for changed tokens
 POST /v1/slack-edge/tokens {xapp tokens}  -------------->  seals them at rest (DUSK_CLOUD_SEAL_KEY)
                                                          desktop stopped or asleep: opens Socket Mode  <---->  events
                                                          acks each event at once, seals it to the desktop's key,
                                                          DM or mention: wakes the desktop (again each minute)
 boots, syncs  <------------------------------------------  sealed events; closes its own connection
 opens them, feeds the bridge (it drops repeats), acks  ->  deletes them
```

What the service can see, and why:

- **The app-level token** (`xapp-`) of each bot, sealed at rest, in memory while it holds the connection. Socket Mode
  needs it. It only opens Socket Mode connections: it cannot read history, post or act as the bot. The bot token
  (`xoxb-`), the signing secret and the config token never leave the desktop.
- **Each event, in memory, while it is held.** Slack sends events in the clear over Socket Mode's TLS, so the process
  holds each one for the moment it takes to read its type fields (`type`, `channel_type`, `subtype`, `bot_id`,
  `user` against the bot's id, `event_id`) and seal the whole payload to the desktop's x25519 key (HKDF, AES-256-GCM,
  bound to the bot). The text is never read, logged or written; channel chatter that does not address the bot is
  dropped unsealed and unstored.
- **At rest** (`slack-edge.json`): sealed events (at most 64 or 256 KB per desktop, 24 hours), their event ids and
  times, bot ids, Slack app and bot user ids, token hashes, the desktop's public key, and wake timings. Only the
  desktop's private key (`slack-edge-key.json` on the desktop, mode 0600) opens an event.
- A compromised service process could read events while it holds a connection. That is why it is opt-in, only while
  the desktop sleeps, and released as soon as the desktop syncs after waking.

Wake timings (wake request to the desktop's first sync) feed the catalog's `wake` stat per desktop kind once 10 or
more were measured; the plan cards print a wake time only from it.

## Admin panel and product analytics

`/admin` (`https://dusk.bot/admin`, staging `https://preview.dusk.bot/admin`; only `DUSK_ADMIN_EMAILS` sessions get the page or its chunks) is the owner's panel: overview (signups, active accounts,
waitlist, the funnel site to signup to onboarding to cloud to paid to app paired to first bot reply, clouds by state),
users (search, plan, clouds, devices, timeline), clouds (pause, resume, delete with a typed confirmation), waitlist
(dusk.waitlist, CSV export, Brevo list check), events, health and the audit log. Keys: `g` then o, u, c, w, e, h or a;
`/` searches; `?` lists them.

- **Who gets in.** `DUSK_ADMIN_EMAILS` (comma-separated account emails). Every `/v1/admin/*` route checks the web
  session (401), the email (403) and, on changes, the CSRF header. Cloud actions, CSV exports and every opened user
  record go to `admin_audit`.
- **Events** (`server/analytics`): the service records sign-ups, sign-ins, app pairing, a daily app heartbeat (the
  app's own session refresh), cloud state changes, payments and the first bot reply; the page sends page views and
  onboarding steps to `POST /v1/events` (20 per batch, rate limited); the site proxy counts site page views with a
  daily visitor hash. Each event carries a context (`analytics/context.ts`: visitor, session, page, referrer, channel,
  utm, Cloudflare country behind a trusted proxy, device, app platform and version). Props are an allowlist per event
  (`analytics/events.ts`); no content, emails or addresses. GPC or DNT turns it off; `PUT /v1/account/analytics
  {optOut}` opts an account out and deletes its events; deleting the account deletes them too.
- **Storage.** `analytics_events` (TTL 400 days), `analytics_daily` (kept), `analytics_marks` (once-only marks),
  `admin_audit` (kept). Without MongoDB (tests, fixture) they live in memory.
- **Usage signals.** Linked workspaces add a `usage` section to `POST /v1/report` (`shared/usage-signals.ts`): one record
  per bot turn and routine run in fixed words and counts, scrubbed notes on how sessions went (after a bad chat, after a
  big session, weekly), and a count snapshot. `analytics/usage.ts` keeps them in `usage_events` (TTL 90 days), rolls them
  into `usage_daily` (kept) and `usage_people` (TTL 400 days), with `usage_snapshots` and `usage_marks`; the one
  `PUT /v1/account/analytics {optOut}` switch covers them all. `GET /v1/admin/usage?from&to` feeds the overview's "what
  people use it for"; `GET /v1/admin/feedback?kind=bad|big|weekly&before` lists the notes newest first for the feedback page. Named signals (`shared/product-signals.ts`)
  carry an exact key allowlist each; app ones ride `app_action`, workspace ones the report's `usage.signals`.
  `usage_routines` keeps each salted routine hash's first and last run (TTL 400 days) for routine survival.
- **Experience.** Experience signals (`shared/product-signals.ts`, source `any`): failed, stopped and tool-using turns, failed
  tools, routine ends, approvals, changes made by talking, refusals, follow-ups right after a reply classified on the
  computer (`server/experience.ts`), creations, files made, failed sign-ins, browser downloads and updates, crashes and
  Settings closed unchanged. A desktop's workspace queues them for its app (`GET /api/dashboard/experience`), which
  forwards them as `app_action` events with the install id (`electron/experience-relay.mjs`); a cloud's ride its usage
  report. `GET /v1/admin/experience?from&to` counts them per day as bad, confusing and done with the top reasons, and
  derives abandoned first runs; `GET /v1/admin/experience/timeline?who=` is one install's last 30 days (audited).
- **Site and app analytics.** `tracker/dusk.js` (about 3 KB gzip, no dependencies, ideas from Minilytics, MIT) is copied to the
  site as `/a.js` by the site's `build-pages.mjs`. It sends page views, goals (`cta_click`, `download_click`, `waitlist_join`,
  `outbound`, any `data-dusk-goal`), and each page view's end (scroll depth, visible time) to `POST /v1/t` as text/plain
  beacons; `?dusk_ignore=1` once turns it off in a browser, and an admin's own visits are never recorded. An open page pings
  `/v1/t` every minute while visible; pings and the admin's own beacons only mark the visitor as here in memory (`analytics/presence.ts`),
  which the live counts add to the last five minutes of events. The first page
  view of each page load goes as a `fetch` instead, and `/v1/t` answers `{"persist": true|false}`: the tracker writes
  `dusk_vid` and `dusk_sid` only after `true`. The answer is `false` when Cloudflare (trusted only as the proxy's peer) puts
  the visitor in the EU, EEA, UK or Switzerland (`COOKIELESS_COUNTRIES` in `analytics/context.ts`) or cannot place them;
  there the service ignores the browser's ids and uses a daily visitor hash (HMAC of address and user agent under a salt
  that lives in memory and changes every day) and its own 30-minute visits, so attribution is per visit. A request that
  did not come through Cloudflare keeps cookies. Origins other than
  the service's own and its `www.` twin must be in `DUSK_TRACK_ORIGINS`. The apps send screens, features, message counts, reply times,
  error and pairing codes to `POST /v1/app/events` (`src/lib/product-analytics.ts`), anonymous by install id until the
  app signs in. The desktop app's own page hands its batches to Electron main over the preload bridge (`productEvents`);
  main (`electron/product-events.mjs`) drops anything outside its event and prop allowlist, adds the account token when
  signed in, and posts to the account client's origin (`cloudTarget()`, so `DUSK_CLOUD_ORIGIN` builds use their own),
  retrying with backoff and holding at most 500 events offline. Channels and named sources (AI assistants apart from search) come from `analytics/sources.ts` (ported from
  Minilytics). Everything else is computed from the event log per read (`analytics/web.ts`): visits, KPIs against the
  previous period, ranked cards with the signups each row became, the funnel with drop-off and median times, journeys,
  realtime, retention (D1, D7 = days 7 to 13, D30 = days 30 to 59). A read scans at most 400,000 raw events.
- - The fixture's `--demo` makes its account the admin and fills the panel with made-up people, clouds and events.

## Running it

```sh
pnpm build:dashboard            # the page, into apps/dashboard/dist
pnpm dashboard:service          # DUSK_DASHBOARD_PORT, _HOST, _DATA, _PUBLIC_URL, _STATIC
```

Production mail uses `DUSK_MAIL_PROVIDER=brevo`, `DUSK_BREVO_API_KEY` and `DUSK_MAIL_FROM` (or `resend` with `DUSK_RESEND_API_KEY`). Loopback HTTP or
`DUSK_DASHBOARD_DEV=1` enables development console mail. Set `DUSK_AUTH_SIGNUP_OPEN=0` to close signups and
`DUSK_TRUST_PROXY=1` only behind a trusted proxy. `DUSK_OPS_TOKEN` (32 characters or more) turns on the operator's checkout funnel:
`GET /v1/billing/ops/funnel?days=30` with `Authorization: Bearer <token>` counts checkouts started, paid and still active
by where they started (`CHECKOUT_SOURCES` in `shared/billing-api.ts`); without the token the route does not exist. `DUSK_AUTH_SECRET` must be at least 32 characters if supplied;
otherwise the service creates a private `auth-secret` file beside its data.

Local work on the page: `pnpm dashboard:fixture` starts the service on `127.0.0.1:7480` with a temporary data folder,
a memory mailer, a signed-in session and a demo workspace (made-up numbers, fixture only). Sign-in codes print in
its terminal. Then `pnpm dev:dashboard` serves the page on `127.0.0.1:5288` with `/v1` proxied to it
(`DUSK_DASHBOARD_SERVICE` to point elsewhere).

The page keeps its own English strings: it is a separate web app outside `src/` and its locales. They are lowercase and
plain, like dusk.bot.

### The site and the app point at each other

The page links back to the marketing site (the logo and "back to" on sign-in and onboarding, terms, privacy, every
download button). `DUSK_SITE_URL` at build sets where that is; it defaults to the current origin:

```sh
DUSK_SITE_URL=http://localhost:3103 pnpm build:dashboard
```

The site links in with these addresses (`src/lib/site.ts` reads them):

| address | what it does |
|---|---|
| `/` | sign-in when signed out, the dashboard home when signed in |
| `/signup` | the create-account screen |
| `/signup?plan=plus` or `?plan=pro`, optional `&period=month` or `year` | sign-up with a plan: after sign-in a new account opens onboarding, where the first screen (its name) carries that plan and period and its button goes straight to checkout; an account that finished onboarding lands on `/billing` with the plan sheet open |
| `/billing?plan=pro&period=year` (or the older `?bundle=pro`) | plans, with the sheet open on that plan |

Signed out on any other address (`/usage`, `/claim`, `/cloud/desktop?code=`), sign-in comes first and then that address
opens. Onboarding keeps its step in the address (`?step=name|plan|app`; the older `done` opens `app`), so back, forward and a refresh hold.

### Sign-in providers

Google uses `DUSK_AUTH_GOOGLE_CLIENT_ID` and `DUSK_AUTH_GOOGLE_CLIENT_SECRET`. Apple uses `DUSK_AUTH_APPLE_CLIENT_ID` (Services ID), `DUSK_AUTH_APPLE_TEAM_ID`, `DUSK_AUTH_APPLE_KEY_ID`, and the .p8 key in `DUSK_AUTH_APPLE_PRIVATE_KEY` (PEM, literal `\n` accepted) or `DUSK_AUTH_APPLE_PRIVATE_KEY_FILE`. Register `<public url>/v1/auth/oauth/google/callback` and `<public url>/v1/auth/oauth/apple/callback` (Apple's Return URL). Partial provider configuration fails startup; endpoint overrides are available only through code options for isolated fixtures. The dashboard fixture runs local fake Google and Apple providers without external accounts.

## Look

The dashboard wears dusk.bot's identity: a white page, soft wash cards with big radii, flat pill buttons, one ink, and
the site's pixel posters (`src/art`, exported from the site's raw art the way its `art-src/final/prep.py` does). Light is
the default theme; dark stays in Account, Appearance. Icons are Gravity UI (src/icons).

| role | family | size / line | where |
|---|---|---|---|
| page title (`.t-title`) | General Sans 500, -0.045em | 40, 32 under 640px | the `h1` of every page, sign-in and onboarding |
| figure (`.t-figure`, `ui/Figure.tsx`) | General Sans 500, tabular | 32/36 | big numbers on stat cards and the activity total |
| meta (`.t-meta`), id (`.t-id`) | Geist Mono | 12.5, 13 | table headers, small captions, ids and versions |
| tag (`.tag`), step numerals | Pixelify Sans | 12, 72 | short word tags and the onboarding step number; never numbers at small sizes |
| body | General Sans 400 | 15/22, 13.5/19 secondary | everything else |

Fonts are the site's own three files in `src/fonts`. The `text-12` to `text-56` steps keep their old names and each draws
about a pixel larger, because General Sans runs small.

## Bots

Bots are drawn with the Metal engine in `src/mascot` (a copy of the site's `mascot-src/engine`; `ui/Mascot.tsx` wraps
it). A bot's saved colour and body are kept as they are and mapped when drawn: `bodyOf` in `ui/Mascot.tsx` turns every
body id a bot may have been saved with into the nearest of the ten dusk bodies, and an unset body draws as the squircle.

What a bot is doing decides its mood (`data/mood.ts`, tested):

| real status | mood | words beside it |
|---|---|---|
| its workspace is offline or has not reported | sleeping | asleep |
| it is running a turn | working | working |
| its computer is starting | waking | waking up |
| its computer is asleep | sleeping | asleep |
| nothing for more than a day | drowsy | resting |
| otherwise | idle, watching the pointer | waiting |

The sign-in and onboarding crew (`ui/Scene.tsx`) acts out the form: idle and watching the pointer, turned to the form
while you type, thinking while a request runs, a bounce per digit, confused on an error, celebrating on the way in. It is
decoration: `aria-hidden`, and nothing depends on it.

## Motion

One language, declared in `app.css`: `--ease-out` for things arriving, `--ease-pop` for things pressed or landing, and
160 / 240 / 420 / 600 ms. Hovers change colour at once. What moves: page and card entrances (`.page-in`, `.enter`),
presses, menus, sheets, dialogs, toasts, numbers that count to their new value (`ui/Figure.tsx`), a chart's first draw,
the onboarding rail, drifting clouds, and the bots. Bots share one frame loop, stop off screen and hold their pose under
reduced motion; every other animation falls back to a short fade or to nothing.
