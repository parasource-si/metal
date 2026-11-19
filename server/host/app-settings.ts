import type { ServerResponse } from "node:http";
import { z } from "zod";

import { APP_PREF_NAMES, APP_PREF_SETTINGS, isAppPrefSetting } from "../../shared/app-prefs.ts";
import { APP_SETTINGS_PATH } from "../drivers/agents-app-settings-tool.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import type { SettingsSync } from "../settings-sync.ts";

export interface AppSettingsDeps {
  sync: () => Pick<SettingsSync, "ui" | "setUi"> | null;
  /** Why this turn may not change the person's preferences (a Team Cloud, a guest, a routine), or null. */
  refusal(botId: string, threadId: string): string | null;
  changed(): void;
  now?: () => number;
}

const bodySchema = z.union([
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("set"), setting: z.string(), value: z.string() }).strict(),
]);

export function createAppSettings(deps: AppSettingsDeps) {
  const now = deps.now ?? Date.now;
  const listing = (sync: Pick<SettingsSync, "ui">) => {
    const kept = sync.ui();
    return APP_PREF_NAMES.map((name) => `${name}: ${kept[APP_PREF_SETTINGS[name].pref]?.value ?? "the app's default"} (one of ${APP_PREF_SETTINGS[name].values.join(", ")})`).join("\n");
  };
  return {
    async internal(ctx: { method: string; path: string; res: ServerResponse; json: typeof sendJson; botId: string; threadId: string; readBody: () => Promise<unknown> }): Promise<typeof PASS | void> {
      if (ctx.path !== APP_SETTINGS_PATH) return PASS;
      if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
      const parsed = bodySchema.safeParse(await ctx.readBody());
      if (!parsed.success) return ctx.json(ctx.res, 400, { error: `app_settings set needs setting (${APP_PREF_NAMES.join(", ")}) and value.` });
      const sync = deps.sync();
      if (!sync) return ctx.json(ctx.res, 409, { error: "This place keeps no personal app preferences (a Team Cloud). Tell the person to change it in Settings on their own screen." });
      if (parsed.data.action === "list") return ctx.json(ctx.res, 200, { text: `The person's app preferences:\n${listing(sync)}` });
      const refused = deps.refusal(ctx.botId, ctx.threadId);
      if (refused) return ctx.json(ctx.res, 403, { error: refused });
      const { setting, value } = parsed.data;
      if (!isAppPrefSetting(setting)) return ctx.json(ctx.res, 400, { error: `There is no app setting "${setting}". Settings: ${APP_PREF_NAMES.join(", ")}.` });
      const { pref, values } = APP_PREF_SETTINGS[setting];
      const wanted = value.trim().toLowerCase();
      if (!(values as readonly string[]).includes(wanted)) return ctx.json(ctx.res, 400, { error: `${setting} must be one of ${values.join(", ")}.` });
      const saved = sync.setUi(pref, wanted, now());
      if (!saved.ok) return ctx.json(ctx.res, 409, { error: `${setting} was changed on another screen a moment ago; list it again before changing it.` });
      deps.changed();
      return ctx.json(ctx.res, 200, { text: `Set ${setting} to ${wanted}. Every open Metal screen of the person's picks it up now; tell them in one line.` });
    },
  };
}
