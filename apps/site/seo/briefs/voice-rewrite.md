You are rewriting existing SEO page records for dusk.bot in a new voice and adding useful blocks. An editor wrote the exemplars by hand and will reject anything that reads like a manual or like AI filler.

READ FIRST, fully: seo/WRITING.md (especially "voice" and "blocks that make a page useful"); seo/facts/dusk.md (the ONLY Metal claims allowed); and the hand-written exemplar for each page's type:
- pillar: seo/pages/pillar/agents-when-laptop-closed.json
- guide: seo/pages/guide/is-it-safe-to-let-ai-control-your-computer.json
- alternative, comparison: seo/pages/alternative/openclaw.json
- integration: seo/pages/integration/gmail.json
- action: seo/pages/action/gmail-create-email-draft.json
- use-case: seo/pages/use-case/email-triage.json
- role: seo/pages/role/founders.json
- routine: seo/pages/routine/weekly-calendar-preview.json
- glossary: seo/pages/glossary/always-on-ai-agent.json
- tool: seo/pages/tool/always-on-cost.json
Compare an exemplar's old version (git show HEAD:sites/dusk/<path>) with its current file to see exactly what "rewritten" means.

FOR EACH FILE IN YOUR LIST:
1. Rewrite every prose field (answer, what, intro, sections md, uses, steps, watch, cannot, asks, method, verdict items, safeguards, knobs, fails, faq answers, day/pack text, routine intros) in the new voice: point first in bold, then 2 to 4 short lines; short active sentences (average under 17 words); paragraphs under 60 words; bullets for lists; any maths in a ```text block; real pains and honest trade-offs; plain words a non-technical person gets; lowercase body. Keep title/description sentence case, 30-65 and 70-160 chars.
2. Keep every fact true and keep the facts you already had (numbers, dates, prices, source markers [^n], table rows and their "src"). Do not add claims that are not in seo/facts/*. Do not remove sources.
3. Add the value blocks that are TRUE for this page (see WRITING.md): "quick" (try it in 2 minutes, 3-4 steps), "mistakes" (2-3 real ones with fixes), "tip" (one line), and where they fit: "worked" (before/after with made-up names, never reused: avoid sam priya jo acme dana maya lee and any name already on another page), "checklist" or "decide", "saves" (only a rough estimate from stated, checkable assumptions; never claim it was measured). Comparison and guide pages usually want "decide" or "checklist", not "saves".
4. Routines must take their input from connected apps, files, folders or the bot's memory notes. NEVER "notes i marked in this chat", "what i logged in this chat", "items i approved in this chat since the last run" or similar: reading earlier chat messages is not a documented feature. Rewrite such routines to read from an app (email, calendar, a folder, a tracker) instead. Never make a routine that repeats the same one-off job every week.
5. Add "voice": 2 to the record. Do not change "path", "type", "review", "action", "app", "art.logo", "connectors" or "sources" URLs.
6. Banned words and phrases (the build fails on them): it's worth noting, it's important to, please note, in today's, whether you're, in conclusion, furthermore, moreover, additionally, in order to, unlock, supercharge, seamless, game-changer, revolutionary, effortless, leverage, delve, robust, cutting-edge, empower, streamline, elevate, a wide range of, this page, documented, establish, supplied. Also avoid: id, uuid, token, cursor, payload, metadata, endpoint, pagination (the reader names things; the bot finds the ids). Never use an em dash.

VERIFY: after each file run `node seo/check.mjs <file>` and fix until "all checks pass" (the voice lint is strict on "voice": 2 pages: average sentence length, paragraph length, passive share, banned words). At the end run it on all your files; no warning may name them. Final message: one line per file, and anything you could not do.
