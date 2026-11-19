import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOKEN_APPS } from "../../shared/app-tokens.ts";
import type { StoredMcpServer } from "../mcp-registry.ts";
import { PASS, type RouteContext } from "../routes/table.ts";
import { authorizePage, exchangeCode, pollDevice, refreshDevice, startDevice } from "./device.ts";
import { nativeConnector, type NativeConnector } from "../../shared/native-connectors.ts";
import { apiUrl, callApi, handleApiRpc } from "./mcp.ts";
import { APP_TOKENS_MCP_PREFIX, createTokenApps, freeName } from "./service.ts";
import { APP_TOKENS_FILE } from "./store.ts";
import { configuredVendor, subdomain, TokenCheckError, VENDORS, vendorFor, type TokenFields } from "./vendors.ts";

type Call = { url: string; init: RequestInit };
/** A fetch that answers by URL prefix and records every call. */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call = { url, init };
    calls.push(call);
    const route = Object.keys(routes).sort((a, b) => b.length - a.length).find((prefix) => url.startsWith(prefix));
    if (!route) throw new TypeError(`fetch failed: ${url}`);
    const answer = routes[route]!(call);
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const signal = () => AbortSignal.timeout(5_000);

// one live-check answer per app, from each vendor's documented response shape
const WHOAMI: Record<string, { fields: TokenFields; url: string; body: unknown; label: string; auth: [string, string] }> = {
  github: { fields: { token: "github_pat_x" }, url: "https://api.github.com/user", body: { login: "octo" }, label: "octo", auth: ["authorization", "Bearer github_pat_x"] },
  notion: { fields: { token: "ntn_x" }, url: "https://api.notion.com/v1/users/me", body: { name: "bot", bot: { workspace_name: "Acme" } }, label: "Acme", auth: ["authorization", "Bearer ntn_x"] },
  linear: { fields: { token: "lin_api_x" }, url: "https://api.linear.app/graphql", body: { data: { viewer: { name: "Ada" } } }, label: "Ada", auth: ["authorization", "lin_api_x"] },
  airtable: { fields: { token: "patx" }, url: "https://api.airtable.com/v0/meta/whoami", body: { id: "usr1", email: "a@b.test" }, label: "a@b.test", auth: ["authorization", "Bearer patx"] },
  todoist: { fields: { token: "t0" }, url: "https://api.todoist.com/api/v1/user", body: { full_name: "Tod" }, label: "Tod", auth: ["authorization", "Bearer t0"] },
  trello: { fields: { key: "k1", token: "t1" }, url: "https://api.trello.com/1/members/me", body: { fullName: "Tre" }, label: "Tre", auth: ["authorization", ""] },
  clickup: { fields: { token: "pk_1" }, url: "https://api.clickup.com/api/v2/user", body: { user: { username: "cu" } }, label: "cu", auth: ["authorization", "pk_1"] },
  hubspot: { fields: { token: "pat-na1" }, url: "https://api.hubapi.com/account-info/v3/details", body: { portalId: 42 }, label: "HubSpot 42", auth: ["authorization", "Bearer pat-na1"] },
  jira: { fields: { site: "acme", email: "a@b.test", token: "j1" }, url: "https://acme.atlassian.net/rest/api/3/myself", body: { displayName: "Jay" }, label: "Jay", auth: ["authorization", `Basic ${Buffer.from("a@b.test:j1").toString("base64")}`] },
  shopify: { fields: { shop: "store.myshopify.com", token: "shpat_1" }, url: "https://store.myshopify.com/admin/api/", body: { shop: { name: "Store" } }, label: "Store", auth: ["x-shopify-access-token", "shpat_1"] },
  stripe: { fields: { token: "rk_live_1" }, url: "https://api.stripe.com/v1/balance", body: { object: "balance" }, label: "Stripe", auth: ["authorization", "Bearer rk_live_1"] },
  cloudflare: { fields: { token: "cf1" }, url: "https://api.cloudflare.com/client/v4/", body: { success: true, result: [{ name: "Acme account" }] }, label: "Acme account", auth: ["authorization", "Bearer cf1"] },
  dropbox: { fields: { token: "sl.x" }, url: "https://api.dropboxapi.com/2/users/get_current_account", body: { name: { display_name: "Dee" } }, label: "Dee", auth: ["authorization", "Bearer sl.x"] },
  googledrive: { fields: { token: "ya29" }, url: "https://www.googleapis.com/drive/v3/about", body: { user: { emailAddress: "g@b.test" } }, label: "g@b.test", auth: ["authorization", "Bearer ya29"] },
};

describe("vendor checks", () => {
  for (const app of TOKEN_APPS) {
    const fixture = WHOAMI[app.id];
    it(`${app.id}: checks the token live and names the account`, async () => {
      const fake = fakeFetch({ [fixture.url]: () => ({ body: fixture.body }) });
      expect(await vendorFor(app.id)!.check(fixture.fields, fake.impl, signal())).toBe(fixture.label);
      const [name, value] = fixture.auth;
      if (value) expect(header(fake.calls[0]!, name)).toBe(value);
      expect(fake.calls[0]!.init.redirect).toBe("error");
      // every app is reachable one way or the other
      expect(Boolean(vendorFor(app.id)!.mcp) || Boolean(vendorFor(app.id)!.api)).toBe(true);
    });
    it(`${app.id}: says the app refused a token`, async () => {
      const fake = fakeFetch({ [fixture.url]: () => ({ status: 401, body: {} }) });
      await expect(vendorFor(app.id)!.check(fixture.fields, fake.impl, signal())).rejects.toMatchObject({ kind: "refused" });
    });
  }

  it("puts Trello's key and token in the query, never a header", async () => {
    const fake = fakeFetch({ "https://api.trello.com/": () => ({ body: { fullName: "T" } }) });
    await VENDORS.trello.check({ key: "k1", token: "t1" }, fake.impl, signal());
    const url = new URL(fake.calls[0]!.url);
    expect(url.searchParams.get("key")).toBe("k1");
    expect(url.searchParams.get("token")).toBe("t1");
  });

  it("asks for a missing token instead of calling", async () => {
    const fake = fakeFetch({});
    await expect(VENDORS.notion.check({}, fake.impl, signal())).rejects.toMatchObject({ kind: "input" });
    expect(fake.calls).toHaveLength(0);
  });

  it("says a network failure is one", async () => {
    await expect(VENDORS.github.check({ token: "x" }, fakeFetch({}).impl, signal())).rejects.toMatchObject({ kind: "network" });
  });

  it("refuses a Stripe value that isn't a secret or restricted key", async () => {
    await expect(VENDORS.stripe.check({ token: "pk_live_1" }, fakeFetch({}).impl, signal())).rejects.toBeInstanceOf(TokenCheckError);
  });

  it("keeps a typed site or store to its own subdomain", () => {
    expect(subdomain("https://Acme.atlassian.net/jira", ".atlassian.net", "site")).toBe("acme");
    expect(subdomain("acme", ".atlassian.net", "site")).toBe("acme");
    for (const bad of ["evil.com/x", "a.b", "", "-x", "acme.atlassian.net.evil.com"]) {
      expect(() => subdomain(bad, ".atlassian.net", "site")).toThrow(TokenCheckError);
    }
  });

  it("gives GitHub, Linear and Cloudflare the vendor's own MCP server with the token as a bearer", () => {
    expect(VENDORS.github.mcp!({ token: "g" })).toEqual({ url: "https://api.githubcopilot.com/mcp/", headers: { authorization: "Bearer g" } });
    expect(VENDORS.linear.mcp!({ token: "l" }).url).toBe("https://mcp.linear.app/mcp");
    expect(VENDORS.cloudflare.mcp!({ token: "c" }).url).toBe("https://mcp.cloudflare.com/mcp");
  });
});

describe("api_request", () => {
  const access = { origin: "https://api.notion.com", headers: { authorization: "Bearer secret-token" }, docs: "https://developers.notion.com" };

  it("keeps every call on the app's own origin", () => {
    expect(String(apiUrl(access, "/v1/users/me", { page_size: "5" }))).toBe("https://api.notion.com/v1/users/me?page_size=5");
    for (const bad of ["https://evil.test/x", "//evil.test/x", "v1/users", "/a b", "/x\\y", 7]) expect(typeof apiUrl(access, bad, undefined)).toBe("string");
  });

  it("adds the credentials, sends JSON or form bodies and hides the token in what comes back", async () => {
    const fake = fakeFetch({ "https://api.notion.com/": () => ({ body: { echoed: "secret-token" } }) });
    const scrub = (text: string) => text.split("secret-token").join("[hidden]");
    const out = await callApi(access, { method: "post", path: "/v1/pages", body: { a: { b: 1 } } }, fake.impl, scrub);
    expect(header(fake.calls[0]!, "authorization")).toBe("Bearer secret-token");
    expect(fake.calls[0]!.init.body).toBe(JSON.stringify({ a: { b: 1 } }));
    expect(out.content[0]!.text).toBe('HTTP 200\n{"echoed":"[hidden]"}');
    await callApi(access, { method: "POST", path: "/v1/x", body: { amount: 5, metadata: { k: "v" } }, form: true }, fake.impl);
    expect(fake.calls[1]!.init.body).toBe("amount=5&metadata%5Bk%5D=v");
    expect(header(fake.calls[1]!, "content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("refuses an unknown method and marks HTTP errors", async () => {
    const fake = fakeFetch({ "https://api.notion.com/": () => ({ status: 404, body: { message: "nope" } }) });
    expect((await callApi(access, { method: "TRACE", path: "/x" }, fake.impl)).isError).toBe(true);
    expect((await callApi(access, { method: "GET", path: "/x" }, fake.impl)).isError).toBe(true);
  });

  it("answers MCP's initialize, tools/list and tools/call, and nothing for a notification", async () => {
    const fake = fakeFetch({ "https://api.notion.com/": () => ({ body: { ok: true } }) });
    const get = async () => access;
    expect(await handleApiRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "notion", get, fake.impl)).toBeUndefined();
    expect(await handleApiRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "notion", get, fake.impl)).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    const list = await handleApiRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "notion", get, fake.impl) as unknown as { result: { tools: Array<{ name: string; description: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["api_request"]);
    expect(list.result.tools[0]!.description).not.toContain("secret-token");
    const call = await handleApiRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "api_request", arguments: { method: "GET", path: "/v1/users/me" } } }, "notion", get, fake.impl);
    expect(call).toMatchObject({ id: 3, result: { content: [{ text: 'HTTP 200\n{"ok":true}' }] } });
    expect(await handleApiRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "other" } }, "notion", get, fake.impl)).toMatchObject({ error: { code: -32602 } });
  });
});

const GITHUB = nativeConnector("github")!;
const DRIVE = nativeConnector("googledrive")!;

describe("device sign-in", () => {
  it("starts GitHub's with the client id only and polls until done", async () => {
    const fake = fakeFetch({
      "https://github.com/login/device/code": () => ({ body: { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } }),
      "https://github.com/login/oauth/access_token": () => ({ body: { error: "authorization_pending" } }),
    });
    const code = await startDevice(GITHUB, { clientId: "Iv1.x" }, fake.impl);
    expect(code).toMatchObject({ userCode: "ABCD-1234", verificationUrl: "https://github.com/login/device", interval: 5 });
    expect(String(fake.calls[0]!.init.body)).toBe("client_id=Iv1.x");
    expect(await pollDevice(GITHUB, { clientId: "Iv1.x" }, "dc", fake.impl)).toEqual({ status: "waiting" });
    expect(String(fake.calls[1]!.init.body)).not.toContain("client_secret");
  });

  it("asks Google for drive.file only, with its installed-app secret", async () => {
    const fake = fakeFetch({
      "https://oauth2.googleapis.com/device/code": () => ({ body: { device_code: "dc", user_code: "XYZ", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 } }),
      "https://oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29", refresh_token: "1//r", expires_in: 3599 } }),
    });
    await startDevice(DRIVE, { clientId: "c", clientSecret: "s" }, fake.impl);
    expect(new URLSearchParams(String(fake.calls[0]!.init.body)).get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    const done = await pollDevice(DRIVE, { clientId: "c", clientSecret: "s" }, "dc", fake.impl, 1_000);
    expect(done).toEqual({ status: "done", tokens: { token: "ya29", refresh: "1//r", expiresAt: 1_000 + 3_599_000 } });
    const next = await refreshDevice(DRIVE, { clientId: "c", clientSecret: "s" }, "1//r", fake.impl, 0);
    expect(next.refresh).toBe("1//r");
  });

  it("reads a denial and an expired code", async () => {
    const denied = fakeFetch({ "https://github.com/": () => ({ body: { error: "access_denied" } }) });
    expect(await pollDevice(GITHUB, { clientId: "c" }, "dc", denied.impl)).toMatchObject({ status: "failed" });
    const expired = fakeFetch({ "https://github.com/": () => ({ body: { error: "expired_token" } }) });
    expect(await pollDevice(GITHUB, { clientId: "c" }, "dc", expired.impl)).toMatchObject({ status: "failed" });
  });
});

describe("token apps service", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function setup(routes: Parameters<typeof fakeFetch>[0], clients = { github: null, googledrive: null }) {
    const dataDir = mkdtempSync(join(tmpdir(), "app-tokens-"));
    dirs.push(dataDir);
    const servers = new Map<string, StoredMcpServer>();
    const fake = fakeFetch(routes);
    let clock = 1_000_000;
    const apps = createTokenApps({
      dataDir, origin: () => "http://127.0.0.1:8799", fetch: fake.impl, clients, now: () => clock,
      servers: {
        names: () => [...servers.keys()],
        add: (name, server) => { servers.set(name, server); return { ok: true }; },
        replace: (name, server) => { servers.set(name, server); },
        remove: (name) => { servers.delete(name); },
      },
    });
    return { apps, servers, fake, dataDir, tick: (ms: number) => { clock += ms; } };
  }

  async function route(apps: ReturnType<typeof createTokenApps>, method: string, path: string, body?: unknown) {
    let status = 0;
    let answer: any;
    const ctx = {
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method, auth: {} as RouteContext["auth"],
      json: (_res: ServerResponse, code: number, data: unknown) => { status = code; answer = data; },
      readBody: async () => body,
    } as unknown as RouteContext;
    const out = await apps.routes(ctx);
    return { status, answer, passed: out === PASS };
  }

  it("connects a vendor-MCP app: the token goes into the server's header and nowhere readable", async () => {
    const { apps, servers, dataDir } = setup({ "https://api.github.com/user": () => ({ body: { login: "octo" } }) });
    const { status, answer } = await route(apps, "POST", "/api/app-tokens/github", { fields: { token: "github_pat_secret" } });
    expect(status).toBe(201);
    expect(answer.account).toMatchObject({ app: "github", label: "octo", server: "github", via: "token" });
    expect(JSON.stringify(answer)).not.toContain("github_pat_secret");
    expect(servers.get("github")).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { authorization: "Bearer github_pat_secret" }, enabled: true });
    expect(readFileSync(join(dataDir, APP_TOKENS_FILE)).includes(Buffer.from("github_pat_secret"))).toBe(false);
    expect(apps.scrub("leak github_pat_secret")).toBe("leak [hidden]");
  });

  it("connects an api app behind Metal's own endpoint, and a second account under its own name", async () => {
    const { apps, servers } = setup({ "https://api.notion.com/": () => ({ body: { bot: { workspace_name: "Acme" } } }) });
    await route(apps, "POST", "/api/app-tokens/notion", { fields: { token: "ntn_one" } });
    await route(apps, "POST", "/api/app-tokens/notion", { fields: { token: "ntn_two" } });
    const [first, second] = apps.status().accounts;
    expect([first!.server, second!.server]).toEqual(["notion", "notion-2"]);
    const entry = servers.get("notion") as { url: string; headers: Record<string, string> };
    expect(entry.url).toBe(`http://127.0.0.1:8799${APP_TOKENS_MCP_PREFIX}${first!.id}`);
    expect(entry.headers.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("ntn_one");
  });

  it("says why a token was refused and keeps nothing", async () => {
    const { apps, servers } = setup({ "https://api.notion.com/": () => ({ status: 401, body: {} }) });
    const { status, answer } = await route(apps, "POST", "/api/app-tokens/notion", { fields: { token: "bad" } });
    expect(status).toBe(400);
    expect(answer.code).toBe("token_refused");
    expect(apps.status().accounts).toEqual([]);
    expect(servers.size).toBe(0);
  });

  it("disconnects one account and its server", async () => {
    const { apps, servers } = setup({ "https://api.clickup.com/": () => ({ body: { user: { username: "cu" } } }) });
    await route(apps, "POST", "/api/app-tokens/clickup", { fields: { token: "pk_1" } });
    const id = apps.status().accounts[0]!.id;
    expect((await route(apps, "DELETE", `/api/app-tokens/accounts/${id}`)).status).toBe(200);
    expect(servers.size).toBe(0);
    expect((await route(apps, "DELETE", `/api/app-tokens/accounts/${id}`)).status).toBe(404);
  });

  it("serves the api endpoint only on loopback with the entry's own bearer", async () => {
    const { apps, servers } = setup({ "https://api.notion.com/": () => ({ body: { bot: { workspace_name: "Acme" }, results: [] } }) });
    await route(apps, "POST", "/api/app-tokens/notion", { fields: { token: "ntn_one" } });
    const account = apps.status().accounts[0]!;
    const bearer = (servers.get("notion") as { headers: Record<string, string> }).headers.authorization!;
    const call = async (authorization: string, remoteAddress = "127.0.0.1") => {
      let status = 0; let body: any;
      const req = { headers: { authorization }, socket: { remoteAddress } } as unknown as IncomingMessage;
      const res = { writeHead: (code: number) => { status = code; }, end: () => {} } as unknown as ServerResponse;
      await apps.mcp(req, res, `${APP_TOKENS_MCP_PREFIX}${account.id}`, "POST",
        async () => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "api_request", arguments: { method: "GET", path: "/v1/search" } } }),
        (_res, code, data) => { status = code; body = data; });
      return { status, body };
    };
    expect((await call(`Bearer ${"0".repeat(64)}`)).status).toBe(401);
    expect((await call(bearer, "10.0.0.5")).status).toBe(401);
    const ok = await call(bearer);
    expect(ok.status).toBe(200);
    expect(ok.body.result.content[0].text).toMatch(/^HTTP 200/);
  });

  it("signs in to Google Drive with a device code, then refreshes the token before it expires", async () => {
    let refreshed = 0;
    const { apps, servers, tick } = setup({
      "https://oauth2.googleapis.com/device/code": () => ({ body: { device_code: "dc", user_code: "XYZ", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 } }),
      "https://oauth2.googleapis.com/token": (call) => new URLSearchParams(String(call.init.body)).get("grant_type") === "refresh_token"
        ? (refreshed++, { body: { access_token: "ya29-new", expires_in: 3600 } })
        : { body: { access_token: "ya29", refresh_token: "1//r", expires_in: 3600 } },
      "https://www.googleapis.com/": () => ({ body: { user: { emailAddress: "g@b.test" } } }),
    }, { github: null, googledrive: { clientId: "c", clientSecret: "s" } } as never);
    expect(apps.status().native).toMatchObject({ github: false, googledrive: true, notion: false });
    const start = await route(apps, "POST", "/api/app-tokens/googledrive/device");
    expect(start.answer).toMatchObject({ userCode: "XYZ", verificationUrl: "https://www.google.com/device" });
    expect((await route(apps, "GET", `/api/app-tokens/device/${start.answer.handle}`)).answer).toEqual({ status: "waiting" });
    tick(5_000);
    const done = (await route(apps, "GET", `/api/app-tokens/device/${start.answer.handle}`)).answer;
    expect(done).toMatchObject({ status: "connected", account: { app: "googledrive", label: "g@b.test", via: "device" } });
    expect(servers.has("googledrive")).toBe(true);
    tick(55 * 60_000);
    await apps.refreshDue();
    expect(refreshed).toBe(1);
    expect(apps.scrub("ya29-new")).toBe("[hidden]");
  });

  it("offers no device sign-in a build has no client for", async () => {
    const { apps } = setup({});
    expect((await route(apps, "POST", "/api/app-tokens/github/device")).status).toBe(400);
  });

  it("names servers without taking one that exists", () => {
    expect(freeName("github", [])).toBe("github");
    expect(freeName("github", ["github", "github-2"])).toBe("github-3");
  });
});

describe("device clients", () => {
  it("reads the environment first, then what the release was built with, and needs Google's secret", async () => {
    const { deviceClients } = await import("./device.ts");
    expect(Object.values(deviceClients({}, {})).every((client) => client === null)).toBe(true);
    expect(deviceClients({ DUSK_GITHUB_APP_CLIENT_ID: "Iv1.env" }, { DUSK_GITHUB_APP_CLIENT_ID: "Iv1.built" }).github).toEqual({ clientId: "Iv1.env" });
    expect(deviceClients({}, { DUSK_GITHUB_APP_CLIENT_ID: "Iv1.built" }).github).toEqual({ clientId: "Iv1.built" });
    expect(deviceClients({}, { DUSK_GOOGLE_DRIVE_CLIENT_ID: "g" }).googledrive).toBeNull();
    expect(deviceClients({}, { DUSK_GOOGLE_DRIVE_CLIENT_ID: "g", DUSK_GOOGLE_DRIVE_CLIENT_SECRET: "s" }).googledrive).toEqual({ clientId: "g", clientSecret: "s" });
  });
});

describe("a native connector added as a row", () => {
  const row: NativeConnector = {
    id: "acme", label: "Acme", domain: "acme.test", flow: "code", clientIdEnv: "DUSK_ACME_CLIENT_ID", clientSecretEnv: "DUSK_ACME_CLIENT_SECRET",
    authorizeUrl: "https://acme.test/oauth/authorize", tokenUrl: "https://acme.test/oauth/token", scopes: ["read", "write"], authorizeParams: { access_type: "offline" },
    check: { url: "https://api.acme.test/me", label: "profile.name" }, use: { api: "https://api.acme.test", docs: "https://acme.test/docs" },
  };

  it("reads its client from the env names it lists, needing the secret it names", async () => {
    const { deviceClients } = await import("./device.ts");
    expect(deviceClients({ DUSK_ACME_CLIENT_ID: "id" }, {}, [row]).acme).toBeNull();
    expect(deviceClients({ DUSK_ACME_CLIENT_ID: "id", DUSK_ACME_CLIENT_SECRET: "s" }, {}, [row]).acme).toEqual({ clientId: "id", clientSecret: "s" });
  });

  it("checks and serves the token from the row alone", async () => {
    const fake = fakeFetch({ "https://api.acme.test/me": () => ({ body: { profile: { name: "Ada" } } }) });
    const vendor = configuredVendor(row);
    expect(await vendor.check({ token: "tok" }, fake.impl, signal())).toBe("Ada");
    expect(header(fake.calls[0]!, "authorization")).toBe("Bearer tok");
    expect(vendor.api!({ token: "tok" })).toMatchObject({ origin: "https://api.acme.test", headers: { authorization: "Bearer tok" } });
    expect(configuredVendor({ ...row, use: { mcp: "https://mcp.acme.test/mcp" } }).mcp!({ token: "tok" })).toEqual({ url: "https://mcp.acme.test/mcp", headers: { authorization: "Bearer tok" } });
  });

  it("signs in with a loopback redirect and PKCE, then trades the code", async () => {
    const page = authorizePage(row, { clientId: "id", clientSecret: "s" }, "http://127.0.0.1:8799/api/app-tokens/callback");
    const url = new URL(page.url);
    expect(url.origin + url.pathname).toBe("https://acme.test/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "id", redirect_uri: "http://127.0.0.1:8799/api/app-tokens/callback", state: page.state, scope: "read write", code_challenge_method: "S256", access_type: "offline" });
    expect(url.searchParams.has("client_secret")).toBe(false);
    const fake = fakeFetch({ "https://acme.test/oauth/token": () => ({ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }) });
    expect(await exchangeCode(row, { clientId: "id", clientSecret: "s" }, "c0de", page.verifier, "http://127.0.0.1:8799/api/app-tokens/callback", fake.impl, 0)).toEqual({ token: "at", refresh: "rt", expiresAt: 60_000 });
    expect(new URLSearchParams(String(fake.calls[0]!.init.body)).get("code_verifier")).toBe(page.verifier);
  });
});

describe("the GitHub and Google Drive rows", () => {
  it("ask for no review: GitHub without scopes, Drive for drive.file only", () => {
    expect(GITHUB).toMatchObject({ flow: "device", clientIdEnv: "DUSK_GITHUB_APP_CLIENT_ID", scopes: [] });
    expect(DRIVE.scopes).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(TOKEN_APPS.find((app) => app.id === "github")).toMatchObject({ native: true });
    expect(TOKEN_APPS.find((app) => app.id === "googledrive")).toMatchObject({ native: true, fields: [] });
  });
});

describe("native sign-ins to Metal's own OAuth apps", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function setup(routes: Parameters<typeof fakeFetch>[0], clients: Record<string, { clientId: string; clientSecret?: string } | null>) {
    const dataDir = mkdtempSync(join(tmpdir(), "app-tokens-native-"));
    dirs.push(dataDir);
    const servers = new Map<string, StoredMcpServer>();
    const fake = fakeFetch(routes);
    let clock = 1_000_000;
    const reconnected: string[] = [];
    const apps = createTokenApps({
      dataDir, origin: () => "http://127.0.0.1:8799", fetch: fake.impl, clients, now: () => clock, reconnected: (server) => reconnected.push(server),
      servers: {
        names: () => [...servers.keys()],
        add: (name, server) => { servers.set(name, server); return { ok: true }; },
        replace: (name, server) => { servers.set(name, server); },
        remove: (name) => { servers.delete(name); },
      },
    });
    return { apps, servers, fake, reconnected, tick: (ms: number) => { clock += ms; } };
  }

  async function signIn(apps: ReturnType<typeof createTokenApps>, app: string, replaces?: string) {
    const start = await apps.beginDevice(app, replaces);
    const state = new URL(start.verificationUrl).searchParams.get("state")!;
    const page = await apps.callback(new URLSearchParams({ state, code: "c0de" }));
    return { start, page };
  }

  it("sends Notion back through the one fixed redirect, naming this server's port in the state, and trades the code with Basic auth and JSON", async () => {
    const { apps, fake } = setup({
      "https://api.notion.com/v1/oauth/token": () => ({ body: { access_token: "ntn-oauth", workspace_name: "Acme" } }),
      "https://api.notion.com/v1/users/me": () => ({ body: { bot: { workspace_name: "Acme" } } }),
    }, { notion: { clientId: "nid", clientSecret: "nsecret" } });
    const { start, page } = await signIn(apps, "notion");
    const url = new URL(start.verificationUrl);
    expect(url.searchParams.get("redirect_uri")).toBe("https://link.dusk.bot/oauth/app-tokens");
    expect(url.searchParams.get("state")).toMatch(/^8799\.[0-9a-f]{32}$/u);
    expect(url.searchParams.get("owner")).toBe("user");
    expect(page.ok).toBe(true);
    const trade = fake.calls.find((call) => call.url === "https://api.notion.com/v1/oauth/token")!;
    expect(header(trade, "authorization")).toBe(`Basic ${Buffer.from("nid:nsecret").toString("base64")}`);
    expect(header(trade, "content-type")).toBe("application/json");
    expect(JSON.parse(String(trade.init.body))).toMatchObject({ grant_type: "authorization_code", code: "c0de", redirect_uri: "https://link.dusk.bot/oauth/app-tokens", client_id: "nid" });
    expect(String(trade.init.body)).not.toContain("nsecret");
    expect(apps.status().accounts).toMatchObject([{ app: "notion", label: "Acme", via: "device" }]);
  });

  it("signs in to Dropbox with PKCE and no secret, and names the account from its POST-only check", async () => {
    const { apps, fake, servers } = setup({
      "https://api.dropboxapi.com/oauth2/token": () => ({ body: { access_token: "sl.at", refresh_token: "rt", expires_in: 14_400 } }),
      "https://api.dropboxapi.com/2/users/get_current_account": () => ({ body: { name: { display_name: "Dee" } } }),
    }, { dropbox: { clientId: "did" } });
    const { start } = await signIn(apps, "dropbox");
    expect(new URL(start.verificationUrl).searchParams.get("token_access_type")).toBe("offline");
    const trade = new URLSearchParams(String(fake.calls[0]!.init.body));
    expect(trade.get("code_verifier")).toBeTruthy();
    expect(trade.has("client_secret")).toBe(false);
    const check = fake.calls.find((call) => call.url.endsWith("get_current_account"))!;
    expect(check.init.method).toBe("POST");
    expect(check.init.body).toBeUndefined();
    expect(apps.status().accounts[0]).toMatchObject({ app: "dropbox", label: "Dee" });
    expect((servers.get("dropbox") as { url?: string } | undefined)?.url).toMatch(/^http:\/\/127\.0\.0\.1:8799\/api\/app-tokens\/mcp\//u);
  });

  it("gives Linear's OAuth token as a bearer, where a personal key goes bare", async () => {
    const fake = fakeFetch({ "https://api.linear.app/graphql": () => ({ body: { data: { viewer: { name: "Ada" } } } }) });
    await VENDORS.linear!.check({ token: "lin_oauth_x" }, fake.impl, signal());
    await VENDORS.linear!.check({ token: "lin_api_x" }, fake.impl, signal());
    expect(fake.calls.map((call) => header(call, "authorization"))).toEqual(["Bearer lin_oauth_x", "lin_api_x"]);
  });

  it("signs in to Trello through its token page: the page posts the #fragment back and the account keeps our API key", async () => {
    const { apps } = setup({ "https://api.trello.com/1/members/me": () => ({ body: { fullName: "Tre" } }) }, { trello: { clientId: "trellokey" } });
    const start = await apps.beginDevice("trello");
    const url = new URL(start.verificationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ key: "trellokey", callback_method: "fragment", response_type: "token", scope: "read,write", expiration: "never" });
    const back = new URL(url.searchParams.get("return_url")!);
    expect(back.origin + back.pathname).toBe("https://link.dusk.bot/oauth/app-tokens");
    const page = await apps.callback(back.searchParams);
    expect(page.page).toBe(true);
    const done = await apps.callback(back.searchParams, { token: "ATTA0123456789abcdef0123" });
    expect(done.ok).toBe(true);
    expect(apps.store.list()[0]!.fields).toMatchObject({ key: "trellokey", token: "ATTA0123456789abcdef0123" });
    expect((await apps.callback(back.searchParams, { token: "ATTA0123456789abcdef0123" })).ok).toBe(false);
  });

  it("reconnects in place: the new sign-in takes the old account's server name, so bots keep their access", async () => {
    const { apps, servers } = setup({
      "https://todoist.com/oauth/access_token": () => ({ body: { access_token: "td-new" } }),
      "https://api.todoist.com/api/v1/user": () => ({ body: { full_name: "Tod" } }),
    }, { todoist: { clientId: "tid", clientSecret: "ts" } });
    await signIn(apps, "todoist");
    const old = apps.store.list()[0]!;
    servers.set("todoist-2", { type: "http", url: "https://other.test", headers: {}, enabled: true } as StoredMcpServer);
    await signIn(apps, "todoist", old.id);
    const accounts = apps.store.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.server).toBe(old.server);
    expect(accounts[0]!.id).not.toBe(old.id);
    await expect(apps.beginDevice("todoist", "0000000000000000")).rejects.toThrow(/isn't connected/u);
  });

  async function apiCall(apps: ReturnType<typeof createTokenApps>, servers: Map<string, StoredMcpServer>, path: string) {
    const account = apps.store.list()[0]!;
    const bearer = (servers.get(account.server) as { headers: Record<string, string> }).headers.authorization!;
    let body: any;
    const req = { headers: { authorization: bearer }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;
    await apps.mcp(req, res, `${APP_TOKENS_MCP_PREFIX}${account.id}`, "POST",
      async () => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "api_request", arguments: { method: "GET", path } } }),
      (_res, _code, data) => { body = data; });
    return body.result as { content: { text: string }[]; isError?: boolean };
  }

  it("renews a token the app refuses mid-call and retries once with the new one", async () => {
    const { apps, servers } = setup({
      "https://airtable.com/oauth2/v1/token": (call) => new URLSearchParams(String(call.init.body)).get("grant_type") === "refresh_token"
        ? { body: { access_token: "air-2", refresh_token: "r2", expires_in: 3600 } }
        : { body: { access_token: "air-1", refresh_token: "r1", expires_in: 3600 } },
      "https://api.airtable.com/v0/meta/whoami": () => ({ body: { email: "a@b.test" } }),
      "https://api.airtable.com/v0/bases": (call) => (header(call, "authorization") === "Bearer air-2" ? { body: { bases: [] } } : { status: 401, body: { error: "AUTHENTICATION_REQUIRED" } }),
    }, { airtable: { clientId: "aid", clientSecret: "as" } });
    await signIn(apps, "airtable");
    const result = await apiCall(apps, servers, "/v0/bases");
    expect(result.content[0]!.text).toMatch(/^HTTP 200/u);
    expect(apps.store.list()[0]!.fields.token).toBe("air-2");
    expect(apps.status().accounts[0]!.needsReconnect).toBeUndefined();
  });

  it("asks for a reconnect when the app refuses both the token and its refresh token, and says so to the bot", async () => {
    const { apps, servers } = setup({
      "https://airtable.com/oauth2/v1/token": (call) => new URLSearchParams(String(call.init.body)).get("grant_type") === "refresh_token"
        ? { status: 400, body: { error: "invalid_grant" } }
        : { body: { access_token: "air-1", refresh_token: "r1", expires_in: 3600 } },
      "https://api.airtable.com/v0/meta/whoami": () => ({ body: { email: "a@b.test" } }),
      "https://api.airtable.com/v0/bases": () => ({ status: 401, body: { error: "AUTHENTICATION_REQUIRED" } }),
    }, { airtable: { clientId: "aid", clientSecret: "as" } });
    await signIn(apps, "airtable");
    const result = await apiCall(apps, servers, "/v0/bases");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Ask the person to reconnect Airtable in Connect apps.");
    expect(apps.status().accounts[0]!.needsReconnect).toBe(true);
  });

  it("marks a dead refresh token for a reconnect when the background renewal meets it", async () => {
    const { apps, tick } = setup({
      "https://api.dropboxapi.com/oauth2/token": (call) => new URLSearchParams(String(call.init.body)).get("grant_type") === "refresh_token"
        ? { status: 400, body: { error: "invalid_grant", error_description: "refresh token is invalid or revoked" } }
        : { body: { access_token: "sl.at", refresh_token: "rt", expires_in: 14_400 } },
      "https://api.dropboxapi.com/2/users/get_current_account": () => ({ body: { name: { display_name: "Dee" } } }),
    }, { dropbox: { clientId: "did" } });
    await signIn(apps, "dropbox");
    tick(4 * 3_600_000);
    await apps.refreshDue();
    expect(apps.status().accounts[0]).toMatchObject({ app: "dropbox", needsReconnect: true });
  });

  it("reconnects a refused account in place: same server, and the chats waiting on it hear so", async () => {
    let grants = 0;
    const { apps, tick, servers, reconnected } = setup({
      "https://api.dropboxapi.com/oauth2/token": (call) => new URLSearchParams(String(call.init.body)).get("grant_type") === "refresh_token"
        ? { status: 400, body: { error: "invalid_grant" } }
        : { body: { access_token: `sl.at${grants++}`, refresh_token: "rt", expires_in: 14_400 } },
      "https://api.dropboxapi.com/2/users/get_current_account": () => ({ body: { name: { display_name: "Dee" } } }),
    }, { dropbox: { clientId: "did" } });
    await signIn(apps, "dropbox");
    tick(4 * 3_600_000);
    await apps.refreshDue();
    const stale = apps.status().accounts[0]!;
    expect(stale.needsReconnect).toBe(true);
    expect(reconnected).toEqual([]);
    await signIn(apps, "dropbox", stale.id);
    const accounts = apps.status().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ server: stale.server });
    expect(accounts[0]!.needsReconnect).toBeUndefined();
    expect([...servers.keys()]).toEqual([stale.server]);
    expect(reconnected).toEqual([stale.server]);
  });

  it("tells the bot when the app is rate limiting, with the wait it asked for", async () => {
    const fake = fakeFetch({ "https://api.x.test/": () => ({ status: 429, body: { error: "slow down" } }) });
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const answer = await fake.impl(url, init);
      return new Response(await answer.text(), { status: 429, headers: { "retry-after": "30" } });
    }) as typeof fetch;
    const out = await callApi({ origin: "https://api.x.test", headers: {}, docs: "" }, { method: "GET", path: "/x" }, impl, undefined, { label: "Acme" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("Acme is limiting how fast it can be called. Wait 30 seconds before the next call.");
  });
});
