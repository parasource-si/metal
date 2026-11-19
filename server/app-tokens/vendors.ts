// How each token app is reached: the live check that proves a pasted token works, and either the vendor's own MCP
// server (which takes the token in a header) or the API origin Metal's own api_request tool calls with it.
// Endpoints and header formats are from each vendor's API docs (checked 2026-11-13).
import { nativeConnector, type NativeConnector } from "../../shared/native-connectors.ts";

export type TokenFields = Partial<Record<"token" | "key" | "email" | "site" | "shop" | "refresh", string>>;

export class TokenCheckError extends Error {
  readonly kind: "refused" | "network" | "input";
  constructor(kind: "refused" | "network" | "input", message: string) {
    super(message);
    this.kind = kind;
  }
}

type Fetch = typeof fetch;

export interface ApiAccess {
  /** https origin every call goes to; a path never leaves it. */
  origin: string;
  headers: Record<string, string>;
  /** Added to every call's query (Trello's key and token). */
  query?: Record<string, string>;
  docs: string;
}

export interface Vendor {
  /** Who the token signs in as, or a TokenCheckError. */
  check(fields: TokenFields, fetchImpl: Fetch, signal: AbortSignal): Promise<string>;
  /** The vendor's own MCP server, when it takes this token in a header. */
  mcp?(fields: TokenFields): { url: string; headers: Record<string, string> };
  api?(fields: TokenFields): ApiAccess;
}

/** A Jira site or Shopify store name: the subdomain only, so a typed value can never point the token elsewhere. */
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export function subdomain(value: string | undefined, suffix: string, what: string): string {
  const raw = (value ?? "").trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/\/.*$/u, "");
  const name = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  if (!SUBDOMAIN.test(name)) throw new TokenCheckError("input", `Type the ${what} name, like yourteam.`);
  return name;
}

function need(fields: TokenFields, key: keyof TokenFields, what: string): string {
  const value = fields[key]?.trim();
  if (!value || /[\s\r\n]/u.test(value) || value.length > 4_096) throw new TokenCheckError("input", `Paste the ${what}.`);
  return value;
}

async function read(fetchImpl: Fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal });
  } catch {
    throw new TokenCheckError("network", "Couldn't reach the app. Check your connection and try again.");
  }
  if (response.status === 429) throw new TokenCheckError("network", "The app is limiting requests right now. Wait a minute and try again.");
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new TokenCheckError("refused", "The app didn't accept this token. Check it and try again.");
  if (response.status === 404) throw new TokenCheckError("refused", "The app couldn't find that account. Check the site or store name and the token.");
  if (!response.ok) throw new TokenCheckError("refused", `The app answered with an error (${response.status}). Check the token and try again.`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") throw new TokenCheckError("refused", "The app gave an answer Metal couldn't read.");
  return body as Record<string, any>;
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const linearAuth = (token: string) => (token.startsWith("lin_api_") ? token : `Bearer ${token}`);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null);

export const VENDORS: Record<string, Vendor> = {
  github: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.github.com/user", { headers: { ...bearer(need(fields, "token", "token")), accept: "application/vnd.github+json", "user-agent": "dusk-bot" } }, signal);
      return text(body.login) ?? "GitHub";
    },
    // GitHub's remote MCP server takes a personal or GitHub App user token as a bearer, on every plan
    mcp: (fields) => ({ url: "https://api.githubcopilot.com/mcp/", headers: bearer(fields.token!) }),
  },
  notion: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.notion.com/v1/users/me", { headers: { ...bearer(need(fields, "token", "integration secret")), "notion-version": "2022-06-28" } }, signal);
      return text(body.bot?.workspace_name) ?? text(body.name) ?? "Notion";
    },
    api: (fields) => ({ origin: "https://api.notion.com", headers: { ...bearer(fields.token!), "notion-version": "2022-06-28" }, docs: "https://developers.notion.com/reference" }),
  },
  linear: {
    async check(fields, fetchImpl, signal) {
      // the GraphQL API takes a personal key (lin_api_) with no Bearer prefix and an OAuth token with one
      const body = await read(fetchImpl, "https://api.linear.app/graphql", { method: "POST", headers: { authorization: linearAuth(need(fields, "token", "API key")), "content-type": "application/json" }, body: JSON.stringify({ query: "{ viewer { name } }" }) }, signal);
      if (Array.isArray(body.errors) && body.errors.length) throw new TokenCheckError("refused", "Linear didn't accept this key. Check it and try again.");
      return text(body.data?.viewer?.name) ?? "Linear";
    },
    mcp: (fields) => ({ url: "https://mcp.linear.app/mcp", headers: bearer(fields.token!) }),
  },
  airtable: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.airtable.com/v0/meta/whoami", { headers: bearer(need(fields, "token", "token")) }, signal);
      return text(body.email) ?? "Airtable";
    },
    api: (fields) => ({ origin: "https://api.airtable.com", headers: bearer(fields.token!), docs: "https://airtable.com/developers/web/api/introduction" }),
  },
  todoist: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.todoist.com/api/v1/user", { headers: bearer(need(fields, "token", "API token")) }, signal);
      return text(body.full_name) ?? text(body.email) ?? "Todoist";
    },
    api: (fields) => ({ origin: "https://api.todoist.com", headers: bearer(fields.token!), docs: "https://developer.todoist.com/api/v1/" }),
  },
  trello: {
    async check(fields, fetchImpl, signal) {
      const query = new URLSearchParams({ key: need(fields, "key", "API key"), token: need(fields, "token", "token"), fields: "fullName,username" });
      const body = await read(fetchImpl, `https://api.trello.com/1/members/me?${query}`, {}, signal);
      return text(body.fullName) ?? text(body.username) ?? "Trello";
    },
    api: (fields) => ({ origin: "https://api.trello.com", headers: {}, query: { key: fields.key!, token: fields.token! }, docs: "https://developer.atlassian.com/cloud/trello/rest/" }),
  },
  clickup: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.clickup.com/api/v2/user", { headers: { authorization: need(fields, "token", "token") } }, signal);
      return text(body.user?.username) ?? text(body.user?.email) ?? "ClickUp";
    },
    api: (fields) => ({ origin: "https://api.clickup.com", headers: { authorization: fields.token! }, docs: "https://developer.clickup.com/reference" }),
  },
  hubspot: {
    async check(fields, fetchImpl, signal) {
      const body = await read(fetchImpl, "https://api.hubapi.com/account-info/v3/details", { headers: bearer(need(fields, "token", "token")) }, signal);
      return text(body.portalName) ?? (body.portalId ? `HubSpot ${body.portalId}` : "HubSpot");
    },
    api: (fields) => ({ origin: "https://api.hubapi.com", headers: bearer(fields.token!), docs: "https://developers.hubspot.com/docs/api-reference" }),
  },
  jira: {
    async check(fields, fetchImpl, signal) {
      const site = subdomain(fields.site, ".atlassian.net", "site");
      const auth = Buffer.from(`${need(fields, "email", "email")}:${need(fields, "token", "API token")}`).toString("base64");
      const body = await read(fetchImpl, `https://${site}.atlassian.net/rest/api/3/myself`, { headers: { authorization: `Basic ${auth}`, accept: "application/json" } }, signal);
      return text(body.displayName) ?? text(body.emailAddress) ?? site;
    },
    api: (fields) => ({
      origin: `https://${subdomain(fields.site, ".atlassian.net", "site")}.atlassian.net`,
      headers: { authorization: `Basic ${Buffer.from(`${fields.email}:${fields.token}`).toString("base64")}`, accept: "application/json" },
      docs: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
    }),
  },
  shopify: {
    async check(fields, fetchImpl, signal) {
      const shop = subdomain(fields.shop, ".myshopify.com", "store");
      const body = await read(fetchImpl, `https://${shop}.myshopify.com/admin/api/2026-10/shop.json`, { headers: { "x-shopify-access-token": need(fields, "token", "access token") } }, signal);
      return text(body.shop?.name) ?? shop;
    },
    api: (fields) => ({ origin: `https://${subdomain(fields.shop, ".myshopify.com", "store")}.myshopify.com`, headers: { "x-shopify-access-token": fields.token! }, docs: "https://shopify.dev/docs/api/admin-graphql" }),
  },
  stripe: {
    async check(fields, fetchImpl, signal) {
      const key = need(fields, "token", "key");
      if (!/^(rk|sk)_(live|test)_/u.test(key)) throw new TokenCheckError("input", "Paste a Stripe secret or restricted key (rk_live_… or sk_live_…).");
      await read(fetchImpl, "https://api.stripe.com/v1/balance", { headers: bearer(key) }, signal);
      return key.includes("_test_") ? "Stripe test mode" : "Stripe";
    },
    api: (fields) => ({ origin: "https://api.stripe.com", headers: bearer(fields.token!), docs: "https://docs.stripe.com/api" }),
  },
  cloudflare: {
    async check(fields, fetchImpl, signal) {
      const headers = bearer(need(fields, "token", "API token"));
      const verified = await read(fetchImpl, "https://api.cloudflare.com/client/v4/user/tokens/verify", { headers }, signal);
      if (verified.success === false) throw new TokenCheckError("refused", "Cloudflare didn't accept this token. Check it and try again.");
      const accounts = await read(fetchImpl, "https://api.cloudflare.com/client/v4/accounts?per_page=1", { headers }, signal).catch(() => null);
      return text(accounts?.result?.[0]?.name) ?? "Cloudflare";
    },
    // Cloudflare's API MCP server takes user and account API tokens as a bearer
    mcp: (fields) => ({ url: "https://mcp.cloudflare.com/mcp", headers: bearer(fields.token!) }),
  },
};

const at = (body: unknown, path: string): unknown => path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), body);

/** A native connector's vendor, from its row alone: the check and the way bots use it. */
export function configuredVendor(connector: NativeConnector): Vendor {
  const auth = (token: string) => (connector.check.auth === "raw" ? { authorization: token } : bearer(token));
  return {
    async check(fields, fetchImpl, signal) {
      const headers = { ...auth(need(fields, "token", "token")), accept: "application/json", "user-agent": "dusk-bot", ...connector.check.headers };
      const body = await read(fetchImpl, connector.check.url, { method: connector.check.method ?? "GET", headers }, signal);
      return text(at(body, connector.check.label)) ?? connector.label;
    },
    ...("mcp" in connector.use
      ? { mcp: (fields: TokenFields) => ({ url: (connector.use as { mcp: string }).mcp, headers: bearer(fields.token!) }) }
      : { api: (fields: TokenFields) => ({ origin: (connector.use as { api: string }).api, headers: auth(fields.token!), docs: (connector.use as { docs: string }).docs }) }),
  };
}

/** A pasted-token app's own vendor entry, else the native connector's row. */
export function vendorFor(id: string): Vendor | undefined {
  const own = Object.hasOwn(VENDORS, id) ? VENDORS[id] : undefined;
  if (own) return own;
  const connector = nativeConnector(id);
  return connector ? configuredVendor(connector) : undefined;
}
