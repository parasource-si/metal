import { createHash } from "node:crypto";

export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read", "chat:write", "channels:history", "channels:read", "groups:history",
  "groups:read", "im:history", "im:read", "im:write", "mpim:history", "mpim:read",
  "reactions:read", "reactions:write", "files:read", "files:write", "users:read", "users:read.email",
];
export const SLACK_BOT_EVENTS: readonly string[] = [
  "app_mention", "message.im", "message.channels", "message.groups", "message.mpim",
  "reaction_added", "member_joined_channel", "app_home_opened",
];

const colors: Record<string, string> = {
  green: "#009957", blue: "#377FE6", red: "#D94B52", orange: "#E78531", purple: "#8057C8",
  cyan: "#0EA5C6", pink: "#D84F8B", yellow: "#D8A729", teal: "#01A492", coral: "#E5634E",
  brown: "#A06B39", silver: "#A8ADB4", chrome: "#B3BAC4",
};

export function buildSlackManifest(bot: { name: string; description?: string; color?: string }, redirectUrl: string): Record<string, unknown> {
  const name = bot.name.trim() || "Metal";
  return {
    display_information: {
      name: name.slice(0, 35),
      description: (bot.description?.trim() || "A bot made with Metal.").slice(0, 140),
      background_color: Object.hasOwn(colors, bot.color ?? "") ? colors[bot.color!] : colors.blue,
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name.slice(0, 80), always_online: true },
    },
    oauth_config: { redirect_urls: [redirectUrl], scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false,
    },
  };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, sorted(child)]));
  }
  return value;
}

export function manifestHash(manifest: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(sorted(manifest))).digest("hex");
}
