import { z } from "zod";

import { claudeUserMcpEnabled, DATA_DIR, type AppConfig } from "../config.ts";
import { lookForBots } from "../bot-move-local.ts";
import { lookForGrokBot, lookForNotes, removeOldCursorSignIn } from "../grok-local.ts";
import { applySetupImport, detectSetup, thisMachine, type SetupHost, type SetupMachine } from "../setup-import.ts";
import { SETUP_SOURCES } from "../../shared/setup-import.ts";
import type { BusyFlag } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SetupImportRouteDeps {
  /** True only on the desktop app's own server. Never on `metal serve`, where any local process, a bot's shell
   * among them, is the owner's loopback; nor on a Cloud home or a hosted organization server, whose files are not the
   * person's own. */
  local: boolean;
  cfg: Pick<AppConfig, "mcpServers" | "features">;
  mcpConfigBusy: BusyFlag;
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  /** A bot of this person's here, whose memory imported notes may go to. */
  botExists?(id: string): boolean;
  /** The computer whose files are read; tests point it at a fixture home. */
  machine?: () => SetupMachine;
  dataDir?: string;
}

export const SETUP_IMPORT_PATH = "/api/setup-import";
export const GROK_LOOK_PATH = "/api/setup-import/grok";
export const BOTS_LOOK_PATH = "/api/setup-import/bots";
/** The notes file another AI saved to Downloads after the prompt was copied (`?since=` its time, in ms). */
export const NOTES_LOOK_PATH = "/api/setup-import/notes";
const LOCAL_ONLY = "Only the desktop app on the computer running Metal can bring in that computer's skills and tools.";
const SOURCES = SETUP_SOURCES;
const requestSchema = z.object({
  skills: z.boolean().optional(), tools: z.boolean().optional(), instructions: z.boolean().optional(), memory: z.boolean().optional(),
  memoryBot: z.string().min(1).max(200).optional(),
  sources: z.array(z.enum(SOURCES)).max(SOURCES.length).optional(),
}).strict();

/** GET finds what is new here; POST brings in the chosen kinds. Only the owner's own loopback, never a paired device,
 * a browser elsewhere, a bot's shell on a service server, a Cloud home or a hosted server. */
export function createSetupImportRoutes(deps: SetupImportRouteDeps): RouteHandler {
  removeOldCursorSignIn(deps.dataDir ?? DATA_DIR);
  const machine = deps.machine ?? thisMachine;
  const host: SetupHost = {
    mcpServers: () => deps.cfg.mcpServers ?? {},
    mcpPolicyRefusal: deps.mcpPolicyRefusal,
    persistMcpServers: deps.persistMcpServers,
    mcpConfigBusy: deps.mcpConfigBusy,
    claudeUserMcp: () => claudeUserMcpEnabled(deps.cfg),
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === NOTES_LOOK_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      res.setHeader("Cache-Control", "no-store");
      const since = Number(new URL(req.url ?? "", "http://local").searchParams.get("since"));
      if (!Number.isFinite(since) || since <= 0) return json(res, 400, { error: "since must be a time in ms" });
      return json(res, 200, { files: lookForNotes(machine(), since) });
    }
    if (path === GROK_LOOK_PATH || path === BOTS_LOOK_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      res.setHeader("Cache-Control", "no-store");
      const downloads = new URL(req.url ?? "", "http://local").searchParams.get("downloads") !== "0";
      return json(res, 200, path === GROK_LOOK_PATH ? lookForGrokBot(machine(), { downloads }) : lookForBots(machine(), { dataDir: deps.dataDir ?? DATA_DIR }));
    }
    if (path !== SETUP_IMPORT_PATH) return PASS;
    if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET") return json(res, 200, detectSetup(machine(), host));
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const parsed = requestSchema.safeParse(await readBody(req, 4_096));
    if (!parsed.success || (!parsed.data.skills && !parsed.data.tools && !parsed.data.instructions && !parsed.data.memory)) {
      return json(res, 400, { error: "Choose skills, tools, instructions or memory." });
    }
    if (parsed.data.memory && (!parsed.data.memoryBot || !deps.botExists?.(parsed.data.memoryBot))) {
      return json(res, 400, { error: "Memory goes to one of your bots: memoryBot must name one." });
    }
    return json(res, 200, applySetupImport(machine(), host, parsed.data));
  };
}
