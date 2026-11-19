# Welcome flow

The first run is a funnel of calm, single screens with back and a progress
bar: the welcome (with the "help improve Metal" switch, on by default and
saved the moment it changes), a Metal account (Google or an emailed code;
only where this window can sign in and isn't yet, and "continue without an
account" only where the app works without one), where the bots live (this
Mac, Dusk Cloud whose sheet opens over the funnel, or your own server), an AI
(a grid of ChatGPT, Claude, Grok, Gemini, Cursor, GitHub Copilot, OpenRouter
and a local model, more ways, and the free model when it is ready; skipped
when a Claude account or a ChatGPT plan already answers), bringing bots from
other apps or connecting email and calendar, and the phone (a QR code). It
ends in Metal's chat, where Metal greets in three bubbles, follows up and offers
chips for what is still missing. There is no job screen. Metal becomes Chief
only when there is no existing Chief. Where, how far and which step are in
`src/components/onboarding/funnel.ts`. The packaged app's account gate
(`src/components/account-gate`) still comes before the app itself, so there the
funnel's account step is passed over.

Headless walk (Nov 13 2026): `~/.playwright-mcp/funnel-sheet.png`, both cases
(nothing signed in; Claude already signed in) on a fresh fixture with a fake
desktop bridge and staged AI list.

The current offline checks are:

```sh
pnpm exec vitest run src/components/onboarding/WelcomeFlow.test.ts src/components/onboarding/WelcomeGate.test.ts src/components/onboarding/ConnectAi.test.ts src/components/onboarding/funnel.test.ts src/components/HelperIntro.test.ts src/lib/default-bot.test.ts server/routes/helper-followup.test.ts electron/system-name.test.mjs src/components/CardHint.test.ts
```

They cover navigation, AI readiness and sign-in errors, talking-style saves,
Chief assignment without replacement, replay and hosted-session gating. The helper tests cover
first-message chips and a follow-up written once for the helper's own person.
These use synthetic accounts and do not prove real provider authentication or
native Electron permissions.

For a manual renderer pass, launch the isolated full-app fixture following
[Chat UI](chat-ui.md):

```sh
node --experimental-strip-types scripts/control-dusk.ts ui launch
```

Use only its printed handle and preview URL. Add `?onboarding=1` to the
`threads` preview URL to play a brand-new install. The older standalone
onboarding browser script still names the retired welcome screens; it is not
current acceptance evidence.

Timed walk (Nov 10 2026, w16/onboarding): a fresh fixture with Dusk renamed
back from the fixture name, the fake engine scripted to answer a price job in
about 4 s, and a headless Chrome with every non-loopback request aborted. From
opening the page to the job's result on screen, with 2 s of reading and 1 s
before pressing Start built in: 12.5 s with a detected sign-in, 17.2 s signed
out (Sign in, paste a code, then the job). Model time in real use is extra and
was not measured. The free-backup state is covered by the component tests
only; the fixture has no OpenCode free model. Stop the fixture launcher with Ctrl-C when finished.

## Providers connected after first launch

```sh
pnpm exec vitest run server/onboarding-model-default.e2e.test.ts server/default-model-selection.test.ts src/components/NewBotDialog.test.ts
```

The server tests launch only disposable homes and repository-owned fake engines.
They cover a genuinely signed-out first install, a missing CLI connected later,
and first-send discovery without opening settings. They assert the selected model
in persisted bot records and fake-provider arguments, settled turns and bounded
transcripts. Existing bot choices and explicitly pinned thread models survive
both automatic repair and a restart. Disabled and signed-out engines stay unset.
Guarded messages recheck permissions after held provider discovery before starting.
Pure-picker tests cover API/custom engines, empty catalogs, fallback model options
and organization policy. Dialog tests cover blank saved new-bot templates without
replacing deliberate choices. Real provider authentication and packaged native
installation are not exercised by these offline fixtures.

## Organization row, hosted beats and member note (Sep 23 2026)

What each first-run surface depends on, and how it was checked:

| Who opens the app | What they get | Checked by |
|---|---|---|
| Desktop app, own server (full bridge, `remoteClient` present) | The current first run, decided without a new request | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/WelcomeFlow.test.ts` |
| Hosted workspace opened inside the desktop app (reduced bridge, no `remoteClient`) | Treated like a browser: the server is asked | `src/components/onboarding/WelcomeGate.test.ts` |
| Packaged desktop with the organization bridge | An optional "Using Metal at work?" row under Other ways in Connect an AI; a signed-in Company engine counts as ready | `src/components/onboarding/beats/OrganisationRow.test.ts`, `src/components/onboarding/ConnectAi.test.ts` (fake bridge) |
| Browser, admin of a hosted workspace | The first screen only, with the shared-workspace line, then the chat | `src/components/onboarding/WelcomeGate.test.ts`, `src/components/onboarding/WelcomeFlow.test.ts`, `src/lib/onboarding.test.ts` |
| Browser, hosted member (no admin scope) | No welcome flow; one dismissible note kept in browser storage; no first-conversation spotlights | `src/components/onboarding/WelcomeGate.test.ts` |
| Browser, client-scope session on a server that is not hosted | Nothing new: the flow does not open itself (it could not be saved); Settings replay and spotlights as before | `src/components/onboarding/WelcomeGate.test.ts`, `src/lib/onboarding.test.ts` |

`GET /api/auth/session` adds `hosted: true` for a session on a hosted
workspace and is otherwise unchanged (`server/email-signin.test.ts`).

On a fresh `ui launch` fixture, the recipe above still passed end to end
through the new session check. In the same fixture browser, a client-scope
paired session with the server's onboarding record reset got no welcome flow.
That run also showed the member note, which review then limited to hosted
workspaces (the fixture is not hosted). The hosted-only rule is covered by the
tests above, not by a rerun. In that run, "Got it" made no `/api/config`
write, and the note stayed away after a reload. Connect an AI was mounted from the Vite preview with a fake
`window.duskDesktop.organization` injected before mount; it showed the row signed out,
then connecting with the code, then connected. `begin` ran once, with the
default Admin. Screenshots are in `.dusk-scratch/verify-evidence/onboarding/`.

Not covered here: the real Electron preload bridge and a real Admin enrolment
(see [organization connection](organization-settings.md), not rerun for this
change), and a real hosted tenant's browser. The hosted beat set was rendered
from a temporary preview entry, not reached through a hosted sign-in. The
organization row now sits under Other ways on the first screen; its states are
covered by the tests in the table.

## A new Cloud's welcome

```sh
node --experimental-strip-types scripts/verify-cloud-welcome.ts
```

It launches the isolated fake-engine fixture and mounts the whole app
(`scripts/testing/cloud-welcome-preview.tsx`) in a Vite preview whose
session and config answer as a Cloud home's owner, with Claude signed out. Open the printed `previewUrl`:

- `?desktop=1` adds the reduced bridge a Cloud's page gets in the desktop app;
  `?move=copy` or `?move=done` shows the one-time move on its way or landed
  (6 bots, 142 chats, 4 routines).
- `?step=engine`, `?step=files` or `?step=done` opens the welcome on that step;
  `?skin=daylight` (or any skin) picks the skin.
- `POST /__fixture/engines?mode=signed-in` (or `signed-out`) changes
  the engine list for the next load.

What was checked this way (Oct 16 2026): every step and the done state in
Midnight and Daylight at 1280×860, 1024×760 and 390×844, the bring and engine
steps in the other seven skins, and
the setup card in short beside Routines. Steps finished there are written to
the fixture's onboarding record; the record can be cleared with
`PUT /api/config` (`{"onboarding":{"hintsSeen":[]}}`). The real move and the
desktop's preload bridge are not exercised here; they are covered by
`server/one-home.e2e.test.ts` and
`src/components/cloud-welcome/CloudWelcome.test.ts`.

## Bring what you already use (Oct 16 2026)

Skills and MCP servers another AI tool keeps on this computer, brought in with
one button: in Settings → Import, and offered by Metal's first messages as a
"Bring in your skills" chip when its look around finds some within two seconds.
Desktop app only.

```sh
pnpm exec vitest run server/setup-import.test.ts server/imported-skills.test.ts server/toml-lite.test.ts server/routes/setup-import.test.ts server/setup-import.e2e.test.ts src/components/ImportSettings.test.ts src/components/HelperIntro.test.ts src/lib/setup-import.test.ts
```

Every test builds its own temporary home; none reads the real `~/.claude`,
`~/.codex` or other dotfiles. The detector test plants credential, session,
history and transcript files holding a sentinel, records every path the step
touches, and checks that none of them was listed or opened and that the
sentinel reaches no answer, saved server or copied skill. The route test
refuses a paired device, a service loopback and a hosted or Cloud server; the
end-to-end test runs the real server from `launchVerificationServer` against a
planted home, as the desktop app runs it (`DUSK_TEST_DESKTOP_OWNER_TOKEN`), checks
that a headless server (`metal serve`) refuses the step, and checks that the starter bot and a bot made afterwards both
get the skills in their turn's index, task folder links and `/name`, that a
Claude turn with "Also use my Claude Code skills" on sees a Claude Code skill
once, and that a bot can switch one off for itself. The rows, working, failed
and with their result, are covered in Settings by
`src/components/ImportSettings.test.ts`; the chip by
`src/components/HelperIntro.test.ts`. Not covered here: the packaged Electron
window itself.

## First-run state checks

```sh
pnpm exec vitest run src/lib/onboarding.test.ts src/lib/welcome-draft.test.ts src/lib/default-bot.test.ts src/components/onboarding src/components/HelperIntro.test.ts src/components/AppNotices.test.ts
```

The current flow components cover first-run state and replay. The
retired Chief selector, app tour, first-conversation spotlight component and Meet
Metal popup have no current renderer fixture; their removed tests must not
be treated as acceptance evidence.

## Notch and dock step (Nov 9 2026)

On the desktop app on a Mac (the island bridge reports `available`), the first run shows one step after the jobs:
a demo display where the island cycles every mood, the dock bots can be pointed at, tapped or dragged into the
notch, and the real island is on while it shows. "Keep the notch on" saves `{ island: true }`, "Just the side dock"
saves `{ island: false, dock: true }`, and leaving with neither puts the island back as it was. Settings →
Appearance → "Island and dock tour" plays it again; dev builds also expose `window.duskIslandIntro()`.

```sh
pnpm exec vitest run src/components/onboarding/IslandIntro.test.ts src/components/onboarding/WelcomeFlow.test.ts
```

For a look without the app, `pnpm dev` and open `/src/windows/previews/island-intro-preview.html` (fake bridge; `?reduced=1`,
`?fail=1`, `?lang=de`, `?w=760&h=600`). The real island lighting up on a display is not covered by these checks.

## Bring your bots from another app (Nov 12 2026)

On the desktop app's own first run, before the first job, Metal looks (within 2.5 s) for bots another agent app keeps
on this computer and, when it finds some, offers them on one screen: each app with its bots as mascots and what comes
over in counts, "bring them over" and "skip for now". Progress names each bot as it moves; the done screen says what
moved in one line and what stayed behind in another. Settings → general → bring in from other apps → "look for bots"
opens the same step later, and says when nothing is found or everything is already here.

| App | Read from | Becomes |
|---|---|---|
| OpenClaw (and Clawdbot, Moltbot) | `~/.openclaw` (`$OPENCLAW_STATE_DIR`, `~/.openclaw-<profile>`, `~/.clawdbot`, `~/.moltbot`, `~/.moldbot`); `agents.list` (2026.3) or `agents.entries` (2026.11) in the JSON5 config; each workspace | one bot per agent: SOUL.md as its soul, IDENTITY.md's name, creature and vibe; MEMORY.md, USER.md, AGENTS.md, TOOLS.md and the newest 30 daily notes as memory; workspace and shared skills; HEARTBEAT.md as a 30-minute routine; cron jobs from `cron/jobs.json` or the `cron_jobs` table of `state/openclaw.sqlite` |
| Hermes Agent | `~/.hermes` (`$HERMES_HOME`) and each real `profiles/<name>` | one bot per profile: SOUL.md plus the chosen personality as its soul, `memories/MEMORY.md` and `USER.md` (§ entries) as memory, its own skills (not the bundled ones in `.bundled_manifest`), `cron/jobs.json` |
| Grok Bot | exports in `~/Downloads`, its roster's names | exports move as before; bots without one are named with a link to the move in Grok bot itself |
| your earlier Metal | a `~/.openmausbot` or `~/.opengrokbot` left beside the data folder in use | each bot but the helper and hidden ones, with its memory, skills and routines |

Every bot moves as a package (`trust: "file"`): new bots beside any already here (a taken name is numbered), skills
off until the scan passes them, routines paused, no keys, no connected apps. A bot already moved (its package id is on
a bot here) is named as already here, so a second run adds nothing. Each app's bots land together in one sidebar
section named after it. Logins, keys, sessions, transcripts and chat history (`.env`, `auth*.json`, `credentials/`,
`sessions/`, `state.db`, `messages.db`, `openclaw-agent.sqlite`) are never listed or opened, links are never followed,
nothing in the app's folder is written, and a file that can't be read is skipped and counted.

```sh
pnpm exec vitest run server/bot-move-local.test.ts server/bot-move.test.ts server/routes/setup-import.test.ts src/lib/bot-move.test.ts src/lib/grok-move.test.ts shared/grok-import.test.ts src/components/onboarding/WelcomeFlow.test.ts
```

The fixtures (`server/testing/agent-app-fixtures.ts`) lay out each app's folder as it does on disk, with a sentinel in
every login, key, session and history file; the tests record every path opened and listed. For a look in the real app:

```sh
node --experimental-strip-types scripts/verify-bot-move.ts
```

It launches the isolated fake-engine fixture as the desktop app's own server, plants OpenClaw 2026.3, Hermes Agent and
a left-behind `~/.openmausbot` in its temporary home, resets the welcome and prints a `previewUrl` that plays the
first run. Not covered here: the packaged Electron window, and a real OpenClaw or Hermes install of a version other
than the ones the fixtures copy.
