import table from "./native-connectors.json" with { type: "json" };

/** One connector Metal signs in to with its own OAuth app (no per-call cost, no app review). Adding one is a row in
 * native-connectors.json plus its client id (and secret, when the vendor needs one) in the release environment. */
export interface NativeConnector {
  id: string;
  label: string;
  domain: string;
  /** "device": the person types a code on the vendor's page. "code": the vendor's page sends the browser back to
   * this computer's loopback address (RFC 8252), with PKCE. "fragment": Trello's token page, which puts the token in
   * the address's #fragment on the way back (no code to trade). */
  flow: "device" | "code" | "fragment";
  /** Names of the environment variables that hold the client: never the values. */
  clientIdEnv: string;
  clientSecretEnv?: string;
  /** device flow */
  deviceUrl?: string;
  /** code and fragment flows */
  authorizeUrl?: string;
  /** Unused by the fragment flow. */
  tokenUrl: string;
  scopes: string[];
  /** How scopes are joined in the authorize address (Trello wants commas). */
  scopeSeparator?: string;
  /** Extra query fields the authorize page needs (Google's access_type=offline, Notion's owner=user). */
  authorizeParams?: Record<string, string>;
  /** How the client authenticates at the token endpoint. "post" (default): id and secret in the form body. "basic":
   * HTTP Basic, as Notion and Airtable require of a confidential client. */
  tokenAuth?: "post" | "basic";
  /** The token request's body. Default a form; Notion's token endpoint takes JSON. */
  tokenBody?: "form" | "json";
  /** Who the token signs in as, and the dotted path of the name in its JSON. Sent with the token as a bearer unless
   * `auth` is "raw"; a POST sends no body (Dropbox's get_current_account). */
  check: { url: string; label: string; method?: "GET" | "POST"; auth?: "bearer" | "raw"; headers?: Record<string, string> };
  /** The vendor's own MCP server, which takes the token as a bearer, or an API origin for Metal's api_request tool. */
  use: { mcp: string } | { api: string; docs: string };
}

export const NATIVE_CONNECTORS: readonly NativeConnector[] = table.connectors as NativeConnector[];

export const nativeConnector = (id: string): NativeConnector | undefined => NATIVE_CONNECTORS.find((one) => one.id === id);

/** Every environment variable a release bakes in for these clients. */
export const NATIVE_CLIENT_ENVS: readonly string[] = NATIVE_CONNECTORS.flatMap((one) => [one.clientIdEnv, ...(one.clientSecretEnv ? [one.clientSecretEnv] : [])]);
