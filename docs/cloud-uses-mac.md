# Cloud bots use this Mac

A person's bots on their Dusk Cloud can work on that person's Mac while the Mac is on and the Metal app is open: run
terminal commands, download files, read and write files, and open apps and links. No screen control, so no Screen
Recording or Accessibility permission.

## What it reuses

- **"Your Mac" for a linked VPS** (`server/mac-control/`, `electron/mac-control*.mjs`): the Mac app long-polls its
  server for jobs (`GET /api/mac/self/jobs`), runs them and posts results. Jobs reach bots as the device MCP server's
  `mac_*` tools, so every call shows in the chat. The cloud path is the same host, poller and executor with a cloud
  mode added.
- **The app's own session at My Cloud**: the same signed Admin pairing the app already uses to lend its connection
  (`electron/home-egress-link.mjs`). It is an admin, non-browser session with no team membership, which is what
  `macHostSession` requires. No port opens on the Mac.
- **The cloud's link key** (`linkPublicKey` at the Admin, the private half in the cloud's `dashboard-link.json`): the
  trust anchor for sealing, see below.
- **Harness-native approval cards** (the peer approval pattern): Allow, Deny, Always allow, with `allowKey` saved to
  the bot's `alwaysAllow` through the existing route.

## Transport

The Mac reaches `https://<cloud>` with its session cookie, but TLS ends at the hosting provider's port proxy, not on
the cloud machine (`apps/cloud-service/deploy/Caddyfile`). So the jobs are sealed end to end on top:

1. The Mac makes an X25519 key pair per run and sends the public half with each poll (`key=`).
2. The cloud seals each job to that key (one-job X25519 key, HKDF-SHA256, AES-256-GCM) and signs the envelope with its
   link key (Ed25519).
3. The Mac gets the cloud's link public key from dusk.bot (in the pairing grant it already asks for), never from the
   cloud's own address, checks the signature and that the job was sealed to its own key, refuses expired or repeated
   jobs, then decrypts.
4. The result goes back sealed with the same job key, bound to the job id.

The edge can neither read jobs or results passively nor inject or change a job. Open risk: an edge that swaps the
Mac's key in a poll can read that one job's contents (it still cannot run anything: the real Mac refuses a job not
sealed to its key).

## Tools

| Asked for | Tool |
| --- | --- |
| mac.run | `mac_exec` (command, cwd, timeoutSeconds up to 600, last 200 KB of output) |
| mac.download | `mac_download` (https or http link to a folder or file path, default `~/Downloads/`, 2 GB cap) |
| mac.files | `mac_read_file`, `mac_list`, `mac_write_file` |
| mac.open | `mac_open` (an app by name, a link, a file) |

`mac_screenshot` and `mac_save_from_cloud` are not offered on a cloud. When the Mac is not polling, a call answers
"The person's Mac is offline" and nothing runs.

## Settings and safety

Settings > Your computer, on the cloud's own Settings page in the app:

- **"Let my cloud bots use this Mac"**: off by default and decided on the Mac. Turning it on shows a native confirm on
  the Mac, so a page cannot turn it on alone. While off the app does not poll at all. Turning it off is the kill
  switch: running commands are stopped and the cloud is told to forget the Mac.
- **When to ask**:
  - **Auto (asks only for risky actions)**, the default. Ordinary work just runs; a card appears only for what
    `electron/cloud-mac-risk.mjs` calls risky: sudo and other admin, AppleScript, system and security settings
    (csrutil, spctl, tccutil, launchctl, profiles, system `defaults` domains), disk tools, `curl | sh` and running
    downloaded scripts or installers, removing quarantine, recursive delete or delete by wildcard, emptying the
    Trash, recursive permission changes on home or system folders, killing processes, reading keys, passwords and
    `.env` files, force-push, `reset --hard` and other history rewrites, login and schedule items, writes outside the
    home folder or into `~/Library`, non-web links, checkout pages, payments. Plain rules, no model; a table of
    examples both ways is in `electron/cloud-mac-risk.node-test.mjs`.
  - **Ask before every action**: every command, download, file change and open asks; ordinary reads do not.
  - **Never ask**.
  - The card says why it asks. "Always allow" saves an exact plain command (no shell syntax) in its folder, a download
    site, a write folder, an exact open target or a read path, per bot.
- **Only these folders**: off by default. When on, reads, lists, writes, downloads and a command's folder must resolve
  (links followed) inside the list (default `~/Downloads` and `~/Metal`), and only https, http and mailto links open.
- **View log**: each job is one line in `~/Library/Logs/Metal/mac-control.log` (tool, bot, command or paths, whether
  a card allowed it, outcome or refusal; never file contents). The chat keeps each tool call too.

The Mac tells its cloud its mode, home folder and folder limit in each poll, so the cloud knows when to show a card;
the Mac applies the same rules itself before it runs a job, so a cloud or edge that skips the card gets a refusal.
The Auto rules catch ordinary dangerous commands, not a determined attacker who hides what a command does; "Ask
before every action" is the setting for that.

**Same account only**: the app serves only its own My Cloud (never a team cloud or another person's), the cloud only
takes a session from the owner's own app, and only the owner's own turns get the tools. Team members: not in this
version. **Credentials never leave the Mac**: jobs run there as the person; the cloud sees only what a command prints
or a read returns. Polling never wakes or keeps awake a sleeping cloud: the app polls only while it is awake, and the
poll is a background path.

Security invariant: the cloud's `dashboard-link.json` must stay unreadable to bot turns, as it already must for the
Admin link; a bot that could read it could sign jobs.

## Releases

- **Desktop app**: the Settings rows' bridge, the poller, sealing, rules, executor (`mac_download`, stoppable
  commands), log.
- **Cloud image**: cloud mode of `/api/mac`, sealing, cards, the Settings rows, the poll as a background path.
- **Admin (dashboard)**: the pairing grant carries the cloud's link public key.

All three are needed; an older piece fails closed (the app says the cloud needs an update and does not poll).
