# OpenAI-compatible structured tools

This recipe exercises the shared chat-completions runtime through a real
isolated harness. It uses an offline loopback provider and a synthetic stdio
MCP server that can write exactly one file in the fixture's disposable home.
It needs no provider account, API key, browser, or desktop access.

Run the permanent acceptance test:

```sh
pnpm exec vitest run server/openai-tools.e2e.test.ts
```

`server/openai-tools.e2e.test.ts` launches its own server with
`launchVerificationServer`, then uses `runControlDusk` with the launcher's exact
URL for `new-bot`, `set-model`, `send`, `wait`, `messages`, and `interrupt`.
Configuration and approval go through the fixture's existing HTTP routes;
approval uses `/api/bots/ID/respond`. The fixture explicitly enables each MCP
server after adding it, following the normal disabled-on-create behavior.
The control CLI does not provide an
approval verb.

The assertions prove:

- Tool schemas reach the provider, and arguments fragmented across streaming
  events form one structured call.
- `wait` reports `needs-user` before any file exists. Allowing the pending
  card creates the expected file, returns a result correlated with the
  assistant call ID, and produces a second provider response before settling.
- Denial returns a tool result and lets the model explain it, while the turn
  remains failed and the file remains absent.
- Interrupting while awaiting approval dismisses the card, records an
  unsuccessful tool result, and produces no file and no continuation. The
  existing control `settled` status means the interrupted conversation is idle;
  the tool result carries the unsuccessful operation outcome.
- Text that resembles a call stays text, ordinary responses settle, and
  neither causes execution.
- An explicitly tools-disabled connection sends no `tools`, starts no MCP
  process, and completes direct and room conversations against a provider
  fixture that rejects tool schemas. Its preview also omits tool guidance.
- Saved memory remains in direct, room, and preview prompts without promising
  native filesystem tools that API drivers do not provide.

The test prints `evidencePath`, next to the fixture's retained server log.
The JSON records the control commands, wait states, bounded messages, file
existence, and provider request counts. It does not retain the provider's
headers, MCP environment, or configuration payloads. The launcher stops its
own child and removes its disposable data on exit.

Driver contract tests cover the three shared adapters, protocol errors,
non-streaming responses, tool errors, and lifecycle edge cases:

```sh
pnpm exec vitest run server/drivers/openai-chat-tools.test.ts server/workspace.test.ts
```

OpenAI-compatible and Cerebras turns recover explicit unfinished action
announcements with at most three nudges per turn. Each nudge must be followed
by tool progress before another is allowed; otherwise the turn fails as
incomplete rather than reporting success. The detector also recognizes a clear
first-person action promise in the last paragraph of an explanation, while
leaving questions, quoted examples, "let me know" closings and ordinary final
reports alone. Denials and pending tool failures take precedence over
announcement recovery. Earlier tool results stay in the conversation, and the
nudge asks the model not to repeat an operation that may already have taken
effect; whether a call runs is still decided by the turn's permissions.

One turn stops after 64 model steps, or 200 tool calls in total (each reply
may carry up to 32). The stop says so in one line with one next action: the
steps so far already ran, so ask only for what's left (retrying the whole task
would repeat them). A batch that would pass 200 runs none of its calls. There
is no per-bot or per-thread setting for either number.

A turn whose MCP servers offer more than the 128 tools a request may carry
lists whole servers in turn order and reaches the rest through the
`mcp_search_tools` / `mcp_describe_tool` / `mcp_call_tool` directory, whose
three tools count toward the limit; no server is skipped for it. The bot's
last budget is read at `GET /api/bots/ID/tool-budget`. The driver tests
cover it with real stdio servers:

```sh
pnpm exec vitest run server/drivers/chat-mcp-tools.test.ts server/drivers/openai-chat-tools.test.ts
```

In a provider's tool-call batch, up to eight adjacent explicitly read-only MCP
calls run together (Hermes Agent caps a batch at 8 workers; Claude Code runs
read-only tools concurrently too). Results return to the provider in its
original call order. Tool search's `mcp_search_tools` and `mcp_describe_tool`
only read the catalog, so they overlap too, and `mcp_call_tool` overlaps when
the tool it runs is read-only. Writes, questions, unannotated tools and the
built-in browser and computer remain ordered barriers. Calls that still need an
approval card also stay serial. Read-only annotations affect scheduling only;
schema, tool selection, approval and safety-floor checks still run for every
call. The agents server marks its reviewed reads (`server/agent-tool-policy.ts`),
including the open-world ones such as `x_search` and `research_search`.

The gated driver fixtures hold eight reads open at once, release them out of
order, and prove that a ninth read and a following write wait. They also prove
that denial and Stop prevent a later operation from being dispatched. These
are synthetic protocol checks, not a live-provider latency benchmark.

The chat runtime answers Metal's own built-in servers (agents, data,
email, browser, phone) in the server's own process, through the code their
stdio proxies run and with the environment those proxies would get, so a turn
starts no child process for them; tool schemas are compiled once per schema
text. `node --experimental-strip-types scripts/bench-tool-calls.ts` measures
mount time, one agents call and read batching with no model in the loop.
`node --experimental-strip-types scripts/bench-everyday.ts` runs ten everyday
tasks (research, a PDF summary, an email draft behind an Ask card, an event,
a comparison, a data query, renames, a reminder, a multi-step lookup and a code
fix) through the real driver with a scripted model and fixture tools, and fails
a task whose writes or approval cards differ from the script; `BENCH_ROOT` runs
another checkout's code for a before and after.

The harness proves the OpenAI-compatible adapter and the shared execution
path. It does not establish that every third-party model supports tools, or
that live Grok and MiniMax services accept a particular schema. Model support
and service-specific limits remain separate from the implemented protocol.

## Computer and browser screenshots

The OpenAI-compatible driver opts into structured image input and mounts the
harness-provided `localComputer` and `browser` stdio descriptors. It does not
discover or grant a desktop itself. Host, VM, VPS and room routing use the
harness's ownership and permission gates. The bot's own VPS computer arrives
in the same `localComputer` slot as every other computer, so the selected API
model is kept. Only the scoped computer bridge reaches the bot's engine;
computer-provider credentials stay out of its environment.

MCP images become bounded inline image parts. Tool results retain their call IDs;
only after the full tool-result batch is appended does a separate image message
carry labelled screenshots. Image data is not copied into text tool previews.
Computer-enabled MCP transports accept frames up to 32 MiB for screenshots;
ordinary text-only transports retain their 2 MiB limit. Each image is bounded to
20 MiB, with 32 MiB of encoded images retained across the whole turn, including
user attachments. Exceeding the turn budget stops without replaying an operation.
Remote image/computer connections require HTTPS; local loopback HTTP is allowed.
Image-bearing completion requests do not follow redirects. Custom text MCP
servers retain their 2 MiB transport cap even in computer-enabled sessions.
PNG, JPEG, WebP and GIF are accepted; invalid base64/MIME results fail
instead of being reported as successful screenshots.

Native unsigned-number formats and root composition constraints are validated
locally. For computer-enabled requests, root composition constraints appear in
the description rather than the outgoing parameter root, preserving the full
original validator before execution.

The driver contract tests exercise real loopback HTTP and stdio MCP processes:
input-image encoding, computer/browser screenshot delivery, call-ID ordering,
approval denial with no side effect, malformed images and a screenshot larger
than the ordinary text frame limit. They do not use real desktop access or paid
inference, and do not establish vision/tool support for every provider model.

### Own VPS computer

Run the scoped bridge, model tool transport and VPS routing checks:

```sh
pnpm exec vitest run server/vps-container-mcp.test.ts server/vps-routing.test.ts server/drivers/chat-mcp-tools.test.ts server/drivers/openai-chat-tools.test.ts
pnpm exec vitest run server/computer-selection.test.ts server/room-turn-end.test.ts src/components/ComputerPanel.lazy.test.ts
```

The real-server VPS fixture uses fake Docker/SSH and fake engines. It proves
that direct turns and routines retain their selected runner, receive the VPS
computer bridge, and share a desktop only through its control gate. Auto
reuses a ready computer without provisioning it. Missing or cancelled shared
setup releases its busy claim. A stopped turn cannot wake the desktop later.
The bridge tests cover its SSH launch arguments, bounded transport and scoped
capability; model tool tests cover validation, approval and image results.

Commands run inside the selected container. The model process receives a
turn-scoped control capability, not provider credentials. Independent annotated
read-only tools may overlap; browser and computer actions remain ordered.
These fixtures do not prove every model's vision support or a real VPS network.
The [desktop viewer fixture](desktop-viewer.md) separately proves synthetic
RFB watching, takeover and handback for private and shared computers.

## Text-only model connections

Tool support is enabled by default for these three API drivers. For a model
or endpoint that supports only ordinary chat, disable tools explicitly on its
provider instance using the existing instance settings route:

```http
PATCH /api/instances/ID
Content-Type: application/json

{"tools": false}
```

Use the exact instance ID from `pnpm control:metal models --url URL`, and direct
the request only to that explicitly selected server. The route accepts this
setting for OpenAI-compatible, Grok API, and MiniMax API instances, refuses
changes while the instance is busy, and stores `config.tools` on that instance.
Set `tools` back to `true` to enable discovery and execution. This affects all
bots using the instance; use separate configured instances for models with
different tool support. Configured MCP tools are never silently disabled.
An otherwise plain turn initially offers the built-in question tool; only an
explicit unsupported-tools HTTP 400/422 rejection permits one retry without
that optional tool. Authentication, schema and network failures do not trigger
this downgrade, nor does a response after any tool call. The next turn offers
questions again. No fallback replays a requested operation without its tools.
When a provider refuses a tool call (Groq's `tool_use_failed`, mid-stream or
as HTTP 400: a tool the model was not given, or arguments that miss the
schema), nothing ran, so the same request is sent again, up to three attempts
in all, each shown as a retrying row. Once answer text has streamed the refusal
ends the turn instead, so one reply never joins two attempts. A turn that runs
out of attempts says in plain words what happened and what to do next,
followed by the provider's message. With no earlier tool call in the turn,
nothing ran and the chat's Retry sends it again; after earlier calls ran, it
asks only for what's left, since a Retry of the whole request would repeat
them. A resend never repeats an earlier call: its result is already in the
request.
Each refusal's full error object, `failed_generation` included, is written to
the thread's redacted native log (`native/THREAD.ndjson` in the data
directory), next to the tool names every request offered.

Cloud routines use the executing bot's selected runner and the configured VPS,
including an inherited team computer where eligible. They do not require a
paid desktop account. Readiness and setup remain owned by the turn generation;
failed or cancelled shared preparation releases its claim.

Run `pnpm exec vitest run server/routine-requests.test.ts server/vps-routing.test.ts`
for target selection, an explicitly cloud-targeted routine on the VPS, shared
setup cancellation and direct-turn mounting. The selected-image and browser
checks are fixture evidence; real provider authentication and production VPS
reachability are outside these tests.
