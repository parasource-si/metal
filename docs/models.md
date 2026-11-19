# Models and providers

Metal can run a bot on almost any model from almost any provider. This page
covers what is supported, how the model list stays current, where a connection
is saved, and what a new person gets before they connect anything.

## In short

- **Settings > Models > All models** searches every provider and every model in
  one box. Results are grouped by provider and show small badges for context
  size, price per million tokens, tools, vision and reasoning.
- **The bot's model picker** searches the AIs you have connected. With a short
  list the search is hidden; **Search all models** turns it on. Once you type,
  it also shows matches from providers you have not connected yet. Picking one
  of those opens the connect sheet.
- **Connecting a provider** takes a short sheet. Providers that offer a sign-in
  (Claude, ChatGPT, Gemini, Grok) have a sign-in button. Every other provider
  takes its key, plus a field or two where it needs them (an Azure resource
  name, a Bedrock region, a Vertex project and location). **Check** lists the
  provider's models with that key before you save it.
- **The connection is saved where the bots run**: on this computer, on your
  Dusk Cloud, or on your own server. See [Where a connection lives](#where-a-connection-lives).

## Providers

| Group | Providers | How they connect |
|---|---|---|
| Popular | Anthropic, OpenAI, Google Gemini, xAI Grok | Sign in with your subscription (Claude, ChatGPT, Google, Grok), or paste an API key |
| Open models | Mistral, DeepSeek, Qwen, Moonshot Kimi, Zhipu GLM | API key |
| Fast inference | Groq, Cerebras, Together AI, Fireworks AI | API key |
| Routers and search | OpenRouter, Perplexity, Cohere | API key |
| Cloud platforms | Azure OpenAI, AWS Bedrock, Google Vertex AI | Key plus resource name, region, or project and location |
| On your machine | Ollama, LM Studio, llama.cpp, vLLM, CLIProxyAPI | Address, which is filled in for you; CLIProxyAPI also takes its key |
| Your own endpoint | Any OpenAI-compatible server, any Anthropic-compatible server | Base URL, key and an optional model id |
| More providers | About 200 more from models.dev that have an OpenAI-compatible address (Venice, DeepInfra, Nebius, SiliconFlow and others) | API key |

How each kind runs:

- **A key provider** becomes an OpenAI-compatible connection to that
  provider's own address, for example `https://api.groq.com/openai/v1`. Bots
  use it like any other AI, with tools.
- **An Anthropic key, or an Anthropic-compatible endpoint**, runs through
  Claude Code with that key and address (`ANTHROPIC_BASE_URL`). Claude Code
  has to be installed where the bots run.
- **Sign-ins** (Claude, ChatGPT, Gemini, Grok) work the same as before. The
  sign-in button opens the existing sign-in in Settings, and a signed-in
  engine counts as that provider connected.
- **Azure OpenAI** uses `https://<resource>.openai.azure.com/openai/v1`. Its
  model ids are your deployment names.
- **AWS Bedrock** uses a Bedrock API key on
  `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`.
- **Vertex AI** takes an access token from `gcloud auth print-access-token`,
  which lasts an hour. For anything long-running, a Gemini key from Google AI
  Studio is the better choice.
- **Perplexity, Cohere and Bedrock** do not list their models with the same
  call the others use, so their model list comes from the catalog.

### CLIProxyAPI and other gateways

**CLIProxyAPI** is a preset for a local gateway that serves your subscriptions
as an API. Its address is `http://127.0.0.1:8317/v1`, which you can change;
paste the gateway's key. The same server can also be added as an
**Anthropic-compatible** endpoint (`http://127.0.0.1:8317`), which runs it
through Claude Code.

Any other OpenAI-compatible server (LiteLLM, a company proxy, a self-hosted
vLLM) goes under **OpenAI-compatible**, with its base URL, key, and a model id
if it needs one.

## How each AI gets installed and signed in

Pressing an AI's card under **Connect an AI** runs one connect, in stages, on
the machine the bots run on (this computer, your Dusk Cloud or your own
server). Each stage has a deadline; one that runs past it ends with a plain
message and **Try again**, never a spinner left alone. Only one connect runs at
a time: pressing another card cancels the one under way.

1. **Waking your cloud.** A Dusk Cloud that went to sleep is woken first.
2. **Getting the AI ready.** The app reads the AI's status again. A sign-in that
   already works is used as it is, without asking. If the AI's official helper
   (its own command-line program) is missing, it is downloaded now, from the
   provider's own source.
3. **Opening the sign-in.** Your browser opens the provider's own page. If it
   can't, the link is shown with **Copy link**.
4. **Waiting for you to sign in.** Where the provider uses a code, the card
   shows it with **Copy code** and **Open GitHub** (or ChatGPT, Grok…). It
   connects by itself when you finish.
5. **Connected.** The card turns green.

Your password is only ever typed on the provider's own page. Metal never
sees it; it keeps the sign-in token the provider's helper saves, where the bots
run.

| AI | What is downloaded, and from where | Where it is kept | How you sign in |
|---|---|---|---|
| ChatGPT | Codex CLI, the npm package `@openai/codex` (from OpenAI, via the npm registry). Not downloaded when a copy is already there: one on your PATH, or the one inside ChatGPT.app (`/Applications/ChatGPT.app/Contents/Resources/codex-cli`) | Metal's `tools/npm` folder | On this computer: ChatGPT's own sign-in page, which comes back to the app by itself (the token is kept in Metal's own folder, `providers/chatgpt-plan`, apart from any other Codex login). On a server or Dusk Cloud: a code to enter at `auth.openai.com/codex/device`; the token is kept in Codex's own `~/.codex` on that machine. A Codex login that already works there is reused |
| Claude | Claude Code, the npm package `@anthropic-ai/claude-code` (from Anthropic) | Metal's `tools/npm` folder | Claude's page opens; it shows a code, which you paste back into the card. Claude Code keeps the token |
| Gemini | Google Antigravity's official ACP server, a zip from `dl.google.com` (checked against its pinned hash) | Metal's `tools/antigravity-acp` folder | Google's own page opens and returns to the app by itself. The token is kept in a Google profile of its own, apart from your browser's |
| Grok | Grok Build, xAI's own installer (`x.ai/cli`) | `~/.grok` | A code to enter on xAI's page. Grok keeps the token in `~/.grok` |
| GitHub Copilot | Copilot CLI, the npm package `@github/copilot` (from GitHub) | Metal's `tools/npm` folder | A code to enter at `github.com/login/device`. Copilot keeps the token in the system's credential store (or `~/.copilot`) |
| Cursor | Cursor's CLI, Cursor's own installer (`cursor.com/install`) | `~/.local/bin` | A one-time link to Cursor's page; approve there. Cursor keeps the token |
| OpenRouter | Nothing | The key, in Metal's settings where the bots run | Paste an API key |
| Local model | Nothing | The address, in Metal's settings | Ollama, LM Studio and others are found on this computer |
| Free backup (OpenCode) | OpenCode's pinned build, downloaded in the background right after setup | Metal's `tools/standalone` folder | No sign-in |

Grok's and Cursor's helpers come from their vendors' shell installers, which
the app does not run for you yet; where one is missing, the card says how to
install it.

Each stage writes a trail event (`connect.stage`, `connect.open`,
`connect.timeout`, `connect.fail`, `connect.cancel`, `connect.done`), so
`node scripts/trail.mjs` shows where a connect stopped.

In the first run, an AI already signed in on this machine is sent one tiny test
message. If it answers, the AI step says "Using your Claude account" and goes
on without asking; a login that only exists as a file but no longer works shows
the cards instead.

## The model catalog

The model list, with each model's context window, price, tool support and
vision, comes from [models.dev](https://models.dev). That catalog is MIT
licensed and is the same one OpenCode uses.

- **It updates itself.** The server downloads models.dev at most once a day,
  when Settings > Models or the search is opened. It asks with the last ETag,
  so an unchanged catalog costs almost nothing. The copy is kept in
  `<data dir>/providers/model-providers/models-dev.json`. Setting
  `DUSK_DISABLE_MODEL_CATALOG_FETCH=1` turns the download off.
- **A snapshot ships with the app** (`server/model-catalog/models-dev.snapshot.json`,
  231 providers and 7,054 models as of 2026-11-14), so search works offline
  and on first start. The newest of the cache, OpenCode's own models.dev cache
  and the snapshot is used. To refresh the snapshot, run
  `node scripts/build-model-catalog.mjs --commit <models.dev sha> --updated-at <commit time>`.
- **Only models a bot can use are listed**: current, tool-calling and
  text-input. Embedding, speech and image-only models are left out.
- **Connected providers list their own models.** Once a key is saved, the
  connection reads the provider's live model list (`GET /models`, or
  `GET /v1/models` for Anthropic-style servers). The search shows those models
  first, with the catalog's badges added where the ids match.

## Engine model lists (Codex, Claude Code, Grok)

The picker for an engine is the engine's own list where it has one, with our
names and order on top, so a new model shows up without an app release.

- **Live first.** Codex's list is what the installed Codex CLI answers to
  `model/list` (ChatGPT's own catalog for the signed-in account). The Grok API
  engine reads xAI's `GET /models` with the saved key. Connected API-key
  providers read their own `GET /models`. Claude Code has no list command, so
  its list is ours.
- **Read again every few hours.** Each list is saved per engine; a list older
  than 6 hours is read again at start and, on a server that keeps running
  (Dusk Cloud), every 3 hours.
- **Our catalog on top.** `server/model-catalog/dusk-models.json` names each
  engine's models, and a model marked `"add": true` is offered even when the
  engine's own list leaves it out (an engine CLI older than the model). A model
  the engine lists that we have not named gets a clean name from its id
  (`gpt-6.2-astra` → "GPT-6.2 Astra"). A ChatGPT plan sign-in and company
  models keep exactly their own list.
- **Updated from dusk.bot without a release.** The server fetches
  `https://dusk.bot/releases/models.json` at start and every 3 hours, keeps it
  in `<data dir>/providers/model-providers/dusk-models.json`, and uses the
  newer (by `updatedAt`) of that and the copy built into the app. To add a
  model the same day: edit `server/model-catalog/dusk-models.json`, copy it to
  `apps/site/public/landing/releases/models.json` (a test keeps them equal),
  raise `updatedAt`, and deploy the site (`apps/site/deploy.sh landing`).
  `DUSK_MODEL_CATALOG_URL` points at another https address;
  `DUSK_DISABLE_MODEL_CATALOG_FETCH=1` turns the download off.

## Where a connection lives

Each window of the app talks to one server: this computer, your Dusk Cloud, or
your own server. A connection is saved on the server the window is connected
to, because that is the machine its bots run on. The connect sheet says which
one:

- **This computer**: "Connections you add here are saved on this computer."
  The key is kept in this computer's Metal settings.
- **Dusk Cloud**: the key is sealed for your cloud's server before it leaves
  the app (the same sealing the app uses for every other API key), and only
  that server can open it. It is stored there. It is never written to logs or
  sent back to the app; the app only learns that the provider is connected.
- **Your own server**: the same as Dusk Cloud, saved on that server.

Local models follow the same rule:

- **On this computer**, Ollama, LM Studio, llama.cpp, vLLM and CLIProxyAPI are
  always offered. One that is not running at the moment is marked
  **Not running**.
- **On your own server**, a local model is offered only if that server is
  running it. The server checks its own `127.0.0.1` ports: 11434 for Ollama,
  1234 for LM Studio, 8080 for llama.cpp, 8000 for vLLM and 8317 for
  CLIProxyAPI.
- **On Dusk Cloud**, local models are never offered, because a cloud cannot
  reach the models on your own computer. The cloud also refuses any custom
  address on its own network (loopback or private ranges). No server accepts
  a link-local address, which is where cloud metadata services live.

A key is only sent to the address of its own connection, and the server
follows no redirects when it checks a key.

## What a brand-new person gets

**With nothing connected, a new bot runs on OpenCode's free models.** OpenCode
is one of Metal's engines, and OpenCode Zen offers a few models for free
with no login. Metal calls this the **free backup**. Someone can start
chatting without connecting anything, as long as OpenCode is installed where
the bots run.

How the free backup works:

- **It is in the picker, by name.** Under **OpenCode**, **Free model** comes
  first: it runs whichever free model OpenCode picks now, and it is the default
  for a person with nothing connected. Below it, the models the CLI lists as
  free (`-free` ids), by name. Pick one and the bot stays on it; a pick the CLI
  stops listing falls back to the free model it lists now. OpenCode's paid
  models are never listed: without a login or credits they answer HTTP 402.
- **It is a backup chain.** A message goes to a free model. If that model sends
  nothing within 25 seconds, or answers with nothing, the same message goes to
  the next free model, with one line in the chat saying so. OpenCode's own
  free models are tried first. A message tries at most 3 free models.
- **It is rate-limited per IP right now.** OpenCode's free tier limits how much
  each IP address can use. When the limit is reached, Metal does not try
  more free models. The chat says the free backup has used up its free replies
  for now, and suggests connecting an AI or trying again later.
- **It always comes last.** A connected AI outranks it as soon as it is ready.
  New bots start on the connected AI. Bots and conversations that were on the
  free backup move over the next time the engines are read, unless they are in
  the middle of a reply.

### Which AI a new bot uses

If a default model is saved (in Settings, `metal setup` or the new-bot
defaults), it always wins. Without one, a new bot gets the first AI that is
ready, in this order:

1. A Claude account
2. A ChatGPT plan
3. Gemini
4. Grok
5. Every other connected AI (API keys, OpenRouter, the providers on this page,
   local models), in the order the app lists them
6. The free backup (OpenCode's free models)

An AI that answered its background test message ("Reply with the single word
OK") is preferred over one that did not answer or was not tested.

### When the AI stops answering

- **Usage limit, sign-out or provider failure.** When an AI reaches its usage
  limit, is signed out, or its provider fails a turn before doing anything, the
  bot carries on with another AI. That is the bot's own backup, or the
  app-wide one when Automatic recovery is on, and then the AI a new bot would
  get. The person hears about it once. The limited AI is used again when its
  limit resets. The details are in
  [self-hosting: when an engine runs out](self-hosting.md#when-an-engine-runs-out).
- **The free backup gives no reply.** After the chain above, the chat shows a
  plain line, either "No free backup model answered just now…" or "The free
  backup model has used up its free replies for now…". With no AI of their own
  connected, the person sees a **Connect your AI to start** card with one
  button to the connect flow.
- **Nothing is connected and the free backup is not installed.** A new bot has
  no AI to run on. The app takes the person to setup instead of picking an AI
  for them.

## For developers

- Provider table: `shared/model-providers.ts`. It holds every provider's base
  URL, extra fields, sign-in engines, local port, and the place rules
  (`providerOffer`, `placeFromEnv`).
- Search and badges: `shared/model-search.ts`.
- Server: `server/model-providers.ts` (catalog groups, live model listing,
  local probes, address rules, connection building) and
  `server/routes/model-providers.ts`, which serves:
  - `GET /api/model-providers`: providers, where the bots run, what is connected
  - `GET /api/model-providers/search?q=`: grouped search over connected models
    and the catalog
  - `POST /api/model-providers/models`: live model list for a key (sealed)
  - `POST /api/model-providers/connect`: saves the connection on this server
    (sealed)

  All four routes are admin only.
- UI: `src/components/models/` (`ModelDirectory`, `ConnectProviderDialog`,
  `ModelBadges`), wired into Settings > Models. The bot's model picker lists
  the connected models; a Not connected row hands its connect to the Connect
  an AI dialog on that provider (`ConnectAiDialog` with `start`), and links to
  the directory for the rest.
- Tests: `shared/model-providers.test.ts`, `shared/model-search.test.ts`,
  `server/model-providers.test.ts`, `server/routes/model-providers.test.ts`,
  and `src/components/models/ModelDirectory.dom.test.ts`. The live check against a real
  gateway, which sends one short message, is
  `DUSK_LIVE_GATEWAY_URL=http://127.0.0.1:8317/v1 DUSK_LIVE_GATEWAY_KEY=… pnpm exec vitest run server/model-providers.live.test.ts`.
