# Log doctor

`scripts/log-doctor.mjs` reads every log we have, groups the lines by what they say, and prints them ranked. Use it
whenever you touch the app, the link, or the account service, and before you call a bug fixed. A line that keeps
coming back is either a bug or a log line that is wrong. Fix whichever it is so the real problems stay visible.

```sh
node scripts/log-doctor.mjs                         # this computer, last 2 days
node scripts/log-doctor.mjs --remote --since 3d     # plus the Oracle server and Contabo, over ssh
node scripts/log-doctor.mjs --grep "egress|two places" --samples 3
node scripts/log-doctor.mjs --remote --json > /tmp/groups.json
```

## What it reads (all read only)

| Source | What |
|---|---|
| this computer | `server.log`, `desktop-crashes.log` and the trail (`trail*.jsonl`) in the app's logs folder (`--dir` to point elsewhere) |
| `--oracle` | `journalctl` for `metal`, `duskbot-link`, `omb-docker-gate`, `dusk-link-node` (`ssh oracle`) |
| `--contabo` | prozessor's logs for `dusk-account`, `dusk-account-prod`, `omb-link`, `dusk-preview`, `dusk-landing`, nginx `error.log`, and nginx's 5xx answers (`ssh contabo`) |

From the trail it keeps only what went wrong: answers of 400 and up, requests slower than 3 s (except streams and long
polls), and retry, lost and failed events. Load-test traffic (`dusk-loadtest`, `stress` user agents) is left out of
nginx's 5xx. A source it cannot reach is named in the header and skipped.

## Reading the list

Each row is one signature. That means the line with ids, addresses, numbers, durations and bot names taken out, per
source. Rows show the count, the level (error, warn; `--all` adds info), and first and last seen. `NEW` marks a
signature that was not there on the last run. Seen signatures are kept in `~/.cache/dusk-log-doctor/seen.json`
(`--state` to move it, `--no-save` to leave it alone), and one gone for 60 days counts as new again. Rows are ranked by
level x count, and a new signature counts double.

`known:` says what is already known about a signature, from the `KNOWN` list at the top of the script. When you find
a cause, add a line there. When the fix has shipped and the signature is gone, take it out.
