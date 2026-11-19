export type ConnectedAppsMode = "managed" | "self-hosted" | "unavailable";

const MANAGED_CUSTOM_AUTH_TOOLKITS = new Set(["twitter", "x"]);

/**
 * Some Composio toolkits no longer include provider-managed credentials.
 * The official Dusk broker cannot offer those connections until its
 * project owns the corresponding OAuth app. Self-hosted Composio projects can
 * still supply their own auth config, so keep this restriction mode-specific.
 */
export function managedConnectorUnavailableReason(
  mode: ConnectedAppsMode,
  slug: string,
): string | null {
  if (mode !== "managed" || !MANAGED_CUSTOM_AUTH_TOOLKITS.has(slug.trim().toLowerCase())) return null;
  return "Twitter/X needs your own X Developer app and Composio auth config. Use self-hosted connected apps for now.";
}

/** A Composio auth config id as the Composio dashboard shows it (ac_…). */
export const AUTH_CONFIG_ID = /^ac_[A-Za-z0-9_-]{4,64}$/;

/**
 * A toolkit Composio has no managed sign-in for connects only through an auth config holding the person's own OAuth
 * app. That config lives in their own Composio project, which the official broker's project cannot use.
 */
export function managedCustomAuthReason(slug: string): string {
  return `${slug} needs your own OAuth app. Add your Composio project key in Settings → API keys; Metal then uses your ${slug} auth config from that project. Connect again.`;
}

/** The auth configs page of the person's own Composio project, where Create Auth Config sets up a toolkit Composio has no
 * managed sign-in for. Composio's docs link it this way; `~` is whichever project they have open, and signing in keeps it
 * (https://docs.composio.dev/docs/tools-direct/authenticating-tools). */
export const COMPOSIO_AUTH_CONFIGS_URL = "https://dashboard.composio.dev/~/project/auth-configs";

// managedCustomAuthReason above, noAuthConfigReason in server/composio-project.ts, and Composio's own wording
const NEEDS_AUTH_CONFIG = /needs your own OAuth app|has no Composio-managed sign-in|does not manage auth for toolkit/i;

/** Connect failed because the toolkit needs an auth config the person makes on Composio. */
export function needsComposioAuthConfig(message: string): boolean {
  return NEEDS_AUTH_CONFIG.test(message);
}
