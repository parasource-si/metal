# Bot checks and bot blocks

What Metal does when a site puts up a wall: a Cloudflare "Just a moment" or "Performing security verification /
Verifying..." page, a Turnstile, reCAPTCHA or hCaptcha, a PerimeterX or Akamai "press and hold", a DataDome page, an
"unusual traffic" page, "access denied", a bare 403 or 429, or a "sign in to confirm you're not a bot" wall.

The hard line: Metal never defeats bot detection. No clicking a check box to pass as a person, no solving services,
no stealth patches that hide automation, no fingerprint spoofing. The recovery below only reads the page, reloads it and
changes the network route.

## The ladder

One detector reads every wall by its markers, words and HTTP status (`classifyChallenge` in
`server/browser/cdp/settle.ts`, `wallState` in `server/host/site-block-ladder.ts`). The states are: `checking` (an
interstitial still working by itself), `check` (a person must answer it), `blocked` (refused outright), and `clear`.

1. **First pass in the browser tool.** Opening a page waits up to 15 s for a self-clearing interstitial before the
   snapshot comes back (`settlePage`), so most "Verifying..." pages never reach the bot.
2. **The bot calls `request_sign_in` with `human_check: true` at once.** It does not wait, reload or say anything
   itself. The server takes over (`requestCheck` in `server/host/sign-in-requests.ts`):
   - **Wait it out.** An interstitial is polled for up to 45 s, with one reload at 20 s. A hard block gets one reload
     and a short look (8 s). If it clears, the bot hears "carry on" and nothing reaches the person.
   - **The person's own connection.** On a cloud computer of a linked VPS, the blocked site (only that site and its
     subdomains) is sent out through the person's own computer while it is online and the setting is on
     (`routeSite` in `server/computer-egress.ts`). It stays on that route for the session (12 h), then reloads.
   - **Another route.** If the wall is still there, the bot gets other ways to the same goal: the site's API, a
     connected app (a GitHub gist for a paste), another site, or the same request from the person's Mac with `mac_exec`
     (`otherRoutesHint`, with a short hint list of common sites). No card yet.
   - **Ask once.** Only when the bot calls again with `other_routes` (what it tried, or why none fits) does the person
     get one card: "pastebin.com wants a quick human check. Tap Take over and I'll carry on from there." The bot writes
     nothing beside it. The card hands back by itself once the page clears (`human-check-watch.ts`), and the computer
     stays awake while it waits.
3. **One ask per site per task.** A task is everything after the person's latest message. A second request for the same
   site while the card is open gets the same card back (no message, no plea). After the person already did the check in
   this task, the bot is told not to ask again and to use another route or say in one line that the site keeps checking.
   A hard block (nothing a person can tick) never gets a card.

## Home route for blocked sites

`computer-egress.ts` already ran "Route traffic through this computer" for a linked VPS: the link agent serves a SOCKS
proxy on the bot computers' bridge and streams each connection to the person's app over the existing link, direct
first, then their tunnel, then our relay. Per-site routing reuses it unchanged:

- The PAC in each bot computer's Chromium policy lists the blocked sites (plus the sites that always go home while the
  whole route is on). Everything else stays on the server's network.
- Setting: Settings > Computer > Your computer, "let your bot browse through this computer's connection when a site
  blocks the cloud", saved as `vps.routeBlockedSites`, on unless turned off (`PUT /api/computer/egress
  {blockedSitesEnabled}`). The link agent is told to take streams when either setting is on.
- Offline: the policy is removed and the site is back on the server's network by itself; it returns when the app says
  hello again. Streams that go over the relay count toward the account's relay fair use, as the relay already meters
  them.
- Dusk Cloud homes have no link agent and no direct, tunnel or relay path: the app reaches them over their own https.
  So the app keeps one websocket to My Cloud (`/api/computer/egress/link`, `electron/home-egress-link.mjs`, using its
  existing session cookie) only while the home is awake, never dialling a sleeping one awake, and hands it to the same
  egress endpoint. The home (`server/home-egress-link.ts`) carries those streams for the built-in browser's gate
  (blocked sites only; the gate's open connections to the site are dropped so the reload takes the new route) and as
  SOCKS on the bot computers' bridge for their PAC. That traffic does not cross our relay, so relay fair use does not
  apply. The all-traffic route stays off on cloud homes; the setting there shows only "when a site blocks the cloud".
- Where it does not apply: the built-in browser on a linked VPS (the link agent's proxy refuses host processes). The
  ladder skips the step and moves on.

## One ask on screen

The card is the only ask, enforced on the server (`server/host/check-ask-filter.ts`): while a check card waits in the
current task, reply lines that only restate it are dropped, keeping anything new. A line the bot wrote earlier in the
turn that only asked is turned into the card itself (the store has no delete), and a mixed line loses only its ask.

## Signed agents (Web Bot Auth): not now

Cloudflare lets verified agents through sites that allow them when every request carries an HTTP message signature
(RFC 9421): `Signature-Agent: "https://<our host>"`, a `Signature-Input` covering at least `@authority` and
`signature-agent` with `tag="web-bot-auth"`, `alg="ed25519"`, the key's JWK thumbprint as `keyid`, and a short
`created`/`expires` window, plus `Signature`. The Ed25519 public keys sit in a JWKS at
`/.well-known/http-message-signatures-directory` (content type `application/http-message-signatures-directory+json`),
and that response must itself be signed (`tag="http-message-signatures-directory"`). Checked against Cloudflare's docs
on 2026-11-14.

Why it is not built yet:

- **Every request needs its own signature**, because `@authority`, `created` and `expires` change per request. In the
  built-in browser that means pausing every request through CDP `Fetch` to add headers, which adds latency and a failure
  point to all browsing. The cloud computer's Chromium has no such hook: its traffic is TLS by the time it reaches our
  proxy, so the egress path cannot add headers without breaking TLS. An extension would be a second browser codebase
  to keep working.
- **Registration needs a live public product.** Cloudflare reviews a submission and can revoke verified status for every
  bot an organization runs after violations. Metal is an intermediary agent (each action comes from a different
  person), so we would answer for every user's traffic. Before launch there is nothing to register.
- **It does not guarantee a pass.** Each site decides what verified agents may do, and many block AI agents by policy.

What the owner does when it is time (about a day of work, near zero running cost):

1. Make an Ed25519 key pair; keep the private key as a secret (env var), never in the repo.
2. Serve the signed key directory at `https://dusk.bot/.well-known/http-message-signatures-directory`.
3. Sign the built-in browser's top-level document requests first (CDP `Fetch` with a `Document` pattern only), and test
   against `https://crawltest.com/cdn-cgi/web-bot-auth` (200 verified, 401 unknown key, 400 malformed).
4. In the Cloudflare dashboard: Manage Account > Configurations > Bot Submission Form, Verification Method "Request
   Signature", the directory URL under Validation Instructions, operated as an Intermediary. Track it under BotBase >
   Submission history.
5. Keep obeying robots.txt and sane request rates. That is part of staying verified.
