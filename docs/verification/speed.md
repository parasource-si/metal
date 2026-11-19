# Speed: start, replies, chat UI and API routes

How long Metal takes from process start to a usable chat, and from a send to the first visible text, hop by hop, on
disposable fake-engine fixtures. Measured 2026-11-19 on an Apple M5 Pro (18 cores, 48 GB), Node 26.7, Chrome for Testing
headless, with other agents' fixtures running on the same machine (numbers move a few ms between runs).

## Running it

```sh
pnpm build && pnpm build:server
node --experimental-strip-types scripts/bench-speed.ts --only start,reply --runs 5 --replies 8
node --experimental-strip-types scripts/bench-speed.ts --only reply --cold --replies 8     # each send opens a new chat
node --experimental-strip-types scripts/bench-speed.ts --only writes --bots 100
node --experimental-strip-types scripts/bench-speed.ts --only ui --bots 50 --playwright PATH/TO/playwright/index.mjs
node --experimental-strip-types scripts/bench-desktop.ts --only server,start,big --chrome PATH/TO/CHROME
```

`bench-speed.ts` runs the packaged server entry (`dist-server/desktop-entry.mjs` with its compile cache) except for the
`ui` phase, which needs the TypeScript server: a built server never lets a local browser in without a sign-in. Each
fixture has its own temporary data folder and ports. The fake engine is wrapped so it stamps when it was spawned, when it
read the turn's prompt and when it wrote its first text, on the wall clock the bench also reads, which splits a reply
into harness time before the engine, engine time, and delivery to `/api/events`. `--cpu-prof DIR` writes a V8 profile of
the first fresh start and the first restart (or of the reply fixture with `--only reply`). `bench-desktop.ts` covers the
renderer: page load, chat switches, scrolling, streaming and the big workspace (150 bots, 300 threads, a 2,000-message
chat).

The bench talks to the server through `node:http`. Node 26's `fetch` (undici) on a reused keep-alive connection here
sometimes held a request 0.2-2 s before the server saw it (the server answered fresh connections in 1-4 ms the whole
time, and a `node:http` keep-alive agent showed no delay); an earlier version of the bench reported those stalls as
reply latency.

## Results

| area | measure | before | after |
|---|---|---|---|
| server start | spawn -> `/api/health`, restart (packaged entry, compile cache) | 284 ms | no change made |
| server start | spawn -> `/api/health`, first start ever (waits for the first engine read) | 812 ms | no change made |
| reply, warm chat | send -> prompt written to the engine (harness overhead) | 8 ms | no change made |
| reply, warm chat | engine's first text -> frame on `/api/events` | 11 ms | no change made |
| reply, warm chat | send -> first text frame | 18.8 ms | no change made |
| reply, new chat | send -> engine spawned | 61 ms | no change made |
| reply, new chat | send -> first text frame (fake engine) | 120 ms | no change made |
| UI | navigation -> sidebar with 50 bots | 249 ms | no change made |
| UI | navigation -> composer visible | 262 ms | no change made |
| UI | switch chat -> that bot's composer | 38 ms | no change made |
| UI | open a 200-message chat -> last message shown | 66 ms | no change made |
| UI (big workspace) | first load to a useful page | 247 ms | no change made |
| UI (big workspace) | scroll a 2,000-message chat back to the top: longest task | 412 ms | no change made |
| API | `POST /api/bots/:id/read`, 100 bots | 5.9 ms | 2.2 ms |
| API | `POST /api/bots/:id/read`, big workspace | 32.7 ms (135 kB written, 1 fsync) | 23.0 ms (nothing written) |

## What changed

| commit | change | measured |
|---|---|---|
| read marker | marking a chat read (`unread`, `lastReadMessageId`) is a bookkeeping save, written within a second, at shutdown and before a backup, instead of a whole `bots.json` rewrite and fsync on the request | 5.9 -> 2.2 ms at 100 bots; 32.7 -> 23.0 ms and 135 kB + 1 fsync -> nothing written on the big workspace |

## Measured and left alone

- Harness time before the engine is 8 ms on a warm chat and about 60 ms on a chat's first message, both under the
  150 ms target; delivery from the engine's first text to the live stream is 11-21 ms, under the 100 ms target.
- A chat's first message writes `bots.json` three or four times before the engine starts (the turn's start, the folder
  pin, which engine has the conversation); each is a durability point for recovery after a crash, so they stay.
- The agents MCP server answers `initialize` and `tools/list` 59 ms after spawn with or without Node's compile cache.
- `/api/bots?messages=0` is about 0.9 kB per bot (1.4 kB in the big workspace), most of it the bot's threads.
- Lifting Chromium's six-connections-per-host cap for `127.0.0.1` changed nothing on the page's start-up burst: the
  requests wait on the server, not on connections.
- A restart spends its 284 ms spread over module evaluation, the data-folder lease, session restore and config parsing;
  no one piece is over 20 ms.

## Next, not done here

- A chat's first message (and the first after ten idle minutes) starts the engine's process: with a real Claude Code
  that is its own start-up plus its MCP servers, which the fake engine does not have. Starting that process when a person
  opens a chat or starts typing would hide it, but the warm process must match the turn's launch contract (system prompt,
  MCP mounts, model), which today is built inside the turn's setup.
- Scrolling a 2,000-message chat back to its start mounts 1,000 rows and 70,000 DOM nodes; the longest task (412 ms) is
  one older page landing. Mounting a landed page in steps, as an opened chat's first paint already does, or windowing
  the rows above the viewport, would cut it.
- Live engine runs through the local gateway were not measured here.
