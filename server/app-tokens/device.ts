// Sign-in to configured OAuth apps (shared/native-connectors.json): a device code (RFC 8628) the person types on the
// vendor's page, or the vendor's page sending the browser back to this computer's loopback address with PKCE (RFC 8252).
// Neither needs an app review for the scopes listed there. GitHub App device tokens refresh with the client id alone;
// Google's installed-app secret is not confidential (Google's OAuth docs), so a release may carry it.
import { createHash, randomBytes } from "node:crypto";

import { NATIVE_CLIENT_ENVS, NATIVE_CONNECTORS, type NativeConnector } from "../../shared/native-connectors.ts";

export interface DeviceClient {
  clientId: string;
  clientSecret?: string;
}

/** Each native connector's client, or null when this build has none (that sign-in is then off). */
export type DeviceClients = Record<string, DeviceClient | null>;

/** JSON of the client values, set by scripts/bundle-server.mjs from the release environment; absent from source. */
declare const DUSK_BUILD_DEVICE_CLIENTS: string | undefined;

function built(): Record<string, string> {
  try {
    return typeof DUSK_BUILD_DEVICE_CLIENTS === "string" ? JSON.parse(DUSK_BUILD_DEVICE_CLIENTS) as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The clients this build may use: the environment first, else as the release was built. A connector whose secret env is
 * named needs it too. */
export function deviceClients(env: NodeJS.ProcessEnv = process.env, baked: Record<string, string> = built(), connectors: readonly NativeConnector[] = NATIVE_CONNECTORS): DeviceClients {
  const value = (name: string | undefined) => (name ? (env[name] ?? baked[name])?.trim() : undefined);
  return Object.fromEntries(connectors.map((one) => {
    const clientId = value(one.clientIdEnv);
    const clientSecret = value(one.clientSecretEnv);
    const ready = clientId && (!one.clientSecretEnv || clientSecret);
    return [one.id, ready ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : null];
  }));
}

export { NATIVE_CLIENT_ENVS };

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokens {
  token: string;
  refresh?: string;
  /** Unix ms, when the token says it expires. */
  expiresAt?: number;
}

export type DeviceAnswer = { status: "waiting"; slowDown?: boolean } | { status: "done"; tokens: DeviceTokens } | { status: "failed"; message: string };

const form = (values: Record<string, string | undefined>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) body.set(key, value);
  return body.toString();
};

async function post(fetchImpl: typeof fetch, url: string, values: Record<string, string | undefined>, headers: Record<string, string> = {}, json = false) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": json ? "application/json" : "application/x-www-form-urlencoded", ...headers },
    body: json ? JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value))) : form(values),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, body: body ?? {} };
}

/** A token request as the row says the vendor wants it: the secret in the form, or as HTTP Basic (RFC 6749 2.3.1). */
function tokenRequest(fetchImpl: typeof fetch, connector: NativeConnector, client: DeviceClient, values: Record<string, string | undefined>) {
  const basic = connector.tokenAuth === "basic" && client.clientSecret;
  const headers: Record<string, string> = basic
    ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret!)}`).toString("base64")}` }
    : {};
  return post(fetchImpl, connector.tokenUrl, { ...values, client_id: client.clientId, ...(basic ? {} : { client_secret: client.clientSecret }) }, headers, connector.tokenBody === "json");
}

/** The vendor said this refresh token is dead (revoked, expired or used): only a new sign-in helps. */
export class SignInExpiredError extends Error {}

const scope = (connector: NativeConnector) => connector.scopes.join(connector.scopeSeparator ?? " ") || undefined;

/** Where every vendor's page sends the browser back: one fixed address registered with each OAuth app, whatever port
 * this computer's server is on. It reads the port from the state and sends the browser on to this server's callback
 * (apps/link-service/src/app-token-callback.mjs). */
export const APP_TOKENS_REDIRECT = "https://link.dusk.bot/oauth/app-tokens";

export async function startDevice(connector: NativeConnector, client: DeviceClient, fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  if (!connector.deviceUrl) throw new Error(`${connector.label} has no device sign-in.`);
  const { body } = await post(fetchImpl, connector.deviceUrl, { client_id: client.clientId, scope: scope(connector) });
  const url = body.verification_uri ?? body.verification_url;
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error(typeof body.error_description === "string" ? body.error_description : "The sign-in didn't start. Try again.");
  }
  return { deviceCode: body.device_code, userCode: body.user_code, verificationUrl: url, expiresIn: Number(body.expires_in) || 900, interval: Math.max(5, Number(body.interval) || 5) };
}

function tokensOf(body: Record<string, unknown>, now: number): DeviceTokens | null {
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const expires = Number(body.expires_in);
  return {
    token: body.access_token,
    ...(typeof body.refresh_token === "string" && body.refresh_token ? { refresh: body.refresh_token } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: now + expires * 1000 } : {}),
  };
}

export async function pollDevice(connector: NativeConnector, client: DeviceClient, deviceCode: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceAnswer> {
  const { body } = await post(fetchImpl, connector.tokenUrl, {
    client_id: client.clientId, client_secret: client.clientSecret, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const tokens = tokensOf(body, now);
  if (tokens) return { status: "done", tokens };
  if (body.error === "authorization_pending") return { status: "waiting" };
  if (body.error === "slow_down") return { status: "waiting", slowDown: true };
  if (body.error === "access_denied") return { status: "failed", message: "The sign-in was cancelled." };
  if (body.error === "expired_token") return { status: "failed", message: "The code expired. Start again." };
  return { status: "failed", message: "The sign-in didn't finish. Start again." };
}

/** A code or fragment sign-in's page and what its answer is checked against. Trello's page takes its API key and a
 * return_url (which carries our state, since Trello sends none back) and returns the token in the #fragment. */
/** `port`: this computer's server, named in the state so the fixed redirect can send the browser back to it. */
export function authorizePage(connector: NativeConnector, client: DeviceClient, redirectUri: string, port?: number): { url: string; state: string; verifier: string } {
  if (!connector.authorizeUrl) throw new Error(`${connector.label} has no browser sign-in.`);
  const state = `${port ? `${port}.` : ""}${randomBytes(16).toString("hex")}`;
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(connector.authorizeUrl);
  const params: Record<string, string | undefined> = connector.flow === "fragment"
    ? { key: client.clientId, return_url: `${redirectUri}?state=${state}`, callback_method: "fragment", response_type: "token", scope: scope(connector), ...connector.authorizeParams }
    : {
      response_type: "code", client_id: client.clientId, redirect_uri: redirectUri, state, scope: scope(connector),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...connector.authorizeParams,
    };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return { url: url.toString(), state, verifier };
}

export async function exchangeCode(connector: NativeConnector, client: DeviceClient, code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceTokens> {
  const { body } = await tokenRequest(fetchImpl, connector, client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  const tokens = tokensOf(body, now);
  if (!tokens) throw new Error("The sign-in didn't finish. Start again.");
  return tokens;
}

/** A new token from a refresh token; each GitHub refresh token works once, so the answer carries the next one. A refusal
 * of the refresh token itself is a SignInExpiredError; anything else (network, a vendor outage) may pass next time. */
export async function refreshDevice(connector: NativeConnector, client: DeviceClient, refresh: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<DeviceTokens> {
  const answer = connector.flow === "device"
    ? await post(fetchImpl, connector.tokenUrl, { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: "refresh_token" })
    : await tokenRequest(fetchImpl, connector, client, { refresh_token: refresh, grant_type: "refresh_token" });
  const tokens = tokensOf(answer.body, now);
  if (tokens) return { ...tokens, refresh: tokens.refresh ?? refresh };
  const error = typeof answer.body.error === "string" ? answer.body.error : "";
  // GitHub answers a dead refresh token with HTTP 200 and bad_refresh_token
  if (["invalid_grant", "bad_refresh_token", "invalid_request", "unauthorized_client"].includes(error) || answer.status === 400 || answer.status === 401) {
    throw new SignInExpiredError(`The ${connector.label} sign-in expired or was revoked. Reconnect ${connector.label}.`);
  }
  throw new Error(`${connector.label} didn't renew the sign-in (HTTP ${answer.status}). It will try again.`);
}
