# writing an seo page record

Every seo page is one JSON file in `seo/pages/<type>/<name>.json`. The templates (`seo/templates.mjs`) do the layout;
the record carries what is this page's own. Read one finished exemplar of the same type before writing:

| type | exemplar | what the page is built around |
| --- | --- | --- |
| pillar | `pages/pillar/agents-when-laptop-closed.json` | sections, optional comparison `table` |
| guide | `pages/guide/is-it-safe-to-let-ai-control-your-computer.json` | sections, optional `table`, optional `steps` |
| alternative, comparison | `pages/alternative/openclaw.json` | `verdict`, `compare` table with sources per row, `method` |
| integration | `pages/integration/gmail.json` | `app` (Composio toolkit + highlighted actions), `routines`, `asks`, `cannot` |
| use-case | `pages/use-case/email-triage.json` | `routine` (message, when, needs, sample output), `safeguards` |
| role | `pages/role/founders.json` | `day` table, `pack` of routines |
| routine | `pages/routine/weekly-calendar-preview.json` | `routine`, `knobs`, `fails` |
| glossary | `pages/glossary/always-on-ai-agent.json` | `definition`, `example` |
| tool | `pages/tool/always-on-cost.json` | `tool` (seo/tools/<name>.html + public/landing/tools/<name>.js), `method` |

## fields every record has

- `path`: the address, exactly as planned (seo/planned.json). `type`: the folder name.
- `title`: the browser tab and search result title, 30 to 65 characters, sentence case, unique. No " · Metal" needed.
- `nav`: the short name in sidebars and breadcrumbs, lowercase.
- `h1`: lowercase, like the site's headings, unique. Phrase it the way people search when that reads naturally.
- `description`: 70 to 160 characters, unique, sentence case. Says what the page gives the reader.
- `keyword` and `keywords`: from the plan; for the record only, never stuffed into copy.
- `answer`: the first paragraph, 40 to 80 words, answers the page's question directly and on its own. Lowercase like the site.
- `updated`: the day you checked the page against its sources (YYYY-MM-DD).
- `review`: `{ "status": "needs_review" }` when you draft it. Only the lead sets `approved`; only approved pages go out.
- `tags`, `connectors` (Composio toolkit slugs like `gmail`, `googlecalendar`), `related` (2 to 5 paths from seo/planned.json): these pick the related pages and the sidebar.
- `art`: `{ "props": [one or two kit objects], "bubble": "a short line, 2 to 5 words" }`, plus `"logo": "<file in public/landing/art/logos without extension>"` for an app that has one there, or `"label": "Name"` for a neutral name tile (competitors: always a label, never a drawn mark). Kit objects: s-books s-button s-clock s-cloud s-coins s-computer s-key s-mailbox s-map s-mobile s-notebook s-palette s-parcel s-phone s-plug s-server s-signpost p-bag p-binoculars p-briefcase p-bubbles p-cap p-chart p-folder p-house p-laptop p-magnifier p-megaphone p-mug p-newspaper p-receipt p-shield.
- `og_line`: under 50 characters, lowercase, ends with a full stop; shown on the share card under the h1.
- `sections`: `[{ "h": "lowercase heading", "md": "markdown" }]`. Markdown: paragraphs, `- lists`, `1. lists`, `**bold**`, `` `code` ``, `[words](/address)`, `| tables |`, `> note:` callouts, and `[^3]` to cite source 3.
- `faq`: 2 to 4 `{ "q", "a" }` taken from how people actually ask (the plan's keywords, the Reddit phrasing in omb-ref/seo-research/03-keywords-competitors.md section 3). Plain content; there is no FAQ markup.
- `sources`: `[{ "label", "url", "checked" }]`. Metal docs as `/docs/...` with no date. Every outside source needs `checked`. Integration pages get their Composio source added by the build; do not add it yourself.

## voice (owner, 12 november 2026: "be more human and genuine, hit hard")

Write like a sharp friend who has done this, not a manual. Every record gets `"voice": 2` once it's written this way;
the build then holds it to the lint below.

- **Point first, proof second.** Each section opens with the takeaway in one bold line, then 2 to 4 short lines that
  back it up. Lead with the stakes: what it costs you, what you get back, what goes wrong if you skip it.
- **Short and active.** Sentences average under 17 words. Paragraphs stay under 60 words. "The bot files it", not
  "it is filed by the bot". "You", not "the user".
- **Real pain, real trade-offs.** The laptop that dies at 2am. The morning brief that never came. The weekend lost to
  VPS updates. Say when Metal is the wrong pick, and say it plainly.
- **Opinions where they're honest.** "Most people overpay here." "Start with one bot, not five." "Don't hand it your
  bank yet." A little wit is fine; jokes that cost clarity are not.
- **Make it scannable.** Bullets for lists. A tiny table for comparisons. Any maths goes in a `text` code block, one
  step per line, never inside a sentence. Don't list every assumption in prose: put them in a short list.
- **No throat-clearing.** Banned (the build refuses them): it's worth noting, it's important to, please note, in
  today's, whether you're, in conclusion, furthermore, moreover, additionally, in order to, unlock, supercharge,
  seamless, game-changer, revolutionary, effortless, leverage, delve, robust, cutting-edge, empower, streamline,
  elevate, a wide range of, "this page", documented, establish, supplied. No hedging stacks ("may potentially").
- **No counts of bots, ever.** Not "2 awake on plus", not "start with three bots". Say "a good amount", "heavy workloads", "a few focused bots", "start with one".
- Lowercase body text and headings, like the rest of the site; titles and descriptions in sentence case. No em dash,
  ever. No hype. Every claim still comes from the facts files.

- **Hooks, not hedges.** Open with the moment it hurts (the client call you walk into blind, the flight email you trashed). Don't make every line a warning; one clear safety point per page beats ten "check it" reminders (the build flags more than six "check"s).
- **The Full access line is always this sentence:** "careful with **Full access**: a bot there with no sending rule can send up to 25 a day without asking. give it **Ask every time**."
- Example names should look like names people have (maya, theo, ines works once, not quessira or thessaline), and never repeat across pages.

## blocks that make a page useful

Use the ones that are true for the page; leave the rest out. Each is a record field the templates render with art.

- `quick`: `{ "steps": [3 or 4 short steps] }`, "try it in 2 minutes", rendered as illustrated cards.
- `worked`: `{ "intro"?, "before", "after", "before_label"?, "after_label"? }`, a before/after with clearly invented
  names and numbers (the page says so).
- `checklist`: `{ "h"?, "items": [...] }` or `decide`: `{ "h"?, "cols": [...], "rows": [[...]] }`, a quick decision aid.
- `saves`: `{ "estimate": "about 2 hours a week", "formula": "20 minutes a day\nx 5 workdays\n= 100 minutes a week", "assumptions": [...] }`.
  Only as a rough estimate from stated assumptions the reader can check; never a measured result.
- `mistakes`: `[{ "mistake", "fix" }]`, 2 to 4 real ones.
- `tip`: `{ "text", "careful"? }`, one line a pixel bot says beside the page.

## facts

- About Metal, use only `seo/facts/dusk.md`. If a claim is not there, leave it out.
- About an app's actions, use only `seo/facts/connectors/<toolkit>.json` (highlight action slugs that exist there).
- About competitors, use only `seo/facts/competitors.json`, citing the `source_url` of each fact you use with its `checked` date. Skip facts marked low confidence or unknown. Say "as of 12 november 2026" where a price or status could change.
- About AI vendors' own features and terms, use only `seo/facts/vendors.json` the same way.
- Never invent: features, numbers, users, ratings, testimonials, measured results, quotes, dates. Example outputs are allowed only where the template labels them as examples, and must use made-up names (sam, priya, acme).

## claims the build refuses

Never imply that an AI vendor endorses, approves or partners with Metal, and never call any AI free or unlimited (the
list is `SUBSCRIPTION` in `seo/quality.mjs`). Plain wording about using the AI subscription you already have is fine
(owner, 2026-11-12). Pages about vendor terms state what the vendor's own page says, dated and linked, and tell people to
check their provider's current terms.

## check

```sh
node seo/check.mjs seo/pages/<type>/<name>.json
```

It must print `all checks pass`. It checks lengths, required fields, words of the page's own (shared template text does not count), placeholder text, em dashes, the words above, links, dated sources and how close the page is to every other page (over 50% alike fails, over 30% warns: rewrite until there is no warning for your page).
