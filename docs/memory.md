# Bot memory

## How it works, in plain words

Metal remembers things in two places.

**General memory** is what every one of your bots knows about you: your name,
where you live, your work, how you like answers, your diet and health needs,
the people close to you and how to reach them. It lives in **Settings →
General → About me**. You can type in it yourself; bots add lines to it too,
each marked with the day and the bot that learned it
(`- 2026-11-14 · learned by Scout · Priya lives in Porto`). Notes you import
from another AI app land here the same way (`learned by ChatGPT`).
Memory and standing instructions brought in from AI tools on this computer
(Claude Code's `CLAUDE.md` and project memory, Codex's `AGENTS.md`, Gemini
CLI's `GEMINI.md`, Windsurf's global rules) go to the first bot's notes, one
`memory/imported-<tool>.md` topic per tool, as unverified imported notes:
recalled when they fit, never loaded every time.

**A bot's own memory** is what only that bot needs: the projects it works on,
decisions made with it, its clients, its topic notes. It lives in that bot's
folder (`MEMORY.md` plus `memory/<topic>.md` files) and is shown under **Bot
Settings → Memory → What it remembers**.

**What gets saved.** Only lasting, useful things: preferences, facts about
you, contacts, recurring facts, decisions, ongoing projects. Small talk, the
weather, a one-off question or task, and codes or passwords pasted for a
moment are skipped. Anything that looks like a secret (an API key, a token,
a `password:` line) is replaced with `«redacted»` before it is written, so it
never sits in memory: secrets belong in the vault.

**When it gets saved.**
- *During a chat*, when you say "remember…", the bot saves it right away with
  its memory tool: to general memory when it is about you, to its own notes
  when it is about its work.
- *After a chat goes quiet* (two minutes, or every six turns), one quick
  background call reads what you said and files anything new. A fact about you
  goes to general memory once, not again into each bot's notes. Anything else
  goes into that bot's notes.
- *Every night* (after 3 am, or the next time the computer is awake) each bot
  tidies its own notes, and then one pass tidies general memory together with
  every bot's notes (below).
- *A daily log* (`memory/log/<day>.md`) records what the bot did each day. It
  is a diary for you; it never loads into a chat.
- *The journal* records every change to a bot's memory files, by whom, with
  one-click undo.

**When something changes.** Say "I moved to Porto" and the older "lives in
Lisbon" is replaced at once: the new fact is saved, the old line leaves
general memory, and in a bot's notes it is struck through as superseded.
The newest fact wins, and the old one becomes history: it never loads as
current, but a question about the past ("where did I live last spring?")
still finds it with the days it held. Nothing is lost: what left general
memory is listed under About me as **Replaced or merged**, with **Restore**,
and a bot's struck lines stay in its file.

**Tidying (consolidation).** Each night, and when you press **Tidy up now**
under About me, one background call (using your own AI, the engine your bots
already run on) reads general memory and every bot's main notes together and:
- merges facts that say the same thing twice, even in other words (numbers,
  names and "not" keep two facts apart);
- where two facts disagree, keeps the newer one;
- moves lasting facts about you that ended up in one bot's notes into general
  memory, so every bot knows them (only where one person uses all the bots,
  and never from a group chat);
- keeps the lines bots learned under about 12,000 characters, moving the
  oldest ones past that into the history (health and safety facts never move).

It never deletes a line you typed yourself as a duplicate, and changes at most
one of your own lines a night. Each bot's own tidy-up also clears expired
notes, merges repeated notes and settles contradictions in its notes.

**How it is used in a chat.** Every message a bot answers starts with:
- general memory: your own lines, health and safety facts, and the newest
  learned lines up to about 2,000 characters (roughly 500 tokens);
- the bot's `MEMORY.md`: your own lines, health and safety notes, and its
  newest notes, up to about 5,000 characters (roughly 1,250 tokens);
- the list of the bot's topic files.

These are read once when a conversation starts and kept for it, so the
cached prompt stays the same while you talk; something saved meanwhile is
told to the bot once, with your next message, and something removed or
replaced stops reaching it at once.

Then, for the message itself, recall looks up what fits it among everything
the bot may read, by words and by meaning (a local model on your computer,
nothing sent anywhere), by names and by the time asked about, and adds the
best facts and a few passages from earlier chats, at most 6,000 characters
(about 1,500 tokens). When a question about you finds nothing, the bot is told
so, and says it does not know instead of guessing.

**What a bot may not keep.** Only your own words, or work the bot checked,
become memory that loads every time. During work that read a web page, an
email, a file, a tool's result or another bot's message, a note the bot saves
goes to its *unverified notes*: recalled when relevant and marked unverified,
never loaded each time and never into About me. Anything that reads like an
instruction ("always cc …", "send … to …") is refused.

**Seeing and editing it.** General memory is the About me box in Settings,
with **Added by your bots** (remove any learned fact; it is not learned
again) and **Replaced or merged** (restore any). A bot's own memory is under
**What it remembers** in its settings: edit any file, see every change in the
journal, undo one. Saying "forget that" in a chat removes exactly that fact
from both; when your words could mean facts about different people ("forget
Pune" while a friend lives there too), the bot asks which.

**Sizes at a glance.**

| What | Limit |
| --- | --- |
| About me, total | 24,000 characters (4,000 for a person on a team); when full, the oldest learned lines move to the history |
| Learned general facts loaded each turn | about 2,000 characters, health and safety up to 1,000 more; the rest are recalled |
| Learned general facts kept | about 12,000 characters; older ones go to the history |
| History of replaced or merged lines | the latest 300 |
| A bot's `MEMORY.md` loaded each turn | about 5,000 characters, health and safety up to 1,500 more; the rest are recalled |
| A bot's `MEMORY.md` file | 200 lines or 24 KB; older entries move to `memory/archive.md` |
| One note | 1,000 characters, 20 lines |
| Recall per message | 14 facts and 4 chat passages, 6,000 characters |

How well this works is measured by an offline suite and a live suite with a
real model (`scripts/memory-eval/`, see its README for the latest scores).

The rest of this page is the detailed reference.

## Reference

By default, bots keep notes between tasks. The notes are plain markdown files in a
folder on the computer running Metal — nothing is stored anywhere else,
and you can open, edit, or delete any of it in any editor. **Bot Settings →
Memory** shows the same files with a gauge of how much of them actually loads,
an editor that never overwrites something the bot wrote while you were typing,
and a journal of every change with one-click undo.

The **Let this bot use memory** switch is on by default. Turn it off while the
bot is idle to stop loading `MEMORY.md` into new turns, stop automatic recall
and upkeep, hide native memory tools, exclude memory files from `session_search`,
and stop automatic daily turn logs. Existing files remain for review. A bot
with filesystem access can still edit those files directly; use standing
instructions to forbid that when memory must stay in another source of truth.

## Where it lives

```
~/.duskbot/workspaces/<botId>/
├── MEMORY.md            core notes; the newest ~5,000 characters load each conversation
└── memory/
    ├── <topic>.md       notes about one subject, recalled when a message needs them
    ├── unverified.md    notes saved during work that read outside content
    ├── archive.md       older notes moved out of other files, and expired ones
    ├── archive-2026.md  the archive's older half, once it passes 128 KB
    └── log/
        ├── 2026-09-10.md   what the bot did that day, in its own words
        └── 2026-05.md      daily logs older than 90 days, one file a month
```

The folder is the bot's private workspace: the directory its file tools work in
when it has no project folder set. It is created the first time the bot runs a
turn. **Open in Obsidian** and **Show in Finder** (Explorer, or your file
manager) in the Memory panel open this folder; because it is on the server's
disk, those buttons only work from the computer running Metal — a
paired phone or a remote browser is shown the path instead.

Files are written with owner-only permissions (`0600`), atomically (a crash
mid-write leaves the old file intact, never a torn one), and anything that
looks like a credential — API keys, tokens, `password: …` lines, private key
blocks — is replaced with `«redacted N chars»` before it reaches disk. A bot
that helpfully "remembers" a key it read from a `.env` does not get to keep it.

## What loads, and the budget

At the start of a conversation the bot's `MEMORY.md` is read and a part of it
goes into the system prompt (`coreForPrompt` in `server/workspace.ts`): every
line the person wrote by hand (no date), then dated health and safety notes
(`CORE_PINNED_CHARS`, 1,500 characters, newest first), then the newest live
entries until `CORE_LOAD_CHARS` (5,000 characters), all in file order. Struck
(superseded or merged) and expired entries never load. When something is left
out, the prompt says how many older notes are not shown and that they are
recalled when a message touches them; the file keeps every line.

The gauge at the top of the Memory panel shows the file against its own cap
(`MEMORY_MAX_LINES`, 200 lines, and `MEMORY_MAX_BYTES`, 24 KB) and how much of
it loads each turn. It is amber from 80% of the cap and red only past it.

`MEMORY.md` never fills up. Every write that goes through the harness
(`memory_update`, and capture) keeps the file within its cap in the same
step: when the new entry would push it past, the oldest dated entries move to
`memory/archive.md` (struck-through ones first, then expired ones, then the
oldest live ones), each marked `· moved <date>`. An entry moves whole, with
the lines indented under it. The archive is written before `MEMORY.md`, so a
line is never out of one without already being in the other, and recall and
`session_search` still find it. Lines you wrote by hand, health and safety
facts, and the entry just written never move. One entry is at most 1,000
characters and 20 lines.

About me loads too: every line the person typed, every health or safety fact
(up to `GENERAL_PINNED_CHARS`, 1,000 characters), then the newest learned
lines up to `GENERAL_LOAD_CHARS` (2,000 characters). When all learned lines
fit, the text is exactly About me.

**Held for the conversation.** About me, `MEMORY.md` and the topic index are
read once per conversation and kept (`server/memory-snapshot.ts`), so the
"memory" and "About the user" parts of the prompt are the same bytes on every
turn and sit in its cached half. A line saved meanwhile reaches the bot once,
at the top of its next message ("Saved to your memory since this
conversation started"). A line removed, forgotten or replaced takes a fresh
copy at once, cache or not. After 30 minutes without a turn (longer than a
provider keeps its prompt cache) the next turn reads them again.

Two more things load with it:

- **Expired notes stay out.** An entry that ends in `· until 2026-09-28` stops
  loading the day after that date.
- **The topic index.** Every `memory/<topic>.md` is listed by name under the
  memory block, with its `title`, `description` and `aliases` when the file
  starts with frontmatter, at most 40 topics or 2,000 characters.

A saved line that reads like an instruction (overriding rules, sending data to
an address or link, reaching for keys) is shown to the bot as
`[blocked: a saved line read like an instruction …]` and stays in the file for
the person to review.

## The fact store

Every line of memory is also a row in `messages.db` (`memory_facts`,
`server/memory-facts.ts`): one per dated entry or hand-written line of
`MEMORY.md`, each topic file and the archive, and one per About me line and
per line in its history. The text stays in the files, which remain what the
person reads and edits; the row holds what code knows about it:

- **status**: active, superseded (struck through, or replaced in About me),
  merged, expired (past its `until`), or suppressed (deleted by hand);
- **when**: the day it was noted, the day it stopped holding, and for events
  the days they happened (dates named in the text, "April 2026", "spring
  2025", are read as ranges; capture writes relative dates out as absolute
  ones);
- **where it came from**: typed by the person, said by the person (with the
  quoted words and the message), verified by the bot, another person in a
  group chat, a tool, the web, another bot, an import, or an older line of
  unknown origin; and a **trust** level from that (high, medium, low);
- its **embedding**, for recall by meaning.

Rows follow the files: a file whose size or time changed is read again on the
next recall and its rows reconciled. A line that moved between files keeps its
row and provenance; a line deleted by hand is marked suppressed, never
recalled again, and dropped from the table after 180 days.

**First start.** The first time a build with the fact store starts, it copies
every bot's `MEMORY.md` and topic files, About me, `profile-learned.json` and
the general-memory history into `memory-v1-backup/<time>/` in the data folder,
then reads them into the store, and writes `memory-v2.json` with how many
lines it read and how many facts it holds (the same number). It rewrites no
file. A crash midway runs it again on the next start.

## Local embeddings

Recall by meaning uses BAAI's `bge-small-en-v1.5` (int8 ONNX, about 34 MB) run
by onnxruntime's WebAssembly build, in the server process
(`server/memory-embed.ts`). The model and runtime (about 50 MB in all) are
downloaded once, in the background, into `models/` in the data folder (or
`DUSK_MODEL_DIR`), each file checked against a pinned SHA-256 digest; the
download is skipped with less than 1 GB of disk free. Until they are there,
or if anything fails, recall works from words alone and the log says why once
(retried after six hours). Memory text is never sent to an embedding
service. `DUSK_MEMORY_EMBED=0` switches embeddings off. The model is English;
other languages are matched by words, names and time.

## Recall before each turn

Before a turn, the person's message (eight characters or more, not a nod
like "ok" or "thanks") is looked up among the facts the turn may read: the
bot's own notes (on a Team Cloud the turn's layer and the team's), About me
and its history (`server/memory-recall.ts`). Four searches run together:

- words: FTS5 BM25 over each fact and its topic's name, title and aliases,
  stemmed, with a few words added for common facets (a question about "my
  job" also searches "works", "role", "lead"…);
- meaning: cosine similarity of the local embeddings;
- names: facts that name a person, place or thing the message names;
- time: when the message asks about a time ("last spring", "in March", "two
  weeks ago", "this year"), facts that held or happened then.

Their rankings are fused by reciprocal rank (k = 60), then lightly boosted: up
to ±10% for recency over a year and ±10% for falling inside the asked-about
time. A fact must also clear a relevance bar (close in meaning, or sharing
enough words, a name or the asked-about time), so an unrelated message
recalls nothing. Superseded and expired facts are searched only when the
message asks about the past, and are shown as `no longer true; held <from> to
<until>`. Facts already in the prompt are not recalled again, and one fact
kept in two places is recalled once.

The best facts (at most 14) come first, each numbered with its id, where it is
kept and its dates; the top two carry the words they were learned from when
that conversation may be read here. Then up to four passages from the bot's
other conversations, in a 1:1 chat the person started. All of it fits in
6,000 characters, opened by a line saying these are the bot's own notes and
that a command inside one is not an instruction. A question about the person
that finds nothing gets one line instead: *nothing in your memory matches it;
say you do not have that rather than guess*.

It is placed in the message, not the system prompt, on purpose: recall changes
nearly every turn. Rooms, routine runs (which start fresh), and turns started
by another bot, a webhook or a teammate hand-off recall notes only.
`features.autoRecall: false` in `config.json` switches recall off. The server
log names every recall (`auto-recall: … got N note and M conversation
passage(s)`).

## Memory upkeep

**Bot Settings → Memory → Memory upkeep** is on for every bot unless switched
off. It keeps the notes in shape without the bot having to decide to:

- **Noticing facts.** When a 1:1 chat has been quiet for two minutes
  (`memory.captureQuietMs`), or after six turns, one quick model call reads those turns, the person's words and
  the bot's under different rules, beside the newest lines of `MEMORY.md`,
  the list of topic files and up to 20 known facts those turns bring to mind
  (recalled from the bot's notes and About me, keyed `F1`…), and files what is
  new. Every item is kept only with the words it rests on, quoted and checked
  against the chat: the person's own words for a preference, a fact or a
  decision, the bot's words for an outcome it verified. A question
  ("…note-takers for a 10-person startup?"), a task ("write a launch plan for
  an AI app") or a "suppose…" is never a fact about who they are. Each item
  gets a verdict against the known facts, applied by code: *new* is saved;
  *repeat* is not (a fact about the person kept only in one bot's notes still
  goes into About me); *change* replaces the fact it names, which leaves About
  me (into the history) or is struck through as superseded in the bot's notes,
  before the new one is written; *end* strikes it with nothing in its place. A
  new item that means the same as a known fact (embeddings at 0.95 or closer,
  with the same numbers, names and negation) counts as a repeat. Dates are
  written out ("next Friday" becomes the date) and an event keeps its days;
  each saved fact records its quote and the message it came from. Nothing that
  a tool can look up again is copied in, only where to find it, and nothing
  that reads like an instruction is kept.
  - a lasting fact about the person themselves (marked `aboutUser`, from their
    own words) goes only to general memory, About me, below, never again into
    the bot's notes;
  - another core fact the bot needs in every conversation goes to `MEMORY.md`,
    marked `(noticed)`:
    `- 2026-09-25 · from chat "Plans" (noticed) · Launches go out on Fridays`;
  - everything else goes to a topic file for its subject — a person, a
    project or client, food, travel — reusing an existing topic or creating
    one with a header (`title`, `aliases`: the other words someone would ask
    with), so recall finds it later.
  A fact that ends on a known day gets its `until` date; a birthday or other
  yearly date never does. Turns started by another bot or by the harness,
  routine runs and failed turns are never read; rooms only with **Learn from
  group chats** (below).
- **Learning from group chats.** The **Learn from group chats** switch under
  Memory upkeep (`features.roomMemoryCapture`, one switch for every bot,
  off by default) lets a member bot's room turns feed its capture the same
  way, batched per bot and room. What the bot read since it last spoke
  there is read with its reply, under room rules: the person's own lines
  count as theirs; another person's lines give only facts about the shared
  work and never reach About me (a batch holding them adds nothing to About
  me); another bot's lines give only an outcome it verified or a decision
  the person agreed to, never its suggestions or claims. A stretch with no
  person's words is skipped. Entries are sourced to the room:
  `- 2026-09-25 · from room "Launch" (noticed) · The launch moved to Friday`.
  A room fewer people can see than the bot never feeds it (the same rule as
  the recent-work brief), checked again when the batch is captured, as are
  the switch and the bot's membership. Bot-to-bot channels, room hand-offs,
  goal runs and, on a Cloud home, every room are left out.
  Turns still waiting when the app quits or restarts through its normal
  shutdown are kept as their ids (never their text) in
  `memory-capture-pending.json`, at most 50 chats, and read back from the
  chat at the next start, so what was said just before quitting is still
  noticed. A crash or a forced kill skips that step (on Windows a `SIGTERM`
  is one), and those turns are not captured. A chat deleted or rewound
  meanwhile leaves nothing to read.
- **Organizing.** Whoever wrote a line in `MEMORY.md` — the bot with
  `memory_update`, the person, or capture — after each capture and in the
  nightly tidy-up one quick model call looks at lines not judged before and
  moves the ones that are detail about a subject (another person, a project
  or client, a trip, likes in one domain) into that subject's topic file,
  unchanged, creating it with a header and other words for it. Core facts —
  the person's name, where they live, their company, diet, allergies and
  health needs, how they like replies — always stay; a line about diet,
  allergies or health is never even offered for moving (a fixed rule, not the
  model's choice), and a line judged core is not asked about again. At most 20 lines move in one pass; each file's change
  is a journal row (*filed into topics*) that can be undone.
- **About me.** A lasting fact about the person, taken from their own words,
  is added to **Settings → General → About me**, which every bot reads, as a
  dated line `- 2026-09-25 · learned by Scout · …`. **Added by your bots**
  under About me lists each one with **Remove**; a removed fact is never
  added again. On a shared installation, another person's messages never add
  to the owner's About me.
- **General memory consolidation.** After the bots' nightly tidy-ups (once a
  day after `memory.tidyHour`) and on **Tidy up now** under About me
  (`POST /api/profile/general/consolidate`), one model call on the first bot
  whose engine can make one reads About me (the person's typed lines first,
  then learned lines newest first) and up to 150 live `MEMORY.md` entries
  shared out across every upkeep-enabled bot in turn, so one bot cannot crowd
  the others out (within a bot, the lines most like an About me line first),
  and answers which lines are the
  same, which an older line a newer one replaced, and (only where one person
  uses every bot, `sharedMembership()` false, and never from a `from room`
  entry) which bot lines are lasting facts about the person to move into
  About me. Fixed rules decide what is applied
  (`server/general-memory.ts`, `planConsolidation`): a person-typed line is
  never dropped as a duplicate of a learned one, at most one is replaced per
  pass; at most a third of the learned lines (two in a short list) go in one
  pass; a learned line dated after the one said to replace it is not
  removed; health and safety facts are never trimmed; learned lines are kept
  under `GENERAL_MAX_CHARS` (12,000). Before the call, learned About me lines
  that mean the same thing (embeddings, as below) are merged, the older one
  into the history as a duplicate. About me is written first, then each
  bot's `MEMORY.md` (skipped for a file that changed meanwhile), each a
  journal row via *general*. What leaves About me goes to
  `general-memory-history.json` (latest 300), listed under About me as
  **Replaced or merged** with **Restore**. A pass is skipped when About me
  changed while the model answered. It does not run on a Team Cloud, where
  each person's About me is their own.
- **Nightly tidy-up.** Once a day after 3 am (`memory.tidyHour`), or at the
  next check if the computer was asleep, never while the bot is working, and
  on **Tidy up now**: expired entries move to `memory/archive.md` (from
  `MEMORY.md` and topic files); of two entries with exactly the same fact the
  newer stays; and in `MEMORY.md` and each project topic a model call looks for pairs that cannot
  both be true, striking the older through (`~~…~~ · superseded <date>`)
  rather than deleting it; when that line also held something still true
  ("lives in Pune and prefers short replies"), that part is kept as its own
  entry `from tidy-up`. At most a fifth of the entries can be struck in one
  pass in core memory, and none in a core file of fewer than five. Topic files
  may reconcile one pair even with two entries; writes recheck for concurrent edits. The archive is written before
  the file it came from, so undoing the newest change never loses a line.
  Four topics are checked a night, first those holding two close but not
  identical facts. Then:
  - **Merging.** Among the bot's newest 300 live entries, pairs that mean the
    same (embeddings at 0.95 or closer, the same numbers, names and negation;
    without embeddings only word-for-word repeats) are confirmed by one model
    call (at most 20 pairs); the older or shorter line is struck through as
    `· merged <date>`, never deleted. The same caps apply, and a hand-written
    line is never merged away.
  - **Keeping files bounded.** A topic past 64 KB moves its struck, then
    expired, then oldest entries into the archive; `memory/unverified.md` is
    kept under 16 KB the same way; past 128 KB the oldest half of
    `memory/archive.md` rolls into `memory/archive-<year>.md`. Daily logs older
    than 90 days fold into one `memory/log/YYYY-MM.md` per month. Everything
    stays searchable; nothing is deleted.

"Exactly the same fact" is narrow on purpose: spacing, a bullet and a final
full stop are ignored, nothing else — `Balance is -10` and `Balance is 10`,
`C++` and `C`, `1.5` and `15` are different facts.

Every upkeep change is a journal row by **Memory upkeep** and can be undone.
Upkeep pauses while a backup runs. The model steps need an engine with a
one-shot text call — Claude, Codex, Grok, OpenAI-compatible, Mistral and
MiniMax, and the agent engines that speak ACP (Grok CLI, Gemini, Kimi, Droid,
Cursor, OpenCode, Qwen, Hermes, Antigravity and custom ACP agents). On an ACP
engine each call starts the engine's own CLI in a fresh session of its own,
never a chat's, in an empty folder, with no MCP servers and in the ask-first
approval mode; it is refused and dropped the moment the agent asks for a
tool, a file or a permission. On Codex each call is one `codex exec` on the
same sign-in, in an empty folder with a read-only sandbox, no session saved,
without the person's `config.toml` (so none of their MCP servers, plugins or
hooks start) and with the shell and every other tool off; it uses the
smallest model the account lists (GPT-6 Luna) at low effort, since it runs
on the person's own plan, and is dropped the moment Codex reports a tool
call. The text goes only to the provider the bot already uses. On any other
engine (Pi and Muse Code, for now) the panel says so — under Memory upkeep
and under Learn from group chats — and only the expiry and exact-duplicate
steps run, unless a helper model is set.

### The helper model

A helper model fills the gaps an engine leaves. It is one connected provider
instance, and optionally one of its models, that writes a small background
text a bot's own engine cannot write:

- memory upkeep's steps and the automatic skill review, for an engine with no
  quick text call at all (Pi and Muse Code, for now);
- the summary written when a long conversation is compacted, for those
  engines and for Codex and the ACP engines too. Their own quick call starts
  a whole agent process, so it is kept for background work and a turn never
  waits on it; without a helper they keep a summary made of excerpts.

A bot whose own engine can write a job always writes it itself; the helper
never takes its place.

It is off unless you set it. Add it to `config.json`; the server follows the
file, so adding the helper or taking it out again applies without a restart:

```json
{ "helper": { "instanceId": "claude", "model": "claude-haiku-4-5" } }
```

or set `DUSK_HELPER_INSTANCE` (and, if you want, `DUSK_HELPER_MODEL`) in the
server's environment before it starts. The environment wins over the file,
and an empty `DUSK_HELPER_INSTANCE` switches a saved helper off. `instanceId` is the id of
a connected instance as `config.json` and `GET /api/instances` name it, such
as `claude`, `claudeApi`, `openai` or `openrouter`; it has to be Claude or an
API model, the engines with a quick text call of their own. `model` is
optional: without it the instance uses the model it already uses for quick
calls. There is no Settings screen for this yet, and Settings still describes
each engine by its own abilities: the line under **Learn skills
automatically** that says bots on an engine won't learn skills this way does
not know about the helper.

**What leaves the bot's provider.** With a helper set, the text those jobs
read is sent to the helper's provider, which may not be the one the bot runs
on: the turns being captured and the bot's memory notes, the history being
summarised, and the conversation and skills under review. That is why it is
opt-in. It applies to every bot whose engine cannot write the job, including
one you run on a local model, unless you keep that bot off the helper (below).
An engine your organisation does not allow is never used as the helper, and
on a hosted workspace only a model assigned to it is.

**Keeping one bot off the helper.** Any bot can be switched to never use the
helper model: send `PATCH /api/bots/<bot id>` with `{ "helperModel": false }`
(there is no Settings switch for it yet). From its next job on, the helper
writes none of that bot's own jobs: not its compaction summary, not its memory
upkeep, not its skill review. For those three the bot gets what it would get
with no helper set.

The switch covers that bot's own jobs and nothing else. What the bot says in
a room, or in reply to a teammate, becomes part of the other bots'
conversations. Their engines read it, and so does whatever writes their
background jobs, the helper included. The switch does not change that. To
keep a bot's text on the machine, run it on a local model, switch it off the
helper, and keep it out of rooms and teams with bots that are not set up the
same way.

The switch is saved with the bot, and a copy made with **Duplicate** keeps
it. It travels in a full workspace backup and in a team backup, the two
exports that hold a bot's notes and chats, so a restored bot stays off the
helper. A shared team package carries no personal settings and does not carry
this one.

A helper that is missing, switched off, failing or slow breaks nothing: the
job falls back exactly as it does with no helper (an excerpt summary, no
capture, no review), and the server log says once why the helper is not
used. The one job a turn waits for is the compaction summary, and a helper
that hangs holds it for at most the summary's usual 20 seconds. Helper calls
count toward the monthly spend limit and stop at it. Each is its own row in
**Settings → Usage → History**, for the bot it wrote for, with the helper's
engine and model: group by **Person** to see them together as *Helper
model*, which is also what the CSV's `triggered_by` column says.

## Remember and forget, in chat

"Remember: short answers, and I'm in India" is saved during that turn with
`memory_update`, so it shows under **What it remembers** in the bot's panel
as soon as the turn ends, and the bot confirms it in one plain line ("Got it:
short answers, and times in India time.").

"Forget that" is `memory_update` with `action: "forget"` and either the ids of
the facts (`ids`, the `#f…` each recalled fact carries) or a few words that
name it (`old_text`). Words find the facts that mention them as whole words
("IST" is not in "dentist"); when those are about different people or things
("forget Pune" with the person's own old city, a friend who lives there and a
colleague who moved there), nothing is removed and the bot gets the candidates
with their ids to ask which one was meant. The facts named go, and every copy
of them: from `MEMORY.md`, every topic file and the archive, keeping their
headers, and, when the person asked in their own 1:1 chat, from **About me**,
learned or written. A note never ends up as a date with no words. What was
forgotten is kept in `profile-learned.json` so no bot learns it again until the
person asks a bot to remember it once more: the words themselves when they
asked with two or more ("forget short answers"), only the facts removed when
they named one word. The bot confirms in one plain line and names no files.

**Who may write what.** Each turn knows where its words came from: the
person, another bot (a hand-off or `coordinate_bots`), or an automation (a
routine, a webhook, the Bot API); and whether, since the person's last message,
it read outside content (a page, a fetch or search, mail, a connected app or an
MCP tool). During a turn whose words came from outside, `append`, `replace`
and `supersede` save to `memory/unverified.md` instead (source and low trust in
the fact store; recalled marked *unverified*, never loaded each session),
`prefer` is refused, and so are `forget` and `remove`. In every turn, text
that reads like an instruction is refused (`server/memory-trust.ts`).

A standing preference or lasting fact for all of the person's bots ("reminders
go to my task app", "I moved to Porto") is `memory_update` with
`action: "prefer"` and the fact as one line of at most 300 characters; with
`old_text`, the older learned line it changes leaves About me. It goes once into the About me of the person whose
own words began the work, as a learned line, and every bot reads it there, so
no bot has to be told it and nothing fans out to each bot
(`server/host/person-preference.ts`). On a Team Cloud that is the person the
turn acts for: their own chat, a group chat line of theirs, or work handed on
from it, and nobody's once another person's words joined. Elsewhere it is the
one person, when their own message began the work. A routine, a webhook, an
outside app or a bot's own work saves no one's preference. A Chief of Staff
saves such a preference itself instead of sending it to each bot.

## Editing

`MEMORY.md` and every topic file can be edited in the panel. A save carries
the hash of the text you opened; if the bot changed the file in between — it
writes with `memory_update` during a task, or with its own file tools — the
save is refused and the panel says so: *Scout changed this file while you were
editing.* **Reload** shows the bot's version and keeps your draft under the
editor so nothing you typed is lost; **Overwrite with mine** saves yours over it.
Either way the change is in the journal and can be undone.

Daily logs are read-only in the panel (they are the bot's own record) but can
be deleted. `MEMORY.md` can be emptied but never deleted — the bot expects it
to exist. Topic names are one file name under `memory/`: letters, numbers,
spaces, dots and dashes, ending in `.md`. Nothing nested, nothing starting
with a dot.

The old whole-file `PUT /api/bots/:id/memory` still works for one release; it
has no hash check, so it can overwrite what the bot just wrote. Clients should
move to `PUT /api/bots/:id/memory/file` with `expectedHash`.

## What a bot knows about its other conversations

A bot's 1:1 chats and its rooms are separate conversations, and its memory
holds only what stays true — so on its own, a bot answering in a room had no
idea what it did in its 1:1 an hour earlier, and a morning standup ended in
guesses. Three things close that gap without attaching transcripts:

- **The recent-work brief.** Every turn's system prompt, 1:1 or room, carries
  a short block: the newest thing the bot said in each of its *other*
  conversations over the last two days — `today 09:05 · 1:1 with Milind ·
  "Invoice reconciliation" · you said: "Sent the three flagged invoices…"`.
  At most ten lines and about 350 tokens; the current conversation is not
  listed. When a brief in a room names a private 1:1 chat, the room gets a
  chip — *Lead's recent-work brief covers 1 private chat with you* — once per
  chat, the same rule as recalled messages.
- **One log line per finished turn when memory is on.** The harness appends what the bot said
  last, the tools it used, and whether the turn failed to
  `memory/log/YYYY-MM-DD.md`, sourced to the chat or room. The log is never
  loaded into a prompt; `session_search` finds it.
- **Recall by time.** `session_search` takes `since` (`"24h"`, `"3d"`,
  `"yesterday"`, or a date) and `until`, with or without words, and covers
  the rooms the bot is a member of as well as its 1:1 tasks. "What happened
  since yesterday's standup" needs no keyword. Hits name the room or task
  they came from; a private chat recalled into a room is marked, and the
  room is told.

A daily standup is then a room routine: the chief asks, each member answers
from its brief and pulls detail with `session_search since`, and what was
agreed shows up in each member's next 1:1 brief.

## The journal

Every change to a memory file that the app can see is recorded — yours from
the panel, the bot's during a task, an import, an undo — in
`~/.duskbot/memory-journal/<botId>.ndjson`. It lives *outside* the
workspace on purpose: the bot's file tools point at the workspace, and a
record the bot could edit would not be a record.

Each row says who (bot, person, or import), how (in Settings, during a task,
from which chat, changed outside the app, undo), which file, when, the
before/after hashes, a short diff, and the full earlier text so **Undo** can put
the file back without anything else. Undo is itself a journaled change, so it
can be undone in turn. Two kinds of row cannot be undone and say so: one
whose earlier text contained a credential (the stored copy is redacted, and
restoring it would write the redaction marker into the bot's memory), and one
whose earlier text was too large to keep.

Bot writes are caught at the turn boundary. When a turn starts, the app notes
what every memory file says; when the turn ends, whatever differs is recorded
as the bot's work for that chat. A file that changed between turns — edited in
Obsidian, say — is recorded as yours, *changed outside the app*. Two of the
same bot's threads running at once are both diffed; a change lands under
whichever thread finished first. Journaling never fails a turn: a row that
cannot be written is logged and dropped.

A bot's journal is kept under 4 MB: past that, its older half moves to
`<botId>.rotated.ndjson.gz` beside it, without the earlier file copies, so
those rows can be read but no longer undone; the newest rows stay undoable.

## Conventions inside the files

The files are yours and the bot's, and any markdown is fine. The app itself
reads them as plain text and never requires a structure. The conventions the
bot follows when it writes are:

- **Dated entries in `MEMORY.md`.** A note the bot adds during a task is one
  bullet with its date and the chat it came from:
  `- 2026-09-10 · from chat "Follow-up" · the user prefers short replies`.
  A person's hand-written bullet without a date is just as valid.
- **Superseded or merged, not deleted.** When a fact is replaced, the old
  bullet is struck through and dated rather than removed:
  `- ~~the office is in Pune~~ · superseded 2026-09-10`, or `· merged
  2026-09-10` when another line says the same thing, so the file itself shows
  what changed. Struck lines never load and answer only questions about the
  past; they count against the file's size and move to the archive first.
- **Unverified notes.** `memory/unverified.md` holds what a bot saved during
  work that read outside content. It is recalled marked unverified and never
  loads each session; a fact the person confirms in their own words is saved
  again normally.
- **Archives.** `memory/archive.md` and the yearly `memory/archive-<year>.md`
  hold notes moved out of other files: history, searchable, never loaded.
- **Daily logs** under `memory/log/YYYY-MM-DD.md` are the bot's diary of what
  it did; they are never loaded into a conversation and are meant for you to
  read in the panel or in Obsidian.
- **Until dates.** A fact that stops being true on a known day ends with
  `· until YYYY-MM-DD` (`memory_update` takes an `until` field for it) and
  stops loading the day after.
- **Topic files** are ordinary markdown. A topic may begin with a small YAML
  frontmatter block — `title`, `description`, and `aliases` (other words for
  the topic, since notes are found by matching words) — which the topic index
  reads, and may link to another topic with an Obsidian-style `[[wikilink]]`,
  which the app leaves as text. A pointer in `MEMORY.md` to a topic (`see memory/clients.md`)
  is how the bot knows the topic exists.

Nothing about the panel depends on these: an older `MEMORY.md` written in
free form, or one you rewrite by hand, works the same.

## Routes

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/bots/:id/memory` | Overview: gauge numbers, topic and log lists, the folder path. |
| `GET` | `/api/bots/:id/memory/file?path=` | One file's text and hash (`MEMORY.md`, `memory/<topic>.md`, `memory/log/<day>.md`). |
| `PUT` | `/api/bots/:id/memory/file` | `{ path, text, expectedHash? }` — `409` with the current text when the hash no longer matches. |
| `DELETE` | `/api/bots/:id/memory/file?path=` | Removes a topic or log; refuses `MEMORY.md`. |
| `GET` | `/api/bots/:id/memory/journal?limit=` | Recent changes, newest first. |
| `POST` | `/api/bots/:id/memory/journal/:entryId/revert` | Puts the file back to that row's earlier text. |
| `POST` | `/api/bots/:id/memory/open` | `{ target: "obsidian" \| "folder" }` — opens the folder on this computer; loopback only. |
| `GET` | `/api/bots/:id/memory/upkeep` | Whether upkeep is on, whether the engine can run the model steps, and the last tidy-up and capture. |
| `POST` | `/api/bots/:id/memory/tidy` | Runs the tidy-up now (`409` when upkeep is switched off) and returns its report. |
| `GET` | `/api/profile/learned` | Facts bots added to About me on their own, newest first. |
| `POST` | `/api/profile/learned/:id/remove` | Takes that line out of About me; the fact is never added again. |
| `GET` | `/api/profile/general` | `{ history, last }`: lines taken out of general memory, newest first, and the last consolidation's report. `404` on a Team Cloud. |
| `POST` | `/api/profile/general/consolidate` | Runs the consolidation now; `{ report, aboutMe, history }`. |
| `POST` | `/api/profile/general/history/:id/restore` | Puts that line back into About me; `{ aboutMe, history }`. |

All of them need the owner (admin) session, like the other bot-settings routes.

On a Team Cloud each person also reaches what a bot remembers about them, their own layer of its memory
(`workspaces/<bot>--member-<person>`, see [team-cloud.md](team-cloud.md)), from any session:
`GET /api/bots/:id/memory/mine` is its overview, and `GET`, `PUT` and `DELETE /api/bots/:id/memory/mine/file` read,
save and remove one of its files as above. Nobody reaches another person's layer. The bot panel's **What it
remembers** shows these notes on a team.
