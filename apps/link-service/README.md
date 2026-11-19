# Metal link service

Links a person's VPS to their Metal app with one pasted line. It's a small Node app with no dependencies and
nothing tied to dusk.bot or Cloudflare.

```
curl -fsSL https://dusk.bot/s/<code> | sh
```

The app asks for the code (`POST /v1/sessions/<id>/short` with the watch token and the setup's vps secret, checked
against its verifier) and shows `shortInstallLine` (electron/vps-link.mjs). The code is 7 characters with no l, o, 0 or
1; it names one setup and works only while that setup waits or installs (a failed step's line again included), and the
secret is dropped once the setup is linked or cancelled. `GET /s/<code>[/<way>]` counts wrong codes: 30 an hour from one
address (Cloudflare's `cf-connecting-ip` through dusk.bot), 2000 an hour in all, and past that every try from there is
refused, a right one too. dusk.bot proxies `/s/` here (`DUSK_LINK_UPSTREAM` on the account service, `LINK_SHORT_BASE`
here), so the line itself goes through Cloudflare.

What it serves (`bootstrapScript`) is the long line's loop as a tiny script: it tries the installer download five times,
2 s apart, every other try over IPv4 (a shell loop: curl's `--retry-all-errors` is newer than Ubuntu 20.04's curl), and
hands it to sh only once it arrived whole, with the way (`/cloudflare`, `/tailscale`, `/ssh`, `/relay`) as its option.
When every try fails it exits 1 with a plain message. An older app, or a link service without short codes, shows the
long line, which still works:

```
(for f in "" -4 "" -4 ""; do s=$(curl -fsSL $f https://link.dusk.bot/i/<code>) && { printf '%s\n' "$s"; exit; }; sleep 2; done; echo 'echo "Metal could not be downloaded. check the internet and paste the line again." >&2; exit 1') | sh
``` Inside, every download (and the report of how a step ended) is tried five times, 2, 5, 10 and 20 seconds apart,
and a connect or TLS error (curl 7, 28, 35, 52, 55, 56) switches the next try to the other address family, IPv4 when
IPv6 was in use; the family that works stays for the run.

## Ways in

`| sh -s -- --cloudflare` (recommended; or `--tailscale`, `--ssh`, `--relay`) after the line picks
how the app reaches the server ([docs/self-hosting.md](../../docs/self-hosting.md#from-the-app-one-line-any-way-in)). The
installer's `address` step sets it up and writes `/etc/duskbot-address.json` (`{v, mode, via, host, pin, quick?}`, no
secret in it). `agent.mjs link` seals `via` with the result; the agent's `hello` answer carries `address` (`{mode, via,
origin, spki}`): a quick tunnel's current name from cloudflared's metrics, and the key of a pinned address read from the
server itself, or nothing when that key cannot be read. `--domain` and `--direct` are gone; an old line with one of
them (or `--cloudflare-token`) prints a note and sets up a Cloudflare tunnel instead. The app takes an `https` address from there, pins its key (none
for tailscale and cloudflare, which hold their own certificates), moves the saved server to it and signs in again.

What only the person can do goes to the app as a step event with `ask` (`installerAsk` in `src/app.mjs`):
`{kind: "tailscale-login" | "tailscale-https", url}` (only on login.tailscale.com) or `{kind: "ssh", user, host}`, each
with `state` waiting, found or done; `{kind: "none"}` clears it. Anything else is refused with 400. (The service still
accepts the older `cloudflare-login`, `dns` and `ports` kinds; the installer no longer sends them and the app ignores
them.)

A claim reply may carry `"cloudflare": {"token", "hostname"}`, a tunnel made for this server on the service's own
Cloudflare account: `--cloudflare` then runs that tunnel (`tunnel run` with `TUNNEL_TOKEN`) instead of a quick one.

## Phone push

`POST /v1/push` sends one push for a workspace that holds no APNs or FCM keys of its own; `GET /v1/push` lists the
services this relay has keys for. It sees the device token, the bot's name and ids, never message text, and keeps
nothing. Set `DUSK_APNS_KEY_FILE`, `DUSK_APNS_KEY_ID`, `DUSK_APNS_TEAM_ID`, `DUSK_APNS_TOPIC` and
`DUSK_FCM_SERVICE_ACCOUNT_FILE` on the service; see `docs/phone-push.md`.

## Slack OAuth return

`GET /slack/callback` validates Slack's code or error and state, then returns a small page that opens
`duskbot://slack/oauth` with a copyable fallback. The route is stateless: it never calls Slack, stores nothing,
and never logs the query. The app completes the exchange with its own harness, so the harness needs no public URL.

## Native OAuth return

`GET /oauth/app-tokens` is the one redirect URI registered with Metal's own OAuth apps (Notion, Linear, Airtable,
Todoist, ClickUp, Trello, Dropbox). The state starts with the desktop app's port (8799, 18799 or 28799, nothing else);
the route answers with a 302 to `http://127.0.0.1:<port>/api/app-tokens/callback` carrying only `state`, `code`,
`error` and `error_description`. A token in the #fragment (Trello) rides along in the browser and never reaches here.
Stateless like the Slack route: no outbound calls, nothing stored, the query never logged.

## How it fits together

```
 app (electron main)                link service (this folder)                 vps
 -------------------                --------------------------                 ---
 1 POST /v1/sessions  ----------->  session {verifier, appPub}
   shows the one line
                                    GET /i/<code>  <---------------------  person pastes the line
                                    POST claim, events  <----------------  install.sh: each step, log tail on failure
 2 long-poll events  <------------  steps as they arrive
                                    POST probe  <------------------------  agent.mjs probe: can we reach :80?
                                    POST result {sealed, vpsPub}  <------  agent.mjs link: pairing code, tunnel keys,
 3 opens the sealed result                                                  sealed for the app (x25519 + aes-gcm)
   (only the app can)
 4 local proxy http://vps-<id>.localhost:<port>
      |  sealed frames  ------->    /v1/tunnels/<id>/to-vps  ----------->  agent.mjs tunnel (duskbot-link.service)
      |  sealed frames  <-------    /v1/tunnels/<id>/to-app  <-----------    -> http://127.0.0.1:8799 (marked remote)
   pairs, saves the server, signs the AI in from this Mac, moves everything
```

- **Relay mode** (the default, and what Oracle Cloud gets because only port 22 is open; see "Direct path" for how such a
  server is still reached directly): every request and reply goes
  through the link service as AES-256-GCM frames, sealed with a key only the app and the VPS hold. The service just
  queues opaque blobs. Every frame carries a timestamp and is refused if it's stale or seen twice.
- **Direct mode**, with `--cloudflare` or `--tailscale`: the app talks HTTPS straight to the tunnel's or tailnet's
  address, which holds its own certificate. The tunnel still runs as a private control channel, and the relay takes over
  while that address does not answer.

## Cloud relay

Where neither direct transport connects, the same direct-path byte stream rides the Cloudflare relay
(`apps/cloudflare/link-relay`, relay.dusk.bot) before this service's relay: the tunnel agent keeps a standing
websocket there (`createCloudRelay`) and serves each app session through the direct hub, and the app dials it as the
third direct transport (`cloudConnector`). The frames stay sealed end to end; this service stays underneath as the
fallback and keeps pairing, setup and updates. `DUSK_RELAY_URL` moves it, `off` turns it off. See that folder's
README for auth, fair use, ops counters and going live.

## Direct path

A relay-linked server also gets a direct path, picked automatically and kept up in the background, with the relay as
the fallback. Nothing is opened on the server and the person configures nothing: it rides the server's own sshd on port
22, which every VPS already answers (Oracle Cloud included). Where the person's network blocks port 22 (Jio, often),
the same byte stream rides a WebSocket to the server's own HTTPS on 443 instead. The app tries ssh, then 443, then
WebRTC, then stays on the relay; a transport that failed on a network is tried last there for 30 minutes.

```
 app (electron main)                                         vps
 vps-link-direct.mjs  -- ssh, tcp 22, host key pinned -->    sshd -> forced command: node agent.mjs direct (as omb-link)
                                                                -> unix socket ~/.config/duskbot-link/direct.sock
                      -- wss, tcp 443, tls key pinned -->    https front (caddy, nginx) /omb-direct -> 127.0.0.1:8797
   same sealed frames as the relay, length-prefixed          both end in the tunnel process: http://127.0.0.1:8799 (marked remote)
```

- **443.** The tunnel process listens on `127.0.0.1:8797` (`DUSK_LINK_WSS_PORT`) for a WebSocket at `/omb-direct`; its
  binary messages carry exactly the ssh channel's byte stream.
  On a server whose operator runs their own HTTPS (nginx with a real certificate), add a location for
  `/omb-direct` that proxies WebSocket upgrades to `127.0.0.1:8797` and set `DUSK_LINK_WSS_URL=wss://<host>/omb-direct` in
  the link unit's environment. The app asks for the address with the sealed control op `direct-wss`; the agent answers
  the URL and the SHA-256 of its certificate's public key (read from the server itself), which the app pins on top of
  the usual certificate checks. A changed key (a renewal that made a new key) asks again over the sealed tunnel, at most
  once an hour. A server with no address says so, and is asked again an hour later.
- **Egress.** Egress streams ride the direct connection the app said hello on last, in the writer's lane (its own
  256 KB of unacknowledged bytes, served first each round), and the relay otherwise, where they have their own queue,
  unnumbered posts marked `lane`, and room of their own in the link service, which reads them out first.

- **Setup.** Once a link's tunnel is up, the app makes its own ed25519 key and sends the public half as the sealed
  control op `direct-key`. The agent adds one line to `~maus/.ssh/authorized_keys`:
  `restrict,command="<node> <agent.mjs> direct" ssh-ed25519 AAAA... omb-link-<tunnel id>` (no shell, pty, agent, X11 or
  port/socket forwarding, so the docker socket the server account can reach stays out of reach) and answers with sshd's public host
  keys, its public IPv4 (from a STUN server, outbound UDP) and the user name. The private key is kept with safeStorage
  in the link record (`links[].direct`); host keys are pinned there. `direct-off` and unlinking remove the line; the
  tunnel agent re-points the line at its own node path on start. An older agent answers "unknown request" and is asked
  again after 6 hours. `DUSK_LINK_DIRECT=off` (agent's environment, or the app's) keeps everything on the relay;
  `DUSK_LINK_DIRECT_HOST` / `DUSK_LINK_DIRECT_PORT` override the address the agent reports.
- **Sealing and identity.** The channel carries exactly the relay's frames (AES-256-GCM with the tunnel key, AAD
  `<id>|to-vps` / `<id>|to-app`, timestamps, one replay guard across every path on each end: the tunnel process serves
  the relay and every direct connection) as `[u32 length][type][iv|ct|tag]`
  records after a `\0OMBD1\n` magic. The agent says a sealed hello first; the app uses the path only after opening it,
  so a server without the tunnel key is never used. sshd's host key must be one the agent sent inside the sealed
  tunnel, so neither the network nor the relay can stand in. An auth or host-key failure asks for a new key over the
  sealed tunnel, at most once an hour.
- **Choosing a path.** A request takes the direct path when it is up and keeps its path. When the direct path drops,
  an unanswered GET or HEAD goes again over the relay and the rest fail (a POST is never sent twice). Event streams
  still on the relay 3 s after the direct path came up are ended so they reconnect over it; a desktop websocket opened
  while the direct path is dialling waits up to 4 s for it. Pings every 5 s measure the round trip; only silence
  (nothing received at all) drops the path. A wake or an unlocked screen resets the relay's sockets and restarts its
  read at once, and new requests take the relay until a quick ping proves the direct connection still alive.
- **Fairness.** Control frames (requests, heads, ends, control) go first. Stream bytes take turns in 16 KB pieces, a
  stream's own frames never overtake its bytes, and unacknowledged stream bytes are capped near what the path delivers
  in its round trip plus 250 ms (384 KB to 8 MB, from the acks), so a download or a busy desktop delays an API reply by
  about that much at most. What is ready goes out as one write a turn later: sshd sets no `TCP_NODELAY` for a channel
  without a pty, so separate small writes waited for delayed acks.
- **WebRTC.** After ssh and 443, the app tries WebRTC (`electron/vps-link-rtc.mjs`, agent `direct-rtc`): the offer and
  answer ride the sealed tunnel as one control op, so the DTLS fingerprints come from the two ends that hold the tunnel
  key; one reliable data channel then carries exactly the same sealed byte stream into the direct hub. STUN finds the
  way where hole punching works (a VPS that drops unsolicited UDP still answers what it punched itself), and the signed-in
  account's Cloudflare TURN servers (UDP, TCP, TLS on 443) carry it where it does not. The agent loads node-datachannel
  from `/opt/duskbot-link/node_modules` (the installer puts it there, best effort; `DUSK_LINK_NDC_DIR` moves it) and
  uses `DUSK_SCREEN_DIRECT_PORTS` for its UDP ports when set. Measured on the reference setup (2026-11-07) without TURN,
  punching failed behind a symmetric-NAT VPN against a VPS dropping unsolicited UDP; TURN covers that case.
- **When it cannot work.** sshd set to refuse the link account (`AllowUsers`, `AllowGroups`, `DenyUsers`), sshd off
  port 22 without `DUSK_LINK_DIRECT_PORT`, or outbound port 22 blocked on the person's network, and no HTTPS address for
  443: the app logs it and stays on the relay.

## Nodes

The relay runs on more than one node: `contabo` (link.dusk.bot, eu, the default) and `oracle-in` (link-in.dusk.bot,
Oracle Mumbai, asia). `LINK_NODES` lists them the same way on every node (`id=https://host@region,...`, the first is the
default home), `LINK_NODE_ID` says which one this is, `LINK_PEER_TOKEN` (32+ characters, the same everywhere) guards the
copy between them. `src/nodes.mjs`.

- **Directory.** Every node keeps the whole tunnel and phone channel table (ids, sha256 verifiers, the account ref, the
  node a tunnel lives on; never a token or anything sealed) and copies changes to the others with `POST
  /internal/v1/sync` at once and every 5 s; newer revisions win, deletes leave a 30 day tombstone so a node that was away
  cannot bring a tunnel back. That sync is also the health check: a peer silent for 30 s is down. Setup sessions stay
  on the node that made them. Why not the account service's Mongo: the link service has no dependencies and must keep
  relaying while the account service (on the Contabo box) is down; with a copy on every node either one answers alone.
- **Placement.** The agent asks `POST /v1/tunnels/<id>/place` (vps token, `{rtt: {node: ms}}` from its own /healthz
  round trips) on every start. It stays on its home unless home is down, paused, past 85% of its month allowance or at
  its tunnel cap, crowded (85%) while another node is under 50%, or out of the server's own reach (it measured another
  node but not its home: a node whose nginx died still syncs out, so its peers see it up). A new one goes to the lowest score among nodes that take
  new servers: 0.5 x max(tunnels / cap, out rate / ceiling), where tunnels is the fullest of busy tunnels, tunnels in use
  and servers reading here, each against its own cap (docs/capacity.md), + 0.3 x month on course / 70% + 0.2 x its share of
  homed servers + up to 0.5 for a slower round trip (300 ms behind the best = 0.5). A node takes no new servers when
  down, paused, at 90% tunnels, 85% bandwidth, 70% of its month allowance on course (box traffic, `LINK_ALLOWANCE_TB`;
  Oracle's free 10 TB), or 90% cpu or memory. With every node full a new server goes to the least loaded one that is not
  paused. A peer that may not hold the record yet is never chosen. A new node: `deploy/add-node.sh`. Answer: `{node,
  url, reason, nodes}`. The tunnel's home moves when its server polls a node (a placement it may not follow never moves
  it: with the copy between nodes cut, that split the directory and sent the app to a node nobody read).
- **Finding it.** `GET /v1/tunnels/<id>/node` (app or vps token) and `GET /v1/channels/<id>/node` (phone channel token)
  answer `{node, url, region, up, nodes: [{id, url, region, up}]}` on any node; `GET /v1/nodes` (public) lists the
  nodes. A tunnel with no home (from before nodes, or an agent that never asks) lives on the default node.
- **Only the home relays.** The app's and phones' reads and writes for a tunnel whose server reads on another node are
  refused with `409 {code: "moved", node, url, nodes}` instead of queued where nobody reads them; the app moves there at
  once. A request over the relay with no answer at all for 4 s makes the app ask where the tunnel lives as well (a node
  whose copy of the directory lags), and on a move an unanswered GET goes again to the new node while anything else
  that waited fails with a short message.
- **The sealed address.** The agent puts its address (what `hello` answers, sealed with the tunnel key, AAD
  `<id>|address`) in the directory with `PUT /v1/tunnels/<id>/address` on start and whenever it changes (checked every
  30 s, so a quick tunnel's new name lands within a minute). `GET .../node` with the app token carries it as `address`;
  the app opens it when its server stops answering at its address and the relay cannot carry the handshake.
- **Failover.** The agent watches its node: reads failing for 20 s (longer than a redeploy), silent for 35 s, or answering `relay_busy`, it
  asks again (at most every 15 s; the node it was linked through first, then every node it learned of, cached in
  `~/.config/duskbot-link/nodes.json`) and restarts on the new node. The app's relay (`createTunnelProxy` with
  `follow`) asks where the tunnel lives at start, after two failed reads, on `relay_busy`, on a 409 and after 4 s of
  silence, and moves there (its one http/2 connection goes to the new node; asking other nodes takes http/1.1); the
  phone does the same after a failed or unanswered request. A 404 from a node it moved to is "unlinked" only once the
  node it was linked through says 404 too. One node listed: nothing moves. Retries on both ends wait a random half to
  all of their backoff, so the servers and apps of a restarted node do not all come back in one second.
- **Beats.** A streamed read writes an empty line after 10 s idle and says `x-link-beat: 10`; the app, the agent and
  the phone drop a connection that stays silent for two beats and 3 s and read again, so a network switch (wifi to a
  hotspot) costs about 25 s without any help, and the desktop's address watch makes it a few.
- **Proxies.** The app opens its relay connections inside the CONNECT tunnel of the proxy chromium would use for the
  url (`session.resolveProxy`, http proxies; DIRECT otherwise) and sends setup sessions through chromium's network; the
  agent honours `HTTPS_PROXY` and `NO_PROXY`.
- **Resumable downloads.** The agent sends a reply's length as `x-dusk-length`; a GET answered 200 with
  `accept-ranges: bytes` and a strong ETag or Last-Modified that loses bytes on the relay goes on with `Range` and
  `If-Range` from where it broke (after 1, 2, 4, 8 s, five times at most); the browser sees one download. Uploads do
  not resume: a body that lost bytes fails.
- **Restarts and lost frames.** Queues live in memory. Every answer carries `x-link-boot` (random per process): an app
  that sees it change sends unanswered GETs again and fails what else was on the relay with a short message. A writer
  whose numbered posts reach a node that never saw its epoch starts where it is after 300 ms. Each end counts the bytes
  of every stream it sends (`{t: "mark", r, n}` every 256 KB or 2 s, and `n` on the end); a receiver whose count
  differs ends that stream as failed, so a lost frame is a failed download or a reconnecting event stream, never a
  file with a hole. Older ends ignore both.
- **Ops.** `GET /ops/relay/stats` adds `node` (id, region, url, default, homed, accepting, refuses, load), `nodes` (each
  as this one sees it), `box` (cpu, memory, interface rates, month bytes kept in `box-usage.json`) and `turn`. The
  account service lists every node (`DUSK_LINK_NODES`, plus the first node's own peers) and mails early warnings
  (`apps/dashboard/server/admin/ops/relay-alerts.ts`).

### TURN

coturn runs beside each node as a second turn tier (Cloudflare Realtime TURN is the first). Short-lived credentials in
the TURN REST API shape, valid on every node (`LINK_TURN_SECRET`, coturn's `static-auth-secret`):

```
GET /v1/tunnels/<id>/turn     bearer: the app or vps token
GET /v1/channels/<id>/turn    bearer: the phone channel token
-> { "iceServers": [ { "urls": ["stun:stun.cloudflare.com:3478"] },
                     { "urls": ["turn:<home>:3478?transport=udp", "turn:<home>:3478?transport=tcp", ...every other node],
                       "username": "<unix expiry>:<id>", "credential": "<base64 hmac-sha1(secret, username)>" } ],
     "ttl": 3600, "expiresAt": <ms> }
```

`iceServers` goes straight into `RTCPeerConnection`; ask again before `expiresAt`. 404 `no_turn` when the node has no
secret set. The node checks its own coturn with a STUN binding every 30 s (`turn` in the ops stats).

## Versions and updates

- **Handshake.** The agent says what it speaks (`LINK_PROTOCOL`, the oldest app and server it works with, `AGENT_VERSION`
  and its capabilities) in its direct hello and in answer to the sealed control op `hello`, which also carries the
  server's version and link protocol (`server/link-protocol.ts`, the `link` field of
  `/.well-known/duskbot/environment`). Protocol numbers decide, never versions; an optional feature is a capability
  the app checks for. The app's view gets `compat: { update: null | "app" | "agent" | "server", message, ... }`. An
  agent from before the handshake answers "unknown request" and works as protocol 1.
- **Self-update.** Every 6 hours (5 minutes after start first) the tunnel reads `GET /v1/release` (the version, protocol
  and sha256 of the agent this service serves, and `agent.mjs.sig` when there is one) and stages a newer release in
  `~/.config/duskbot-link/releases/<version>/` only when the file matches its hash and its own version line, a
  signature checks out when release keys are pinned (`RELEASE_KEYS` in agent.mjs or `DUSK_LINK_RELEASE_KEYS`; sign with
  `node release.mjs sign <key>`), and `agent.mjs selftest` runs; `ready.json` is written last. It never takes an older
  version or a lower protocol. It applies only after 5 minutes without a request, a stream byte or an egress stream
  from the app or a phone (or at once for the `update` op with `apply: "now"`), by ending the tunnel so systemd starts it again.
  The installed `/opt/duskbot-link/agent.mjs` then launches the staged file, and stops launching one that did not
  stay up for 2 minutes three starts in a row, so a bad release leaves the installed agent running.
  One release key is pinned (`RELEASE_KEYS`); its private half is the repository secret `DUSK_LINK_RELEASE_KEY` (and
  the owner's `dusk.env`), and `.github/workflows/link-agent-sign.yml` re-signs `agent.mjs.sig` on main whenever
  `agent.mjs` changes, so a deploy after that serves a release every pinned agent takes. Bump `AGENT_VERSION` with
  any change servers should get. `DUSK_LINK_UPDATES=off` turns it off for good.
- **The server's own build.** The server is root's, so the agent only stages it and root installs it:
  - The agent reads `GET /v1/tunnels/<id>/server` with the tunnel's own VPS token (`{v:1, package:{sha256,size,version,signature?}, policy?}`,
    404 `no_build` when none is published; 12 reads an hour per tunnel) 10 to 30 minutes after start, then every 60 to
    80 minutes (the spread keeps servers from asking together). Only a build signed by a pinned release key and newer
    than the server's version (its well-known descriptor) is downloaded: `GET /v1/tunnels/<id>/server/<sha256>.tgz`
    (only the current build, open byte ranges to resume, 12 a day per tunnel) into
    `~/.config/duskbot-link/server-release/`, checked against its hash, with `ready.json` written last.
    `DUSK_LINK_SERVER_UPDATES=off` turns it off.
  - `duskbot-server-update.timer` (15 minutes after boot, then 15 minutes after each run) runs root's copy of this
    script, `/usr/local/lib/duskbot/install.sh --update-server`. Root reads the link account's `ready.json` and tgz as
    that account (`runuser`, capped at 70000 bytes and the size it said, at most 2 GiB) into its own folder
    `/var/lib/duskbot-link/packages`, checks every field and the hash there, and takes signed builds only on this path.
  - It goes ahead only when `systemctl is-active duskbot.service` is `active` and `GET /api/updates/busy` (owner-trust
    loopback only) names no hold (`turn`, `run`, `live-call`, `computer`, `maintenance`), or the server is `failed` or
    stuck `activating`. A server someone stopped stays stopped and is not updated. Just before the restart it asks
    again and waits up to 5 minutes in 15 s steps; still busy, the restart waits for the next round.
  - The install is the same as a pasted line's: signature, policy, never older, never a version that failed here, the
    build before kept in root's folder, and after the restart the server must answer and pass its self-test or the build
    before goes back. A build it would not take is noted and not tried again. Its log is
    `/var/log/duskbot-link/server-update.log`.
  - Root never writes, reads or changes a path in the server account's home: npm gets a copy the server account writes
    into its own cache from root's file on stdin (pasted lines too).
  - Root's copy of the script comes from the link service when a line runs (the same trust as the line), and after that
    only from a signed build that carries it (`link/install.sh` in the package, `scripts/build-vps-package.mjs`).
  - An install from before this needs one more pasted line (or `--repair`) to get the timer.

## Phone channels

The VPS agent syncs phone channels with its local harness at `/api/mobile/relay/sync` and registers them under the
existing tunnel. Each phone has its own relay token verifier, encryption key, replay guard and queues. Grant channels
only serve pairing redemption, environment discovery and health; device channels serve the harness API with the
phone's session. Phone channels refuse agent controls and strip cookies and `x-dusk-*` headers. Requests carry
a per-channel remote address, so they never receive loopback trust. Removing a channel from the harness closes its
forwarded requests and removes it from the relay.

A desktop runs the same hub for its own phones (`electron/phone-relay.mjs`, which imports `createPhoneHub` from this
file; the desktop package ships it). While remote access is on, the app makes a tunnel for itself through the ordinary
setup session (`POST /v1/sessions` with the signed-in account's grant, then `claim` and `result` from the same app),
keeps it per workspace with its phone keys in the OS keychain, and syncs channels with its harness as the desktop owner
(`x-dusk-desktop-owner`, which the hub strips from every phone request). A dropped tunnel is made again with the same
phone keys, so the phones' channels carry over. Nothing here changes for it: it is one more tunnel on the account.

The agent keeps its X25519 phone keys in `phone-keys.json` beside `tunnel.json`, with mode 0600. Grant keys come from
the harness; device keys derive from the phone and agent key pairs using the channel id. Set `DUSK_LINK_PHONES=off`
to disable the phone hub. Phone clients use `createTunnelProxy` with `id` set to the channel id and `route` set to
`${base}/v1/channels/${channelId}`.

## Security model

- The code in the command is one-time. It must be used within 30 minutes and the session ends 2 hours after it opens.
  Once linked, the same line is refused ("already used"), and running it again only repairs the install offline.
  Nothing in shell history can be used again.
- The service stores only sha256 verifiers of bearer tokens, public keys and sealed blobs. It never stores a token, the
  pairing code, a credential or chat data. `test/link-service.test.mjs` checks the saved state file for this.
- The result is sealed with X25519 ECDH between a key the app made and a key the VPS made, so passively logging
  everything the service sees opens nothing. Residual risk: an actively malicious link service could serve a different
  script or swap keys. That is the trust you give anything you `curl | sh`. Run the service yourself (this folder) to
  remove the third party entirely.
- Tunnelled requests arrive at Metal with `X-Forwarded-For` set, so the server treats them as remote: they need
  the paired session and never get loopback trust. The app's proxy serves only its own `vps-<id>.localhost:<port>` host.
- AI credentials are made on the Mac (`claude setup-token`, Codex's `~/.codex/auth.json`). They travel only as sealed
  control frames to the agent, which writes them with mode 0600 into its hand-off folder (`/var/lib/omb-link/handoff`).
  A root unit (`duskbot-handoff.service`, `/usr/local/lib/duskbot/engine-handoff.sh`) reads them as `omb-link`,
  keeps only the `CLAUDE_CODE_OAUTH_TOKEN=` line for `/etc/duskbot/engines.env` (which only systemd reads) and
  writes the Codex sign-in into maus's `~/.codex/auth.json` as maus. They never pass through Metal's HTTP API and
  are never logged.

### Accounts on the server

Bots run shell commands, so the server is split so that no bot can reach what would give it the machine or the link:

| Account | Runs | Holds | Never has |
|---|---|---|---|
| `dusk` (`maus` on a server set up before the rename) | `duskbot.service` (hardened: no new privileges, no capabilities, system read-only, other homes hidden) | its home (0700) and data folder (0700) | the docker group, the link files |
| `omb-link` | `duskbot-link.service` and the app's restricted direct key | `/var/lib/omb-link`: `tunnel.json`, `.ssh/authorized_keys`, the hand-off folder | the server's data |
| `omb-docker` (in `docker`) | `omb-docker-gate.service`: a Docker API filter on `/run/duskbot-docker/docker.sock` (group `omb-dockergate`: the server account only) | nothing | a shell, the network |

- Every bot's turn runs in the bot box (`DUSK_BOT_BOX=required`, server/bot-box): its own user, mount, pid and network
  namespaces, HOME an engine home inside the data folder (`engine-home`) with only the engines' sign-ins bound in
  (settings read-only), its workspace, and the internet through the box's egress gate. The server's HOME, data folder,
  `~/.ssh`, `~/.config` and `~/.local` are never in a box, and a working folder that would contain them is refused. If
  bubblewrap cannot run, bots' turns are refused rather than run unboxed. Ubuntu 24.04 needs the AppArmor profile
  install.sh writes (`/etc/apparmor.d/duskbot-bwrap`) for bubblewrap to make user namespaces.
- The docker gate (`docker-gate.mjs`, served at `/docker-gate.mjs` like the agent) forwards only what the server's bot
  computers need, on containers labelled as ours, with the flags it sets (gVisor, no privileged mode, no host mounts,
  devices or namespaces, dropped capabilities). The two host probes are allowed only in their exact shape.
- Running install.sh again on an older install moves `tunnel.json` to `omb-link`, drops the app's key from the server account (the app
  asks the agent for a new one over the sealed tunnel and connects as `omb-link`), moves the Claude token to
  `/etc/duskbot/engines.env`, copies the engines' sessions into the engine home, takes the server account out of the docker group
  and installs the gate and the hardened units. Nothing in the data folder moves.
- A server set up before the rename to Metal keeps its server account (`maus`). Running install.sh on it again
  (`migrate_legacy`) stops and removes the old units, moves the state, logs, agent, gate, `/etc` and link folders and
  the data folder to the new names (the old data and agent folder names stay as links), points the app's direct key at
  the moved agent, and moves the AppArmor profile and Caddy site. Until then the old install keeps working: the agent
  reads its old folder and env names, and the app reads the old unit names and the old well-known path.
- Unlinking in the app deletes the tunnel at the service. The agent then idles and the app forgets the server.

### Secrets sealed for the server itself

On top of the tunnel, every password, 2FA key, 1Password service-account token and API key typed in the app is sealed
for the Metal server process before it leaves the page (HPKE: P-256, HKDF-SHA256, AES-256-GCM), so neither the
link service, the agent nor anything else that relays the request can read it:

- The server makes a fresh sealing key each start (`GET /api/seal-key`) and signs it with its long-term identity key,
  `seal-identity.key` (P-256, mode 0600, in the data folder, never in a workspace backup or a move). The identity is in
  `/.well-known/duskbot/environment` as `sealIdentity`.
- `agent.mjs link` puts `sealIdentity` in the result it seals for the app, and the app pins it in its link record
  (`vps-link.json`, `links[].sealIdentity`). A link made before that pins the first identity it sees, through the same
  sealed tunnel (`sealPinnedAt` says when). The page asks main (`window.ogb.sealTrust.check`); main picks the link from
  the page's own origin. A key signed by any other identity is refused and nothing is sent.
- Each seal is bound to what it is for (`shared/saved-secrets.ts` `sealedValueAAD`): a login from Settings to its host
  and username, a change to the login's id, a sign-in card's login to that bot, conversation and card, the 1Password
  token to its connect, API keys to the settings paths they fill (`sealedPaths`). A sealed value opens once.
- The server refuses a secret in the clear from anything but loopback with `400 {code: "seal_required", sealKey}`. The
  desktop's own page on this computer, and its private main-process channel for keys, keep working unsealed.
- Reinstalling Metal with a fresh data folder makes a new identity: the app then refuses to seal for it until the
  server is linked again (run the install line from a new "Add your VPS").

## Route traffic through this computer

Settings > Computer > Your computer > "Route traffic through this computer" (`PUT /api/computer/egress {enabled}`,
saved as `vps.routeThroughComputer`, on unless someone turned it off) sends the bot computers' web traffic out through the person's own
computer while its app runs, so sites see a home connection instead of the VPS's data centre address. When the app is
closed, asleep or offline, new connections use the VPS's own network, and they go back through the computer once it
says hello again. The row says which network is in use (amber while it is the server's), and the app shows a quiet
note the first time it falls back. It applies to new connections only.

```
 bot computer (chromium)         vps host                            the app (electron main)
 managed policy: PAC              agent.mjs createEgressProxy         vps-link-egress.mjs createEgressEndpoint
 "SOCKS5 172.18.0.1:3129"         -> socks5 / http connect on the  -> {t:"dial", r, host, port}  ->  resolve here, check
                                    omb-desk0 bridge only             <- {t:"dialed", r, ok, code}     every address, connect
                                                                      <-> bytes frames on the same sealed tunnel streams
```

- Frames: the app says `{t:"egress", ready}` every 15 s while it takes streams (and `ready: false` on close). The agent
  sends `dial`, the app answers `dialed`; then both sides send the stream's bytes as ordinary `bytes` frames and `end`
  or `cancel`. It is the tunnel's own stream api (`send`, `bytes`, `queued`, `onDrain`), so it rides any transport the
  tunnel uses, with the outbox's per-stream round robin. Egress reads pause at 1 MiB queued (the desktop's own mark is
  2 MiB), so the screen and API keep their share.
- The app connects only to ports 80 and 443 on the public internet. It looks names up itself, refuses a whole name when
  any answer is loopback, this computer, its networks (and its public IPv6 prefix), the home's public address (from
  `GET /v1/ip` on the link service), private, CGNAT, link-local, metadata, multicast or reserved (NAT64 and 6to4
  unwrapped), refuses `.local`, `.localhost`, `.internal`, `.lan`, `.home.arpa` and single-label names, and connects
  only to the addresses it checked (no second lookup, so DNS rebinding changes nothing). At most 128 streams, 600 new
  streams a minute and 8 MiB/s down; idle streams close after 5 minutes. No UDP.
- The agent never dials anything itself (a box must not reach this host past the host fence). It listens only on the
  bridge's address, refuses the bridge's own address (so processes on the host cannot use it), and answers with a
  SOCKS failure at once when the setting is off, the app is at its stream cap, has not said hello for 40 s or did not
  answer a dial within 5 s (then its open streams close too, and the agent reports at once). The policy has no
  `DIRECT` fallback, so such a request fails instead of leaving through the server's network: a page that exhausts the
  stream cap cannot push the browser off the proxy. The server removes the policy (every request direct) only once the
  agent reports the app offline, and writes it again when the app is back. A destination the app refuses
  or cannot reach (its own DNS may block ad domains, for one) gets a SOCKS success and an immediate close instead,
  which fails only that request and keeps the proxy in use; HTTP CONNECT gets 403 or 502.
- `host-fence.sh` lets the bridge reach TCP 3129 on the host (`omb-box-egress`); nothing else on the host.
- The server (`server/computer-egress.ts`) takes the agent's report every 5 s (`POST /api/computer/egress/agent`,
  owner-trust loopback only), and writes `/etc/chromium/policies/managed/omb-egress.json` into each running bot
  computer while the route is up and the box can reach the proxy (removing it otherwise). Chromium rereads that folder
  by itself, so nothing restarts and no image change is needed. Strict (read-only) boxes keep using the server's network.
- Settings show the row only on a linked VPS, with the route new connections take now: through your computer, or the
  server's network while your computer is offline. Bots are told about it in their prompt while it is on.

## Phone channels and typed codes

Each phone has its own channel and bearer verifier under a VPS tunnel, separate from the Mac's queues.
The VPS token authorizes `PUT /v1/tunnels/:id/channels {channels:[{id,verifier,kind,expiresAt?}]}` to replace
its whole set (up to 32): `grant` expires within 24 hours; `device` has no expiry. Omitted channels are revoked;
changing a verifier ends old readers and clears queued frames. Channel verifiers persist in `state.json`; frames do not.

- Phone token: `POST /v1/channels/:cid/to-vps {frames,epoch?,seq?}`,
  `GET /v1/channels/:cid/to-app?wait=25&stream=1`, `DELETE /v1/channels/:cid`.
- VPS token: `POST /v1/tunnels/:id/channels/:cid/to-app {frames,epoch?,seq?}`,
  `GET /v1/tunnels/:id/channels/to-vps?wait=25&stream=1`. The aggregated stream starts with `{frames:[]}`,
  then emits `{channel,frames}` batches round robin, with one reader per tunnel. Without `stream=1`, it returns
  `{batches:[{channel,frames}]}`. Deleting the tunnel also removes its channels.
- Phone limits per channel: 50 posts/s with a burst of 400, 256 MiB of frame text per rolling minute,
  and 600 reads per rolling minute. A limit returns `429 {error,code:"rate_limited"}`.
- Public typed-code storage: `POST /v1/lookups {id,sealed,ttlS,deleteVerifier?}` (32 lowercase hex id,
  base64url sealed text up to 16384 characters, TTL 30-900 seconds), `GET /v1/lookups/:id` returns
  `{sealed,expiresAt}`. Optional `DELETE /v1/lookups/:id` requires the token matching `deleteVerifier`.
  Lookups stay in memory only, up to 5000 live entries; per IP, 120 creations and 240 misses per hour.

## Step events

install.sh posts every step to `POST /v1/sessions/<id>/events` (bearer: the VPS token); the app reads them from
`GET /v1/sessions/<id>/events?after=<seq>&wait=25` (bearer: the watch token) as `events[]`:

```
{ "seq": 12, "at": 1762462800000, "step": "node", "status": "running" | "done" | "failed" | "skipped",
  "log":   "last 30 lines\n...",              // only on failed and skipped: the step's log tail
  "cmd":   "apt-get -y -q install nodejs",     // optional: the command running now
  "lines": ["$ apt-get -y -q install nodejs", "Get:4 https://deb.nodesource.com/... [31.2 MB]", "..."] }  // optional
```

- While a step runs, install.sh sends its new log lines about every 0.5 s: at most 40 a batch (a batch that had more
  starts with `[N more lines]`), each line cut to 300 characters and stripped of control characters, one batch in
  flight at a time, and the last one before the step's `done`/`failed`. Lines starting with `$ ` are the commands it
  runs. Those batches have `"status": "running"`, so an app that ignores `lines` sees nothing new.
- Before anything is written to a log or sent, bearer tokens, the link secret and VPS token, `sk-...` keys and
  `token`/`password`/`secret`/`*_KEY` values are replaced with `[redacted]`.
- The service keeps up to 60 lines and 16 KB per event (the newest), `cmd` up to 300 characters, and the newest 150
  line, progress and heartbeat events per session; status events are never dropped for those events. Steps the app does not know
  (`sandbox`, `fence`) are reported as `desktop`.
- In the app, `electron/vps-link.mjs` keeps them in memory only and puts them on the view it already sends:
  `steps[i].cmd`, `steps[i].lines` (last 200 per step) and `terminal` (last 400 lines overall, in order, each
  `{ "step": "node", "text": "..." }`). A late batch never moves a finished step back to running.
- Running events may include `progress`: downloads report `kind: "download"`, `receivedBytes` and `totalBytes`;
  Docker reports `kind: "layers"` or `"build"`, `completed` and `total`, and known transfer bytes. Build totals count
  observed operations and can grow; only `DONE` or `CACHED` operations count as complete.
- Running events include `activity: { elapsedMs, quietMs }`. A heartbeat is sent about every two seconds without
  output; `heartbeat: true` means no new log bytes or progress were observed. It proves contact, never progress.
  Closing the app's setup modal keeps installation running. Explicit cancellation stops the installer's children,
  keeps installed files and cached download bytes, and requires a new setup command to resume.

## The server build

The VPS installs our own server, built from this repo, not the upstream `duskbot` npm package. That build is
private: the service hands it only to a claimed install session, at `/pkg/<session>/<sha256>.tgz`, with the session's
own bearer token, while the session is still installing, at most 20 times across both archives. There is no public url for it.

- The claim reply names the build: `"package": {"sha256", "size", "version", "signature"?, "path"}`. install.sh downloads it (the
  terminal shows a progress bar), checks the sha256, and installs it with `npm install -g <file>` as the server account (`dusk`).
  Interrupted downloads retain `.part` files and resume with an authenticated `Range: bytes=<offset>-` request.
  A checksum mismatch discards that partial file and retries from zero; a verified cache needs no download.
  Its three native dependencies (DuckDB, resvg, the 1Password SDK) still come from the npm registry, per platform.
- Updates (running install.sh again with a new build published) can't break the server: with `DUSK_RELEASE_SIGNING_KEY`
  set, `scripts/build-vps-package.mjs` signs the build and the claim carries `"signature"`; `<packages>/update-policy.json`
  (`apps/cloud-service/scripts/sign-update-policy.ts`) rides as `"policy": {"body" (base64url), "signature"}`. install.sh
  takes a build only when its signature verifies against the pinned release keys (required once one signed build was
  taken), it is not older than the installed one, at or above the policy's floor, not blocked and not rolled back here
  before; anything else keeps the installed build. The build before stays cached; after the restart the server must
  answer and pass its own self-test (`$DATA/update-state.json`, server/update-state.ts), else install.sh puts the build
  before back ("Update rolled back, nothing lost") and never takes that version again.
- No build published means no `package` in the claim, and the install stops at "Installing Metal" with "the link
  service has no Metal build to hand out yet".
- `DUSK_PACKAGE=<npm spec or tarball url>` before `sh` installs that instead. It is never the default.
- The bot computer kit rides the same way: `deploy/bot-desktop/` plus `shared/bot-desktop.ts` as one tgz, named in
  the claim as `"desktop": {"sha256", "size", "image", "path"}` (`image` is `BOT_DESKTOP_IMAGE`). install.sh then sets
  the host up the way `deploy/bot-desktop/README.md` ("Host setup the box expects") says, as three terminal steps
  that all report to the app as its one `desktop` step:
  - **Sandboxing bot computers**: gVisor `runsc` from its apt repo, registered in `/etc/docker/daemon.json` with
    `"runtimeArgs": ["--overlay2=none"]`; if that fails, `"userns-remap": "default"`. The file is merged, never
    replaced (the first original is kept as `daemon.json.omb-before`), Docker restarts only when it changed, and the
    old file goes back if Docker won't start with the new one.
  - **Fencing their network**: `host-fence.sh` to `/usr/local/sbin/omb-host-fence`, `omb-box-fence.service`
    enabled and started, then `omb-host-fence --check`.
  - **Building the bot computer**: nothing if the image is already there, a `docker pull` if a registry copy exists,
    else the kit's `build.sh` (installs `docker-buildx` only for that fallback), reporting completed build operations.
  Each of these that fails is shown in amber and the install goes on: bots work without a bot computer, boxes fall
  back to strict mode without the sandbox or fence, and the app builds the image on first use.

Publish a new build (from the repo root, on a machine with this checkout):

```
node scripts/build-vps-package.mjs                               # builds; writes release/vps/duskbot-<version>-<sha12>.tgz + manifest.json
node scripts/build-vps-package.mjs --skip-build --publish /root/omb-link-data   # on the link service host: copies it in
```

`--publish <data dir>` writes `<data dir>/packages/<sha256>.tgz` for the build and the kit, then
`<data dir>/packages/current.json` (`{"sha256","version","commit","builtAt","desktop":{"sha256","image"}}`), each by rename, so nothing restarts and new claims get the new build at
once. To publish from elsewhere, copy those three files into the service's `packages/` dir in that order (tgz first). Older
tgz files keep serving installs already under way; delete them when no install from the last 2 hours needs them.
`LINK_PACKAGES_DIR` moves the folder.

## Stops, reruns and odd servers

- One install, repair or uninstall runs at a time (`flock` on `/run/duskbot-install.lock`; step processes keep it).
- A dropped ssh connection does not stop the install: it finishes, reports to the app, and writes what it would have
  shown to `/var/log/duskbot-link/install.log`. Ctrl-C stops it; the same line picks up where it stopped.
- A dpkg run that was cut off is finished (`dpkg --configure -a`) before apt runs again.
- A server build is installed with `app-installing` noted first, so one cut off inside npm is finished from the verified
  download on the next run, `--repair` included; an update's rollback is noted before npm runs and stays pending until
  the build before is back. A new build always restarts the server. A first build that never answered here is noted
  as failed, so a line offering the build before it may install that.
- A line this server already linked with, run again before it noted the link, repairs instead of saying "already used";
  the service answers a repeated result (same sealed blob and tunnel verifiers) as done.
- Linking a linked server again ends its old tunnel at the service and removes that app's direct key, so the app that
  held it reads "unlinked"; the app replaces a record with the same `environmentId`.
- `check` refuses Ubuntu before 20.04, Debian before 11, less than 900 MB of memory and swap
  (`DUSK_MIN_MEMORY_MB`) and a clock more than 4 minutes off the link service's after turning time sync on. Frames are
  stamped and checked in the link service's time (its `Date` header) on the agent, the app and the phone, so a clock
  that drifts later does not silence the link.

## The free backup AI

The engines step also runs `duskbot free-backup install` as the server account: OpenCode's pinned build goes into the
data folder through the same verified install Settings uses, so the free backup answers the first message with no
download wait. A copy already there (the app's or one the person installed) is kept and nothing is downloaded. A failed
download does not stop the install: the server's unit sets `DUSK_PREINSTALL_FREE_BACKUP=1`, so the server tries again
in the background at every start. The desktop app's server and a dusk cloud home (its unit and the `cloud-home` image)
set the same flag.

## The terminal

install.sh opens with the wordmark decoding out of noise and one light sweep (about a second, one awk process), then
shows five phases, one line each: Preparing your server (check, basics, docker, user), Installing the runtime
(node), Installing Metal (app, engines, service), Setting up the bot computer (sandbox, fence, desktop) and
Linking to your app (address, link). The running step is the line's sub-status, with a bar for downloads of known
size and build steps, and the line turns into one check when the phase is done (amber when an optional part failed).
The mascot wags its tail while work runs. A failure shows the red step, its last log lines and one plain fix. The end
is three lines: ready and how long it took, where it runs, and "go back to the app". The versions table goes to
`/var/log/duskbot-link/summary.log` (and on screen with `DUSK_VERBOSE=1`); every step's log is
`/var/log/duskbot-link/<step>.log`.

It falls back to plain lines (no escapes) when stdout is not a terminal or `TERM=dumb`, drops colors and the
animation for `NO_COLOR` (`DUSK_NO_ANIM=1` keeps colors without the animation), uses ASCII for `DUSK_ASCII=1`, and a
one-line wordmark under 80 columns. In-place drawing (the phase list, the mascot) only happens when the screen has
room for all of it; otherwise lines just follow each other.

Try the screen without a server (writes nothing, needs no root, runs on a Mac too):

```
DUSK_INSTALL_DEMO=1 sh apps/link-service/install.sh        # DUSK_INSTALL_DEMO=fail shows a failure
```

## Uninstall

```
curl -fsSL https://link.dusk.bot/uninstall | sh                 # shows what it removes, asks on the terminal
curl -fsSL https://link.dusk.bot/uninstall | sh -s -- --yes     # no question (or DUSK_UNINSTALL_YES=1)
```

`GET /uninstall` (also `/uninstall.sh`) serves `uninstall.sh` to anyone, no session, with the base baked in. It puts
the server back the way install.sh found it, in the same five-phase screen: Unlinking from your app (deletes the
tunnel at the service with the server's own tunnel token, so the app reads "unlinked"), Stopping Metal (every
unit install.sh wrote), Clearing the bot computers (our containers, their home volumes, the desktop
network (`DOCKER_NAMES.desktopNetwork` in `electron/legacy-names.mjs`), our images, the host fence and its iptables rules, and `/etc/docker/daemon.json` back from install.sh's
`.omb-before` copy or with only our keys taken out; Docker restarts only when that file changed), Removing your bots'
home (a 0600 tarball of `~maus/.duskbot` to `/root/duskbot-backup-<date>.tgz` first unless `--no-backup`,
then the server account, `/opt`, `/var/lib`, `/var/log` files and Caddy site) and Removing what it installed. It ends
with a check of what is left (systemctl, `docker ps -a` and friends, the account, the paths, the fence, daemon.json).

It asks before changing anything, on `/dev/tty`, so the `curl | sh` line works. With no terminal and no `--yes` it only
shows what it would remove; `--dry-run` does that on purpose. It is safe to run again, and when nothing or only part is
installed. A failed backup stops it before anything of the bots is removed.

install.sh writes `/var/lib/duskbot/install-manifest`: every package its apt calls added (dependencies too), the
apt sources and keyrings it created, whether it made `daemon.json` or which keys it added, what it did to the
Caddyfile, the ufw ports it opened and whether it made the server account. A plain uninstall keeps Docker, Node, Caddy
and gVisor (and the `pkg`/`file` lines of the manifest, so a later `--all` still knows them). `--all` also purges
those packages: it marks them automatic and purges only the ones apt would then autoremove, so anything installed
later that needs one keeps it; it never removes `curl` or `ca-certificates`, and it clears Docker's build cache. When
Docker is one of them, purging it also empties `/var/lib/docker` (every container and volume, not only ours), and the
plan says so before it asks. Docker's socket unit is stopped first so a later install's Docker starts cleanly.

### Chaos run

`node apps/link-service/chaos/run.mjs` (or `npm run chaos` here) brings up two real nodes (`src/server.mjs`) behind a
tls front with h2 like nginx, a fault proxy in front of each node and one for each side's own network, a stand-in dusk
bot server, the real agent (`agent.mjs link`, then `tunnel` restarted like systemd) and the app's relay code
(`electron/vps-link-protocol.mjs`, in `chaos/app-runner.mjs`), all on loopback with a throwaway ca. It then breaks one
thing at a time (`chaos/scenarios.mjs`: a node killed, restarted, blackholed, frozen, slow, answering 502, paused; both
down; the copy between nodes failing; flapping; the server and its agent restarting; a fast server clock; a full disk;
a laptop asleep, offline, on a new network, without dns, on one address family, behind a captive portal or a bad
link; 100 MB through the relay; 60 servers through a node restart) while a probe sends a request every half second
and holds an event stream open. Each row says how long until both worked again, what failed and what a person would
see. `--quick` is the short set ci runs (`.github/workflows/link-chaos.yml`), `--only a,b` picks scenarios, `--home
oracle-in` places the server on the node the app did not link through, `--client phone` puts the phone app's own
transport (`src/mobile/transport/relay.ts`, on a device channel the stand-in server hands the agent) where the desktop's
relay code is, `--direct rtc` adds the webrtc direct path (node-datachannel from this checkout) on top of the relay,
`--md` / `--json` write the matrix, `--verbose` streams every process's log. Needs node and openssl only (and the
checkout's node-datachannel for `--direct rtc`).

## Run it

```
cd apps/link-service && npm start                       # PORT (default 8790)
```

| env | default | |
|---|---|---|
| `PORT` | 8790 | listen port |
| `LINK_BASE` | `https://link.dusk.bot` | public address the VPS reaches; baked into the served script |
| `LINK_DATA_DIR` | `./data` | `state.json` (sessions, tunnel verifiers); keep it outside the checkout so redeploys keep tunnels |
| `LINK_PACKAGES_DIR` | `$LINK_DATA_DIR/packages` | the private server builds (see "The server build") |
| `LINK_TRUST_PROXY` | `1` | read the client IP from `X-Real-IP` or the last `X-Forwarded-For` hop; set `0` without a proxy |
| `HOST` | `127.0.0.1` | listen address; keep loopback behind the proxy so `X-Real-IP` cannot be forged |
| `DUSK_LINK_DASHBOARD_URL` | unset | advertised at `/.well-known/duskbot/dashboard` |
| `DUSK_APNS_KEY_FILE`, `DUSK_APNS_KEY_ID`, `DUSK_APNS_TEAM_ID`, `DUSK_APNS_TOPIC` | unset | APNs for the push relay; all four or it stays off |
| `DUSK_FCM_SERVICE_ACCOUNT_FILE` | unset | FCM for the push relay |
| `DUSK_LINK_GRANT_KEYS` | the pinned entitlement key | `kid:x,...` Ed25519 public keys the account service signs link grants with |
| `DUSK_LINK_OPEN` | unset | `1` opens setup sessions without a dusk account (local development only) |

`.env.example` lists the same names. The proxy must set `X-Real-IP` to the connecting address (overwriting any the
client sent), or every per-address rate limit can be dodged. A tunnel whose server has not polled for 7 days is
dropped by the sweep (35 days when it carries a paired phone's channel, so a phone never hears "removed" from a
computer that was off a week); that server links again with a new command. Health: `GET /healthz` (or `/health`).

## Limits

The relay is not a free pipe: every setup session needs a dusk account, and every tunnel has a byte budget.

- **Account.** `POST /v1/sessions` takes `grant`, a five-minute token the signed-in app gets from the account service
  (`POST /v1/app/link-grant`, bearer app session; `src/grant.mjs` has the format). Without a valid one the answer is
  401 `account_required`. One account has at most 20 live tunnels by default (409 `tunnel_limit`) and opens at most 120 sessions an
  hour and 10 a minute, besides 120 an hour and 30 a minute per address; it holds 5 unused ones at most (a sixth retires
  its oldest), so no account can fill a node's 5,000 session store. The VPS side (install.sh, the agent, the phone's channels) needs nothing:
  the session the app opened already carries the account.
- **Bytes.** Defaults, changeable at runtime (below): each tunnel, both directions and its phone channels together, 3 MiB/s
  sustained with a 24 MiB burst. All tunnels together stay under a 10 MiB/s ceiling (~88 Mbit/s on the wire, under
  Contabo's 100 Mbit/s average rule): while several are busy the ceiling is split evenly between busy accounts, then
  between an account's busy tunnels. Egress lane posts also stay under 6 MiB/s (8 MiB burst). Sizes are the frames'
  base64url text, the bytes on the wire. Past its rate a post is held (slowed), not refused; only a wait over 20 s gets
  429 `rate_limited` with `retry-after`.
- **Fair use per account, per month** (`src/fair-use.mjs`, every node together through the directory's sync): full speed
  (`accountBytesPerSec`, 3 MiB/s) up to `accountFullSpeedBytes` (20 GB), then slower along a curve linear in the log of
  the rate down to `floorBytesPerSec` (2 Mbit/s) at `accountFloorAtBytes` (80 GB), and past that `chatBytesPerSec`
  (256 kbit/s). A burst of `accountBurstSeconds` (45) at the account's rate stays even when slowed, and a post of 16 KB
  or less (a message, an approval) goes at once from a small allowance of its own (64 KB/s, 1 MiB) when the account's is
  spent. Nothing is ever cut off. The ops stats carry `fairUse` (each account's month and rate now); the admin ops page
  shows the heaviest.
- **Busy.** At most 150 tunnels relay at once (oracle-in is set to 110 in its limits, Contabo keeps 150; both on the ops page) (bytes in the last 2 minutes); a new one past that, or any new one while the
  owner paused the relay, gets 503 `relay_busy` with `retry-after: 60` and should use a Cloudflare tunnel, SSH or Tailscale.
  Tunnels already relaying are never cut off.
- **Ops.** `GET /ops/relay/stats` and `PUT /ops/relay/limits` with `authorization: Bearer $LINK_STATS_TOKEN` (the account
  service sends it as `DUSK_LINK_STATS_TOKEN`; unset hides both). Stats: `{ relay, now: { tunnels, accounts,
  bytesPerSecOut, bytesPerSecIn, cpu, rssMb }, today: { bytesOut, bytesIn }, month: { bytesOut, bytesIn,
  projectedBytesOut, allowanceBytes }, limits, top: [{ account, tunnels, bytesToday }], busy }`. Limits (any subset):
  `perTunnelBytesPerSec, burstBytes, perTunnelDailyBytes, tunnelsPerAccount, globalCeilingBytesPerSec, maxTunnels`
  (whole numbers in range) and `paused` (boolean); kept in `$LINK_DATA_DIR/relay-limits.json`, byte totals in
  `relay-usage.json`.
- **Memory.** A frame nobody read for 60 s is dropped. All queues together hold at most 1 GiB; past it posts get 503
  `busy` and the process keeps running.
- **Per address.** 512 requests in flight and 200 requests a second (burst 2000); past either, 429 `rate_limited`.
  Generous because many people share one address behind carrier NAT; nginx's own `limit_conn`/`limit_req` sit in front.

The app's base comes from `DUSK_LINK_BASE` (default `https://link.dusk.bot`).

Deploy every node with `apps/link-service/deploy/deploy.sh` from the repo root. A node restarts only when a file it runs
changed (tests, the chaos lab, this readme and the deploy scripts do not count): each restart makes every app and agent
on that node reconnect its relay stream. Contabo runs under prozessor, which restarts only on a `deploy` of this folder
(its checkout is a local repo fed by the deploy cli, not main); oracle-in is a tar and a systemd restart. `--force`
ships anyway. The first install on contabo was:

```
printf 'LINK_DATA_DIR=/root/omb-link-data\n' > /tmp/omb-link.env
deploy link-service --name omb-link --domain link --env-file /tmp/omb-link.env
```

Requests stay under 1 MB (nginx's default body limit), and long polls are 25 s (under nginx's 60 s read timeout).
WebSockets are not needed.

How the two ends use it, for speed (docs/verification/wire-latency.md has the measurements):

- Both reach the service over one HTTP/2 connection when it offers h2 (nginx does): the streamed read and every post
  share one warm TLS connection, and up to eight posts are out at once (the service holds eight that overtook an
  earlier one). A service without h2 gets keep-alive HTTP/1.1 and three posts.
- A post leaves on the next turn of the event loop; frames that come while posts are out gather for 2 ms per post out.
- Each end asks for its next streamed read 21 s into the current one, so the next is waiting at the service when the
  current one ends (the service hands the queue to the newest reader): no frame waits through a round-trip gap.
- After a sleep or a network change the connections are dropped but the TLS sessions are kept, so reconnecting
  resumes instead of paying a full handshake.

Tests: `pnpm vitest run link-service electron/vps-link.test.mjs` and `node --test electron/vps-link-*.node-test.mjs` from the repo root.

## Account dashboard

Set `DUSK_LINK_DASHBOARD_URL` to advertise the hosted dashboard through `GET /.well-known/duskbot/dashboard`.
