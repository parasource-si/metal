import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cardOwner, McpOAuthError, McpOAuthManager, mcpCallbackOrigin, mcpOAuthRedirectUri, type McpSignInPhase, type McpSignInStatus, withMcpSignIn, withoutPendingSignIn } from "./mcp-oauth.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";
import { MCP_CLIENT_ID, MCP_CLIENT_METADATA, MCP_CLIENT_METADATA_REDIRECT } from "../shared/mcp-client-metadata.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth, type FakeOAuthOptions } from "./testing/fake-oauth-server.ts";
import { engineMcpSignIn, MCP_OAUTH_PROXY_PATH, mcpOAuthProxyRoutes } from "./mcp-oauth-proxy.ts";
import { PASS } from "./routes/table.ts";
import { decryptBrowserState } from "./browser-sites.ts";
import { withFreeSignInPort } from "./testing/ports.ts";

let dir: string;
let oauth: FakeOAuth;
let mcp: FakeHttpMcp;
let manager: McpOAuthManager;
let registered: McpOAuthClientConfig | undefined;

/** Tokens the MCP server refuses although they are unexpired, as after the provider revoked them. */
const refusedTokens = new Set<string>();

async function setup(options: FakeOAuthOptions = {}, lifetimeMs?: number) {
  oauth = await startFakeOAuth(options);
  mcp = await startFakeHttpMcp({ acceptBearer: (auth) => oauth.isValid(auth) && !refusedTokens.has(auth ?? ""), wwwAuthenticate: oauth.challenge });
  // a pre-registered app returns to the port derived from the URL: make it a free one
  if (options.preRegistered) mcp = { ...mcp, url: await withFreeSignInPort(mcp.url) };
  manager = new McpOAuthManager({
    file: join(dir, "mcp-oauth.json"),
    ...(lifetimeMs ? { lifetimeMs } : {}),
    clients: (name, url) => (name === "docs" && url === mcp.url ? registered : undefined),
  });
}

async function approve(status: McpSignInStatus) {
  return fetch(status.authorizationUrl!, { redirect: "follow" });
}

async function settled(name: string, flowId: string): Promise<McpSignInStatus> {
  for (let i = 0; i < 100; i++) {
    const status = manager.status(name, flowId);
    if (status && status.phase !== "waiting") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("sign-in never settled");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  registered = undefined;
});
afterEach(async () => {
  manager?.dispose();
  await mcp?.close();
  await oauth?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("McpOAuthManager sign-in", () => {
  it("reads where a server signs in once, ahead of the press when warmed, so a start only registers", async () => {
    await setup();
    const reads: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/.well-known/") || url === mcp.url) reads.push(url);
      return real(input, init);
    });
    try {
      manager.warm(mcp.url);
      await expect.poll(() => reads.filter((url) => url.includes("oauth-authorization-server")).length).toBe(1);
      const before = reads.length;
      const first = await manager.start("docs", mcp.url);
      expect(first.phase).toBe("waiting");
      expect(reads.length, "the warmed addresses are used, nothing read again").toBe(before);
      expect(oauth.counts.register).toBe(1);
      manager.cancel("docs");
      await manager.start("docs", mcp.url);
      expect(reads.length).toBe(before);
      expect(oauth.counts.register, "a fresh client per sign-in still").toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("signs in through the browser and returns a working token", async () => {
    await setup();
    expect(manager.authState("docs", mcp.url)).toBe("none");
    const started = await manager.start("docs", mcp.url);
    expect(started.phase).toBe("waiting");
    const link = new URL(started.authorizationUrl!);
    expect(link.origin + link.pathname).toBe(`${oauth.issuer}/authorize`);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("resource")).toBe(mcp.url);
    expect(link.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-oauth\/callback$/);

    const page = await approve(started);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Signed in/);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");

    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
  });

  it("reuses the waiting flow when sign-in is started twice", async () => {
    await setup();
    const [a, b] = await Promise.all([manager.start("docs", mcp.url), manager.start("docs", mcp.url)]);
    expect(a.flowId).toBe(b.flowId);
    expect(oauth.counts.register).toBe(1);
  });

  it("rejects a callback with the wrong state and keeps waiting", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    const redirect = new URL(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", "forged");
    redirect.searchParams.set("code", "stolen");
    const response = await fetch(redirect);
    expect(response.status).toBe(400);
    expect(manager.status("docs", started.flowId)?.phase).toBe("waiting");
  });

  it("expires a sign-in nobody finishes and closes its listener", async () => {
    await setup({}, 100);
    const started = await manager.start("docs", mcp.url);
    expect((await settled("docs", started.flowId)).phase).toBe("expired");
    await expect(approve(started)).rejects.toThrow();
  });

  it("reports a denied sign-in", async () => {
    await setup({ deny: true });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    const status = await settled("docs", started.flowId);
    expect(status.phase).toBe("failed");
    expect(status.message).toMatch(/not approved/);
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("explains a server that offers no client registration", async () => {
    await setup({ noRegistration: true });
    await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "no-registration" });
  });

  it("signs in with Metal's client metadata document where a server registers nobody but takes one", async () => {
    await setup({ noRegistration: true, metadataDocument: true });
    const status = await manager.start("docs", mcp.url);
    const authorize = new URL(status.authorizationUrl!);
    expect(authorize.searchParams.get("client_id")).toBe(MCP_CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(MCP_CLIENT_METADATA_REDIRECT);
    manager.cancel("docs");
  });

  it("falls back to the metadata document when a server refuses to register Metal", async () => {
    await setup({ refuseRedirect: () => true, metadataDocument: true });
    const status = await manager.start("docs", mcp.url);
    expect(new URL(status.authorizationUrl!).searchParams.get("client_id")).toBe(MCP_CLIENT_ID);
    manager.cancel("docs");
  });

  it("refuses a server that does not use OAuth", async () => {
    await setup();
    const open = await startFakeHttpMcp();
    try {
      const error = await manager.start("open", open.url).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(McpOAuthError);
      expect(error).toMatchObject({ code: "not-oauth" });
    } finally {
      await open.close();
    }
  });
});

describe("McpOAuthManager tokens", () => {
  async function signedIn(options: FakeOAuthOptions = {}) {
    await setup(options);
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
  }

  it("refreshes a token about to expire, once for concurrent callers", async () => {
    await signedIn({ expiresIn: 60 });
    const [a, b] = await Promise.all([manager.accessToken("docs", mcp.url), manager.accessToken("docs", mcp.url)]);
    expect(oauth.counts.refresh).toBe(1);
    expect(a).toBe(b);
    expect(oauth.isValid(`Bearer ${a}`)).toBe(true);
  });

  it("does not refresh a token with time left", async () => {
    await signedIn({ expiresIn: 3600 });
    await manager.accessToken("docs", mcp.url);
    expect(oauth.counts.refresh).toBe(0);
  });

  it("marks the server as needing sign-in when refresh is refused", async () => {
    await signedIn({ expiresIn: 60, rejectRefresh: true });
    expect(await manager.accessToken("docs", mcp.url)).toBeNull();
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
  });

  it("never hands a token to a different URL", async () => {
    await signedIn();
    expect(await manager.accessToken("docs", "https://elsewhere.example.com/mcp")).toBeNull();
    expect(manager.authState("docs", "https://elsewhere.example.com/mcp")).toBe("none");
  });

  it("signs out: revokes and forgets", async () => {
    await signedIn();
    await manager.signOut("docs", mcp.url);
    expect(oauth.counts.revoke).toBeGreaterThan(0);
    expect(manager.authState("docs", mcp.url)).toBe("none");
    expect(await manager.accessToken("docs", mcp.url)).toBeNull();
  });

  it("remembers a server that needs sign-in until it is forgotten", async () => {
    await setup();
    manager.markNeedsSignIn("docs", mcp.url);
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
    manager.forget("docs");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("records that a sign-in is required for a server with no record", async () => {
    await setup();
    manager.requireSignIn("docs", mcp.url);
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
  });

  it("leaves a signed-in server signed in and never revokes", async () => {
    await signedIn();
    const token = await manager.accessToken("docs", mcp.url);
    manager.requireSignIn("docs", mcp.url);
    manager.requireSignIn("docs", mcp.url);
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
    expect(await manager.accessToken("docs", mcp.url)).toBe(token);
    expect(oauth.counts.revoke).toBe(0);
  });

  it("keeps a requirement it already recorded", async () => {
    await setup();
    manager.requireSignIn("docs", mcp.url);
    manager.requireSignIn("docs", mcp.url);
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
    expect(oauth.counts.revoke).toBe(0);
  });
});

describe("turn servers", () => {
  const stdio = { command: "npx", args: ["notes"], env: {} };

  it("leaves out a URL server that needs sign-in, keeps the rest", async () => {
    await setup();
    manager.markNeedsSignIn("docs", mcp.url);
    const servers = { docs: { type: "http" as const, url: mcp.url, headers: {} }, notes: stdio };
    expect(withoutPendingSignIn(servers, manager)).toEqual({ notes: stdio });
  });

  it("sends a signed-in server its bearer token in place of any Authorization header", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const servers = {
      docs: { type: "http" as const, url: mcp.url, headers: { authorization: "Bearer stale", "X-Org": "acme" } },
      plain: { type: "http" as const, url: "https://plain.example.com/mcp", headers: { Authorization: "Bearer mine" } },
      notes: stdio,
    };
    const out = await withMcpSignIn(servers, manager);
    const token = await manager.accessToken("docs", mcp.url);
    expect(out.docs).toEqual({ type: "http", url: mcp.url, headers: { "X-Org": "acme", Authorization: `Bearer ${token}` } });
    expect(out.plain).toEqual(servers.plain);
    expect(out.notes).toEqual(stdio);
    expect(servers.docs.headers.authorization).toBe("Bearer stale");
  });

  it("drops a signed-in server whose token cannot be refreshed", async () => {
    await setup({ expiresIn: 60, rejectRefresh: true });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const out = await withMcpSignIn({ docs: { type: "http" as const, url: mcp.url, headers: {} } }, manager);
    expect(out).toEqual({});
  });
  it("refreshes every signed-in server's token at once, keeping server order", async () => {
    let inFlight = 0;
    let most = 0;
    const fake = {
      authState: () => "signed-in" as const,
      accessToken: async (name: string) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, name === "first" ? 30 : 5));
        inFlight -= 1;
        return name === "gone" ? null : `token-${name}`;
      },
    } as unknown as McpOAuthManager;
    const url = (name: string) => ({ type: "http" as const, url: `https://${name}.example.com/mcp`, headers: {} });
    const out = await withMcpSignIn({ first: url("first"), gone: url("gone"), notes: stdio, last: url("last") }, fake);
    expect(most).toBe(3);
    expect(Object.keys(out)).toEqual(["first", "notes", "last"]);
    expect(out.last).toEqual({ ...url("last"), headers: { Authorization: "Bearer token-last" } });
  });
});

describe("review fixes", () => {
  it("keeps no tokens when the server is removed while the code is being exchanged", async () => {
    await setup({ tokenDelayMs: 150 });
    const started = await manager.start("docs", mcp.url);
    const browser = approve(started);
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.forget("docs");
    await browser;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("keeps no tokens when sign-in is cancelled while the code is being exchanged", async () => {
    await setup({ tokenDelayMs: 150 });
    const started = await manager.start("docs", mcp.url);
    const browser = approve(started);
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.cancel("docs");
    await browser;
    expect(manager.status("docs", started.flowId)?.phase).toBe("cancelled");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("does not expire a sign-in whose code is already being exchanged", async () => {
    await setup({ tokenDelayMs: 200 }, 100);
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
  });

  it("stays signed in when a refresh fails for a reason other than a dead grant", async () => {
    await setup({ expiresIn: 60, refreshStatus: 429 });
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
  });

  it("registers a fresh client for every sign-in", async () => {
    await setup();
    for (let i = 0; i < 2; i++) {
      const started = await manager.start("docs", mcp.url);
      await approve(started);
      await settled("docs", started.flowId);
    }
    expect(oauth.counts.register).toBe(2);
  });

  it("accepts a returned iss when the resource lists its issuer with a trailing slash", async () => {
    await setup({ listIssuerWithSlash: true, returnIss: true });
    const started = await manager.start("docs", mcp.url);
    const callback = (await fetch(started.authorizationUrl!, { redirect: "manual" })).headers.get("location")!;
    expect(new URL(callback).searchParams.get("iss")).toBe(oauth.issuer);
    expect((await manager.completeCallback("docs", started.flowId, callback)).phase).toBe("succeeded");
    expect(oauth.counts.token).toBe(1);
  });

  it("refuses metadata that claims another issuer", async () => {
    await setup({ claimIssuer: "https://someone-else.example.com" });
    await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "not-oauth" });
  });
});

describe("a sign-in app registered in advance", () => {
  async function signIn(): Promise<McpSignInStatus> {
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    return settled("docs", started.flowId);
  }

  it("signs in as a public app on a server without registration, with its own scopes", async () => {
    await setup({ noRegistration: true, preRegistered: { "entra-app": null } });
    registered = { clientId: "entra-app", scopes: ["api://mcp/read", "offline_access"] };
    const started = await manager.start("docs", mcp.url);
    const link = new URL(started.authorizationUrl!);
    expect(link.searchParams.get("client_id")).toBe("entra-app");
    expect(link.searchParams.get("scope")).toBe("api://mcp/read offline_access");
    expect(link.searchParams.get("redirect_uri")).toBe(mcpOAuthRedirectUri(mcp.url));
    await approve(started);
    expect((await settled("docs", started.flowId)).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    expect(oauth.clientAuths).toEqual([{ method: "none", clientId: "entra-app" }]);
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
  });

  it("uses the app in place of registration even when the server offers it", async () => {
    await setup({ preRegistered: { mine: null } });
    registered = { clientId: "mine" };
    expect((await signIn()).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    expect(oauth.lastAuthorize?.get("scope")).toBe("mcp");
  });

  it("proves a secret with HTTP Basic by default, on sign-in, refresh and sign-out, and never stores it", async () => {
    const secret = "s3cret:with/odd+chars";
    await setup({ noRegistration: true, expiresIn: 60, preRegistered: { corp: secret } });
    registered = { clientId: "corp", clientSecret: secret };
    expect((await signIn()).phase).toBe("succeeded");
    const token = await manager.accessToken("docs", mcp.url);
    expect(oauth.counts.refresh).toBe(1);
    expect(oauth.isValid(`Bearer ${token}`)).toBe(true);
    await manager.signOut("docs", mcp.url);
    expect(oauth.counts.revoke).toBe(1);
    expect(oauth.clientAuths).toEqual([
      { method: "basic", clientId: "corp" },
      { method: "basic", clientId: "corp" },
      { method: "basic", clientId: "corp" },
    ]);
    expect(oauth.lastAuthorize?.has("client_secret")).toBe(false);
  });

  it("sends the secret in the form when the server only takes that", async () => {
    const secret = "app-secret-never-stored";
    await setup({ noRegistration: true, preRegistered: { corp: secret }, tokenAuthMethods: ["client_secret_post"] });
    registered = { clientId: "corp", clientSecret: secret };
    expect((await signIn()).phase).toBe("succeeded");
    expect(oauth.clientAuths).toEqual([{ method: "post", clientId: "corp" }]);
    const stored = readFileSync(join(dir, "mcp-oauth.json"), "utf8");
    expect(stored).not.toContain(secret);
    const file = join(dir, "mcp-oauth.json");
    const opened = decryptBrowserState(readFileSync(file), readFileSync(`${file}.key`, "utf8").trim());
    expect(opened).not.toContain(secret);
    expect(JSON.parse(opened).servers.docs).toMatchObject({ clientId: "corp", tokenAuth: "client_secret_post" });
  });

  it("reports a refused secret as a failed sign-in", async () => {
    await setup({ noRegistration: true, preRegistered: { corp: "right" } });
    registered = { clientId: "corp", clientSecret: "wrong" };
    const status = await signIn();
    expect(status.phase).toBe("failed");
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("does not refresh with a secret once the app is no longer configured", async () => {
    await setup({ noRegistration: true, expiresIn: 60, preRegistered: { corp: "pw" } });
    registered = { clientId: "corp", clientSecret: "pw" };
    await signIn();
    registered = { clientId: "another-app", clientSecret: "pw" };
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    expect(oauth.counts.refresh).toBe(0);
  });

  it("explains a busy redirect port instead of moving to another one", async () => {
    await setup({ noRegistration: true, preRegistered: { corp: null } });
    registered = { clientId: "corp" };
    const blocker = createServer();
    const port = Number(new URL(mcpOAuthRedirectUri(mcp.url)).port);
    await new Promise<void>((resolve) => {
      blocker.once("error", () => resolve());
      blocker.listen(port, "127.0.0.1", resolve);
    });
    try {
      await expect(manager.start("docs", mcp.url)).rejects.toMatchObject({ code: "port-busy" });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("MCP sign-in from another computer", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  async function redirect(status: McpSignInStatus): Promise<string> {
    const response = await fetch(status.authorizationUrl!, { redirect: "manual" });
    return response.headers.get("location")!;
  }

  it.each(["none", "basic", "post"] as const)("completes a pre-registered %s app remotely and retains its refresh authentication", async (method) => {
    const secret = method === "none" ? undefined : "private-client-secret";
    await setup({
      noRegistration: true, expiresIn: 60, preRegistered: { corp: secret ?? null },
      ...(method === "post" ? { tokenAuthMethods: ["client_secret_post"] } : {}),
    });
    registered = { clientId: "corp", scopes: ["mcp", "offline_access"], ...(secret ? { clientSecret: secret } : {}) };
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    await expect(manager.completeCallback("docs", started.flowId, callback, "bob")).rejects.toMatchObject({ status: 404 });
    expect((await manager.completeCallback("docs", started.flowId, callback, "alice")).phase).toBe("succeeded");
    expect(oauth.counts.register).toBe(0);
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    expect(oauth.counts.refresh).toBe(1);
    await manager.signOut("docs", mcp.url);
    expect(oauth.clientAuths).toEqual(Array.from({ length: 3 }, () => ({ method, clientId: "corp" })));
    expect(oauth.counts.revoke).toBe(1);
  });

  it("completes a pasted redirect with PKCE, without visiting the loopback listener", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    const result = await manager.completeCallback("docs", started.flowId, callback, "alice");
    expect(result).toMatchObject({ phase: "succeeded", authorizationUrl: null });
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    expect(oauth.counts.token).toBe(1);
  });

  it("isolates starts, status, cancellation and completion by owner", async () => {
    await setup();
    const starting = manager.start("docs", mcp.url, undefined, "alice");
    await expect(manager.start("docs", mcp.url, undefined, "bob")).rejects.toMatchObject({ status: 409 });
    const started = await starting;
    const callback = await redirect(started);
    await expect(manager.start("docs", mcp.url, undefined, "bob")).rejects.toMatchObject({ status: 409 });
    expect(manager.status("docs", started.flowId, "bob")).toBeUndefined();
    expect(() => manager.cancelFlow("docs", "bob", started.flowId)).toThrow();
    await expect(manager.completeCallback("docs", started.flowId, callback, "bob")).rejects.toMatchObject({ status: 404 });
    expect(oauth.counts.token).toBe(0);
    expect((await manager.completeCallback("docs", started.flowId, callback, "alice")).phase).toBe("succeeded");
  });

  it("rejects malformed callbacks without spending the flow or requesting their addresses", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url);
    const callback = await redirect(started);
    const variants = [
      "not a URL", "x".repeat(16_385),
      callback.replace("127.0.0.1", "attacker.example"),
      callback.replace("http:", "https:"),
      callback.replace("127.0.0.1", "user:pass@127.0.0.1"),
      callback.replace("/mcp-oauth/callback", "/other"),
      callback + "#fragment", callback + "&code=duplicate", callback + "&error=access_denied",
      callback + "&iss=https%3A%2F%2Fwrong.example",
    ];
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "wrong");
    variants.push(wrongState.href);
    const wrongPort = new URL(callback);
    wrongPort.port = String(Number(wrongPort.port) + 1);
    variants.push(wrongPort.href);
    for (const invalid of variants) {
      await expect(manager.completeCallback("docs", started.flowId, invalid)).rejects.toMatchObject({ status: 400 });
      expect(manager.status("docs", started.flowId)?.phase).toBe("waiting");
    }
    expect(oauth.counts.token).toBe(0);
    expect((await manager.completeCallback("docs", started.flowId, callback)).phase).toBe("succeeded");
  });

  it("reports a pasted provider denial without exposing its error description", async () => {
    await setup({ deny: true });
    const started = await manager.start("docs", mcp.url);
    const result = await manager.completeCallback("docs", started.flowId, await redirect(started) + "&error_description=private");
    expect(result).toMatchObject({ phase: "failed", message: "Sign-in was not approved." });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(oauth.counts.token).toBe(0);
  });

  it.each(["cancel", "revoke", "forget", "expire"])("rejects a pasted callback after %s", async (action) => {
    await setup({}, action === "expire" ? 100 : undefined);
    const started = await manager.start("docs", mcp.url);
    const callback = await redirect(started);
    if (action === "cancel") manager.cancelFlow("docs", "loopback", started.flowId);
    if (action === "revoke") manager.revokeOwner("loopback");
    if (action === "forget") manager.forget("docs");
    if (action === "expire") await expect.poll(() => manager.status("docs", started.flowId)?.phase).toBe("expired");
    await expect(manager.completeCallback("docs", started.flowId, callback)).rejects.toThrow();
    expect(oauth.counts.token).toBe(0);
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("checks session expiry even before its revocation event is delivered", async () => {
    await setup();
    manager.dispose();
    let live = true;
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), isOwnerLive: () => live });
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    live = false;
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    expect(oauth.counts.token).toBe(0);
  });

  it("releases a dead owner's waiting flow before accepting another admin's start", async () => {
    await setup();
    manager.dispose();
    let aliceLive = true;
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), isOwnerLive: (owner) => owner !== "alice" || aliceLive });
    const old = await manager.start("docs", mcp.url, undefined, "alice");
    aliceLive = false;
    const current = await manager.start("docs", mcp.url, undefined, "bob");
    expect(current.phase).toBe("waiting");
    expect(current.flowId).not.toBe(old.flowId);
    expect(manager.status("docs", current.flowId, "bob")?.phase).toBe("waiting");
    expect(manager.status("docs", old.flowId, "alice")).toBeUndefined();
  });

  it("does not let an old cancellation cancel a new attempt", async () => {
    await setup();
    const old = await manager.start("docs", mcp.url);
    manager.cancel("docs");
    const current = await manager.start("docs", mcp.url);
    expect(() => manager.cancelFlow("docs", "loopback", old.flowId)).toThrow();
    expect(manager.status("docs", current.flowId)?.phase).toBe("waiting");
  });

  it("revokes a start still waiting for registration", async () => {
    const entered = deferred();
    const release = deferred();
    await setup({ beforeRegister: async () => { entered.resolve(); await release.promise; } });
    const started = manager.start("docs", mcp.url, undefined, "alice");
    const rejected = expect(started).rejects.toMatchObject({ status: 409 });
    await entered.promise;
    manager.revokeOwner("alice");
    release.resolve();
    await rejected;
    expect(manager.authState("docs", mcp.url)).toBe("none");
  });

  it("spends one code when pasted and listener callbacks race, and discards tokens on logout", async () => {
    const entered = deferred();
    const release = deferred();
    await setup({ beforeToken: async () => { entered.resolve(); await release.promise; } });
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await redirect(started);
    const completing = manager.completeCallback("docs", started.flowId, callback, "alice");
    const rejected = expect(completing).rejects.toMatchObject({ status: 409 });
    await entered.promise;
    expect((await fetch(callback)).status).toBe(409);
    await expect(manager.completeCallback("docs", started.flowId, callback, "alice")).rejects.toMatchObject({ status: 409 });
    manager.revokeOwner("alice");
    release.resolve();
    await rejected;
    expect(oauth.counts.token).toBe(1);
    expect(manager.authState("docs", mcp.url)).toBe("none");
    await expect.poll(() => oauth.counts.revoke).toBe(1);
  });
});

describe("McpOAuthManager onSettled", () => {
  async function watched(lifetimeMs?: number) {
    await setup({}, lifetimeMs);
    const calls: Array<[string, McpSignInPhase, string]> = [];
    manager = new McpOAuthManager({
      file: join(dir, "mcp-oauth.json"), ...(lifetimeMs ? { lifetimeMs } : {}),
      onSettled: (name, phase, owner) => { calls.push([name, phase, owner]); },
    });
    return calls;
  }

  it("onSettled fires once with succeeded for a card owner", async () => {
    const calls = await watched();
    const owner = cardOwner("thread-1", "msg-1");
    expect(owner).toBe("card:thread-1:msg-1");
    const started = await manager.start("docs", mcp.url, undefined, owner);
    expect(calls).toEqual([]);
    expect((await approve(started)).status).toBe(200);
    expect(calls).toEqual([["docs", "succeeded", owner]]);
    manager.cancel("docs");
    manager.dispose();
    expect(calls).toHaveLength(1);
  });

  it("reports a sign-in that expires or is cancelled, and nothing when the server shuts down", async () => {
    const calls = await watched(100);
    await manager.start("docs", mcp.url, undefined, "loopback");
    await expect.poll(() => calls).toEqual([["docs", "expired", "loopback"]]);
    await manager.start("docs", mcp.url, undefined, "loopback");
    manager.cancel("docs");
    expect(calls.at(-1)).toEqual(["docs", "cancelled", "loopback"]);
    await manager.start("docs", mcp.url, undefined, "loopback");
    manager.dispose();
    expect(calls).toHaveLength(2);
  });
});

describe("McpOAuthManager with a failing onSettled", () => {
  it("a throwing onSettled neither breaks a callback nor escapes the expiry timer", async () => {
    await setup({}, 150);
    const heard: McpSignInPhase[] = [];
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), lifetimeMs: 150, onSettled: (_name, phase) => { heard.push(phase); throw new Error("listener broke"); } });
    const started = await manager.start("docs", mcp.url);
    const page = await approve(started);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("Signed in. You can close this tab and return to Metal.");
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
    await manager.start("docs", mcp.url);
    await expect.poll(() => heard).toEqual(["succeeded", "expired"]);
  });
});

describe("McpOAuthManager callback page", () => {
  it("shows a browser the script-free pixel page with the same words", async () => {
    await setup({});
    manager = new McpOAuthManager({ file: join(dir, "mcp-oauth.json") });
    const started = await manager.start("docs", mcp.url);
    const page = await fetch(started.authorizationUrl!, { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("<h1>you&#39;re signed in!</h1>");
    expect(html).toContain("Signed in. You can close this tab and return to Metal.");
    expect(html).not.toMatch(/<script\b/i);
  });
});

describe("McpOAuthManager sign-in from a browser on another computer", () => {
  const elsewhere = { remote: true, origin: "https://cloud.example" };

  async function returnAddress(status: McpSignInStatus): Promise<URL> {
    return new URL((await fetch(status.authorizationUrl!, { redirect: "manual" })).headers.get("location")!);
  }

  const portFree = (port: number) => new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

  it("registers for this server's https address and listens on no loopback port", async () => {
    await setup();
    mcp = { ...mcp, url: await withFreeSignInPort(mcp.url) };
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    const link = new URL(started.authorizationUrl!);
    expect(link.searchParams.get("redirect_uri")).toBe("https://cloud.example/mcp-oauth/callback");
    expect(started.pasteBack).toBeUndefined();
    expect(await portFree(Number(new URL(mcpOAuthRedirectUri(mcp.url)).port))).toBe(true);

    const callback = await returnAddress(started);
    expect(callback.origin + callback.pathname).toBe("https://cloud.example/mcp-oauth/callback");
    const page = await manager.publicCallback("cloud.example", callback.search);
    expect(page).toEqual({ status: 200, text: "Signed in. You can close this tab and return to Metal." });
    expect(manager.status("docs", started.flowId, "alice")?.phase).toBe("succeeded");
    expect(oauth.isValid(`Bearer ${await manager.accessToken("docs", mcp.url)}`)).toBe(true);

    const replay = await manager.publicCallback("cloud.example", callback.search);
    expect(replay.status).toBe(409);
    expect(replay.text).not.toContain(callback.searchParams.get("code"));
    expect(oauth.counts.token).toBe(1);
  });

  it("answers a wrong state or another address with a plain 400 and keeps waiting", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    const callback = await returnAddress(started);
    const forged = new URLSearchParams(callback.search);
    forged.set("state", "forged");
    for (const [host, search] of [["cloud.example", `?${forged}`], ["attacker.example", callback.search], [undefined, callback.search], ["cloud.example", ""]] as const) {
      expect(await manager.publicCallback(host, search)).toEqual({ status: 400, text: "Invalid sign-in callback. Return to Metal and try again." });
    }
    expect(manager.status("docs", started.flowId, "alice")?.phase).toBe("waiting");
    expect(oauth.counts.token).toBe(0);
    expect((await manager.publicCallback("CLOUD.example", callback.search)).status).toBe(200);
  });

  it("refuses a callback after the sign-in expired", async () => {
    await setup({}, 100);
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    const callback = await returnAddress(started);
    await expect.poll(() => manager.status("docs", started.flowId, "alice")?.phase).toBe("expired");
    expect((await manager.publicCallback("cloud.example", callback.search)).status).toBe(409);
    expect(oauth.counts.token).toBe(0);
  });

  it("reports a denied approval on the page without the server's own words", async () => {
    await setup({ deny: true });
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    const callback = await returnAddress(started);
    const page = await manager.publicCallback("cloud.example", `${callback.search}&error_description=private`);
    expect(page).toEqual({ status: 400, text: "Sign-in was not approved. You can close this tab." });
    expect(manager.status("docs", started.flowId, "alice")?.phase).toBe("failed");
  });

  it("never completes a loopback sign-in through the public address", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url, undefined, "alice");
    const callback = await returnAddress(started);
    expect((await manager.publicCallback(callback.host, callback.search)).status).toBe(400);
    expect(manager.status("docs", started.flowId, "alice")?.phase).toBe("waiting");
  });

  it("falls back to the loopback callback, pasted, when the server refuses the https address", async () => {
    await setup({ refuseRedirect: (uri) => uri.startsWith("https:") });
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    expect(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-oauth\/callback$/);
    expect(started.pasteBack).toBe(true);
    expect(oauth.counts.register).toBe(2);
    const callback = await returnAddress(started);
    expect((await manager.completeCallback("docs", started.flowId, callback.href, "alice")).phase).toBe("succeeded");
  });

  it("keeps an app registered in advance on its loopback redirect, pasted", async () => {
    await setup({ noRegistration: true, preRegistered: { corp: null } });
    registered = { clientId: "corp" };
    const started = await manager.start("docs", mcp.url, undefined, "alice", elsewhere);
    expect(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")).toBe(mcpOAuthRedirectUri(mcp.url));
    expect(started.pasteBack).toBe(true);
    expect(oauth.counts.register).toBe(0);
  });

  it("asks a browser on this machine to paste nothing", async () => {
    await setup();
    const started = await manager.start("docs", mcp.url, undefined, "loopback", { remote: false, origin: "https://cloud.example" });
    expect(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(started.pasteBack).toBeUndefined();
  });
});

describe("mcpCallbackOrigin", () => {
  it("uses the origin the browser proved when nothing is configured or it is configured", () => {
    expect(mcpCallbackOrigin("https://me.fly.dev", [])).toBe("https://me.fly.dev");
    expect(mcpCallbackOrigin("https://bots.acme.com", ["https://me.fly.dev", "https://bots.acme.com"])).toBe("https://bots.acme.com");
  });

  it("prefers a configured address over one nobody vouched for", () => {
    expect(mcpCallbackOrigin("https://elsewhere.example", ["https://me.fly.dev"])).toBe("https://me.fly.dev");
    expect(mcpCallbackOrigin(null, [null, undefined, "https://me.fly.dev/"])).toBe("https://me.fly.dev");
  });

  it("returns null for plain http, a path or credentials", () => {
    expect(mcpCallbackOrigin("http://192.168.1.5:3000", [])).toBeNull();
    expect(mcpCallbackOrigin(null, ["http://me.example", "https://me.example/omb", "https://user:pw@me.example", "not a url"])).toBeNull();
    expect(mcpCallbackOrigin(null, [])).toBeNull();
  });
});

describe("MCP OAuth through the local proxy", () => {
  let proxy: ReturnType<typeof createServer>;
  let port: number;
  beforeEach(async () => {
    refusedTokens.clear();
    proxy = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void mcpOAuthProxyRoutes({ req, res, url, path: url.pathname, method: req.method ?? "GET" } as Parameters<typeof mcpOAuthProxyRoutes>[0])
        .then((out) => { if (out === PASS) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    port = (proxy.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise((resolve) => proxy.close(resolve)); });

  async function signedIn(options: FakeOAuthOptions = {}) {
    await setup(options);
    const started = await manager.start("docs", mcp.url);
    await approve(started);
    await settled("docs", started.flowId);
  }
  const initialize = (spec: { url: string; headers: Record<string, string> }) => fetch(spec.url, {
    method: "POST",
    headers: { ...spec.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } } }),
  });
  const engineSpec = async () => (await engineMcpSignIn({ docs: { type: "http", url: mcp.url, headers: { "x-team": "team-header-fixture" } } }, manager, port)).docs as { url: string; headers: Record<string, string> };

  it("gives an engine this server's address and a bearer of its own, never the token or the server's headers", async () => {
    await signedIn();
    const token = (await manager.accessToken("docs", mcp.url))!;
    const spec = await engineSpec();
    expect(spec.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}${MCP_OAUTH_PROXY_PATH}[\\w-]+$`));
    expect(Object.keys(spec.headers)).toEqual(["Authorization"]);
    expect(JSON.stringify(spec)).not.toContain(token);
    expect(JSON.stringify(spec)).not.toContain("team-header-fixture");
    const answer = await initialize(spec);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("protocolVersion");
  });

  it("refreshes a token the server refuses once, and retries with the new one", async () => {
    await signedIn();
    const spec = await engineSpec();
    refusedTokens.add(`Bearer ${(await manager.accessToken("docs", mcp.url))!}`);
    const answer = await initialize(spec);
    expect(answer.status).toBe(200);
    expect(oauth.counts.refresh).toBe(1);
    expect(manager.authState("docs", mcp.url)).toBe("signed-in");
  });

  it("answers a refused sign-in it cannot refresh without a 401, so the engine never starts its own sign-in", async () => {
    await signedIn({ rejectRefresh: true });
    const spec = await engineSpec();
    refusedTokens.add(`Bearer ${(await manager.accessToken("docs", mcp.url))!}`);
    const answer = await initialize(spec);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: expect.stringContaining("reconnect docs in Connect apps") } });
    expect(manager.authState("docs", mcp.url)).toBe("needs-sign-in");
  });

  it("answers each request in a refused batch, and a lone notification with nothing to show", async () => {
    await signedIn({ rejectRefresh: true });
    const spec = await engineSpec();
    refusedTokens.add(`Bearer ${(await manager.accessToken("docs", mcp.url))!}`);
    const post = (body: unknown) => fetch(spec.url, { method: "POST", headers: { ...spec.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const batch = await post([{ jsonrpc: "2.0", id: "a", method: "tools/call" }, { jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    expect(((await batch.json()) as Array<{ id: unknown }>).map((answer) => answer.id)).toEqual(["a", 2]);
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("refuses a request without its route's bearer", async () => {
    await signedIn();
    const spec = await engineSpec();
    expect((await initialize({ ...spec, headers: { Authorization: "Bearer not-the-route-bearer" } })).status).toBe(403);
    expect((await initialize({ url: `${spec.url}x`, headers: spec.headers })).status).toBe(403);
  });
});

describe("Metal's client metadata document", () => {
  it("names itself as its own client id and lists only the fixed loopback redirect", () => {
    expect(MCP_CLIENT_METADATA.client_id).toBe(MCP_CLIENT_ID);
    expect(MCP_CLIENT_METADATA.redirect_uris).toEqual([MCP_CLIENT_METADATA_REDIRECT]);
    expect(MCP_CLIENT_METADATA.token_endpoint_auth_method).toBe("none");
  });
});
