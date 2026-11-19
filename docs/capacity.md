# Capacity: what one relay node and the account service carry

Measured 2026-11-14 on throwaway copies bound to loopback (never the live nodes' tunnels): a link service with
simulated agents and desktops (two streamed reads per server renewed every 21 s, a third and a 15 s hello per open
desktop, screens as ordered posts), and an account service on its own MongoDB with 2000 enrolled computers. Plain
http on loopback: the TLS front (nginx on Contabo, Caddy on Oracle) is extra and was not measured.

## Who holds what on a relay node

| Who | On the link service | Counts as |
|---|---|---|
| Own server, desktop closed | 2 streamed reads (tunnel, phone hub) | a server (`maxServers`) |
| Own server, desktop open (any screen) | 3 streamed reads and a hello every 15 s | also in use (`maxConnected`) |
| Someone watching a screen or downloading over the relay | posts at the stream's rate | also busy (`maxTunnels`) |
| Mac only, Dusk Cloud | nothing (phones reach a Mac by Cloudflare tunnel, LAN or tailnet; clouds by the edge) | - |

Direct paths (ssh, 443, WebRTC) take the bytes off the relay, not the reads or the hello.

## One node process (one core)

| | Contabo (EPYC 2.0 GHz, shared) | Oracle A1 |
|---|---|---|
| 1000 servers, desktops open (3000 sockets) | 33% of a core, 290 MB | 14%, 285 MB |
| each MB/s relayed | about 4% of a core | about 3.5% |
| restart storm, 1000 desktops | all back in 20 to 25 s, 1 to 2 s near a full core | same, peak 80% |
| caps (relay-limits.json) | 1500 servers, 1000 in use, 150 busy, 10 MiB/s | 2500 servers, 1500 in use, 110 busy, 16 MiB/s |

The caps keep the process near 75% of its core with every one of them full. A server costs about 70 kB and three
sockets; memory and file handles are never the limit (3000 servers: 350 MB, 6000 sockets).

## Account service

2000 computers, 25 kB reports, each holding the 25 s long poll, on the Contabo box:

| | cpu | memory | report time p50 / p95 |
|---|---|---|---|
| before (every report diffed every row) | 110%, then stalls | 1.2 GB | 1.6 s / 13 s |
| now, 5% watched (about 30 reports a second) | 40% | 680 MB | 45 ms / 150 ms |
| now, 20% watched (about 90 a second) | 55% | 880 MB | 300 ms / 800 ms |

## 2000 heavy users

Assumed: half have their own server (1000), a quarter Dusk Cloud, a quarter only a Mac; at peak half the server
owners have the desktop open and a tenth watch a screen; the direct path works for 80%; screens at 0.6 Mbit/s
(H.264 browsing). Worst case: all 2000 on own servers, every desktop open, 30% watching at 1.5 Mbit/s, direct
working for only 70%.

| | normal | worst |
|---|---|---|
| servers on the relay / desktops in use | 1000 / 500 | 2000 / 2000 |
| screens on the relay at peak | 20 (2 MB/s) | 180 (45 MB/s) |
| node cpu (two nodes) | under 30% each | at the caps; bandwidth is what runs out |
| month egress (all nodes) | about 2 TB | about 36 TB (allowances: Contabo 32, Oracle 10) |
| fits two nodes? | yes, with room for 3x | servers and desktops yes; screens share 26 MiB/s fairly (about 1.1 Mbit/s each) |

## When to add a node

Add a third node when, for a week, any of these holds at the daily peak (the admin relay page shows them):

- servers past 70% of `maxServers` on both nodes, or tunnels in use past 70% of `maxConnected`;
- out rate past 60% of the ceiling on both nodes for an hour a day (the alert already fires);
- the month on course past 70% of the allowance on either node (placement already stops sending it new servers).

A Hetzner CX22 (2 vCPU, 4 GB, 20 TB a month in the EU, about 5 euro) carries about what Oracle does:

```
NODE_ID=hetzner-de DOMAIN=link-de.dusk.bot REGION=eu ALLOWANCE_TB=20 \
LINK_NODES="contabo=https://link.dusk.bot@eu,oracle-in=https://link-in.dusk.bot@asia,hetzner-de=https://link-de.dusk.bot@eu" \
LINK_PEER_TOKEN=... LINK_STATS_TOKEN=... LINK_TURN_SECRET=... apps/link-service/deploy/add-node.sh root@<box>
```

Then put the same `LINK_NODES` on Contabo (omb-link's env) and Oracle (`/etc/dusk-link-node.env`) and in the
account service's `DUSK_LINK_NODES`, restart them, and set the new node's caps in admin ops (Oracle's values are a
good start). New servers start landing there at once; existing ones move when their node passes its caps.

## Not the relay

- **Sign-in email.** Brevo's free 300 a day (we stop at 250, 200 for new addresses). 2000 people signing up in one
  week means about 300 new addresses a day: past it they wait until tomorrow. Before a launch push, move Brevo to a
  paid plan and raise `DUSK_BREVO_DAILY_LIMIT` and `DUSK_AUTH_MAIL_PER_DAY`, or lean on Google and Apple sign-in.
- **One box.** The account service, MongoDB, the preview and the Contabo relay node share the Contabo box. If it
  goes down, servers move to Oracle by themselves, but sign-in, the dashboard, billing and cloud upkeep stop. Mongo
  backups go to Oracle and R2 daily, so data survives; the service does not run anywhere else.
- **dusk cloud.** 500 clouds is InstaBox's capacity question, not ours: check our workspace's machine quota and
  the 30 starts a minute before a launch.
