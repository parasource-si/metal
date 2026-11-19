# The demo workspace

`pnpm demo` starts a second, fully separate Metal filled with the test bots below, so you can click through every screen
and talk to bots that reply for real, without touching your own workspace.

```sh
pnpm demo            # start it (the first run seeds it, about 20 seconds) and open http://127.0.0.1:5299
pnpm demo --reset    # stop it, delete the demo folder, seed again from scratch, start
pnpm demo stop       # stop the demo's harness and UI
pnpm demo status     # is it running, and where
pnpm demo --no-open  # start without opening the browser
```

`pnpm demo` returns once both servers answer; they keep running in the background until `pnpm demo stop`. Running it
again while the demo is up just opens the page.

## What is separate

| | Your app | The demo |
| --- | --- | --- |
| Data folder | `~/.duskbot` | `~/.duskbot-demo` |
| Harness | `127.0.0.1:8799` | `127.0.0.1:8899` (webhooks on `8900`) |
| UI | `127.0.0.1:5199` | `127.0.0.1:5299` (its own Vite, its own `node_modules/.vite-demo` cache) |

The launcher strips every `DUSK_*` variable from your shell before starting the demo, so nothing can point it back at your
workspace. It keeps `HOME` and `PATH`, so the demo's bots use the engine CLIs you already signed in to (Claude Code by
default) the same way your own app does. Nothing is copied out of `~/.duskbot`.

The demo opens in your browser, not in a second Electron window: the development Electron build always talks to the
harness on 8799 (saving a key in its Settings would write to your real workspace), so a browser tab is the isolated
way to view it.

## What is in it

The same invented test bots `pnpm test-bots` adds (`scripts/demo/content.mjs`), for a made-up ceramics shop, all in
one **Test bots** section: Nova (research), Quill (copy), Rivet (engineer), Tally (books), Echo (support inbox), Juno
(trips), Basil (meals) and Moss (plants), each with its own color, Grok-style body, title and instructions.

- **Conversations** with tool calls, a markdown table and code, reactions, an answered approval card (Rivet), a work
  summary and a failed tool call.
- **A pending question card**: Quill asks which subject line to send. Answering it really reaches Quill.
- **Unread chats**: Quill and Echo (Echo also has a sample delivery from its webhook).
- **A room**, Shop standup. **Library files**: Nova's price CSV and Tally's October summary.
- **Memory** for Nova, Quill, Tally and Moss. **Skills**: price-check, subject-lines, release-checklist.
- **Routines**: six, all off, with past runs in the log. **Webhooks**: Storefront CI failed, Payment received, New
  support email (a "post" webhook: it writes into Echo's chat with no AI turn).

Every test bot is on **Ask me first**, and its instructions say its history is sample data.

## Test bots in your own app

```sh
pnpm test-bots            # add them to the app on this computer (127.0.0.1:8799); run again and it skips what is there
pnpm test-bots --remove   # delete only what it added
pnpm test-bots --url http://127.0.0.1:PORT   # another server on this computer
```

It uses only the server's HTTP API while it runs (a team backup import, then section, approval level, skills,
routines, webhooks, reactions and unread marks) and never changes, renames or deletes anything it did not create. It
records what it created, by id, in `~/.duskbot-test-bots/manifest-<workspace id>.json`; `--remove` deletes exactly
those, keeps a test bot you moved out of **Test bots**, and deletes the section only when nothing else is in it.

Its chats are plainer than the demo's: the HTTP import carries conversation text only, so there are no tool-call
rows, cards (no pending question card), shared files or work summaries, and no past routine runs. Reactions, unread
marks, memory, skills, the room, routines and webhooks are all there, and every chat takes real follow-ups.

## Costs and timers

Replies use your own engine sign-in, so every message you send, every card you answer and every "run" webhook spends
on it like a normal chat. Every routine starts off, so nothing runs on a timer until you turn one on. Run
`pnpm demo stop` when you are done.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `DUSK_DEMO_DIR` | `~/.duskbot-demo` | The folder's name must contain `demo`; `--reset` only deletes a folder `pnpm demo` made. |
| `DUSK_DEMO_PORT` | `8899` | Harness; webhooks use the next port. |
| `DUSK_DEMO_UI_PORT` | `5299` | The UI. |
| `DUSK_DEMO_MODEL` | `claude/claude-sonnet-5` | `INSTANCE/MODEL` every demo bot starts on. Applies at the next `--reset`. |

Logs are in `~/.duskbot-demo/.demo/logs` (`harness.log`, `vite.log`). Content lives in `scripts/demo/content.mjs`;
edit it and run `pnpm demo --reset`.

## How the seed works

1. With the demo harness running, `scripts/demo/seed-live.mjs` makes the same requests the app makes: a team backup
   import (`POST /api/teams/import`, which brings the bots, looks, instructions, sections, memory, room and conversation
   text), then skills, routines and webhooks through their own routes.
2. With the harness stopped, `scripts/demo/seed-offline.ts` swaps each imported conversation for its full version
   (tool calls, cards, files, reactions) through `server/message-db.ts`, marks the unread chats and adds past routine
   runs. It refuses to run unless `DUSK_DATA_DIR` is the demo folder.
