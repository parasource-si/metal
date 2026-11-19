# what is true about Metal (checked 2026-11-12)

The only claims about Metal an seo page may make. Each line names its source: a site docs page (link it as /docs/...)
or a doc in the Metal repo (do not link those; they are internal). If a page needs a fact that is not here, it does not
make that claim. Never invent features, numbers, integrations, users, ratings or testimonials.

## what it is
- An app where you keep a small team of AI bots and text them like teammates. Each bot has a name, a job, its own chats, its own memory and the AI you picked for it. (/docs/getting-started, /docs/bots)
- Desktop app for macOS 12 or later, Windows 10 or 11 (64-bit, installer needs no admin rights) and Ubuntu 24.04 (beta, .deb or AppImage). (/docs/getting-started)
- Phone: you text your bots from an iPhone or Android phone. The store apps are on their way; until then pairing opens Metal in the phone's browser and you add it to the home screen (that version sends no notifications). (/docs/phone)
- Free for personal use on your own computer, with every feature. No account, no card. An account is only needed to buy a plan. (/docs/account-and-billing)
- Source-available under the PolyForm Noncommercial license: free for personal and other noncommercial use, and you may change it and pass it on for noncommercial purposes if the license and its required notice go with it; work use needs a work license. Not open source. (/docs/faq, /license)
- Independent; not owned by, paid for by or affiliated with any AI company whose models it runs. (/about)
- Began from OpenMausBot, an open project by Milind Soni and contributors; that original code stays under Apache 2.0. Metal itself is source-available, never call it open source or Apache licensed. (/about, /license)

## the ai
- Metal has no model of its own. Bots think with an AI you already use: Claude, ChatGPT, Gemini, Grok and others. You sign in the usual way from the first screen. (/docs/getting-started)
- It runs the AI vendors' own official command-line apps on the machine your bots live on (for example Claude Code, OpenAI's Codex CLI, GitHub Copilot CLI, OpenCode, Cline), and you sign in to them yourself. Sign-in happens in the app, never on a server. (repo: server/engine-install.ts, shared/device-sign-in.ts; /docs/your-own-server)
- No subscription? Add an API key (Anthropic, xAI, OpenRouter, Groq and anything that speaks the OpenAI API) under Settings, API keys. (/docs/getting-started)
- All local: run Ollama or LM Studio and choose Use a local model. (/docs/getting-started)
- Each bot has its own model; switch at any time, the bot keeps chats, files and memory. (/docs/bots)
- If your AI plan runs out, the bot says so; wait for the reset or switch it to another AI. (/docs/bots, /docs/troubleshooting)
- What you say to a bot goes straight from your machine to your AI provider, on your plan with them. It does not pass through Dusk. (/docs/getting-started, /docs/privacy-and-data)
- AI usage is never on the Dusk bill; the AI provider bills you. (/docs/account-and-billing)
- WORDING RULE (owner, 2026-11-12): plain wording like "use the AI subscription you already have" is fine. Never imply a vendor endorses, approves or partners with Metal, and never call any AI free or unlimited. Every statement about a vendor's terms is factual, dated and sourced to the vendor's own page; vendor terms decide what a sign-in may be used for, and pages say so plainly.

## bots and chats
- Make a bot with New bot: name, shape, colour, one job in plain words. Change any of it later. (/docs/bots)
- While it works: replies stream in and a line shows each tool it uses. You can send another message to steer it, stop it (Cmd . / Ctrl .), and answer its questions with Allow / Deny cards. (/docs/bots)
- A bot can keep several threads; memory and job are shared. (/docs/bots)
- Voice: listen to replies, talk instead of typing, or start a call (Space interrupts, Esc hangs up). Each bot can have its own voice; built-in Mac voices are free; ElevenLabs, Fish Audio and Grok voices use your own key. (/docs/bots)
- Cmd K / Ctrl K jumps to any bot or searches every chat. (/docs/bots)

## group chats
- Several bots in one thread; they hand work to each other by @mentioning. You step in when one needs a yes. (/docs/group-chats)
- Who answers: Everyone responds, Only when mentioned, or Leader (one lead bot hands out tasks). (/docs/group-chats)
- Group instructions every bot follows; pin one thing to the top; keep it small (three focused bots beat eight). (/docs/group-chats)
- Each bot keeps its own AI and its own permissions inside a group. (/docs/group-chats)
- Bots don't learn from group chats; what they remember comes from your own messages to them. (/docs/memory)

## routines
- A routine is a job a bot does without being asked again. You make one by saying it ("summarise my inbox every weekday at 8"). The bot replies with a card showing the schedule and next runs, with Edit, Pause and Undo. Automations in the sidebar lists every routine with a calendar and run history. (/docs/routines)
- A routine can start from an event in a connected app ("whenever i get an email from acme, draft a reply", "when a github issue opens, triage it"). Gmail is checked every 15 minutes; Slack, GitHub and most others arrive at once. (/docs/routines; repo docs/composio.md)
- App events kept per day: 500 on the desktop, 2,000 on a paid Cloud. (repo docs/composio.md)
- On your own computer nothing runs while it's asleep or the app is closed. A run missed by less than 12 hours runs once when you're back; older ones are skipped. Dusk Cloud runs them on time. (/docs/routines)
- A routine asks before risky steps like any chat; you get a notification naming the routine. (/docs/routines)
- Good routines: small and specific; say where the result goes; say when to stay quiet; watch the first few runs. (/docs/routines)
- Wrong time? Ask the bot what time zone the routine is in. (/docs/troubleshooting)

## connected apps
- Connect an app once in Connected apps, sign in on the app's own page (your password goes to them, never to a bot), choose which bots may use it. (/docs/files-and-apps)
- 60+ apps, including Gmail, Google Calendar, Drive, Docs, Sheets, Slack, Notion, GitHub, Linear, Figma, Stripe, Discord, HubSpot, Airtable, Asana, Trello, Dropbox, Outlook, Shopify, Sentry, Vercel, Supabase, PostHog, Zapier. (/docs/files-and-apps)
- Apps connect through Composio. Dusk Cloud plans include connected apps with no key; the desktop app uses Metal's managed connection service by default. You can use your own Composio project key instead. (repo docs/composio.md)
- Per bot, each app can be off, read only, or read and write; a bot can also be limited to an exact list of an app's actions. A bot allowed only to read cannot call actions that change things; this is enforced before the call reaches the app. (repo docs/composio.md, shared/connector-scopes.ts)
- Several accounts per app (for example work and personal Gmail), each with its own label; up to five usable accounts per app. (repo docs/composio.md)
- Metal stores no Gmail, GitHub, Slack or other provider tokens; Composio holds the connection; Disconnect revokes the grant upstream. (repo docs/composio.md)
- Reading and drafting happen freely. Sending (emails, messages, posts, payments) asks first, unless you set a daily amount a bot may send on its own. (/docs/files-and-apps, /docs/computer)
- Gmail filters, vacation responder, IMAP/POP, forwarding, send-as and delegates need extra Google permissions the standard connection doesn't ask for; the bot says so. With your own Composio project you can add them; on Dusk Cloud you ask support. (repo docs/composio.md)
- Some apps (for example Xero, Buffer) have no Composio-managed sign-in and need your own Composio project key and auth config. The per-app facts files in seo/facts/connectors say which (managed_sign_in). (repo docs/composio.md)
- Anything with an MCP server can be added under Plugins, MCP servers; only add servers you trust. (/docs/files-and-apps)
- A connected app sees what a bot does in it, through Dusk's relay and Composio. (/docs/privacy-and-data)
- Files: drop a file in the chat or use Attach files (documents, spreadsheets, pictures, screenshots). What bots make shows in the chat; on your computer it lives in the bot's own folder (or a project folder you give it); on Dusk Cloud a copy comes down to Documents/Dusk Bot. (/docs/files-and-apps)

## a bot's computer and safety
- A bot can have its own browser and desktop, separate from yours. On Dusk Cloud each bot gets a desktop (2 awake at once on Plus, 5 on Pro); on your own server a private desktop there; on a Mac or Windows you can also point a bot at your own screen, on purpose (Ubuntu too, in beta, on Xorg). (/docs/computer)
- Watch live with Screen; Take control to click and type yourself, then Hand control back. That's how a bot gets past sign-ins, captchas and two-step codes; it stays signed in and never sees the password. (/docs/computer)
- Approval levels per bot: Ask for approval (nothing risky alone), Auto-accept edits (changes files; other things ask), Approve for me (the AI's own review approves routine actions; the rest come to you), Full access (everything; real questions and missing sign-ins still come to you). (/docs/computer)
- Sending in your name is separate: Ask every time, or Allow a daily amount. (/docs/computer)
- Which app actions are sends (shared/outbound.ts): a send verb in the action's name (send, reply, forward, post, publish, invite, share, refund, charge, pay, transfer ...) or creating something people receive (a comment, message, email, invoice, payment). A draft is not a send unless its name also carries a send word: Outlook's Create draft reply counts as a send. The seo/facts/connectors files mark each action read, write or send by this rule. A send waits for Allow; or a bot may send a daily amount you set. Exception to say plainly where it matters: a bot on **Full access** with no sending rule of its own may send up to 25 a day without asking, so set **Sending on your behalf** to **Ask every time** for full-access bots. (repo shared/outbound.ts, docs/approval-levels.md)
- What approval levels cover: commands and file changes (and, on Approve for me, the AI's own review of routine actions). Sends through connected apps (emails, messages, posts, payments) follow the sending setting. Other changes inside a connected app (labels, moving a meeting, editing a page) are NOT documented as asking first: never claim they do. To keep them supervised, a page tells people to give the bot read-only access, or to write "ask me before you change anything" into the routine. (repo docs/approval-levels.md)
- Allow / Deny cards come to the app, your phone or a call. Cmd . stops a bot at any moment. You're responsible for what you approve. (/docs/computer)
- Tip: keep a new bot on Ask for approval for a few days, then loosen up. (/docs/tips)

## memory
- Bots remember what you tell them, and facts about you they notice in your own messages (shown in Settings, About me, under "added by your bots"). (/docs/memory)
- Anything that looks like a password or key is blanked out before a note is saved. (/docs/memory)
- Notes are markdown files in .duskbot/workspaces/<bot>/; edit them in the bot's Memory settings or any text editor. Old notes archive themselves; a note can carry an end date. (/docs/memory)
- About me in Settings: name, time zone, how you like to be written to; every bot gets it. (/docs/memory)
- Turn off Let this bot use memory to stop it; files stay on disk. (/docs/memory)

## where bots live, and what it costs
- COPY RULE (owner, 13 november 2026): describe plans by their machine (vCPU, RAM, disk), "always available" (sleeps when idle, wakes in seconds), priority wake, and the work or team license and its seats. Never a number of bots or bot computers, never "unlimited", never usage multipliers or caps, never "shared", never "24/7" or "always on". Never put a number on bots in page copy either ("start with one bot, add more when it earns its keep", "a few focused bots").
- Your computer: free; stops when it sleeps. Dusk Cloud: a computer Dusk hosts and looks after, always available (sleeps when idle, wakes in seconds), daily backups. Your own server: free plus the server; you look after it. You can keep several and switch from the menu at the top of the sidebar. (/docs/dusk-cloud)
- Free: $0, your bots on your own computer, personal use. Dusk Cloud Plus: $20 a month or $200 a year; 2 vCPU, 4 GB RAM, 20 GB disk; always available, wakes in seconds. Pro: $50 a month or $500 a year ($12 work license plus $38 Dusk Cloud Pro); 4 vCPU, 8 GB RAM, 60 GB disk; priority wake; a work license for one person. Team: $119 a month or $1,190 a year ($30 team license with 2 seats plus an $89 dedicated Dusk Cloud with 8 vCPU, 16 GB RAM, 160 GB disk); priority wake; each extra team member $20 a month, up to 50. The team license is self-serve from the billing page; the dedicated machine is set up by writing to hello@dusk.bot. A work license on its own is $12 a month. Yearly is two months free (12 months for the price of 10). (/docs/dusk-cloud, /docs/account-and-billing, /pricing)
- Dedicated Dusk Cloud pricing: $7 base (includes 40 GB disk) plus $4 per vCPU, $2 per GB RAM and $3 per extra 20 GB disk; sizes 2 vCPU/4 GB, 4 vCPU/8 GB or 8 vCPU/16 GB, disk 40 to 200 GB in 20 GB steps. (/pricing)
- Each Dusk Cloud has its own storage no one else can reach; Plus and Pro each run in a sandbox of their own, Team gets a dedicated machine. Your AI sign-in stays yours. Your phone works with your computer off when paired to the Cloud. (/docs/dusk-cloud)
- Setting up a Cloud: pick a plan, sign in under Settings, Dusk Cloud; ready in about a minute; a welcome moves your bots (chats, memory, routines). (/docs/dusk-cloud)
- Tip from the docs: a bot that works a lot uses your AI plan a lot; for heavy use a bigger AI plan or an API key works best. (/docs/dusk-cloud)
- Cloud files: share a folder (read-only copy, kept up to date while your computer is on); bots' work lands in Documents/Dusk Bot. (/docs/dusk-cloud)
- If you stop: bots on your computer carry on; a cloud computer is kept 30 days then deleted (email a week before). (/docs/dusk-cloud)
- Your own server: Ubuntu 22.04 or 24.04, 2 GB memory or more, root or sudo, a fresh server is best. No ports, no domain. Paste one line the app gives you; about ten minutes. App and server talk through a relay at link.dusk.bot, sealed with a key only they hold. (/docs/your-own-server)
- Payments by Dodo Payments (merchant of record); Dusk never sees your card. (/docs/account-and-billing)

## phone
- Pair once by scanning a code (or a six-digit code, a nearby list on Wi-Fi, or Tailscale). Secure pairing asks for an email sign-in; Wi-Fi or Tailscale pairing needs no account. (/docs/phone)
- Paired with your computer, the phone only works while that computer is on and running Metal (Settings, Remote access, Keep this computer awake helps). Paired with Dusk Cloud it works with your computer off. (/docs/phone)
- Notifications show the bot's name and "new message", never the text. (/docs/phone)

## privacy and data
- Bots, chats, files and memory live where your bots live: your disk (.duskbot in your home folder), your cloud computer, or your server. (/docs/privacy-and-data)
- API keys and sign-ins stay on the machine your bots run on. The account never sees messages, prompts, files or keys. (/docs/privacy-and-data, /docs/account-and-billing)
- Backups: Export full backup with a password of 12+ characters; Import replaces everything; routines arrive paused; sign-ins and keys aren't included. (/docs/privacy-and-data)
- Bots move between your computer, a cloud and a server with chats, memory and routines. (/docs/faq)

## things never to claim
- Ratings, reviews, user counts, customer logos, testimonials, "trusted by", awards.
- Measured time savings, benchmarks or success rates (none have been measured yet).
- That Metal is open source.
- That a store phone app is out (it is on its way).
- That any routine is importable as a file, or that Dusk has a template marketplace (routines are made by sending a message).
- Anything about a competitor without a dated source from seo/facts or omb-ref/seo-research/facts-*.json.
