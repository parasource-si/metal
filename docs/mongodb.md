# MongoDB

Metal uses the MongoDB instance configured through `MONGODB_URI` and
`MONGODB_DB` for hosted operator data. Add a collection for new operator data.

## Upstream Dusk deployment

The hostnames, databases and services below describe the original Dusk deployment.

- Where: the Contabo VPS (169.58.211.160), a dedicated `mongod-dusk` systemd
  service on `127.0.0.1:29018` (loopback only, auth on). It is separate from
  make.design's mongod on 29017; never point Dusk at that one.
- App user: `dusk`, `readWrite` on `dusk` only, `authSource=admin`. Apps on
  the VPS use the URI as is. From a Mac, open a tunnel first:
  `ssh -N -L 29018:127.0.0.1:29018 root@169.58.211.160` (add `-J oracle`
  when the direct route is blocked) and use the same URI.
- Backups: daily `mongodump` at 03:17 server time, 7 days kept, in
  `/root/backups/mongo-dusk/` on the VPS. Off the box: `dusk-backup@dusk.timer`
  (`deploy/account/backup.sh`, set up per `backup.env.example`, installed with
  `backup-install.sh`) dumps it fresh with both account data folders and the link
  service's state, encrypts the archive with age and uploads it daily to the Oracle box
  (`/srv/dusk-backups/data`, SFTP-only user `duskbackup`) and to Cloudflare R2 (bucket
  `dusk-backups`); 7 dailies and 4 weeklies kept. `dusk-backup@make.timer` does the same
  for make.design's database (read-only `mongodump`). The age private key lives only on
  the operator's Mac (`~/.config/duskbot/backup-age.key`).
- Values: the operator's `.env` (repo root, git-ignored) and
  `~/.config/duskbot/dusk.env`. Never commit them.

The ops runbook (users, restore, rotation) is `dusk-ref/DUSK-MONGO.md` on the
operator's Mac.

## The account service

The account service (`apps/dashboard/server`, with the managed cloud) keeps all of its state here: it refuses to
start outside local development without `MONGODB_URI`. Each module still holds its state in memory and says when it
changed; `persistence/` writes the rows that changed as one document each, in one transaction per flush, and a
response leaves only once what its request changed is written (a failed write drops the connection rather than
claim a success). Tests and local fixtures keep JSON files in the data folder.

- Needs a replica set for transactions: `mongod-dusk` runs as the one-node set `rs-dusk` (key file
  `/etc/mongod-dusk-rs/keyfile`). Add `&replicaSet=rs-dusk` to the URI.
- One writer: the process holds the `locks` document `account-service` (30 s lease, renewed every 10 s, checked inside
  every transaction). A second process waits up to 75 s for it, then refuses to start; a process that loses it exits.
- `/v1/health` answers 503 while writes fail.
- Two services, two databases: production (`dusk.bot`, deployd app `dusk-account-prod`) writes `dusk_prod` as the user
  `dusk_prod` (`readWrite` on `dusk_prod`, `read` on `dusk` for the waitlist through `DUSK_WAITLIST_DB=dusk`); the
  staging copy (`preview.dusk.bot`, `dusk-account`) keeps `dusk`. Each holds its own database's lease, so they never
  block each other, and preview's test accounts and clouds never reach production. The daily dump covers both.
- Preview's admin reads dusk.bot's analytics (events, daily counts, accounts) from `dusk_prod` as the user `dusk_admin_ro`
  (`read` on `dusk_prod` only), through `DUSK_ADMIN_ANALYTICS_URI` and `DUSK_ADMIN_ANALYTICS_DB`. It never writes there;
  a switch in the admin sidebar shows preview's own instead.

| Collection | What | Key | Indexes |
| --- | --- | --- | --- |
| `accounts` | accounts | `id` | `email` unique |
| `identities` | Google and Apple sign-ins | `provider:subject` | `accountId` |
| `sessions` | web and app sessions (token hashes only) | `id` | `tokenHash` unique, `accountId`, `expiresAt` |
| `workspaces`, `workspace_accounts` | linked workspaces and their latest report | `id` | `ownerAccountId`, `publicKey` |
| `billing_*` | customers, checkouts, subscriptions, licenses, invoices, credits, webhook events, feedback, closures, refunds, provider cancels, ledger (immutable money and subscription moments) | `id` (customers: `accountId`) | `accountId`; `providerPaymentId` unique; `(reason, ref)` unique; `providerSubscriptionId` unique when set; ledger `key` unique, `(accountId, at)`, `at` |
| `clouds` | Dusk Cloud records with the managed lifecycle | `id` | `accountId`, `status` |
| `pages`, `slack_edge_regs`, `slack_edge_events` | published pages, Slack wake edge | `id` / `cloudId` | |
| `stores` | each module's small fields (queues, counters, provider start ledger, sweep) | module name | |
| `managed_audit` | append-only lifecycle audit, ids and codes only | | `(cloudId, at)`, `at` |
| `analytics_events` | raw product events (allowlisted props, no content); written directly by `server/analytics/sink.ts`, outside the writer lease | `id` | `at` TTL 400 days, `(accountId, at)`, `(name, at)`, `(ctx.session, at)`, `(ctx.visitor, at)`, `(ctx.install, at)` |
| `analytics_daily`, `analytics_marks` | daily counts (kept); once-only marks | `day\|name` / key | `(day, name)`; marks: `expiresAt` TTL |
| `admin_audit` | the admin panel's actions and record views, kept | `id` | `at` |
| `analytics_notes` | chart notes the admin adds (a day and a line of text), kept | `id` | `at` |
| `infra_usage_daily` | each managed cloud's InstaBox usage and cost per UTC day, collected hourly (yesterday and today rewritten in place); written outside the writer lease | `day\|cloudId` | `day`, `(cloudId, day)` |
| `locks` | the writer lease | | |

Every row carries `_n`, its insertion number, so arrays load back in order. Sessions expire in the service itself
(`expiresAt` is a number, not a TTL date).

Import a data folder of JSON files once: `node apps/dashboard/scripts/import-json-state.ts <data folder>` with
`MONGODB_URI` and `MONGODB_DB` set (refuses a database that already holds account state).

## What else uses it

| Data | Store | Status |
| --- | --- | --- |
| dusk.bot waitlist | `dusk.waitlist` + `dusk.counters` (`apps/site`) | live |
| composio broker installs, triggers, events | Cloudflare D1 `duskbot-composio` | stays (runs on Workers, cannot reach a loopback DB) |
| link-service sessions and tunnels | `link-service/src/store.mjs` JSON | stays for now (ephemeral) |
| companion, self-hosted bot | local files on the user's machine | stays (user-side data) |
| sealed cloud backups, secrets files, error spool | files under `DUSK_DASHBOARD_DATA` | blobs and keys stay on disk |
