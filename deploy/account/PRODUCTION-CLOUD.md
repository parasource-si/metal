# Upstream Dusk Cloud production notes

Turns on managed clouds for the production account service with nothing for sale, gives App Review's account its
demo cloud, routes the public edge to both account services, and puts the APNs key on the link service. Every step
needs the owner's approval first. Run from a checkout of main on the Mac. Each step has its command, its health check
and its rollback; do them in this order and stop at the first red check.

Secrets stay in `~/.config/duskbot/dusk.env` (mode 600). Commands here read them into the process; never echo them.
`CF` below is shorthand for exporting the Cloudflare token for wrangler:

```sh
CF='export CLOUDFLARE_API_TOKEN="$(sed -n "s/^CLOUDFLARE_API_TOKEN=//p" ~/.config/duskbot/dusk.env | tr -d "\"\x27")" CLOUDFLARE_ACCOUNT_ID="$(sed -n "s/^CLOUDFLARE_ACCOUNT_ID=//p" ~/.config/duskbot/dusk.env | tr -d "\"\x27")"'
```

## Before: record what to roll back to

```sh
ssh contabo 'git -C /root/autorunner/projects/dusk-account-prod log --oneline -1'    # the production deploy commit now
(eval "$CF"; cd apps/cloud-service/edge && npx wrangler deployments list --name dusk-edge | tail -8)   # the live edge version
ssh contabo 'git -C /root/autorunner/projects/omb-link log --oneline -1'             # the link service deploy now
```

On 2026-11-14 these were `4bfd9cd1` then `63f0b26f`, and the edge version `3aa928ad-37c9-43bb-9781-c2923303d532`.

## 1. Production's dusk cloud names in dusk.env

Adds to `[production]`: `DUSK_MANAGED_PRODUCTION=1`, `INSTABOX_API_KEY_PRODUCTION` (preview's key by reference; the
production scope label keeps its machines apart), `DUSK_MANAGED_PROVIDER_PLAN_PRODUCTION` (preview's),
`DUSK_MANAGED_PUBLIC_DOMAIN_PRODUCTION=dusk.bot`, `DUSK_MANAGED_EDGE_TOKEN_PRODUCTION` (preview's by reference, so the
edge needs no new secret), and two new random secrets, `DUSK_CLOUD_SEAL_KEY_PRODUCTION` and `DUSK_OPS_TOKEN_PRODUCTION`.
Billing stays off (`DUSK_BILLING_PROVIDER` unset) and `DUSK_PRELAUNCH_WAITLIST_ONLY=1` stays: every web and app checkout
answers `checkout_soon`.

```sh
node deploy/account/production-cloud.mjs env            # dry run: the names it would add
node deploy/account/production-cloud.mjs env --apply    # writes them, prints the backup it made, checks the env builds
```

Check: the apply ends with `production env builds (N names)`.
Rollback: `cp -p <the backup it printed> ~/.config/duskbot/dusk.env` (nothing was deployed yet).

## 2. The home package (release flow only)

Home packages are built, signed and placed only by the release flow (the owner-agent for package builds): it puts
`/var/lib/dusk-account-prod/home/omb-home.tgz(.sig)` on the VPS and sets `DUSK_MANAGED_HOME_PACKAGE_FILE_PRODUCTION`,
`DUSK_MANAGED_HOME_PACKAGE_SIGNATURE_FILE_PRODUCTION` and `DUSK_MANAGED_HOME_PACKAGE_SHA256_PRODUCTION`. Nobody else
builds a package or edits those names. Ask for it, then check, right before step 3 (and before any preview deploy):

```sh
node deploy/account/production-cloud.mjs package-check production    # read only: file, signature and sha256 agree
```

Check: `production: ... matches dusk.env (sha256 ...) and has its signature`. Anything else: do not deploy.
Also skip a deploy when the release flow deployed that service in the last 15 minutes
(`ssh contabo 'git -C /root/autorunner/projects/dusk-account-prod log -1 --format=%cI'`).

## 3. The production account service with dusk cloud on

```sh
deploy/account/deploy.sh production
```

Checks:

```sh
curl -fsS https://dusk.bot/v1/health                                              # {"ok":true,...}
curl -sI https://dusk.bot/account | grep -i '^location'                           # /delete-account (waitlist mode)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dusk.bot/v1/billing/checkout -H 'content-type: application/json' -d '{}'   # 503
ssh contabo 'tail -n 80 /root/autorunner/logs/dusk-account-prod*.log 2>/dev/null | grep -iE "managed|error" | tail'               # no boot error
```

Rollback (production had no clouds before this step, so first remove any machine it made, then the old env and code):

```sh
cp -p <the step 1 backup> ~/.config/duskbot/dusk.env
git worktree add --detach /tmp/dusk-rollback <the production deploy commit recorded before>   # or the main commit it was built from
(cd /tmp/dusk-rollback && pnpm install --frozen-lockfile && deploy/account/deploy.sh production)
```

A review cloud made in step 4 is deleted before that with
`curl -X POST https://dusk.bot/v1/billing/ops/clouds/<cloud id>/delete -H "authorization: Bearer $OPS" -d '{"reason":"rollback"}'`
(`OPS` read from `DUSK_OPS_TOKEN_PRODUCTION`), then waiting until it is gone, so no machine is left running unbilled.

## 4. The public edge routes to both account services

The code (`apps/cloud-service/edge/route.js`, commit a57cc4f29) asks each listed service in turn. Only `ROUTE_URL`
changes; `EDGE_TOKEN` stays (production shares preview's token, step 1).

```sh
cd apps/cloud-service/edge
sed -i '' 's#"ROUTE_URL": "https://preview.dusk.bot"#"ROUTE_URL": "https://preview.dusk.bot,https://dusk.bot"#' wrangler.jsonc
(eval "$CF"; npx wrangler deploy --dry-run --outdir /tmp/edge-dry | grep ROUTE_URL)    # shows both origins
(eval "$CF"; npx wrangler deploy)
```

Commit the `wrangler.jsonc` change after the deploy is green.
Checks: a preview cloud still answers through the edge (`curl -s -o /dev/null -w '%{http_code}\n' https://<a preview label>.dusk.bot/api/health`:
200, 401 or a 503 with `x-dusk-cloud-power`, never 404), and `wrangler tail dusk-edge` shows no `route lookup failed`.
Rollback: `(eval "$CF"; npx wrangler rollback 3aa928ad-37c9-43bb-9781-c2923303d532 --name dusk-edge)` (or the version recorded before).

## 5. App Review's demo cloud and bot

```sh
node apps/dashboard/scripts/review-account.mjs production
```

It signs in with the review code, grants the review cloud (never through Dodo), flags it, waits for it, pairs as the
phone does, makes the demo bot, wires its AI when `DUSK_REVIEW_AI_OPENROUTER_KEY` is set, and checks a reply.
Check: it ends with `the demo AI replied in Ns` and `done`.
Rollback: delete the review cloud with the ops delete above (the account itself is harmless).

## 6. APNs on the link service

The key is the `.p8` at `APPLE_APNS_KEY_PATH` (its id is `APPLE_APNS_KEY_ID`), team `S85QBF7KWC`, topic
`bot.dusk.mobile`. TestFlight and App Store builds use production tokens. Both link nodes get it.

```sh
key="$(sed -n 's/^APPLE_APNS_KEY_PATH=//p' ~/.config/duskbot/dusk.env | tr -d "\"'")"; key="${key/#\~/$HOME}"
id="$(sed -n 's/^APPLE_APNS_KEY_ID=//p' ~/.config/duskbot/dusk.env | tr -d "\"'")"
lines="DUSK_APNS_KEY_FILE=%s\nDUSK_APNS_KEY_ID=$id\nDUSK_APNS_TEAM_ID=S85QBF7KWC\nDUSK_APNS_TOPIC=bot.dusk.mobile\n"
# contabo (prozessor; the env file is the deploy cli's)
scp -q "$key" contabo:/root/omb-link-data/apns.p8 && ssh contabo 'chmod 600 /root/omb-link-data/apns.p8 && cp -p /root/autorunner/envs/.env.omb-link /root/autorunner/envs/.env.omb-link.bak-apns'
printf "$lines" /root/omb-link-data/apns.p8 | ssh contabo 'cat >> /root/autorunner/envs/.env.omb-link'
deploy restart omb-link
# oracle-in (systemd)
scp -q "$key" oracle:/tmp/apns.p8 && ssh oracle 'sudo install -m 600 -o root /tmp/apns.p8 /etc/dusk-link-node-apns.p8 && rm /tmp/apns.p8 && sudo cp -p /etc/dusk-link-node.env /etc/dusk-link-node.env.bak-apns'
printf "$lines" /etc/dusk-link-node-apns.p8 | ssh oracle 'sudo tee -a /etc/dusk-link-node.env >/dev/null && sudo systemctl restart dusk-link-node'
unset key id lines
```

The oracle node's service user must be able to read the key: if `systemctl cat dusk-link-node` names a `User=` other
than root, use `-o <that user>` above.

Check: `curl -s https://link.dusk.bot/v1/push` answers `{"services":["apns"]}` (each node in turn: it was `[]` before).
Rollback: `ssh contabo 'cp -p /root/autorunner/envs/.env.omb-link.bak-apns /root/autorunner/envs/.env.omb-link' && deploy restart omb-link`
and `ssh oracle 'sudo cp -p /etc/dusk-link-node.env.bak-apns /etc/dusk-link-node.env && sudo systemctl restart dusk-link-node'`.

A test push, once the owner's TestFlight build is paired and has registered (the device token is in the workspace's
push registrations, or in the phone's Settings, Notifications diagnostics):

```sh
curl -s https://link.dusk.bot/v1/push -H 'content-type: application/json' -d '{"service":"apns","environment":"production","token":"<DEVICE_TOKEN>",
  "message":{"id":"push-test-1","kind":"message","botId":"push-test","threadId":"push-test","botName":"dusk bot"}}'
```

`{"outcome":"sent"}` means APNs took it; the phone shows "dusk bot: New message".
