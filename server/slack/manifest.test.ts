import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSlackManifest, manifestHash, SLACK_BOT_EVENTS, SLACK_BOT_SCOPES } from "./manifest.ts";

const redirect = "https://example.test/slack/callback";
const scopes = [
  "app_mentions:read", "chat:write", "channels:history", "channels:read", "groups:history", "groups:read",
  "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "reactions:read", "reactions:write",
  "files:read", "files:write", "users:read", "users:read.email",
];
const events = [
  "app_mention", "message.im", "message.channels", "message.groups", "message.mpim", "reaction_added",
  "member_joined_channel", "app_home_opened",
];

describe("Slack manifest", () => {
  it("builds the exact plain bot manifest", () => {
    const manifest = buildSlackManifest({ name: "  Research bot  ", description: "Finds answers.", color: "green" }, redirect);
    expect(manifest).toEqual({
      display_information: { name: "Research bot", description: "Finds answers.", background_color: "#009957" },
      features: {
        app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: "Research bot", always_online: true },
      },
      oauth_config: { redirect_urls: [redirect], scopes: { bot: scopes } },
      settings: {
        event_subscriptions: { bot_events: events }, interactivity: { is_enabled: false },
        org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false,
      },
    });
    expect(SLACK_BOT_SCOPES).toEqual(scopes);
    expect(SLACK_BOT_EVENTS).toEqual(events);
    expect(JSON.stringify(manifest)).not.toMatch(/assistant_view|agent_view/);
  });

  it("truncates names and descriptions to Slack limits", () => {
    expect(buildSlackManifest({ name: ` ${"n".repeat(100)} `, description: "d".repeat(150) }, redirect)).toMatchObject({
      display_information: { name: "n".repeat(35), description: "d".repeat(140) },
      features: { bot_user: { display_name: "n".repeat(80) } },
    });
  });

  it("uses nonempty defaults", () => {
    expect(buildSlackManifest({ name: " \t\n ", description: " " }, redirect)).toMatchObject({
      display_information: { name: "Metal", description: "A bot made with Metal.", background_color: "#377FE6" },
      features: { bot_user: { display_name: "Metal" } },
    });
  });

  it.each([
    ["green", "#009957"], ["blue", "#377FE6"], ["red", "#D94B52"], ["orange", "#E78531"],
    ["purple", "#8057C8"], ["cyan", "#0EA5C6"], ["pink", "#D84F8B"], ["yellow", "#D8A729"],
    ["teal", "#01A492"], ["coral", "#E5634E"], ["brown", "#A06B39"], ["silver", "#A8ADB4"],
    ["chrome", "#B3BAC4"], ["unknown", "#377FE6"], ["toString", "#377FE6"],
  ])("maps colour %s", (color, background_color) => {
    expect(buildSlackManifest({ name: "Bot", color }, redirect)).toMatchObject({ display_information: { background_color } });
  });

  it("hashes recursively sorted JSON while preserving array order", () => {
    const first = { z: [{ b: 2, a: 1 }], a: { y: 2, x: 1 } };
    const second = { a: { x: 1, y: 2 }, z: [{ a: 1, b: 2 }] };
    expect(manifestHash(first)).toBe(manifestHash(second));
    expect(manifestHash(first)).toBe(createHash("sha256").update(JSON.stringify(second)).digest("hex"));
    expect(manifestHash({ a: [1, 2] })).not.toBe(manifestHash({ a: [2, 1] }));
    expect(manifestHash({ a: 1 })).not.toBe(manifestHash({ a: 2 }));
  });
});
