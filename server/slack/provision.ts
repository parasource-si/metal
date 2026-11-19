import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SlackApiError, type SlackApi, type SlackParams } from "./api.ts";
import type { createConfigTokens } from "./config-token.ts";
import { buildSlackManifest, manifestHash, SLACK_BOT_SCOPES } from "./manifest.ts";
import type { SlackBotRecord, SlackSecretStore } from "./secrets.ts";

export interface SlackProvisionBot { id: string; name: string; description?: string; color?: string }
export interface ProvisionDeps {
  store: SlackSecretStore;
  api: SlackApi;
  tokens: ReturnType<typeof createConfigTokens>;
  redirectUrl: string;
  icon?: (botId: string) => Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg"; name: string } | null>;
  now?: () => number;
  randomState?: () => string;
  log?: (line: string) => void;
}

const id = z.string().min(1).max(64);
const secret = z.string().min(1).max(4096);
const createSchema = z.object({
  app_id: id,
  credentials: z.object({ client_id: id, client_secret: secret, signing_secret: secret }),
});
const oauthSchema = z.object({
  access_token: secret.startsWith("xoxb-"), bot_user_id: id, app_id: id,
  team: z.object({ id, name: z.string().max(200).optional() }),
});
const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

export function slackAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  return `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
    client_id: clientId, scope: SLACK_BOT_SCOPES.join(","), redirect_uri: redirectUri, state,
  })}`;
}

export function createSlackProvisioner(deps: ProvisionDeps) {
  const { store, api, tokens, redirectUrl } = deps;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(32).toString("hex"));
  const log = deps.log ?? (() => {});

  async function call(method: string, token: string | null, params?: SlackParams) {
    try { return await api.call(method, token, params); }
    catch (error) {
      const values = [...store.secretValues(), token, ...Object.values(params ?? {}).filter((value) => typeof value === "string")];
      if (error instanceof SlackApiError && !values.some((value) => value && error.message.includes(String(value)))) throw error;
      throw new SlackApiError("bad_response");
    }
  }

  function patch(botId: string, values: Partial<SlackBotRecord>): SlackBotRecord {
    const record = store.patchBot(botId, values);
    if (!record) throw new SlackApiError("not_installed");
    return record;
  }

  async function setIcon(botId: string, appId: string, configToken: string) {
    try {
      const icon = await deps.icon?.(botId);
      if (!icon) { log("Slack bot icon is unavailable and was skipped."); return; }
      await api.upload("apps.icon.set", configToken, { app_id: appId }, { field: "image", ...icon });
    } catch { log("Slack bot icon could not be updated."); }
  }

  return {
    async provision(bot: SlackProvisionBot): Promise<{ record: SlackBotRecord; authorizeUrl: string }> {
      const workspace = store.workspace();
      if (!workspace || workspace.state !== "connected") throw new SlackApiError("needs_reconnect");
      let record = store.bot(bot.id);
      if (record?.botToken) throw new SlackApiError("already_installed");
      const configToken = await tokens.token();
      const manifest = buildSlackManifest(bot, redirectUrl);
      const hash = manifestHash(manifest);
      if (record?.appId) {
        if (record.teamId !== workspace.teamId) throw new SlackApiError("wrong_team");
        if (record.manifestHash !== hash) {
          await call("apps.manifest.update", configToken, { app_id: record.appId, manifest });
        }
        record = patch(bot.id, { manifestHash: hash, redirectUri: redirectUrl, handle: (bot.name.trim() || "Metal").slice(0, 80) });
      } else {
        const response = createSchema.safeParse(await call("apps.manifest.create", configToken, { manifest }));
        if (!response.success) throw new SlackApiError("bad_response");
        const { app_id, credentials } = response.data;
        record = {
          botId: bot.id, appId: app_id, teamId: workspace.teamId, clientId: credentials.client_id,
          clientSecret: credentials.client_secret, signingSecret: credentials.signing_secret,
          redirectUri: redirectUrl, manifestHash: hash, createdAt: now(),
          handle: (bot.name.trim() || "Metal").slice(0, 80),
        };
        store.putBot(record);
      }
      await setIcon(bot.id, record.appId, configToken);
      const state = randomState();
      if (!/^[0-9a-f]{64}$/.test(state)) throw new SlackApiError("bad_state");
      record = patch(bot.id, { oauthState: { hash: stateHash(state), expiresAt: now() + 15 * 60_000 }, error: undefined });
      return { record, authorizeUrl: slackAuthorizeUrl(record.clientId, record.redirectUri, state) };
    },

    async exchange(code: string, state: string): Promise<SlackBotRecord> {
      if (!/^[0-9a-f]{64}$/.test(state)) throw new SlackApiError("bad_state");
      if (!/^[A-Za-z0-9._-]{8,256}$/.test(code)) throw new SlackApiError("bad_code");
      const expected = Buffer.from(stateHash(state), "hex");
      const record = store.bots().find((candidate) => {
        const actual = Buffer.from(candidate.oauthState?.hash ?? "", "hex");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
      if (!record?.oauthState) throw new SlackApiError("bad_state");
      // consume before the first await so concurrent callbacks cannot reuse the state.
      patch(record.botId, { oauthState: undefined });
      if (record.oauthState.expiresAt <= now()) throw new SlackApiError("expired_state");
      const response = oauthSchema.safeParse(await call("oauth.v2.access", null, {
        client_id: record.clientId, client_secret: record.clientSecret, code, redirect_uri: record.redirectUri,
      }));
      if (!response.success) throw new SlackApiError("bad_response");
      const result = response.data;
      if (result.app_id !== record.appId) throw new SlackApiError("wrong_app");
      if (result.team.id !== record.teamId) throw new SlackApiError("wrong_team");
      let handle = record.handle || "Metal";
      try {
        const user = z.object({ user: z.object({
          name: z.string().max(200).optional(), profile: z.object({ display_name: z.string().max(200).optional() }).optional(),
        }) }).safeParse(await call("users.info", result.access_token, { user: result.bot_user_id }));
        if (user.success) handle = user.data.user.profile?.display_name || user.data.user.name || handle;
      } catch { log("Slack bot profile could not be read."); }
      return patch(record.botId, {
        botToken: result.access_token, botUserId: result.bot_user_id, teamName: result.team.name || record.teamName || record.teamId,
        handle, installedAt: now(), error: undefined,
      });
    },

    async setAppToken(botId: string, token: string): Promise<SlackBotRecord> {
      if (!/^xapp-[A-Za-z0-9-]{20,300}$/.test(token)) throw new SlackApiError("bad_app_token");
      if (!store.bot(botId)?.botToken) throw new SlackApiError("not_installed");
      await call("apps.connections.open", token);
      return patch(botId, { appToken: token, appTokenAt: now() });
    },

    async update(bot: SlackProvisionBot): Promise<void> {
      try {
        const record = store.bot(bot.id);
        if (!record) return;
        const manifest = buildSlackManifest(bot, redirectUrl);
        const hash = manifestHash(manifest);
        if (record.manifestHash === hash || store.workspace()?.state !== "connected") return;
        await call("apps.manifest.update", await tokens.token(), { app_id: record.appId, manifest });
        patch(bot.id, { manifestHash: hash, redirectUri: redirectUrl });
      } catch { log("Slack bot manifest could not be updated."); }
    },

    async remove(botId: string): Promise<void> {
      const record = store.bot(botId);
      if (!record) return;
      if (record.botToken) {
        try { await call("auth.revoke", record.botToken); }
        catch { log("Slack bot token could not be revoked."); }
      }
      if (store.workspace()?.state === "connected") {
        try { await call("apps.manifest.delete", await tokens.token(), { app_id: record.appId }); }
        catch (error) {
          if (!(error instanceof SlackApiError && error.code === "app_not_found")) log("Slack bot app could not be deleted.");
        }
      }
      store.removeBot(botId);
    },
  };
}
