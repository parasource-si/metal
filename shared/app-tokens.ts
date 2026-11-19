// Apps Metal connects for free with the person's own credentials: a token they paste, or a device sign-in to our own
// GitHub App or Google client (no app review). Each one either becomes the vendor's own MCP server with the token in a
// header ("mcp"), or a small API tool Metal serves itself ("api"). Shared by the server and the Connect apps window.

import { NATIVE_CONNECTORS } from "./native-connectors.ts";

/** A pasted-token app's id, or a native connector's (shared/native-connectors.json). */
export type TokenAppId = string;

/** One thing the person pastes or types. `secret` fields are never shown again. */
export interface TokenField {
  key: "token" | "key" | "email" | "site" | "shop";
  label: string;
  placeholder: string;
  secret: boolean;
}

export interface TokenAppSpec {
  id: TokenAppId;
  label: string;
  domain: string;
  /** Where the person makes the token: opened from the card. */
  settingsUrl: string;
  fields: readonly TokenField[];
  /** Signs in to configured OAuth app (shared/native-connectors.json) when this build has its client. An app with
   * no fields signs in only that way. */
  native?: boolean;
}

const token = (placeholder: string): TokenField => ({ key: "token", label: "Token", placeholder, secret: true });

const TOKEN_APPS_PASTE: readonly TokenAppSpec[] = [
  { id: "github", label: "GitHub", domain: "github.com", settingsUrl: "https://github.com/settings/personal-access-tokens/new", fields: [token("github_pat_…")] },
  { id: "notion", label: "Notion", domain: "notion.so", settingsUrl: "https://www.notion.so/profile/integrations", fields: [token("ntn_…")] },
  { id: "linear", label: "Linear", domain: "linear.app", settingsUrl: "https://linear.app/settings/account/security", fields: [token("lin_api_…")] },
  { id: "airtable", label: "Airtable", domain: "airtable.com", settingsUrl: "https://airtable.com/create/tokens", fields: [token("pat…")] },
  { id: "todoist", label: "Todoist", domain: "todoist.com", settingsUrl: "https://app.todoist.com/app/settings/integrations/developer", fields: [token("API token")] },
  { id: "trello", label: "Trello", domain: "trello.com", settingsUrl: "https://trello.com/power-ups/admin",
    fields: [{ key: "key", label: "API key", placeholder: "API key", secret: false }, token("Token")] },
  { id: "clickup", label: "ClickUp", domain: "clickup.com", settingsUrl: "https://app.clickup.com/settings/apps", fields: [token("pk_…")] },
  { id: "hubspot", label: "HubSpot", domain: "hubspot.com", settingsUrl: "https://app.hubspot.com/l/integrations-settings/", fields: [token("pat-…")] },
  { id: "jira", label: "Jira", domain: "atlassian.com", settingsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [{ key: "site", label: "Site", placeholder: "yourteam (from yourteam.atlassian.net)", secret: false },
      { key: "email", label: "Email", placeholder: "you@example.com", secret: false }, token("API token")] },
  { id: "shopify", label: "Shopify", domain: "shopify.com", settingsUrl: "https://admin.shopify.com/settings/apps/development",
    fields: [{ key: "shop", label: "Store", placeholder: "yourstore (from yourstore.myshopify.com)", secret: false }, token("shpat_…")] },
  { id: "stripe", label: "Stripe", domain: "stripe.com", settingsUrl: "https://dashboard.stripe.com/apikeys", fields: [token("rk_live_…")] },
  { id: "cloudflare", label: "Cloudflare", domain: "cloudflare.com", settingsUrl: "https://dash.cloudflare.com/profile/api-tokens", fields: [token("API token")] },
];

const PASTE_IDS = new Set(TOKEN_APPS_PASTE.map((app) => app.id));
export const TOKEN_APPS: readonly TokenAppSpec[] = [
  ...TOKEN_APPS_PASTE.map((app) => (NATIVE_CONNECTORS.some((one) => one.id === app.id) ? { ...app, native: true } : app)),
  ...NATIVE_CONNECTORS.filter((one) => !PASTE_IDS.has(one.id)).map((one): TokenAppSpec => ({ id: one.id, label: one.label, domain: one.domain, settingsUrl: `https://${one.domain}`, fields: [], native: true })),
];

export const tokenApp = (id: string): TokenAppSpec | undefined => TOKEN_APPS.find((app) => app.id === id);

/** One connected account, as the window sees it: never a token. */
export interface TokenAccountView {
  id: string;
  app: TokenAppId;
  /** Who it signed in as: a login, a workspace or a store name. */
  label: string;
  /** The MCP server it is kept under. */
  server: string;
  connectedAt: string;
  via: "token" | "device";
  /** The app refused this sign-in (expired or revoked). Reconnect with `replaces` set to this id: the new sign-in takes
   * over the same MCP server name, so every bot keeps its access. */
  needsReconnect?: true;
}

export interface TokenAppsStatus {
  accounts: TokenAccountView[];
  /** The native sign-ins this build can offer (its client is set up), by connector id. */
  native: Record<string, boolean>;
}

/** A native sign-in under way: a code to type on the vendor's page, or (no code) a page that sends the browser back. */
export interface DeviceStart {
  handle: string;
  userCode?: string;
  verificationUrl: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds to wait between checks. */
  interval: number;
}

/** Body of POST /api/app-tokens/:app (fields) and POST /api/app-tokens/:app/device: `replaces` names an account of
 * the same app whose server the new sign-in takes over. */
export interface TokenConnectRequest {
  fields?: Partial<Record<TokenField["key"], string>>;
  replaces?: string;
}

export type DevicePoll =
  | { status: "waiting" }
  | { status: "connected"; account: TokenAccountView }
  | { status: "failed"; message: string };
