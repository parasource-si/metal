You are drafting per-action SEO page records for dusk.bot (Metal: an app where people keep a small team of AI bots and text them like teammates; bots work inside connected apps through Composio). A lead editor wrote the exemplar and will review and reject weak pages. Accuracy and usefulness beat length.

READ FIRST, fully: seo/WRITING.md; seo/facts/dusk.md (the ONLY Metal claims allowed); the exemplar seo/pages/action/gmail-create-email-draft.json (copy its shape and voice exactly); the app's own integration page in seo/pages/integration/<app>.json (do not repeat its routines or wording); and for EACH action, its record in seo/facts/connectors/<toolkit>.json (find the tool by "slug": read "description", "inputs", "scopes", "tags" and "kind").

FILES: for each candidate below create seo/pages/action/<appfolder>-<action-path-tail>.json, e.g. path /integrations/slack/send-message -> seo/pages/action/slack-send-message.json. "type": "action", "action": {"toolkit": ..., "slug": ...}, "path" exactly as given, "connectors": [toolkit], "art": {"logo" or "label" as the app's integration record uses, "props": one or two kit objects (see WRITING.md list) that fit THIS action, "bubble": 2 to 5 words specific to this action}, "review": {"status": "needs_review"}, "updated": "2026-11-12", "related": 2 to 4 paths (the app page, a related use case or another action of the same app from seo/action-candidates.json). Do not add the composio source yourself (the build adds it); add the dusk docs pages you rely on as sources.

WHAT EACH PAGE MUST HAVE (all specific to this one action; nothing that could be pasted onto a sibling):
- title (30 to 65 chars, sentence case, the way a person searches: "Search Gmail with AI: find any email by asking", not the composio name), nav (the action in lowercase plain words), h1 (lowercase, unique), description (70 to 160), keyword + 3 to 4 keywords (realistic searches: "<app> <task> with ai", "chatgpt <app> <task>", "claude <app> <task>").
- answer: 40 to 80 words, says plainly what a bot does with this action and the one thing to know (approval, limit or risk).
- what: 1 to 2 short paragraphs in your own words (do NOT copy composio's description; paraphrase what it means for a person, including any real limit the description mentions).
- uses: 3 to 5 concrete situations, each a real job a person would hand over.
- routine: {message (a real paste-ready message, 2 to 6 sentences, specific schedule or trigger, where the result goes, what never to do), when, needs (connection + access level: read only, read and write), output (an example result with made-up names, labelled as an example by the template)}.
- steps: 3 to 5 steps to start, using real setting names in **bold** from dusk.md (Connected apps, read only vs read and write, Ask every time, Pause ...).
- watch: 2 to 4 honest limits or failure modes from the action's inputs/description and from dusk.md.
- optional "rules": 1 short paragraph only if there is something specific to add beyond what the template prints (the template already prints how dusk treats the action and the permissions it asks for).
- faq: 2 to 3 questions people would actually ask about this task, answered in 1 to 3 sentences.

TRUTH RULES:
- Dusk treats the action as the facts file's "kind": read (looks only), write (a change; the sending setting does NOT cover it and it does not ask first unless the routine says so), send (asks first by default; unless a daily amount is set; a bot on Full access with no sending rule may send up to 25 a day without asking: say this on every send page). Never claim a write asks first. A read-only bot can't call write or send actions.
- Only describe what the action and its inputs really do. If an input is required (e.g. an id), say how the bot gets it (often from another action, which you may name if it exists in the facts file).
- Events: gmail is checked about every 15 minutes; slack, github and most others arrive at once; on your own computer nothing runs while it sleeps (missed < 12h runs once); dusk cloud runs on time. Use only these.
- No invented numbers, features, results, users or quotes. No em dashes. No placeholder text. Lowercase body voice; short warm plain sentences for non-technical people. Never write about how the page was made (no "catalog", "facts", "supplied", "this page", "documented").

VARIATION (mandatory; the build fails pages more than 40% alike and the editor rejects pages over 25%):
- Vary sentence openings, the shape of uses (some as tasks, some as situations), routine schedules (different days/times/triggers), example names and companies (never reuse sam/priya/jo/acme/dana; invent fresh ones per page), and faq questions. Never reuse a sentence across your pages.

VERIFY: run `node seo/check.mjs <file>` after each file until "all checks pass"; at the end run it on all your files and make sure no warning names your pages. Final message: one line per file and anything you could not do.

YOUR CANDIDATES (path, toolkit, slug, composio name, kind):

UPDATE (owner, 12 november 2026): write in the voice of seo/WRITING.md "voice" (point first in bold, short active sentences, real pains, no filler; the build lint fails pages that miss it), set "voice": 2, add the useful blocks from WRITING.md where true (quick, worked, mistakes, tip, saves only from checkable assumptions), and never build a routine on "notes i marked in this chat": routines read from connected apps, files, folders or memory notes. The rewritten exemplar seo/pages/action/gmail-create-email-draft.json is the bar.
