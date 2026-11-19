# Product analytics

The desktop app shares anonymous usage information to help improve Metal. **Help improve Metal** is on on a new
install (an opt-out). The switch is on the first screen of the first run ("Share anonymous usage to help improve dusk
bot. Never your messages or files.") and in Settings, and you can turn it off at any time. Once it is off, the app
records nothing more, clears anything still queued and sends nothing.

There is no third-party analytics SDK. Everything below goes to the configured account service, the same service your
sign-in uses.

## What the switch covers

One switch controls three things:

- **App events**: the small events listed below, sent by the desktop app. The phone app sends none: it has no switch
  of its own yet, and nothing there counts as on.
- **Usage records**: one record per bot turn and routine run, plus a count snapshot of what is set up, sent by your
  workspace with its regular report. Every value is a word from a fixed list, a count or a time (for example, the
  engine family `claude`, the tool kind `browser`, or a connector slug such as `gmail`). Bot, chat and routine ids are
  hashed with a salt that never leaves your computer.
- **Crash reports** from the desktop app, in builds that name a crash report endpoint: the error's type, message,
  stack and page path.

Message text, prompts, file contents, URLs, tool arguments, keys, names and email addresses are never sent. Free text
is dropped on your device before anything leaves it, and the account service drops anything outside its allowlist
again on arrival.

## When it is sent

Events are queued in memory and sent in batches of at most 50, about every 30 seconds, when the window is hidden and
when the app closes. The desktop app hands its batches to its own main process, which adds your account's event
token and posts them. A batch that fails is retried once. Turning the switch off clears anything still queued.

Each batch carries a random install id (kept in the app's local storage), a random id for this launch, the platform
and the app version.

## Events

| Event | Properties | When |
| --- | --- | --- |
| `app_open` | `kind` (desktop or mobile), `platform`, `appVersion` | once per launch |
| `app_close` | `ms`, how long the app was open | when the window closes |
| `app_screen` | `screen`, the page path with ids, numbers and long parts replaced by `:id` and no query string | when you move to another page |
| `app_feature` | `feature`, one word from a fixed list (`bot_created`, `routine_ran`, `chat_opened`, `voice_used` and so on) | when you use one of those features |
| `app_messages` | `sent`, `replies`, `latencyMs` (the median time to a first reply) | counts, folded into each batch |
| `app_error` | `kind`, `code`, both single words | a window error or unhandled rejection, without its message or stack |
| `app_pair_failed` | `reason`, a single word such as `expired_code` or `network` | pairing a phone fails |
| `app_action` | `name`, plus up to eight properties that are each a single word, a count or true/false | a button or step such as the setup environment (`env`: OS, architecture, language, screen size bucket, theme, skin, notification permission, hour of day) |
| `app_feedback` | `score` (1 to 5), `moment`, a single word | you answer the short feedback prompt |

## Turning it off

Turn off **help improve Metal** on the first screen of the first run or in Settings. The desktop app, its background
server (usage records) and its crash reports all follow the same switch, and stop at once. A server you run yourself can also be kept off with `DUSK_USAGE_SIGNALS=off`, and a desktop build's
crash reports with `DUSK_ERROR_REPORTS=0`.

Bot usage, cost accounting, server logs and diagnostics stay available in the app and on your server whether the
switch is on or off.
