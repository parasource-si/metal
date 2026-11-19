# Server provider sign-in and custom domain

Use an isolated fixture only. Never change the running user's provider account,
domain, or configuration to verify these controls.

## Automated checks

```sh
pnpm exec vitest run server/custom-domain.test.ts server/provider-auth-sessions.test.ts server/drivers/codex-device-auth.test.ts server/drivers/acp/grok-device-auth.test.ts server/grok-sign-in-api.test.ts server/request-auth.test.ts server/config.test.ts src/components/DeviceSignIn.test.ts src/components/EngineSetup.test.ts src/components/EnginesSettings.test.ts
pnpm typecheck
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The domain helper tests substitute DNS and HTTPS responses. They check public
address restrictions, pinned DNS, TLS options, redirects, deadlines, bounded
responses, the workspace identity, and the independent one-time proof. They do
not prove a customer's real DNS, certificate, or reverse proxy is configured.

## Real Settings UI with an offline provider

1. Follow the [fixture launcher](README.md#launch), retaining its printed URL,
   temporary data directory and persistent log path. Run Doctor against that
   explicit URL.
2. Start Vite on a separate free port with `DUSK_PORT` set to the printed harness
   port. Do not let it proxy to the default port or the user's live app.
3. A custom domain has no Settings rows: a self-hosted server gets one with
   `metal serve --domain HOST` (a managed Caddy) or `--public-url` behind a
   proxy of its own, as the add-a-place flow's "your own domain" way shows.
   Check the API alone with the domain helper tests above.
4. To exercise Codex, add an instance to **only the fixture's config.json**:
   driver `codex`, CLI set to the absolute path of
   `server/testing/fake-codex-login-cli.ts`, environment
   `DUSK_DEVICE_AUTH_FIXTURE=1`, `HOME` set to the fixture's temporary directory,
   and `CODEX_HOME` set to its `.codex` subdirectory. Reload that isolated
   provider registry and refresh the preview. Never substitute the real Codex
   executable. The fixture requires an explicit opt-in and makes no network
   requests.
5. Settings → Engines → Connect ChatGPT should display `TEST-12345`, the
   official link, expiry, and Cancel. **Do not enter the fake code at OpenAI.**
   Cancel and restart, then switch Settings sections and return; Connect should
   recover the same active flow without spawning a second login.
6. Create the empty `.dusk-fake-codex-login-approved` marker in the fixture's
   temporary HOME. The offline process records a fake signed-in state. Confirm
   the real Settings UI changes to “ChatGPT connected on this server.”
7. Stop the Vite process and interrupt the foreground fixture launcher. Only
   its owned child and disposable data are removed; retain the printed log.

For deployment acceptance, separately test an actual public domain and an
owner-initiated real provider sign-in. A green offline run must not be reported
as a real OpenAI account login or proof of public DNS/TLS reachability.
