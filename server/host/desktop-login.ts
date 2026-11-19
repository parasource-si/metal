// fill_login on a bot's VPS desktop: the front page of the desktop's Chromium, once the turn may use the screen like any
// screen call (a person's hold is waited out), with that desktop's screen calls held back until the fill answers. Also
// starts that Chromium as soon as a turn takes the desktop, so a page, the browser tools and fill_login never race its launch.
import type { ControlState } from "../control-client.ts";
import { boxChromeSocket, openBoxLoginPage } from "../box-login-page.ts";
import type { BotRecord } from "../store.ts";
import { DESKTOP_TAKEN, type DesktopLogin } from "./fill-login-turn.ts";

type Turn = { botId: string; threadId: string; generation: string; teamComputerId?: string };

export const DESKTOP_FILL_BUSY = "Metal is typing a saved login on this computer, so this call was not performed. Look at the screen again once fill_login has answered.";

export interface DesktopLoginDeps<T extends Turn> {
  /** The VPS desktop this turn mounted, if it is this bot's turn's. */
  mounted(threadId: string): { generation: string; botId: string } | undefined;
  /** The same wait and claim every screen call passes. */
  gate(turn: T): Promise<ControlState>;
  /** The relay address of the Chromium on the turn's desktop; null or false when there is none. */
  boxChrome(botId: string, turn: { threadId: string; generation: string }): Promise<string | false | null>;
  personHolds(botId: string, teamComputerId?: string): boolean;
  active(turn: T): boolean;
  touched(turn: T): void;
  open?: typeof openBoxLoginPage;
  log?: (line: string) => void;
}

export function createDesktopLogin<T extends Turn>(deps: DesktopLoginDeps<T>) {
  const filling = new Set<string>();
  const open = deps.open ?? openBoxLoginPage;

  async function openDesktopLogin(bot: BotRecord, turn: T): Promise<DesktopLogin | { refusal: string } | null> {
    const { threadId, generation } = turn;
    const mounted = deps.mounted(threadId);
    if (!mounted || mounted.generation !== generation || mounted.botId !== bot.id) return null;
    const gate = await deps.gate(turn);
    if (gate.held) return { refusal: gate.blockedReason ?? "The person is using your computer right now. Wait for them to hand it back, then call fill_login again." };
    const url = await deps.boxChrome(bot.id, { threadId, generation });
    if (!url) return null;
    filling.add(threadId);
    let page: Awaited<ReturnType<typeof openBoxLoginPage>>;
    try {
      page = await open(url, { guard: () => {
        if (deps.personHolds(bot.id, turn.teamComputerId) || !deps.active(turn)) throw new Error(DESKTOP_TAKEN);
      } });
    } catch (error) {
      filling.delete(threadId);
      throw error;
    }
    if ("refusal" in page) {
      filling.delete(threadId);
      return page;
    }
    const opened = page;
    return {
      input: opened.input,
      finish: (held) => {
        filling.delete(threadId);
        deps.touched(turn);
        if (!held?.clear) { opened.close(); return; }
        const clear = held.clear;
        setTimeout(() => { void clear().catch(() => undefined).finally(() => opened.close()); }, held.ms).unref();
      },
    };
  }

  /** Starts the desktop's Chromium ahead of use, waiting out a slow first start. */
  function prewarm(botId: string, chrome: () => Promise<string | null>): void {
    void chrome()
      .then((url) => (url ? boxChromeSocket(url) : null))
      .catch((error: unknown) => (deps.log ?? console.warn)(`vps ${botId}: the desktop's Chromium did not start ahead of use (${error instanceof Error ? error.message : String(error)})`));
  }

  return { openDesktopLogin, prewarm, filling: (threadId: string) => filling.has(threadId) };
}
