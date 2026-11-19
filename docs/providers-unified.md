# Unified provider handling

Status: proposal, 2026-11-14. Research only, nothing here is built yet.

## Recommendation

1. Make Metal's own tool loop (the `openai-chat` / `openai-responses` runtime that already serves key providers) the one engine for every provider that allows it, and give it a built-in coding toolset so it no longer needs a CLI for file edits and shell.
2. Give every provider the same "Connect" button: it opens the provider's own login page in the browser (OAuth with PKCE on a loopback port, or a device code on remote servers), or asks for an API key when the provider has no allowed login.
3. Sign in directly, with no CLI, only where the provider allows third-party apps to use the plan: ChatGPT (OpenAI's "Sign in with ChatGPT" plan usage, which Metal already implements) and GitHub Copilot (our own GitHub OAuth app plus the Copilot SDK). Every API key provider also goes direct.
4. Keep a CLI only where the terms or the product require it: Claude subscriptions (unmodified Claude Code, its own login), Cursor, and for now Grok subscriptions. Ship those CLIs with the app or install them silently, so the person still only sees a login redirect.
5. Stop offering the Antigravity consumer login and Gemini consumer logins inside Metal: Google's terms say third-party access to them is a violation and Google suspends accounts for it. Offer a Gemini API key (AI Studio) instead.

## What "the same thing for all providers" can and cannot mean

The owner's goal is one flow: pick a provider, the browser opens, sign in, done, no download. That flow is achievable for the person's experience. It is not achievable as "Metal holds every provider's subscription token and calls their API itself", because Anthropic and Google forbid that for consumer plans, and xAI has not granted it. Two tools that do exactly that (Hermes Agent and CLIProxyAPI) are described below, including the workarounds they need to avoid being detected as third-party apps. Copying those workarounds would put users' accounts at risk.

So the proposal is: one login experience and one engine, with a small number of provider CLIs kept underneath where the provider insists, hidden behind the same button.

## How Hermes Agent does it

Source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), commit `ae3707b` (2026-11-14), plus [hermes-labs-plugins](https://github.com/NousResearch/hermes-labs-plugins) for Copilot.

**One agent loop, a few wire formats.** Hermes has one agent loop and picks a transport per provider: `chat_completions` for most, `anthropic_messages` for Anthropic, `codex_responses` for ChatGPT/Codex and xAI, plus Bedrock and a Gemini native client (`agent/transports/`, `plugins/model-providers/*`). Providers are small profile plugins (base URL, env vars, `api_mode`). It does not drive per-provider CLIs for the main providers. It still uses CLIs over ACP for a few (Copilot ACP, and catalog plugins for Cursor, Grok and Kiro, see `agent/copilot_acp_client.py`).

**Subscription logins, provider by provider:**

| Provider | How Hermes signs in | Notes from the code and docs |
|---|---|---|
| ChatGPT / Codex | Device code by default; opt-in PKCE on `localhost:1455/auth/callback` (`hermes_cli/auth_codex.py`, `auth_codex_browser.py`) | Uses the Codex CLI's public client ID. Calls `https://chatgpt.com/backend-api/codex`. Can import `~/.codex/auth.json`. |
| Claude | PKCE with Claude Code's client ID and Anthropic's hosted redirect, or borrows Claude Code's token from `~/.claude/.credentials.json` / macOS Keychain (`agent/anthropic_credentials.py`) | Sends `user-agent: claude-code/<version>`, `x-app: cli`, a "You are Claude Code" system prefix, and renames tools (`memory` to `context_notes`, `mcp__` prefixes) because Anthropic's billing classifier otherwise answers "Third-party apps now draw from extra usage" (`agent/anthropic_adapter.py` lines 318 to 330, 548 to 551). Hermes' own docs say this path only works on Max with purchased extra usage, and never draws on the base plan. |
| Gemini (Google) | No consumer login. API key (AI Studio) or Vertex service account / ADC | Docs: "There is currently no way to sign in to Hermes with a consumer Gemini subscription." |
| xAI / Grok | Device code against `auth.x.ai` with the Grok CLI's client ID and scope `grok-cli:access api:access` (`hermes_cli/auth_xai.py`) | Docs warn xAI returns HTTP 403 for some SuperGrok tiers after a successful login. |
| GitHub Copilot | Moved out of core into an unsupported labs plugin. Device code with VS Code's Copilot client ID, then `api.github.com/copilot_internal/v2/token`, then `api.githubcopilot.com` with `Copilot-Integration-Id: vscode-chat` | Presents itself as VS Code. A second provider drives the Copilot CLI over ACP. |
| Qwen, MiniMax, OpenRouter, Nous Portal | Browser PKCE or device code with each vendor's own client | These vendors offer the login to third parties. |

**Storage and refresh.** Tokens live in `~/.hermes/auth.json`, written atomically with mode 0600 under a cross-process `flock` (`hermes_cli/auth.py`). Access tokens are refreshed a fixed margin before expiry (120 s for Codex and Anthropic, one hour for xAI). Single-use refresh tokens are handled carefully: a refresh whose new token could not be saved is recorded so the spent token is never replayed, and a terminal `invalid_grant` quarantines the credential and asks for a new login. When it borrows Claude Code's login it also writes the refreshed token back into Claude Code's Keychain entry so the two do not diverge.

**Takeaway.** Hermes proves one loop over four wire formats covers every major provider. Its subscription logins for Claude, Codex, xAI and Copilot reuse the official CLIs' client IDs and imitate those clients, which is exactly what the providers' terms address.

## How CLIProxyAPI does it

Source: [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), commit `905e70c` (2026-11-14). The owner runs v7.3.15 from `~/Desktop/code/mchat` (`run.sh`, binary in `bin/`, credentials in `auth/`, which I did not open).

**Logins** (`internal/auth/*`, flags in `cmd/server/main.go`):

| Provider | Flow | Client and redirect |
|---|---|---|
| Claude | PKCE, loopback callback | Claude Code's client ID, `http://localhost:54545/callback`, authorize at `claude.ai/oauth/authorize`, token at `platform.claude.com/v1/oauth/token` |
| Codex | PKCE loopback, or device code (`--codex-device-login`) | Codex CLI client ID, `http://localhost:1455/auth/callback` |
| Antigravity (Google) | PKCE loopback on port 51121 | Antigravity's own Google client ID and embedded client secret, scopes include `cloud-platform` and `aicode`, calls `cloudcode-pa.googleapis.com` |
| xAI | Device code via OIDC discovery on `auth.x.ai` | Grok CLI client ID, scope `grok-cli:access api:access` |
| Kimi, Meta, Devin | Device code (Kimi, Meta) or PKCE (Devin) | Each vendor's CLI client |
| Gemini CLI, Qwen | Not present as login flags on current main | Google is reached through Antigravity, AI Studio, Vertex or API keys |
| Copilot | Not in core; only via third-party wrappers listed in the README | |

**Storage and refresh.** Each account is a JSON file in the auth directory (default `~/.cli-proxy-api`, `oauth.auth-dir`), watched for changes; a refresh registry renews Codex, Claude, Antigravity and Kimi tokens ahead of expiry with a refresh journal for single-use rotation (`sdk/auth/`).

**One endpoint.** It serves `/v1/chat/completions`, `/v1/responses`, `/v1/messages` and `/v1/models` (OpenAI and Anthropic shapes) plus `/v1beta` (Gemini shape) on one port, behind its own API key (`internal/api/server_routes.go`). Any request is translated to whichever upstream account serves that model, with multi-account rotation.

**Takeaway.** CLIProxyAPI is the reference for "one OpenAI-compatible endpoint over many subscriptions". It also mimics the official clients closely, including a uTLS transport that reproduces Claude Code's TLS and header order (`internal/auth/claude/utls_transport.go`), and it has a test fixture for Google's `TOS_VIOLATION` 403 (`internal/runtime/executor/antigravity_executor_tos_test.go`). That is evidence the providers detect and ban this pattern, not that it is allowed. Metal already supports CLIProxyAPI as a user-run gateway preset (`docs/models.md`); that should stay a power-user option the person runs themselves, not something Metal ships or runs for them.

## Provider terms (checked 2026-11-14)

**Anthropic: forbidden for third-party apps, allowed through unmodified Claude Code.** The Claude Code legal page (last modified 2026-11-14) says: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens; sign-in to a Claude account must complete through Anthropic's own flow." It also says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and that preinstalling or running Claude Code in a product requires the Commercial Terms, an unmodified binary, and no reselling. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). The Agent SDK page repeats: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview). Hermes' code shows Anthropic also enforces this server-side by billing detected third-party traffic to extra usage.

**OpenAI: allowed, through the official "Sign in with ChatGPT" plan usage flow, for open-source and locally hosted apps.** OpenAI's developer docs: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." The flow is browser PKCE on a `127.0.0.1` callback with dynamic client registration, a per-host `ext_agent_host_id`, scope `chatgpt.tokens.use.direct`, and inference on `https://api.openai.com/v1` Responses (`store: false`, `stream: true`). Preview limits: no native computer use, no hosted MCP, no `tool_search`, no Code Interpreter; client-side function tools are fine. [Plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Metal already implements this in `server/drivers/chatgpt-plan-auth.ts`. Two open questions for us: Metal's repo is private with a custom license, so it is not plainly "open source"; and Dusk Cloud is remotely hosted. Both point to the interest form. Reusing the Codex CLI's client ID (what Hermes and CLIProxyAPI do) is not this sanctioned path.

**Google: forbidden for consumer logins.** Gemini CLI terms: "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination." [Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md), last changed 2026-04-10. Antigravity terms: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement." [Antigravity terms](https://antigravity.google/terms). The Antigravity FAQ goes further and covers wrapping its CLI: "Wrapping agy inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans", and recommends "a Gemini Enterprise or Google AI Studio API key" for third-party agents. [Antigravity FAQ](https://antigravity.google/docs/faq). Many paid users report suspensions on Google's forum. Metal's own Gemini driver notes consumer Google logins in Gemini CLI stopped working on 2026-06-18.

**xAI: not formally granted, partner-endorsed, gated.** I could not read xAI's current consumer terms (the page blocks automated fetches), so I have no primary text either way. xAI officially announced "Use your SuperGrok or X Premium subscription inside OpenCode" with browser and device-code OAuth, and said "More open-source agents and integrations are coming soon" ([xAI news, 2026-05-21](https://x.ai/news/grok-opencode)). Hermes documents xAI rejecting some SuperGrok tiers with 403 after login. Treat a direct xAI subscription login as unapproved until xAI publishes a third-party client program or approves Metal; the API key and the official Grok CLI login are safe.

**GitHub Copilot: allowed through the official SDK and your own OAuth app.** GitHub publishes the [Copilot SDK](https://github.com/github/copilot-sdk) for "integrating GitHub Copilot Agent into apps and services". Its auth docs list "GitHub OAuth App: Apps acting on behalf of users via OAuth", where your app gets a `gho_`/`ghu_` user token and passes it to the SDK ([authenticate.md](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)). The Node SDK includes the Copilot CLI as a package dependency, so the person downloads nothing separately, and usage counts against their Copilot plan. GitHub's terms (Section J, last changed 2026-04-27) do not prohibit this; they do prohibit "excessive automated bulk activity" ([GitHub Terms](https://github.com/github/site-policy/blob/main/Policies/github-terms/github-terms-of-service.md), [Acceptable Use](https://github.com/github/site-policy/blob/main/Policies/acceptable-use-policies/github-acceptable-use-policies.md)). Calling `copilot_internal` with VS Code's client ID (the Hermes plugin's way) is undocumented and impersonates VS Code; avoid it.

**Cursor: CLI only.** Cursor has no public inference API for plan usage. Its CLI supports browser login or a `CURSOR_API_KEY` ([Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)). Keep the ACP driver.

**OpenCode: allowed with a key.** OpenCode's console sells API keys "to use them with OpenCode or another coding agent", on OpenAI-compatible endpoints such as `https://opencode.ai/inference/openai/v1` ([OpenCode Zen docs](https://opencode.ai/docs/zen/)). Whether the free models answer without a key outside the OpenCode CLI is unverified.

## Proposed design

### One connect flow

Every provider gets one entry in a provider table with a `connect` method. The UI never shows a different screen per provider; it shows one sheet with one button and, if needed, a short code.

| Method | What the person sees | What runs |
|---|---|---|
| `oauth-loopback` | Browser opens the provider's page, they approve, the tab says "done, return to Metal" | PKCE plus state and nonce, listener on `127.0.0.1` (random port, or the fixed port the provider registered) |
| `oauth-device` | Browser opens the provider's page with the code filled in or shown; works when bots run on Dusk Cloud or the person's server | RFC 8628 device code, polled from the server where bots run |
| `cli-login` | Same button; the browser opens the provider's own page | Metal starts the official CLI's own login (for example `claude` login, `grok login --device-auth`, `cursor-agent login`) and only watches whether it succeeded; it never reads the CLI's token |
| `api-key` | A "Get a key" link to the provider's key page and one paste field, with a Check button | Existing key flow in `docs/models.md` |

Rules for all of them:

- **Where tokens live.** The same rule as keys today: on the server the bots run on (this computer, Dusk Cloud, or the person's server), sealed in transit, never logged, never returned to the app. New server-side state goes to MongoDB per `docs/mongodb.md`, encrypted at rest; on This Mac the OS keychain is the better store.
- **Refresh.** One refresher for every OAuth provider: refresh at a margin before expiry, serialize per credential, persist the rotated refresh token before using the new access token, quarantine on terminal errors (`invalid_grant`, revoked) and show one "sign in again" prompt. Hermes' spent-rotation handling is the model to copy.
- **Remote servers.** Device code where the provider offers it. Where it only offers loopback (ChatGPT plan usage), finish OAuth on the person's computer and move the sealed credential to the server with that server's own host ID, which is exactly OpenAI's self-hosted VM guidance.
- **No borrowing.** Metal never reads `~/.claude`, `~/.codex`, `~/.grok` or Keychain entries of other apps. Imports from another CLI are where accounts get banned and where Anthropic's "collect, store, or intermediate" clause applies.

### One engine

Metal already has most of an engine: `server/drivers/openai-chat.ts` (tool loop, approvals, repeat guard, images, text tool-call recovery), `openai-responses.ts` (Responses routing), `chat-mcp-tools.ts` (MCP mounting, including the computer tool), and the dusk app tools. The work is to make it a full coding agent and the default for every provider that allows it:

- **Transports:** Chat Completions (most providers), Responses (OpenAI, ChatGPT plan, xAI), Anthropic Messages (Anthropic API keys, so they no longer need Claude Code), optionally Gemini native. This mirrors Hermes' `api_mode` split.
- **Built-in coding tools:** read, write, edit (search/replace and apply_patch), list, glob, grep, shell with timeout and background output, web fetch and search. Exposed as `native:*` so the existing tool-selection rules keep working.
- **Sandboxing and approvals:** the shell tool runs under the existing approval levels plus an OS sandbox (Seatbelt profile on macOS, bubblewrap on Linux, the bot box on cloud) with a workspace write scope, which replaces what Codex's sandbox and Claude Code's permission rules give today.
- **Context management:** compaction when the window fills (a summary turn), prompt caching where the provider supports it (Anthropic cache control, OpenAI automatic caching).
- **Optional:** subagents (a tool that runs a child loop), checkpoints for undo.

### CLIs only where required

| Kept CLI | Why | How it stays out of the person's way |
|---|---|---|
| Claude Code | Only allowed way to use a Claude subscription | Ship or silently install the unmodified CLI; the Connect button runs its own login. Needs the Commercial Terms for Dusk Cloud and other hosted use. |
| Cursor agent | No public API | Silent install, its own browser login or `CURSOR_API_KEY` |
| Grok CLI (for now) | Only clearly safe subscription path for Grok | Silent install, `grok login --device-auth`; switch to direct xAI OAuth if xAI approves Metal |
| Copilot runtime | Comes inside the Copilot SDK npm package | No separate download; our GitHub OAuth app provides the token |

Everything else (Codex CLI, Gemini CLI, Antigravity, OpenCode, Qwen, Kimi, DeepSeek, Cline, Droid, Pi) becomes optional: the CLI drivers stay for people who want that exact CLI, but none is needed to connect a provider.

## What we lose, and how to keep it

| Lost by leaving the CLIs | How to keep it |
|---|---|
| Each CLI's tuned prompts and tool behaviour (Claude Code's edit tools, Codex's apply_patch) | Write our own toolset to the same shapes the models were trained on (apply_patch for GPT models, search/replace for Claude and others). Measure with a fixed task set per model before switching defaults. |
| Codex's sandbox and approval policy | Our own sandboxed shell tool plus the existing approval levels |
| Claude Code's permission rules, hooks, skills, memory files, plan mode | Only matters for Claude subscriptions, which keep Claude Code. For key-based Claude, use Metal's own memory, skills and approvals |
| CLI-managed MCP (each CLI mounts servers its own way) | Already solved in our loop: `chat-mcp-tools.ts` mounts dusk and custom MCP servers for every provider, one code path instead of seven |
| Computer use | Our MCP computer tool already works in the own loop. OpenAI's native computer-use tool is not available on ChatGPT plan usage anyway (preview limitations). Anthropic's computer-use tool needs a key path |
| Hosted provider tools (OpenAI web search, Anthropic web search, code execution) | Our own web tools; pass hosted tools through per transport where the route allows them |
| Context compaction, resume, session files | Our compaction plus Metal's own conversation store (already the source of truth for chats) |
| Subagents and parallel tool calls | Child-loop tool; parallel calls are already batched in `chat-tool-batches.ts` |
| Provider-specific features (Claude thinking signatures, Codex reasoning summaries, Gemini thinking levels) | Per-transport adapters, as Hermes does in its provider profiles |
| Usage meters that the CLIs report (5-hour and weekly windows) | Read rate-limit headers and provider usage errors; for ChatGPT plan usage, handle `subscription_sharing_usage_limit_exceeded` |

## Per-provider table

| Provider | Login method | Usable without their CLI? | Terms verdict | API key fallback |
|---|---|---|---|---|
| ChatGPT / Codex | OAuth PKCE loopback, "Sign in with ChatGPT" plan usage (already in `chatgpt-plan-auth.ts`) | Yes, Responses API on `api.openai.com/v1` | Allowed for open-source and locally hosted apps; paid or hosted apps need OpenAI's interest form ([docs](https://developers.openai.com/siwc/token-sharing-open-source)) | OpenAI API key |
| Claude (Pro, Max) | Claude Code's own login, started from our button | No | Third-party login forbidden; unmodified Claude Code with the user's own login allowed ([legal](https://code.claude.com/docs/en/legal-and-compliance)) | Anthropic API key on our engine |
| Gemini (Google AI plans) | None for consumer plans | Not with a consumer login | Third-party access forbidden, bans enforced ([Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)) | AI Studio key (recommended by Google), Vertex |
| Antigravity | None; remove the consumer engine | No, and wrapping its CLI is "not supported under consumer plans" | Forbidden ([terms](https://antigravity.google/terms), [FAQ](https://antigravity.google/docs/faq)) | AI Studio key or Gemini Enterprise |
| Grok (SuperGrok, X Premium+) | Grok CLI's own device-code login | Technically yes (device code on `auth.x.ai`), but only with the Grok CLI's client ID | Not granted to third parties in published text; endorsed only for OpenCode ([xAI news](https://x.ai/news/grok-opencode)); 403 gating reported | xAI API key |
| GitHub Copilot | Our own GitHub OAuth app (device code or web redirect) | Yes for the person; the Copilot runtime ships inside the SDK package | Allowed via the official SDK ([Copilot SDK auth](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)) | SDK BYOK with any supported key |
| Cursor | Cursor CLI's own browser login | No | No public API; use the CLI ([docs](https://cursor.com/docs/cli/reference/authentication)) | `CURSOR_API_KEY` (still through the CLI) |
| OpenCode (Zen, Go) | API key from the OpenCode console | Yes, OpenAI-compatible endpoint | Allowed "with OpenCode or another coding agent" ([docs](https://opencode.ai/docs/zen/)) | Same key |
| Qwen, Kimi, MiniMax | Vendor OAuth (device or PKCE) | Yes | Not reviewed in this pass; check each before shipping | Vendor API key |
| Everything else (Groq, Mistral, DeepSeek, OpenRouter and so on) | API key | Yes | Normal API terms | Is the key |

## Risks

- **Account bans for users.** Any direct subscription login that imitates an official client (Claude, Gemini, Antigravity, possibly Grok) can get the person's account suspended. This is the main reason the proposal keeps CLIs for those providers.
- **Existing Antigravity engine.** Google's FAQ says wrapping `agy` in a third-party app is not supported on consumer plans. Metal's current Antigravity driver is exposed to that today, independent of this proposal.
- **OpenAI eligibility.** Metal is not plainly open source and Dusk Cloud is hosted. Until OpenAI confirms eligibility through the interest form, ChatGPT plan usage should be limited to the desktop app, or the risk accepted knowingly. The flow is also labelled a preview and may change.
- **Claude Code in a hosted product.** Running Claude Code on Dusk Cloud requires accepting Anthropic's Commercial Terms and must not resell usage. Needs a decision from the owner.
- **Quality regression.** Our loop may do worse than a provider's own CLI on hard coding tasks at first. Gate each default switch on a task benchmark per model.
- **Token custody.** Holding refresh tokens for many providers makes the dusk server a higher-value target. Keep the sealing, never log, scope tokens to the server where bots run, and support revoke on sign-out.
- **Single-use refresh tokens.** OpenAI, xAI and Anthropic rotate refresh tokens. A crash between refresh and save loses the login. Persist before use, and serialize refreshes per credential.
- **Terms move.** Anthropic, Google and xAI changed these rules several times in 2026. Recheck before each release and keep the per-provider method switchable by config.

## Effort estimate

About 10 engineer-weeks for one engineer who knows the codebase, range 8 to 13.

| Phase | Work | Estimate |
|---|---|---|
| 0. Decisions | Owner decides on Antigravity removal, Claude Code on Dusk Cloud, OpenAI interest form, GitHub OAuth app registration | 0.5 week |
| 1. Connect broker | Provider table `connect` methods, shared loopback listener, device-code poller, token store with sealing and refresh scheduler, quarantine and re-login prompt, remote-server credential transfer, one connect sheet in the UI | 2 weeks |
| 2. Engine to coding agent | Built-in coding tools, sandboxed shell, Anthropic Messages transport, compaction, prompt caching, usage-limit handling | 3 weeks |
| 3. Direct providers | Move ChatGPT plan, OpenAI, Anthropic, xAI, Gemini and OpenCode keys onto the engine; Copilot via our OAuth app and the SDK | 1.5 weeks |
| 4. CLI-only providers behind the same button | Silent install or bundling for Claude Code, Cursor and Grok CLI; their own logins started from the sheet; retire Antigravity consumer and Gemini consumer paths | 1.5 weeks |
| 5. Parity and migration | Benchmark per model against the current CLIs, move existing bots and sessions, failover rules, docs and tests | 1.5 weeks |

## Sources read for this proposal

- Hermes Agent: `hermes_cli/auth_constants.py`, `auth_codex_browser.py`, `auth_xai.py`, `auth.py`, `agent/anthropic_credentials.py`, `agent/anthropic_adapter.py`, `agent/copilot_acp_client.py`, `agent/transports/`, `website/docs/integrations/providers.md`, `website/docs/guides/xai-grok-oauth.md`; hermes-labs-plugins `github-copilot/`.
- CLIProxyAPI: `internal/auth/{claude,codex,antigravity,xai,kimi,meta}`, `internal/api/server_routes.go`, `cmd/server/main.go`, `sdk/auth/`, `README.md`; local `~/Desktop/code/mchat/run.sh` and directory layout only.
- Metal (read only): `docs/models.md`, `docs/tool-selection.md`, `server/drivers/builtIn.ts`, `chatgpt-plan-auth.ts`, `device-auth.ts`, `openai-chat.ts`, `openai-responses.ts`, `openai-compat.ts`, `chat-mcp-tools.ts`, `acp/{gemini,grok,copilot}.ts`, `antigravity-account.ts`, `pi.ts`.
- Terms and docs linked inline above, all opened on 2026-11-14 except the xAI consumer terms, which could not be fetched.
