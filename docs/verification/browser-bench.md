# Browser bench: hard real-world pages through the real browser

27 local pages that reproduce the UI bots trip on (`server/browser-bench/tasks-*.ts`), each with a check of what the
page itself saw: the message sent, the setting saved, the answer the bot gave. A real Claude Code CLI plays each task
with Metal's browser tools as its only tools, through the real `BrowserService` on a headless Chrome
(`--use-mock-keychain --password-store=basic`). Nothing leaves the computer: every page is served on loopback, and
every run gets its own path, so runs in parallel never share state.

| Group | Tasks |
|---|---|
| composers | X-style DM in a model-driven contenteditable, Gmail compose with recipient chips, Slack post on two lines where Enter sends, a reply box holding an old draft to replace |
| lists | virtualized chat list with no search, infinite feed of look-alike Like buttons, pricing that loads on scroll behind a billing toggle, table with icon-only pagination |
| widgets | async combobox that only takes a picked option, portal dropdowns with a scrolling list, read-only date range picker, custom slider, switches and Save in closed and open shadow roots |
| frames | signup form in a cross-site iframe, card fields each in their own cross-site iframe, sign-in popup window |
| overlays | target under a fixed chat bar at the page end, consent wall with no reject until its settings, nested hover menu, animated three-step modal with a label-drawn checkbox |
| flows | deep link that redirects to sign-in, client-routed dashboard with skeletons, list that rebuilds on every click, sign-in that answers with a plain red inline error |
| files | hidden file input behind a dropzone, export behind a row's icon menu, form with a phone mask, select, radios and terms |

Each play records whether the check passed, the tool calls (a batch counts once), the wall time, the failed calls by
kind (stale ref, not found, covered, not editable, timeout, bad arguments) and the page text the model read.

## Running it

```sh
# no model: each task's scripted way through passes on real Chrome, and doing nothing fails it
DUSK_CDP_E2E=1 npx vitest run server/browser-bench
# the real Claude Code CLI, 3 runs per task
node --experimental-strip-types scripts/browser-bench.ts --engine claude --runs 3 --parallel 3 --label after --out /tmp/bench
# --model haiku, --only x-dm,slider for a subset; the scorecard of two runs as HTML and PNG
node --experimental-strip-types scripts/browser-bench-card.ts --before /tmp/bench/before.json --after /tmp/bench/after.json --out /tmp/bench/card
```

Wall time moves with the machine's load (two runs of the same code measured 19 s and 28 s per task while other work
ran), so compare a before and an after played at the same time, each from a frozen copy of its tree.

## Scores, 2026-11-17

27 tasks, 3 runs each, before (fb4ba1218f) and after (738745d39c) played at the same time:

| | Sonnet before | Sonnet after | Haiku before | Haiku after |
|---|---|---|---|---|
| Tasks done right | 78/81 | 80/81 | 73/81 | 76/81 |
| Tool calls per task | 6.6 | 4.9 | 10.0 | 6.9 |
| Seconds per task | 16.2 | 12.9 | 17.7 | 15.3 |
| Failed calls per task | 0.4 | 0.1 | 0.4 | 0.4 |
