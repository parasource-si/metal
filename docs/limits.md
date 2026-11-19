# Limits: what keeps Metal up and what it costs us

Every limit, quota and cost lever the hosted side relies on, with its value today and where it lives. Values are the
code defaults; the ones you can change say how. "Per ip" means the caller's address as Cloudflare saw it (an IPv6
caller counts by its /64). Checked 2026-11-13.

Short version:

- **We pay for no one's AI.** Every engine runs on the person's own sign-in or key, on their computer or their dusk cloud.
- **Apps cost us nothing per call.** People connect apps with their own accounts, tokens or their own Composio. Our
  Composio broker is closed to new installs.
- **The money levers are Dusk Cloud machines (InstaBox) and email (Brevo).** A machine's compute is held under its plan
  by the cost ceiling, its upload is slowed and then paused by the egress steps, and sign-in mail is capped per address,
  per ip, per hour and per day.
- **The uptime levers are the Contabo box** (account service, relay, Mongo all share it) **and its 800 Mbit/s port.**

## 1. Sign-in and accounts (account service, `apps/dashboard/server`)

| What | Limit | When it's hit | Where |
|---|---|---|---|
| Sign-in codes to one address | 6 an hour, 12 a day, one every 30 s | "try again later" | `auth/index.ts` `AUTH_LIMITS` |
| Code requests from one ip | 60 an hour | same | same |
| Sign-in emails, everyone together | 120 an hour, 250 a day (`DUSK_AUTH_MAIL_PER_HOUR`, `DUSK_AUTH_MAIL_PER_DAY`) | same, and one incident email a day | same |
| Share of the day for new addresses | 80% (200 of 250); the rest is kept for people who already have an account | new addresses wait until tomorrow | same |
| Wrong code guesses | 5 per code, codes live 10 min, 600 checks an hour per ip | code is dead / 429 | `shared/account-api.ts`, `auth/index.ts` |
| Google / Apple sign-in starts | 600 an hour per ip | 429 | `auth/index.ts` |
| Desktop sign-in (device code) | 300 an hour per ip | 429 | same |
| Web sessions / app sessions | 30 days / 90 days (renewed while used) | signed out | same |

The 250 a day sits under Brevo's free plan (300 a day; the service key can't read the plan, so this is assumed: set
`DUSK_BREVO_DAILY_LIMIT` and `DUSK_AUTH_MAIL_PER_DAY` higher when the plan grows). Cloud notices and owner alerts use
the same Brevo account, which is why sign-in stops at 250.

Code brute force: with 5 guesses per code and 12 codes a day per address, one address can be guessed at most 60 times
a day against 100 million codes.

## 2. Computers and reports

| What | Limit | When it's hit | Where |
|---|---|---|---|
| New computers joining from one ip | 120 an hour | 429 | `app.ts` (`enroll`) |
| Unclaimed computers at once | 5000 (each is dropped after a day unless claimed) | "too many new computers are joining" | `app.ts` `WORKSPACE_LIMITS` |
| Computers per account | 50 | "an account holds at most 50 computers" | same |
| Reports per computer | 2400 an hour (the app sends one every 3 min, every 5 s while someone watches) | 429, nothing written | same |
| Report size | 512 KiB | 413 | `shared/dashboard-protocol.ts` |
| Dashboard commands waiting per computer | 200, of which 5 app sign-ins | 429 | `app.ts` |
| Signed request clock skew | 60 s | 401 | `app.ts` |

Every computer also holds one 25 s long poll open to the account service, so 1000 computers are about 1000 open
connections through Cloudflare and nginx (see section 9).

## 3. Website and analytics

| What | Limit | Where |
|---|---|---|
| Waitlist joins (dusk.bot) | 20 a minute per ip, 200 new joins a day per ip or ipv6 /64 (`DUSK_WAITLIST_PER_IP_DAY`), 2 KiB body, 22 throwaway domains refused, a honeypot field | `apps/site/server.js` |
| Waitlist to Brevo | each new address becomes a contact on the waitlist list; no email is sent | same |
| Page beacon `/v1/t` | 3000 an hour per ip, 4 KiB | `analytics/ingest.ts` |
| App events | 1500 an hour per ip and per install, 50 events / 32 KiB a batch | same |
| Dashboard events | 3000 an hour per ip, 1500 per account, 20 a batch | `analytics/index.ts` |
| Page error reports `/v1/errors` | 240 an hour per ip, 16 KiB | `incidents/routes.ts` |
| Raw analytics events kept | 400 days (Mongo TTL); bot visits in a 64 MiB capped collection | `analytics/sink.ts` |
| Published pages | 50 per account, 5 MiB and 200 files each, 120 uploads an hour | `pages/service.ts` |

A bot that rotates many networks can still fill the list with made-up emails; nothing is mailed, so it costs Brevo
contacts, not sends.

## 4. Billing (Dodo)

| What | Limit | Where |
|---|---|---|
| Clouds per account | 5 | `billing/plans.ts` `maxCloudsPerAccount` |
| Checkouts per account | 30 an hour, each open 30 min; asking again replaces an unpaid one with a fresh payment page | same |
| Webhooks | signed (Standard Webhooks), 5 min clock window, 64 KiB body, each id handled once (kept 30 days) | `billing/webhook-signature.ts`, `billing/service.ts` |
| Free trial | none (`trial: null`) | `billing/plans.ts` |
| Work license free until | 2026-12-01 (`DUSK_FREE_WORK_UNTIL`) | same |
| Dodo fees | 6% + $0.40 a charge | ops page |

## 5. Dusk Cloud machines (InstaBox, `apps/cloud-service`)

| Plan | Machine | Upload a month: alert / slower at / paused at |
|---|---|---|
| Plus (`shared_s`), $20 | 2 vCPU, 4 GB, 20 GB disk | 30 GB / 40, 55, 70, 90 GB (200, 100, 50, 25 Mbit/s) / 100 GB |
| Pro (`shared_m`), $50 with license | 4 vCPU, 8 GB, 60 GB | 60 / 80, 110, 140, 180 / 200 GB |
| Team (`dedicated`), $119 | 8 vCPU, 16 GB, 160 GB | 120 / 160, 220, 280, 360 / 400 GB |

- **Who pays the tokens:** the person. The bot runs on their own Claude, ChatGPT or other sign-in; nothing on the
  cloud bills us per token. (The voice, X and decision relays in `server/included-services.ts` are not wired into
  Dusk Cloud machines.)
- **Compute:** InstaBox bills by the running hour (0.4 c per vCPU-hour, 0.225 c per GiB-hour, disk 8 c per GiB a month).
  Each machine has a monthly cost ceiling of always-on cost x 1.065; past it, starts and backups are refused
  (`power/ceiling.ts`, `spend.ts`). So a machine that runs flat out all month costs about what its plan assumed.
- **Sleep and wake:** asleep 15 min after the start or the last input (`DUSK_MANAGED_IDLE_MINUTES`), 30 min once someone has been using it this hour, 5 min after work ends, never more than 2 h with no input unless a bot works; routines and their checks wake it on their own schedule; at most 20 starts an hour and 96 a day
  per machine on InstaBox; 20 wakes an hour from the web edge (`DUSK_MANAGED_EDGE_WAKES_PER_HOUR`); 60 power changes an
  hour per cloud from the dashboard. Our whole InstaBox workspace can start 30 machines a minute; alerts at 70% and up
  of the daily included starts.
- **Upload (egress):** read every 5 min. Past each step the machine is slowed inside the VM; a machine that removes
  its own limit is paused at once; at the last step it is paused until the 1st. InstaBox includes 1 TiB a month across
  the workspace, then $0.02 a GB.
- **CPU:** no cap (the plan pays for the cores). A Dusk Cloud above 90% cpu for 6 hours opens one incident a day
  (mining or a runaway loop), so we look before InstaBox does.
- **Memory:** the home service is held at 80% (soft) and 90% (hard) of the machine, bots at 65% / 75%.
- **Backups:** daily (`DUSK_MANAGED_BACKUP_HOURS`), 3 kept plus one at least a week older, at most 4 GiB each
  (`DUSK_MANAGED_BACKUP_MAX_MB`), on the account service's disk. Kept 30 days after a plan ends. Streamed to disk,
  sealed, hashed and checked a piece at a time (a few MiB of memory whatever the size); upkeep looks after 4 machines
  at once.

## 6. Relay (link service, `apps/link-service`, link.dusk.bot)

Changeable live from the admin relay page (`relay-limits.json`).

| What | Limit |
|---|---|
| Speed per tunnel | 3 MiB/s, bursts to 24 MiB |
| Per tunnel per day | 25 GiB |
| Tunnels per account | 20 |
| Whole relay (Contabo) | 10 MiB/s (about 88 Mbit/s on the wire) |
| Busy tunnels (a screen or download, 1 MiB or more in 2 min) | 150 new ones a node lets on (`maxTunnels`); ones already in use go on |
| Tunnels in use (an open desktop says hello every 15 s) | 1000 (`maxConnected`); past it a new one hears "relay busy" and moves |
| Servers reading from a node | 1500 (`maxServers`), placement only: from 90% new servers go elsewhere |
| Contabo month | 32 TB allowance (Contabo slows the port to 100 Mbit/s past a 10 day average above it) |
| New pairing sessions | 120 an hour per ip; queued bytes 16 MiB per direction, frames dropped after 60 s, 1 GiB queued in all |
| Per ip | 512 connections, 200 requests a second |
| Phone channels | 50 posts a second, 256 MiB a minute, 600 reads a minute |
| Who can make a tunnel | only a signed-in Metal account (anonymous sessions get 401) |
| nginx in front (Contabo only) | 512 connections and 200 requests a second per ip, 10 new sessions a minute; Oracle's Caddy has none |

Load test (2026-11-13): 100 tunnels with 3 clients each and a full reconnect storm ran clean on both nodes. On Contabo
the 150-tunnel cap is reached while the process is near one full core; on Oracle (2 cores) the box itself is near 100%
cpu at 140 to 150 tunnels, so Oracle's real ceiling is about 100 to 120.

Alerts (every minute): a node down 2 min, bandwidth past 60% of the ceiling for 10 min, the month on course past 70% of
the allowance, cpu or memory past 80% for 10 min, busy tunnels, tunnels in use or servers past 70% of their cap for 5 min.

What one node carries and when to add one: `docs/capacity.md` (measured 2026-11-14).

The Cloudflare relay (`apps/cloudflare/link-relay`, Durable Objects) has its own fair use: 25 Mbit/s per tunnel, an
account at full speed for 50 GB a month then halved every 50 GB down to 2 Mbit/s, 10 tunnels per account, 8 sessions per
tunnel. Its overall ceiling and per-tunnel daily cap are off by default.

## 7. Apps (Composio)

- People connect apps with their own accounts, tokens, or their own Composio key (Composio's own free plan: 10,000
  actions a month). We pay nothing per call.
- Our broker (`composio.dusk.bot`) is closed to new installs (`REGISTRATION_MODE: "closed"`). If it is ever reopened:
  500 tool calls a day across everyone (`GLOBAL_DAILY_TOOL_CALLS`), 10,000 per install, 60 new installs a day per ip.
  Lower the per-install cap below the global one first, or one install can use up everyone's day.

## 8. Email (Brevo)

| Sender | Volume | Cap |
|---|---|---|
| Sign-in codes | most of it | section 1 |
| Cloud notices (sleep, egress, payment, deletion) | a few per cloud a month | one per event |
| Owner alerts (incidents) | rare | 10 a day, one per incident, never repeated |
| Owner money and signup alerts | rare | 30 an hour |
| Waitlist | no sends, contacts only | none |

Alert when Brevo's day passes 80% of `DUSK_BREVO_DAILY_LIMIT` (300 unless set).

## 9. Boxes, database, storage

| What | Value | Alert |
|---|---|---|
| Contabo (account service, preview, relay, Mongo, others) | 12 vCPU, 48 GB, 800 Mbit/s port, "unlimited" traffic under fair use | memory > 90% for 10 min, disk > 85%, upload > 70% of 120 Mbit/s for 15 min, month on course past 32 TB (cpu shows on the health page, no email) |
| nginx on Contabo | 12 workers x 8192 connections, 65535 open files each (every proxied request uses two) | none |
| Oracle (backups copy, uptime checks) | 2 OCPU, 12 GB, 200 GB (free tier) | disk > 85%, no report in 30 min |
| MongoDB (`mongod-dusk`, one-node replica set on Contabo) | about 2 MB today | over 5 GB, unreachable or not primary for 4 min |
| Mongo backups | daily dump kept 7 days on Contabo; encrypted copy to Oracle and R2 (7 daily, 4 weekly) | backup older than 26 h |
| R2 | backups only | over 8 GB (free tier is 10 GB) |
| Cloudflare Workers (edge, relay, broker) | Workers Paid assumed: 10 M requests, 30 M cpu-ms a month | projected past either |

Kept forever and growing slowly: `analytics_daily`, `admin_audit`, `managed_audit`, `infra_usage_daily`, billing
records, `workspaces`. At today's sizes this is years away from mattering; the 5 GB alert catches it.

## 10. What is not limited (on purpose or not yet)

- **Waitlist volume** (section 3): capped per network only, no cap across everyone.
- **Restoring a cloud backup** still opens it whole in memory (up to 4 GiB) before it is uploaded to the new machine;
  rare (a lost machine only), unlike the daily backups, which now stream.
- **Rate limit counters live in memory** and reset when the account service restarts (sign-in codes in flight are
  saved, so a deploy no longer kills them).
- **Bot tools reaching private addresses** on a Dusk Cloud: the bot has a shell on its own machine by design, so this is
  the owner's own machine, not ours.
