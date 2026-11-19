// Token apps end to end: check a pasted token live, keep it sealed, and add the app as an MCP server bots already know
// how to use (the vendor's own, or Metal's api_request endpoint); sign-ins to configured OAuth apps.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { tokenApp, type DevicePoll, type DeviceStart, type TokenAccountView, type TokenAppId, type TokenAppsStatus } from "../../shared/app-tokens.ts";
import { NATIVE_CONNECTORS, nativeConnector, type NativeConnector } from "../../shared/native-connectors.ts";
import type { StoredMcpServer } from "../mcp-registry.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { handleApiRpc } from "./mcp.ts";
import { APP_TOKENS_REDIRECT, authorizePage, deviceClients, exchangeCode, pollDevice, refreshDevice, SignInExpiredError, startDevice, type DeviceClients, type DeviceTokens } from "./device.ts";
import { accountView, TokenStore, type TokenAccount } from "./store.ts";
import { TokenCheckError, vendorFor, type ApiAccess, type TokenFields } from "./vendors.ts";

export const APP_TOKENS_MCP_PREFIX = "/api/app-tokens/mcp/";
/** Where a code-flow sign-in comes back to, sent on by APP_TOKENS_REDIRECT; public, checked by its state. */
export const APP_TOKENS_CALLBACK_PATH = "/api/app-tokens/callback";
const APP = /^\/api\/app-tokens\/([a-z]{2,20})$/u;
const DEVICE_START = /^\/api\/app-tokens\/([a-z]{2,20})\/device$/u;
const DEVICE_POLL = /^\/api\/app-tokens\/device\/([a-f0-9]{32})$/u;
const ACCOUNT = /^\/api\/app-tokens\/accounts\/([a-f0-9]{16})$/u;
const FIELD_KEYS = ["token", "key", "email", "site", "shop"] as const;
// a device token is refreshed this long before it expires, checked this often
const REFRESH_AHEAD_MS = 10 * 60_000;
const REFRESH_EVERY_MS = 5 * 60_000;
const ACCOUNT_ID = /^[a-f0-9]{16}$/u;

/** What the service needs of the MCP server list: the same writer Settings uses, so policy and limits apply. */
export interface TokenServers {
  names(): string[];
  add(name: string, server: StoredMcpServer): { ok: true } | { ok: false; status: number; error: string };
  replace(name: string, server: StoredMcpServer): void;
  remove(name: string): void;
}

export interface TokenAppsDeps {
  dataDir: string;
  /** The local server's own address, which an api app's MCP entry points at. */
  origin(): string;
  servers: TokenServers;
  clients?: DeviceClients;
  fetch?: typeof fetch;
  now?(): number;
  /** A reconnect took over this MCP server's account: a chat waiting on it may carry on. */
  reconnected?(server: string): void;
}

interface PendingDevice { connector: NativeConnector; deviceCode?: string; code?: { state: string; verifier: string; redirect: string }; replaces?: string; expiresAt: number; interval: number; nextAt: number; result?: DevicePoll }

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function freeName(base: string, taken: readonly string[]): string {
  let name = base;
  for (let suffix = 2; taken.includes(name); suffix++) name = `${base}-${suffix}`;
  return name;
}

export function createTokenApps(deps: TokenAppsDeps) {
  const store = new TokenStore(deps.dataDir);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const clients = deps.clients ?? deviceClients();
  const pending = new Map<string, PendingDevice>();

  const scrub = (text: string) => store.secretValues().reduce((safe, secret) => (safe.includes(secret) ? safe.split(secret).join("[hidden]") : safe), text);

  function serverFor(account: TokenAccount): StoredMcpServer {
    const vendor = vendorFor(account.app)!;
    if (vendor.mcp) return { type: "http", ...vendor.mcp(account.fields), enabled: true };
    return { type: "http", url: `${deps.origin()}${APP_TOKENS_MCP_PREFIX}${account.id}`, headers: { authorization: `Bearer ${account.mcpKey}` }, enabled: true };
  }

  function status(): TokenAppsStatus {
    return { accounts: store.list().map(accountView), native: Object.fromEntries(NATIVE_CONNECTORS.map((one) => [one.id, Boolean(clients[one.id])])) };
  }

  /** Checks the credentials live, keeps them sealed and adds the app's MCP server. */
  /** The account a reconnect takes over: one of the same app, or none when `replaces` is unset. */
  function replaced(app: TokenAppId, replaces: string | undefined): TokenAccount | undefined {
    if (replaces === undefined) return undefined;
    const old = ACCOUNT_ID.test(replaces) ? store.get(replaces) : undefined;
    if (!old || old.app !== app) throw new TokenCheckError("input", "That account isn't connected any more. Connect the app again.");
    return old;
  }

  async function connect(app: TokenAppId, fields: TokenFields, via: TokenAccount["via"], tokens?: DeviceTokens, replaces?: string): Promise<TokenAccountView> {
    const vendor = vendorFor(app);
    if (!vendor) throw new TokenCheckError("input", "No such app.");
    replaced(app, replaces);
    const label = await vendor.check(fields, fetchImpl, AbortSignal.timeout(20_000));
    // checked again: the old account may have been removed while the check ran
    const old = replaced(app, replaces);
    const id = hex(8);
    const server = old?.server ?? freeName(app, deps.servers.names());
    const account: TokenAccount = {
      id, app, label, server, via, connectedAt: now(),
      fields: Object.fromEntries(Object.entries({ ...fields, ...(tokens?.refresh ? { refresh: tokens.refresh } : {}) }).filter(([, value]) => typeof value === "string" && value)) as Record<string, string>,
      ...(vendor.mcp ? {} : { mcpKey: hex(32) }),
      ...(tokens?.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    };
    if (old) {
      // same server name, so every bot's access to it stays as it was
      store.remove(old.id);
      store.put(account);
      deps.servers.replace(server, serverFor(account));
      deps.reconnected?.(server);
      return accountView(account);
    }
    store.put(account);
    const added = deps.servers.add(server, serverFor(account));
    if (!added.ok) {
      store.remove(id);
      throw new TokenCheckError("input", added.error);
    }
    return accountView(account);
  }

  function markReconnect(account: TokenAccount): TokenAccount {
    const current = store.get(account.id);
    if (!current || current.needsReconnect) return current ?? account;
    const next: TokenAccount = { ...current, needsReconnect: true };
    store.put(next);
    return next;
  }

  /** A signed-in token's next one, saved, and the vendor server's header with it: when it is about to expire, or when
   * `force` says the app just refused it. A refresh token the vendor refuses marks the account for a reconnect. */
  async function fresh(account: TokenAccount, force = false): Promise<TokenAccount> {
    if (account.needsReconnect || !account.fields.refresh) return account;
    if (!force && (!account.expiresAt || account.expiresAt - now() > REFRESH_AHEAD_MS)) return account;
    const connector = nativeConnector(account.app);
    const client = clients[account.app];
    if (!connector || !client) return account;
    let tokens: DeviceTokens;
    try {
      tokens = await refreshDevice(connector, client, account.fields.refresh, fetchImpl, now());
    } catch (error) {
      if (error instanceof SignInExpiredError) return markReconnect(account);
      throw error;
    }
    const latest = store.get(account.id);
    if (!latest) return account;
    const next: TokenAccount = { ...latest, fields: { ...latest.fields, token: tokens.token, ...(tokens.refresh ? { refresh: tokens.refresh } : {}) }, ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}) };
    store.put(next);
    if (vendorFor(account.app)?.mcp) deps.servers.replace(account.server, serverFor(next));
    return next;
  }

  async function refreshDue(): Promise<void> {
    for (const account of store.list()) await fresh(account).catch((error) => console.warn(`App tokens: ${account.app} could not refresh its sign-in: ${error instanceof Error ? error.message : error}`));
  }

  /** Keeps signed-in tokens fresh while nobody has Connect apps open, so a bot never meets an expired one. */
  function startAutoRefresh(everyMs = REFRESH_EVERY_MS): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void refreshDue().finally(() => { running = false; });
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  function remove(id: string): boolean {
    const gone = store.remove(id);
    if (gone) deps.servers.remove(gone.server);
    return Boolean(gone);
  }

  async function beginDevice(app: string, replaces?: string): Promise<DeviceStart> {
    const connector = nativeConnector(app);
    const client = clients[app];
    if (!connector || !client) throw new TokenCheckError("input", "This sign-in isn't set up in this build yet.");
    replaced(app, replaces);
    for (const [key, entry] of pending) if (entry.expiresAt < now()) pending.delete(key);
    const handle = hex(16);
    if (connector.flow !== "device") {
      const redirect = APP_TOKENS_REDIRECT;
      const page = authorizePage(connector, client, redirect, Number(new URL(deps.origin()).port) || undefined);
      pending.set(handle, { connector, code: { state: page.state, verifier: page.verifier, redirect }, replaces, expiresAt: now() + 15 * 60_000, interval: 2, nextAt: 0 });
      return { handle, verificationUrl: page.url, expiresIn: 900, interval: 2 };
    }
    const code = await startDevice(connector, client, fetchImpl);
    pending.set(handle, { connector, deviceCode: code.deviceCode, replaces, expiresAt: now() + code.expiresIn * 1000, interval: code.interval, nextAt: now() + code.interval * 1000 });
    return { handle, userCode: code.userCode, verificationUrl: code.verificationUrl, expiresIn: code.expiresIn, interval: code.interval };
  }

  async function finish(entry: PendingDevice, tokens: DeviceTokens, fields: TokenFields = { token: tokens.token }): Promise<DevicePoll> {
    try {
      entry.result = { status: "connected", account: await connect(entry.connector.id, fields, "device", tokens, entry.replaces) };
    } catch (error) {
      entry.result = { status: "failed", message: error instanceof Error ? error.message : "The sign-in didn't finish." };
    }
    return entry.result;
  }

  /** The browser coming back from a code or fragment sign-in: matched to its sign-in by state, once. A fragment
   * sign-in's token arrives in a second request, posted by the page the first one gets (`page`). */
  async function callback(query: URLSearchParams, posted?: { token?: unknown }): Promise<{ ok: boolean; text: string; page?: true }> {
    const state = query.get("state") ?? "";
    const entry = [...pending.values()].find((one) => one.code?.state === state && !one.result);
    if (!entry?.code || entry.expiresAt < now()) return { ok: false, text: "This sign-in is over. Go back to Metal and start again." };
    const label = entry.connector.label;
    if (entry.connector.flow === "fragment") {
      if (!posted) return { ok: true, text: "", page: true };
      const token = typeof posted.token === "string" && /^[A-Za-z0-9_-]{16,256}$/u.test(posted.token) ? posted.token : null;
      if (!token) { entry.result = { status: "failed", message: "The sign-in was cancelled." }; return { ok: false, text: "The sign-in was cancelled. You can close this tab." }; }
      const result = await finish(entry, { token }, { key: clients[entry.connector.id]!.clientId, token });
      return result.status === "connected" ? { ok: true, text: `${label} is connected. You can close this tab.` } : { ok: false, text: "The sign-in didn't finish. Go back to Metal and try again." };
    }
    const code = query.get("code");
    if (!code) { entry.result = { status: "failed", message: "The sign-in was cancelled." }; return { ok: false, text: "The sign-in was cancelled. You can close this tab." }; }
    try {
      const tokens = await exchangeCode(entry.connector, clients[entry.connector.id]!, code, entry.code.verifier, entry.code.redirect, fetchImpl, now());
      const result = await finish(entry, tokens);
      return result.status === "connected" ? { ok: true, text: `${label} is connected. You can close this tab.` } : { ok: false, text: "The sign-in didn't finish. Go back to Metal and try again." };
    } catch {
      entry.result = { status: "failed", message: "The sign-in didn't finish. Start again." };
      return { ok: false, text: "The sign-in didn't finish. Go back to Metal and try again." };
    }
  }

  /** One check of a device sign-in; the vendor is asked at most once per its interval, whatever the window does. */
  async function checkDevice(handle: string): Promise<DevicePoll> {
    const entry = pending.get(handle);
    if (!entry) return { status: "failed", message: "This sign-in is over. Start again." };
    if (entry.result) return entry.result;
    if (entry.expiresAt < now()) { pending.delete(handle); return { status: "failed", message: "The code expired. Start again." }; }
    if (now() < entry.nextAt || !entry.deviceCode) return { status: "waiting" };
    const answer = await pollDevice(entry.connector, clients[entry.connector.id]!, entry.deviceCode, fetchImpl, now());
    if (answer.status === "waiting") {
      if (answer.slowDown) entry.interval += 5;
      entry.nextAt = now() + entry.interval * 1000;
      return { status: "waiting" };
    }
    if (answer.status === "failed") { entry.result = answer; return answer; }
    return finish(entry, answer.tokens);
  }

  const routes: RouteHandler = async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/app-tokens" && method === "GET") {
      void refreshDue();
      return json(res, 200, status());
    }
    const remove_ = ACCOUNT.exec(path);
    if (remove_ && method === "DELETE") return remove(remove_[1]!) ? json(res, 200, status()) : json(res, 404, { error: "That account isn't connected." });
    const device = DEVICE_START.exec(path);
    if (device && method === "POST") {
      if (!nativeConnector(device[1]!)) return json(res, 404, { error: "No such sign-in." });
      const body = await readBody(req, 2_000).catch(() => null) as { replaces?: unknown } | null;
      try { return json(res, 200, await beginDevice(device[1]!, typeof body?.replaces === "string" ? body.replaces : undefined)); }
      catch (error) { return json(res, error instanceof TokenCheckError ? 400 : 502, { error: error instanceof Error ? error.message : "The sign-in didn't start." }); }
    }
    const poll = DEVICE_POLL.exec(path);
    if (poll && method === "GET") {
      try { return json(res, 200, await checkDevice(poll[1]!)); }
      catch { return json(res, 200, { status: "waiting" } satisfies DevicePoll); }
    }
    const app = APP.exec(path);
    if (app && method === "POST") {
      const spec = tokenApp(app[1]!);
      if (!spec || !spec.fields.length) return json(res, 404, { error: "No such app." });
      const body = await readBody(req, 20_000).catch(() => null) as { fields?: Record<string, unknown>; replaces?: unknown } | null;
      const fields: TokenFields = {};
      for (const key of FIELD_KEYS) if (typeof body?.fields?.[key] === "string") fields[key] = (body.fields[key] as string).trim();
      try {
        return json(res, 201, { account: await connect(spec.id, fields, "token", undefined, typeof body?.replaces === "string" ? body.replaces : undefined), ...status() });
      } catch (error) {
        if (error instanceof TokenCheckError) return json(res, error.kind === "network" ? 502 : 400, { error: error.message, code: `token_${error.kind}` });
        throw error;
      }
    }
    return PASS;
  };

  /** Metal's own MCP endpoint for an api app. Security: loopback only, and the entry's own 256-bit bearer. */
  async function mcp(req: IncomingMessage, res: ServerResponse, path: string, method: string, body: () => Promise<unknown>, json: (res: ServerResponse, status: number, body: unknown) => void) {
    const account = store.get(path.slice(APP_TOKENS_MCP_PREFIX.length));
    const presented = /^Bearer ([a-f0-9]{64})$/u.exec(req.headers.authorization ?? "")?.[1];
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback || !account?.mcpKey || !presented || !timingSafeEqual(Buffer.from(presented), Buffer.from(account.mcpKey))) return json(res, 401, { error: "unauthorized" });
    if (method === "GET" || method === "DELETE") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const vendor = vendorFor(account.app)!;
    const latest = () => store.get(account.id) ?? account;
    // a renewal that fails for now (network) leaves the current token to answer for itself
    const access = async (): Promise<ApiAccess> => vendor.api!((await fresh(latest()).catch(() => latest())).fields);
    const refused = async (): Promise<ApiAccess | null> => {
      const before = latest();
      const after = await fresh(before, true).catch(() => before);
      if (after.fields.token !== before.fields.token && !after.needsReconnect) return vendor.api!(after.fields);
      markReconnect(before);
      return null;
    };
    const message = await body().catch(() => null);
    const answer = Array.isArray(message)
      ? (await Promise.all(message.map((one) => handleApiRpc(one, account.app, access, fetchImpl, scrub, refused)))).filter(Boolean)
      : await handleApiRpc(message, account.app, access, fetchImpl, scrub, refused);
    if (answer === undefined || (Array.isArray(answer) && !answer.length)) { res.writeHead(202); res.end(); return; }
    return json(res, 200, answer);
  }

  /** An api app's entry points at this server's address; a new port fixes it. */
  function repointServers(): void {
    for (const account of store.list()) {
      if (vendorFor(account.app)?.mcp) continue;
      try { deps.servers.replace(account.server, serverFor(account)); } catch {}
    }
  }

  /** The routes that answer before sign-in: the api endpoint (its own bearer) and the sign-in callback (its state). */
  async function publicRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string, body: () => Promise<unknown>, json: (res: ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
    if (url.pathname.startsWith(APP_TOKENS_MCP_PREFIX)) { await mcp(req, res, url.pathname, method, body, json); return true; }
    if (url.pathname !== APP_TOKENS_CALLBACK_PATH) return false;
    const posted = method === "POST" ? await body().catch(() => null) as { token?: unknown } | null : undefined;
    const answer = method === "GET" ? await callback(url.searchParams)
      : method === "POST" && posted ? await callback(url.searchParams, posted)
      : { ok: false, text: "Invalid sign-in callback." };
    if (answer.page) {
      // the token is in this page's #fragment, which the browser never sends: the page posts it back here, same origin
      const nonce = randomBytes(16).toString("base64");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(`<!doctype html><meta charset="utf-8"><title>Metal</title><p id="m">Finishing sign-in…</p><script nonce="${nonce}">
const token = new URLSearchParams(location.hash.slice(1)).get("token");
history.replaceState(null, "", location.pathname + location.search);
fetch(location.pathname + location.search, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
  .then((r) => r.text()).then((t) => { document.getElementById("m").textContent = t; }, () => { document.getElementById("m").textContent = "The sign-in didn't finish. Go back to Metal and try again."; });
</script>`);
      return true;
    }
    res.writeHead(answer.ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(answer.text);
    return true;
  }

  return { store, status, connect, remove, beginDevice, checkDevice, callback, refreshDue, startAutoRefresh, routes, mcp, publicRoute, scrub, repointServers };
}

export type TokenApps = ReturnType<typeof createTokenApps>;
