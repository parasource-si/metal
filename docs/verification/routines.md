# Routines

## Monthly and custom cron

See [schedule behavior and examples](../routine-schedules.md). A person no longer types cron in the app: bots set
cron schedules from chat, and the bot panel's routine editor keeps such a
schedule as it is ("Keep" in its When picker) while the name or instructions
change.

The automated cron tool fixture calls the real MCP proxy through a disposable
server, confirms the resulting card, and verifies list/update/pause/resume,
persisted timing and HTTP 400 validation failures. It scripts the tool call;
it does not measure a real model's natural-language-to-cron accuracy.

It also retries an existing schedule under a different name through the real
tool, checking that the response identifies the existing routine and creates
neither a second approval card nor a second schedule. The proposal-service
tests cover competing confirmations, Full Access, per-bot ownership, explicit
interval starts, meaningful punctuation and differing execution settings.
This guard only applies to agent creation proposals; intentional duplicates
in the manual editor remain possible. Existing routines are never removed.

```sh
pnpm exec vitest run shared/routine-schedule.test.ts server/routine-cron.e2e.test.ts server/routine-requests.test.ts server/routines.test.ts server/routines-startup.test.ts src/lib/routine-calendar.test.ts src/lib/routine-when.test.ts src/lib/schedule-label.test.ts src/components/routines/BotRoutines.test.ts server/bot-package.test.ts server/package-export.test.ts
```

## Launch the isolated renderer

Run the launcher directly so Ctrl-C reaches the fixture owner:

```sh
node --experimental-strip-types scripts/verify-routines.ts
```

Open the printed `previewUrl`, not the user's running app. The launcher uses
`launchVerificationServer()` from the shared control surface, a temporary home
and data directory, free ports, and only the repository's fake Claude engine.
It mounts the real App and StoreProvider through Vite, with `/api` proxied to
that exact fixture. It does not use a real provider account, inbox, desktop,
cloud VM, or external service.

The launcher prepares these cases:

- **Pepper** gets an **Agent-created inbox check** trigger, applied at once with
  its live trigger card. The real `trigger` MCP handler (`action: "create"`) creates it using
  credentials captured from a running fixture turn. The fake model does not
  decide to call the tool.
- **Manual inbox check** is created through the routine API and run twice for
  Pepper. Both fresh executions report into **Fleet health reports**, inside
  the **Metal management** folder. Its next scheduled occurrence is an hour later.
- **Provider failure example** is created for **Miso** and run once. Miso's
  isolated fake engine deliberately exits early, producing a failure receipt.
- **Automatic scheduled check** is scheduled for Pepper about twelve seconds
  after creation. The real scheduler must dispatch it without clicking Run now.

The final startup JSON includes the server `url`, `previewUrl`, `pepperId`,
`misoId`, `scheduledRoutineId`, `manualRoutineId`, `resultsThreadId`,
`resultsFolderId`, temporary `dataDir`, and persistent `logPath`.

## Real UI checks

1. In Pepper's source chat, inspect the pending routine card. Confirm it once;
   the card must become settled and exactly one matching routine must appear.
   Reloading must preserve both the routine and the card's settled state.
   Open that routine and run it. Its report lands in Pepper's main thread (the
   open conversation the person last wrote in, here the source chat), not a new
   "· Results" thread, as one Pepper message captioned with the routine's name,
   and the caption's **See run** leads to the isolated execution thread. See
   [automation reports](automation-reports.md) for quiet runs, questions and
   the concurrency rule.
2. Open Pepper's panel (its name pill) on **Details**. **Routines** lists each
   of Pepper's routines, webhooks and app events by name with when it runs (or
   Paused) and its switch; Miso's never show under Pepper. Clicking a row opens
   it in place: when (and the next run), what to do, where it works, where
   results go, what it uses, its last three runs (each opens its run) and
   **Run now**, **Edit**, **Delete**. Nothing slides or fades in.
3. **Add a routine** opens the same small form at the end of the card: Name
   (optional, filled from what to do), When (Every day, Every weekday, Every
   week, Every hour, Once, with a time, day or date) and What to do. Save it,
   then edit it in place, pause and resume it with the switch. **Run now**
   creates one run whose result shows under Recent runs. For the agent-created
   interval, compare `/api/routines` before and after a name-only edit:
   `schedule.anchorAt` and `nextRunAt` must not shift, and a schedule the
   picker cannot say stays exactly as it was.
4. **Delete** asks once more in place (**Delete “name”** or Cancel) before the
   routine goes.
5. A chat's routine card and an execution chat's **Open routine** open that
   routine in its bot's panel; the card's **Edit** opens it in its form.
6. The Computer panel's **Routines** tab (Advanced mode) shows the same list.
7. A new bot's draft (New bot → Routines) uses the same form.
8. Expand Pepper's threads. **Metal management** contains one **Fleet health
   reports** thread, not separate sidebar entries for the two executions.
   Right-click the folder (or use its actions menu) → **Mark folder as read**.
   Its unread dots clear without selecting a conversation or resolving any
   pending approvals. Open the results thread: both captioned reports remain.
9. Use a report's **See run** to inspect its fresh execution transcript, then
   **Back to results**. The routine's Recent runs keep the latest three.
   A user follow-up sent in a completed execution makes it an ordinary visible
   thread; marking the older run seen must not hide that conversation again.
10. An opened routine names where its results go: **The bot's main thread**
    (the default) or the thread a bot chose for it. Editing it in place keeps
    that destination. Run a new routine twice: both reports land there as two
    different executions, and none creates a "· Results" thread.

Every routine reports into its bot's main thread unless the user chooses another
destination, whether it was made in a chat, the editor or the API, and whether a
teammate (such as a Chief) asked for it. The main thread is the open
conversation a person last wrote in (until anyone has, the selected one, then
the oldest); a bot with hidden threads opens there too. Conversations from
before the server kept that take it, once on upgrade, from the newest line a
person sent there from the app. Each run looks it up
again, so the routine saves nothing and its results follow the person. A routine
still pointing at an automatic "<name> · Results" thread from an older version
moves to the main thread on its next run; that thread and its reports stay. The
oldest thread that v0.1.98 to v0.1.107 saved on routines as if it were chosen is
cleared once on upgrade, also when it was archived since. On a Cloud home, a routine written by someone other
than the owner keeps its own results conversation, opened as theirs. Historical
runs keep the destination they started with. If that destination is deleted,
their execution threads become visible so results and approvals remain
reachable; future runs report into the main thread. No existing user
conversation is silently deleted or filed.

An unconfirmed proposal is not an active routine. A run marked **Waiting** is
not necessarily asking the user for approval: its attention text can explain
that work it handed to teammates is still outstanding — the job runtime has
assignments open for the run's thread (docs/runtime-contract.md §9), and the
run completes when their results have resumed it as a routine turn. Status,
result and scheduled/manual trigger must agree with the saved server record.

## Run on startup

A repeating routine's **Advanced** section offers **Also run when Metal
starts**. In the isolated renderer, create a daily routine with it ticked, then
reopen the editor: the box stays ticked. A one-time routine does not offer it.
Startup needs a restart on the same data, which this launcher does not do;
`server/routines-startup.test.ts` restarts a real fixture server on its own
store and requires exactly one completed **On startup** run.

The desktop gives every server child of one launch the same
`DUSK_DESKTOP_LAUNCH_ID`, and `routines.json` records the launch whose startup
runs were queued. A crash recovery or switching back to a workspace within
that launch queues none; the next launch does. A server without the variable,
such as a standalone one, counts every process start.

```sh
pnpm exec vitest run server/routines.test.ts server/routines-startup.test.ts server/routine-requests.test.ts server/drivers/agents-proxy.test.ts shared/package-format.test.ts server/package-export.test.ts server/package-import.test.ts
node --test electron/server-child-launch.node-test.mjs
```

## Evidence and cleanup

Keep screenshots or a browser action transcript for renderer checks, and the
final startup JSON. For bounded chat evidence, copy the exact fixture bot and
execution-thread IDs into the shared control commands:

```sh
pnpm control:metal wait --bot BOT_ID --task THREAD_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:metal messages --bot BOT_ID --task THREAD_ID --limit 20 --url http://127.0.0.1:PORT
```

Use only the printed fixture server URL. The browser interaction checklist is
not automatically asserted by the launcher. On Ctrl-C, the launcher writes
`<logPath>.json` containing setup mutation evidence and the final `/api/routines`
snapshot (or a separately labelled `persisted` snapshot if Ctrl-C already stopped
the API), closes Vite and the exact child server, and removes only its temporary
data. The server log and adjacent JSON remain. Close the dedicated browser tab;
never kill processes by name or delete a broad temporary root.

## Automated regressions

In the editor's Advanced section, recurring routines offer **Skip this
occurrence** (the default) or **Queue one run**. The queued scheduled run waits
for the same routine to finish, including the assignments its run still has
outstanding on the job runtime; extra occurrences are skipped, not
accumulated. Manual runs and webhook deliveries remain independent. Pausing
still cancels queued work. The cron renderer test changes this option, saves
it, opens the editor again and switches it back.

The List view and `trigger_info` expose saved skipped-occurrence counts and
recent consecutive failures. Skips count occurrences observed by the scheduler
while busy, not every interval elapsed while offline. Failure streaks are
derived from retained terminal receipts (up to the existing history limit),
ignore cancelled/missed runs, and reset only after the whole run succeeds—not
an intermediate turn waiting for a teammate. Neither indicator pauses work
automatically. The scheduler tests cover bounded queues, daily/cron/interval
parity, restart recovery, duplicate completion events and atomic cursor/counter
rollback on a failed save. The MCP fixture verifies reviewed policy changes
and the listing through the actual tool and API, using no live accounts.

The routine tool defaults to `maus` (the bot's configured model and computer,
including VPS); `cloud` explicitly selects the bot's own VPS computer with the
same model. The retired `box` choice is refused by the tool. The cron tool
fixture checks the default and refusal. The VPS fixture runs a real routine
execution with fake ACP/SSH and checks that the same VPS computer tools reach
the agent without a paid desktop account. These are
deterministic routing checks, not a live model-choice or real VPS acceptance test.

```sh
pnpm exec vitest run server/vps-routing.test.ts server/routine-cron.e2e.test.ts
```

```sh
pnpm exec vitest run server/routines.test.ts server/routines-startup.test.ts server/routine-results.e2e.test.ts server/routine-delegation.e2e.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run server/routine-concurrency.test.ts server/routine-parallel-approvals.e2e.test.ts
pnpm exec vitest run src/components/RoutineRunCard.test.ts src/lib/folder-read.test.ts src/lib/computer-panel-view.test.ts src/state/store.test.ts
```

The hand-off integration tests (`server/routine-delegation.e2e.test.ts`,
`server/runtime-paths.e2e.test.ts`) launch their own shared-control fixtures.
A routine turn hands work on with `coordinate_bots`; the run's root on the
job runtime names the run as its
requester with routine lineage (docs/runtime-contract.md §9). They verify a
busy peer delaying completion until its result resumes the same run as a
routine turn, a denied hand-off refused with that outcome and no assignment
written, a run that stays waiting through a restart while its cut teammate
turn runs again once (§5), and the one-time import of a pre-runtime
`delegations.json` at boot (`server/routines-startup.test.ts`). They print
retained server-log and JSON evidence paths. These complement the scheduler,
proposal and renderer tests; they do not prove real-provider tool selection,
actual desktop work, or packaged Electron behavior.

The parallel-approval fixture opens two permission requests through a running
routine's real Claude broker. Answering the first leaves the routine waiting
for the second; their answers reach the broker independently, and cancellation
keeps one terminal receipt. The scheduler regressions additionally cover both
resolution orders, unknown and duplicate events, overlapping wait-time
accounting, restart recovery, independent bot dispatch, and invalid one-time
timestamp rejection. These requests are scripted in a disposable fake-engine
workspace and run no external action.

Webhook delivery IDs are committed atomically with their execution receipt.
Retries keep the same run ID for seven days, independently of run-log pruning;
unfinished work remains deduplicated beyond that window. A full retry ledger
rejects new work rather than discarding identities that senders may still retry.

```sh
pnpm exec vitest run server/webhook-idempotency.test.ts server/webhook-restart.e2e.test.ts
```

The restart test launches a disposable fake-engine server, creates a webhook,
then exits an owned worker between the execution and ingress commits. It restarts
that same isolated server and checks that redelivery returns the original run ID
with one execution. Its retained JSON evidence includes the receipt and transcript.

The results integration fixture additionally proves fresh provider contexts,
saved destination snapshots, captioned report lines, copied approval cards,
deleted-thread fallback, and continued user conversations staying visible. Native decoding and
thread-list tests retain hidden execution records for direct navigation and
approvals while omitting them from ordinary iOS/Android thread pickers.
