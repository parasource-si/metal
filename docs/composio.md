# Connect apps

Metal pays nothing per tool call. Every app connects with the person's own account, key or token, and Metal's
own Composio service (`apps/cloudflare/composio-broker`, `composio.dusk.bot`) is closed to new installations and is no
build's default. The Connect apps window groups apps by how they connect, free first:

- **Connect in one click.** The vendor's own hosted MCP server, signed in with the person's own account through dynamic
  client registration (`server/connectors/remote-mcp.ts`), and sign-in to Metal's own OAuth apps.
- **Paste a token.** GitHub, Notion, Linear, Airtable, Todoist, Trello, ClickUp, HubSpot, Jira, Shopify, Stripe and
  Cloudflare (`server/app-tokens`), plus Gmail with an app password on the built-in email connector. Each shows a
  numbered guide: open the app's token page, make a token, paste it; Metal checks it live before saving it.
- **More apps with your Composio.** The person's own Composio account (Sign in with Composio, or their own `ak_` key),
  free for 10,000 actions a month on Composio's own plan.

## Token apps and native sign-ins

A pasted token is checked against the vendor's own "who am I" endpoint, sealed in `app-tokens.json.enc` in the data
folder (key in `app-tokens-key`, both 0600) and added as an MCP server:

- the vendor's own MCP server with the token as a bearer where it takes one (GitHub, Linear, Cloudflare);
- otherwise Metal's own `api_request` endpoint at `http://127.0.0.1:<port>/api/app-tokens/mcp/<id>`, which keeps the
  token in the server, answers only loopback callers with that entry's random 256-bit bearer, and keeps every call on
  the app's own API origin.

Native sign-ins are rows in `shared/native-connectors.json`: a device-code flow (the person types a code on the
vendor's page), a code flow with PKCE, or Trello's token page (the token comes back in the address's fragment, which a
small same-origin page posts to the server). Every code and token page sign-in comes back to one fixed address,
`https://link.dusk.bot/oauth/app-tokens` (`apps/link-service/src/app-token-callback.mjs`): the state starts with the
app's port (`8799.`, `18799.` or `28799.`), and the link service redirects the browser straight on to
`http://127.0.0.1:<port>/api/app-tokens/callback`, storing nothing, so a sign-in works whichever port the app fell back
to. Each row names the env vars that hold the client id and secret, scopes, endpoints, how the client authenticates at the token endpoint (`tokenAuth`: form or HTTP Basic; `tokenBody`: form
or JSON), a check URL (GET or POST) and how bots use the token. `scripts/bundle-server.mjs` bakes exactly the env
names the rows list. Today:

| App | Flow | Redirect | Client env | Notes |
|---|---|---|---|---|
| GitHub | device | none | `DUSK_GITHUB_APP_CLIENT_ID` | GitHub App, not registered yet |
| Google Drive | device | none | `DUSK_GOOGLE_DRIVE_CLIENT_ID`, `_SECRET` | `drive.file` only |
| Notion | code | `https://link.dusk.bot/oauth/app-tokens` | `DUSK_OAUTH_NOTION_*` | Basic auth, JSON body |
| Linear | code | same | `DUSK_OAUTH_LINEAR_*` | token goes to Linear's MCP |
| Airtable | code | same | `DUSK_OAUTH_AIRTABLE_*` | Basic auth |
| Todoist | code | same | `DUSK_OAUTH_TODOIST_*` | |
| ClickUp | code | same | `DUSK_OAUTH_CLICKUP_*` | |
| Dropbox | code | same | `DUSK_OAUTH_DROPBOX_CLIENT_ID` | PKCE only, no secret; Dropbox's own MCP refuses unreviewed clients |
| Trello | fragment | same | `DUSK_OAUTH_TRELLO_API_KEY` | the API key is public |

Not native, on purpose: Slack and Calendly accept no loopback redirect, Spotify's app is capped at 5 allowlisted
users, and GitLab and Miro already sign in through their own MCP servers. Never add a sensitive or restricted Google
scope to the Drive project.

Signed-in tokens are renewed in the background every 5 minutes when they expire within 10, and again when an app
refuses one mid-call (the call is retried once). When the vendor refuses the refresh token itself, or a pasted token
stops working, the account shows `needsReconnect`; reconnecting with `replaces: <account id>` (on
`POST /api/app-tokens/:app` or `POST /api/app-tokens/:app/device`) keeps the same MCP server name, so every bot keeps
its access. The bot's tool answer names the app and says to reconnect it, or how long to wait when the app is
rate limiting.

## Vendor MCP servers and the client metadata document

`server/connectors/remote-mcp.ts` lists vendors' own MCP servers. They sign in with dynamic client registration, or,
where a vendor registers nobody but supports OAuth client ID metadata documents (Railway, MongoDB Atlas, and Vercel,
which admits only reviewed clients otherwise), with `https://dusk.bot/v1/oauth/mcp-client.json`: the account service
serves it (`shared/mcp-client-metadata.ts`) and its only redirect is `http://127.0.0.1:47615/mcp-oauth/callback`. Run
`node --experimental-strip-types scripts/probe-remote-mcp.ts` to check every row live with no account.

## Your own Composio

Metal uses one Composio project API key and one reusable Composio Session. That project key is the only Composio credential users need to provide. The Session enables Composio's multi-account mode with explicit account selection, so one Metal installation can keep several Slack, Gmail, Calendar, or other accounts connected without silently replacing the first one.

## Packaged desktop app

1. Open the [Composio Dashboard](https://dashboard.composio.dev).
2. Select **Platform**, select or create a project, then open **Settings → API Keys**.
3. Copy a project key beginning with `ak_`.
4. In Metal, open **App Settings → Connections** and save it under **Composio project key**.
5. Open **Connected apps** and choose Gmail, GitHub, Slack, or another service. Enter a unique label such as `work` or `personal`, then finish the authorization in your normal browser.
6. To connect another account for the same app, choose **Add account**, give it a unique label, and finish the second authorization in your browser.

The Connected tab lists every account separately. **Disconnect** revokes only the account named on that row. Metal asks for a label for every new account and configures Composio to require explicit selection when more than one account could run a tool; a new OAuth flow never silently becomes the default for an existing connection.

The desktop app validates the key before saving it. The key is encrypted using Electron's operating-system-backed `safeStorage`; the local JSON configuration stores only the non-secret Composio user and Session identifiers.

## Dusk Cloud

A Cloud home connects apps the same way as the desktop app: the person's own accounts, tokens and Composio. It
registers with a managed Composio service only when `DUSK_COMPOSIO_BROKER_URL` names one on purpose.

## App events

Without a managed service (the default now), a bot watches an app with a schedule that checks it every few minutes
(for mail: search messages since the last run), or a webhook the app sends. The rest of this section applies only where
a managed service is named on purpose.

An app-event automation runs a bot when something happens in a connected app: a new Gmail message, a Slack
message in a channel, a HubSpot deal changing stage. It uses Composio triggers through the managed service:

1. `trigger` (`action: "create"`, `when: "app_event"`) or the editor saves the automation in `app-triggers.json` in the data
   folder and creates its trigger on the service (`POST /v1/triggers`), which checks that the connected account
   belongs to this installation. A Gmail filter (from, subject, label, words) becomes Gmail's own search, so
   other mail never arrives; other apps match the filter as events arrive.
2. Composio posts each event, signed, to the service, which queues it per installation for up to 7 days.
3. The server long-polls the queue (`GET /v1/events`, 25 seconds at a time) while it has an automation switched
   on. Each event becomes a routine run, with the event fenced as untrusted data. A burst shares runs: at most 3
   waiting runs per automation, up to 20 events each. The cursor that acknowledges events moves only after the
   run is saved, and a redelivered event is recognised by its id, so each event runs once.
4. The server compares its automations with the service at start and every 15 minutes (hourly while all are
   paused) and fixes any difference by itself: a lost copy is made again, an unwanted one is removed, on/off is
   matched. An expired connection shows as **Needs you** with **Reconnect**.

| | Desktop | Paid Cloud |
| --- | --- | --- |
| Events kept per day (UTC) | 2,000 | 10,000 |

A Cloud counts as paid once its server presents the Admin's signed grant (`DUSK_CLOUD_CONNECTED_APPS_GRANT`).
Events over the limit are not run; the automation shows how many were skipped today and why.

Gmail and other polled apps are checked every 15 minutes, the minimum for Composio-managed sign-ins. A server
that uses its own Composio project key cannot watch apps yet: `trigger_info` (`action: "events"`) and the editor say so, and a
schedule that checks the app, or a webhook, does the job instead.

## Scoped key permissions

A default project API key works without additional configuration. For a least-privilege scoped key, grant:

- **Sessions:** read and write
- **Toolkits:** read
- **Connected accounts:** read and write

Connected-account write access is required so **Disconnect** can revoke the upstream provider grant before removing the connection.

## Running from source

Set the key in the server environment:

```sh
COMPOSIO_API_KEY=ak_your_project_key pnpm dev:server
```

The browser-only development UI can also save a key to the owner-only `~/.duskbot/config.json` file. Using the environment variable is preferred for headless and shared development machines.

Metal creates a stable random user identifier for the installation, stores the returned Session identifier, and reuses that Session across launches. No Gmail, GitHub, Slack, or other provider tokens are stored by Metal; Composio owns their connection lifecycle.

Sessions created by older Metal versions are upgraded in place by creating a multi-account Session for the same stable Composio user. Connected accounts belong to that user, so existing grants remain available while the new Session adds explicit multi-account routing. Each toolkit is capped at five usable accounts.

## Multiple Google and Slack accounts

Yes. Gmail, Google Calendar, Google Drive, and the other Google toolkits can each hold multiple labeled authorizations, and Slack can hold multiple labeled workspace/account authorizations. Accounts are scoped to the Metal installation's stable Composio user and appear by alias and connected-account ID in **Connected apps**.

If a provider or restricted Composio project policy prevents another authorization, the safe fallback is a separate Metal installation/configuration with its own Composio user. Re-authorizing the same single-account Session is not a safe workaround: it can change which grant is selected. Do not share raw provider tokens or place them in bot prompts.

The hosted/managed connected-apps broker exposes the same account-aware response shape and account-specific removal routes as the self-hosted project-key mode; it does not send broker or provider credentials to the renderer.

## Permissions the default connection does not ask for

Each app you connect uses the Composio project's authorization for that app. Unless you set up your own, that is the Composio-managed one, which asks the provider only for Composio's default permissions. Some actions need more. In Gmail:

- **Filters, the vacation responder, IMAP and POP settings** need `https://www.googleapis.com/auth/gmail.settings.basic`.
- **Forwarding addresses, send-as aliases and delegates** need `https://www.googleapis.com/auth/gmail.settings.sharing`.

Without the permission, Google refuses the call with `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. Reconnecting the account does not help: the consent screen asks for the same permissions every time. Metal adds a note to that refusal, so the bot tells you what to change instead of retrying.

To grant the permission:

1. In the [Composio Dashboard](https://dashboard.composio.dev), open your project's **Auth Configs** and create an auth config for the app (for example Gmail) that uses your own OAuth app credentials.
2. Add the permissions you need to it and keep it enabled.
3. In Metal, open **Connected apps** and reconnect the account. The consent screen now asks for the added permissions.

Metal uses your project's own auth config for an app automatically, in place of the Composio-managed one. If there are several enabled ones for the same app, it uses the most recently created, and it skips disabled ones. Google may require your OAuth app to list the added permissions on its consent screen, and to be verified before people outside your organization can grant them.

On a Dusk Cloud plan, connected apps run through Metal's managed connection service rather than your own Composio project, so you cannot add permissions yourself; ask Metal support instead.

## Apps with no Composio-managed sign-in

Some apps, such as Xero and Buffer, have no sign-in that Composio provides: they connect only through an auth config holding your own OAuth app. Without one, Composio answers "Composio does not manage auth for toolkit … and no auth config without required fields is available".

With your own Composio project key, create the auth config in the Composio dashboard (**Auth Configs → Create**), keep it enabled, then connect the app. Nothing else is needed:

- A Tool Router Session uses one of your auth configs only while that config is *enabled for Tool Router*. A config you made yourself can have that off, and the dashboard may not show it. When an app is connected (its Connect card appears, you click **Connect**, or a bot's call to it fails for want of a config), Metal turns it on for the app's config through Composio's API. It changes nothing else in your project, and nothing for apps you don't connect.
- Metal then names the config in its Session (`auth_configs`), changing the Session in place, so a bot that is already running keeps its tools and picks the config up on its next call. If Composio won't change the Session, a new one is made under the same Composio user, so existing connections stay.
- If an app has several enabled auth configs, Metal uses the most recently created and tells the bot which one in the card's tool result.
- Metal reads your project's auth configs at most once a minute, and again right away when Composio reports a missing one, so a config made while a bot is working is found on the next try. If they cannot be read, the Session keeps the ones it last read; if Composio refuses a config, connecting that app says what Composio said.

An account you connected in the Composio dashboard belongs to a different Composio user than Metal's, so Metal does not see it: connect the app once from Metal.

A bot can also name one auth config for an app: `COMPOSIO_MANAGE_CONNECTIONS` with `"auth_config_id": "ac_…"` next to a single toolkit, or `toolkits: [{ "name": "xero", "action": "add", "auth_config_id": "ac_…" }]` (`auth_config_override` is read as well). Metal adds `auth_config_id` to the tool's description so bots can see it. It checks the id in your project before it shows the Connect card (it must exist, belong to that app and be enabled) and keeps the choice in `composio-auth-configs.json` in the data folder, so later Sessions use it while it stays usable.

Metal's managed connection service (the desktop default and Dusk Cloud) runs on Metal's own Composio project, which cannot use an auth config in yours. For such an app it says so in one line: add your own Composio project key in **Settings → API keys**; Metal then uses your auth config for that app from that project.

## Browser authorization recovery

The web UI reserves an authorization tab during your click, before requesting
the link. If the browser still blocks it, use **Open authorization page** in
the Apps modal or connector card. **Continue** / **Open again** reuses the
pending link instead of creating another account. Links stay in UI memory only;
after ten minutes, retry requests a fresh link, as required by
[Composio's connection lifecycle](https://docs.composio.dev/kb/guide/platform-connected-accounts).

A label is required only when the app already has an `ACTIVE` account (or one
whose status Composio did not report). While no account works, an alias-less
retry gets a unique `dusk-retry-…` alias and leaves the other accounts alone.
Asking again for a label held only by an account that is not active (for
example an `INITIATED` sign-in that was abandoned, or a `FAILED` or `EXPIRED`
one) revokes and deletes that account, then links a new one under the same
label; a label an active account holds is still refused with 409. The
five-usable-account limit remains; the account being replaced does not count
toward it. Managed installations need the updated broker as well as the
updated app; this is not a client-side bypass.

In **Connected apps**, only an `ACTIVE` account shows the app as connected. An
app whose accounts all stopped working shows **Reconnect**, which removes the
newest stopped account and signs in again under its label; each stopped account
beside a working one has its own **Reconnect**. When a connected-app call fails
because the account is signed out (Composio's `USER_NOT_LOGGED_IN`, a 401, or no
connected account), Metal adds a note telling the bot to call
`COMPOSIO_MANAGE_CONNECTIONS`, which shows the person a reconnect card. That
tool stays available to a bot with no app grants, and a failed `tools/list` is
retried once and then answered with the last list the connection service gave.

## Renderer-neutral connection inventory

Desktop, web, and mobile clients can load the complete account inventory in one request:

```http
GET /api/connectors/connected
```

```json
{
  "configured": true,
  "services": {
    "gmail": {
      "connected": true,
      "pending": false,
      "status": "ACTIVE",
      "accounts": [
        { "id": "ca_123", "alias": "work", "status": "ACTIVE" }
      ]
    }
  }
}
```

This operation cursor-paginates both the Session toolkit state and the user's connected accounts directly. It merges no-auth toolkits and the Session-selected account with the full multi-account inventory, without deriving service slugs from marketplace cards, so account visibility is independent of catalog ordering and pagination. If a scoped project key can read the Session but cannot list raw connected accounts, the response safely falls back to the Session-selected and no-auth toolkit inventory rather than making those services appear disconnected. The managed broker provides the same behavior and response at `GET /v1/connectors/connected`; the local server adds the normal `configured: false` empty response when no connection service is configured. Responses expose only connected-account IDs, user-supplied aliases, and lifecycle status, never project keys, broker tokens, provider tokens, or write-only authorization fields.

The existing scoped `GET /api/connectors?services=gmail,slack` operation remains available for lightweight post-OAuth polling and backward compatibility.

## Per-bot tool grants

The workspace-level connections above say which accounts exist. A second, per-bot layer says which of an app's **tools** each bot may actually call. Open a bot's settings on the desktop, and under **Connected apps** each service can be set to:

- **All tools**: every tool the service offers (the wildcard grant).
- **An exact list**: only the named tools, such as GMAIL_SEND_EMAIL, shown as the granted count.
- **No tools**: the service is listed but grants nothing.

A bot with no grant record at all keeps the legacy behavior: every tool on every connected app it can see. Assigning the first grant switches the bot to exact-tool mode: a service not on the list grants nothing, even when the workspace is connected to it.

**Nothing changes until you assign.** Upgrading Metal does not alter any bot's access: existing bots keep the all-tools default until someone edits their grants. An emptied grant list is deliberate and means "no tools on any connected app." The one exception is an app a bot's **Apps** switch turns on (its read or write level) that its tool list leaves out: that app gets all of its tools, so a switch that shows an app on always lets the bot use it.

**Imported bots land with no grants.** Shareable packages and team imports never carry grants: an imported bot starts with connected apps off, and any grants it later gets are chosen by the importing workspace. Grants also never appear in exports; only the workspace's own private team backup keeps them.

**A Chief's new bots start with the Chief's apps.** A bot a Chief of Staff creates (`create_bot`, or a team setup) starts with a copy of the Chief's own connected apps, tools, read or write levels and MCP servers at that moment, never more, and the workspace's default access level. It has the Chief's owner and exactly the Chief's audience; on a Team Cloud, an app each person connects still works only for the person whose own request the work is, with their own connection. A bot a person creates keeps the defaults above.

**Gmail and Google Calendar by name.** Besides Composio's search-and-run tools, a bot with Gmail or Google Calendar connected and granted gets plain tools for the common reads and writes, the same on every engine: `gmail.search_emails`, `gmail.read_email`, `gmail.read_email_thread`, `gmail.create_draft`, `gmail.send_email`, `googlecalendar.list_events` and `googlecalendar.list_calendars` (writes only where the bot may write). Claude Code finds them by those names (`select:gmail.search_emails`); other engines show them as `gmail_search_emails` behind their own prefix. Each one runs its Composio tool through the multi-execute tool, so its grant, read or write level and approval rules are that tool's. A routine written on one engine keeps working when its bot moves to another.

Grants are enforced on the real tool names at call time (including batches inside the MULTI_EXECUTE meta-tool), the tool list offered to the model is filtered to the granted set, and every allow/deny writes a decision-log row. Refusals do not enumerate what else is granted. Paired phones see each bot's grants read-only in its profile (What this bot does → App tools); grants are assigned on the computer, never from a phone.

Connected-app sends also follow the bot's **Permissions → Sending on your behalf** setting at every access level, including Full access. **Ask every time** requires approval for each send regardless of prompt language. **Allow a daily amount** permits automatic sends up to its cap. Reading and drafting do not consume the allowance; opaque app code execution always requires approval because its effects cannot be counted.
