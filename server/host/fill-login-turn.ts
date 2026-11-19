// fill_login for one turn: filled by the server as one browser action, answered with a status in words, never a value.
import type { Surface } from "../../shared/wire.ts";
import type { BotLogins } from "../bot-logins.ts";
import { BROWSER_CONTROL_REFUSAL } from "../browser-runtime.ts";
import type { StepContext } from "../browser-steps.ts";
import type { SecretHold } from "../browser-secret-hold.ts";
import { fillLogin, NO_LOGIN_NEXT, type FillLoginDeps, type FillLoginOutcome } from "../login-fill.ts";
import { redactSecretsInText } from "../redact.ts";
import { classifyLoginFailure } from "../secret-failure.ts";
import type { LoginRejection } from "./secret-cards.ts";
import type { BotRecord } from "../store.ts";
import { surfaceLabel } from "../surface.ts";

type Spec = { command: string; env: Record<string, string> };
type Turn = { botId: string; threadId: string; generation: string };
type Answer = { ok: boolean; text: string };
type LoginInput = Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click">;

/** The page in front of the bot's own desktop Chromium, held for one fill: `finish` lets the computer go again and clears
 * what a fill left on the page once its hold ends. */
export interface DesktopLogin {
  input: LoginInput;
  finish(held?: SecretHold): void;
}

/** Thrown by a desktop fill's input when the person took control of the computer mid-fill. */
export const DESKTOP_TAKEN = "the person took control of the computer";

export interface FillLoginTurnDeps<T extends Turn = Turn> {
  place(bot: BotRecord, threadId: string): Surface | null;
  current(bot: BotRecord, threadId: string): BotRecord;
  builtInBrowserOn(): boolean;
  /** The bot's own browser can be this conversation's place on its next turn. */
  browserSelectable(bot: BotRecord): boolean;
  /** Continues this request in the bot's own browser once the turn ends; false when this turn cannot move. */
  moveToBrowser(turn: Turn): boolean;
  /** The bot's browser profile is the person's own Chrome. */
  myChrome(bot: BotRecord): boolean;
  /** Null while the browser engine is not installed. */
  target(bot: BotRecord, threadId: string): Promise<{ session: string; spec: Spec; env: NodeJS.ProcessEnv } | null>;
  claim(turn: Turn, resource: string): boolean;
  withSecretInput(session: string, spec: Spec, fill: () => Promise<FillLoginOutcome>, ctx: StepContext): Promise<FillLoginOutcome>;
  logins: Pick<BotLogins, "candidates" | "sitesFor" | "markUsed"> & Partial<Pick<BotLogins, "rejected">>;
  /** A saved login the site refused was removed or marked: the person is told once, and what the bot is told is returned. */
  loginRejected?(botId: string, threadId: string, rejection: LoginRejection | null): string | null;
  /** Why 1Password's logins may be missing just now. */
  onePasswordTrouble(): string | undefined;
  loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click">;
  remember: FillLoginDeps["remember"];
  stepContext(bot: BotRecord, turn: Turn): StepContext;
  /** The bot's own VPS desktop: its Chromium's front page once this turn may use the screen, a refusal in words, or null
   * when that desktop has no Chromium the server can reach. */
  desktop?(bot: BotRecord, turn: T): Promise<DesktopLogin | { refusal: string } | null>;
}

const ONLY_IN_BROWSER = "fill_login types a password only into a page of your own browser, where Metal checks the page's site first";

export function createFillLoginTurn<T extends Turn = Turn>(deps: FillLoginTurnDeps<T>) {
  // Security: on a screen the server cannot prove which site a focused box belongs to, so a secret is never typed there.
  function elsewhere(bot: BotRecord, turn: Turn, place: Surface | null): Answer {
    const current = deps.current(bot, turn.threadId);
    const where = place ? surfaceLabel(place) : null;
    const notHere = where ? `; it never types one on the screen of ${where}` : "";
    const signIn = where ? `Call request_sign_in so the person signs in on ${where}.` : "Call request_sign_in instead.";
    const noLogin = `${NO_LOGIN_NEXT}${where ? ` They can also sign in themselves on ${where} with request_sign_in.` : ""}`;
    if (!deps.browserSelectable(current)) {
      const why = current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()
        ? "the built-in browser is off for you here"
        : "your browser is not available here: it is not installed yet, or this AI model cannot use browser tools";
      return { ok: false, text: where ? `${ONLY_IN_BROWSER}${notHere}, and ${why}. ${signIn}` : `fill_login works in the built-in browser, and this conversation has none. ${signIn}` };
    }
    if (!deps.logins.sitesFor(bot.id).length) {
      const trouble = deps.onePasswordTrouble();
      return { ok: false, text: `You have no saved logins to fill${trouble ? ` (1Password could not be read just now: ${trouble})` : ""}. ${noLogin}` };
    }
    if (!deps.moveToBrowser(turn)) {
      return { ok: false, text: `${ONLY_IN_BROWSER}${notHere}, and this run cannot move to your browser. ${signIn}` };
    }
    const chrome = deps.myChrome(current) ? ", which is the person's own Chrome (My Chrome), signed in as them" : "";
    return { ok: false, text: `${ONLY_IN_BROWSER}${notHere}. Metal is moving this conversation to your own browser${chrome}. End this turn now without using the screen tools: the request continues there with your browser tools. Open the site's sign-in page in that browser, then call fill_login.` };
  }

  // a clear "wrong password" or refused code removes a saved login; an unclear refusal marks it once; a temporary one does nothing
  function answer(bot: BotRecord, threadId: string, outcome: FillLoginOutcome): Answer {
    if (outcome.ok && outcome.loginId) deps.logins.markUsed(outcome.loginId);
    if (outcome.ok || !outcome.rejected || !outcome.loginId) return { ok: outcome.ok, text: outcome.text };
    let extra: string | null = null;
    try {
      const change = deps.logins.rejected?.(outcome.loginId, outcome.rejected.step, classifyLoginFailure(outcome.rejected)) ?? null;
      extra = deps.loginRejected?.(bot.id, threadId, change) ?? null;
    } catch (error) {
      console.warn(`fill_login: could not record a refused login: ${error instanceof Error ? error.name : "error"}`);
    }
    return { ok: false, text: extra ? `${outcome.text}${extra}` : outcome.text };
  }

  function fillInput(bot: BotRecord, rawUsername: unknown, rawSubmit: unknown) {
    return {
      username: typeof rawUsername === "string" ? rawUsername.slice(0, 512) : undefined,
      submit: rawSubmit !== false,
      candidates: (host: string) => deps.logins.candidates(bot.id, host),
      available: async () => deps.logins.sitesFor(bot.id),
      trouble: deps.onePasswordTrouble,
    };
  }

  // the desktop's Chromium answers over DevTools, so the server reads the page's own address before every keystroke,
  // exactly as in the built-in browser; null leaves the request to the plain screen answer
  async function onDesktop(bot: BotRecord, capability: T, rawUsername: unknown, rawSubmit: unknown): Promise<Answer | null> {
    if (!deps.desktop) return null;
    const current = deps.current(bot, capability.threadId);
    if (!deps.logins.sitesFor(bot.id).length) {
      const trouble = deps.onePasswordTrouble();
      return { ok: false, text: `You have no saved logins to fill${trouble ? ` (1Password could not be read just now: ${trouble})` : ""}. ${NO_LOGIN_NEXT}` };
    }
    let opened: DesktopLogin | { refusal: string } | null;
    try {
      opened = await deps.desktop(current, capability);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not reach Chromium on your computer: ${redactSecretsInText(reason)} Call fill_login again in a moment; if it keeps failing, call request_sign_in.` };
    }
    if (!opened) return null;
    if ("refusal" in opened) return { ok: false, text: opened.refusal };
    let outcome: FillLoginOutcome;
    try {
      outcome = await fillLogin(fillInput(bot, rawUsername, rawSubmit), { ...opened.input, remember: deps.remember });
    } catch (error) {
      opened.finish();
      if (error instanceof Error && error.message === DESKTOP_TAKEN) {
        return { ok: false, text: "The person took control of your computer while the login was being typed, so it stopped and the password was cleared from the page. Wait for them to hand it back, look at the page, then call fill_login again." };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the login: ${redactSecretsInText(reason)} Call request_sign_in if it keeps failing.` };
    }
    opened.finish(outcome.held);
    return answer(bot, capability.threadId, outcome);
  }

  async function fillLoginForTurn(bot: BotRecord, capability: T, rawUsername: unknown, rawSubmit: unknown): Promise<Answer> {
    const threadId = capability.threadId;
    const place = deps.place(bot, threadId);
    if (place === "cloud") {
      const answer = await onDesktop(bot, capability, rawUsername, rawSubmit);
      if (answer) return answer;
    }
    if (place !== "browser") return elsewhere(bot, capability, place);
    const current = deps.current(bot, threadId);
    if (current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()) {
      return { ok: false, text: "The built-in browser is off for you here, so fill_login has nothing to fill. Call request_sign_in instead." };
    }
    const browser = await deps.target(current, threadId);
    if (!browser) return { ok: false, text: "The browser is not available on this computer right now. Call request_sign_in instead." };
    const { session, spec, env } = browser;
    if (!deps.claim(capability, `browser:${session}`)) {
      return { ok: false, text: "Another conversation is using this browser. Wait until it finishes, then call fill_login again." };
    }
    try {
      const outcome = await deps.withSecretInput(session, spec, () => fillLogin(fillInput(bot, rawUsername, rawSubmit), {
        ...deps.loginInput(session, spec, env),
        remember: deps.remember,
      }), deps.stepContext(current, capability));
      return answer(bot, threadId, outcome);
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL) {
        return { ok: false, text: "The person is using this browser right now. Wait for them to hand it back, then call fill_login again." };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the login: ${redactSecretsInText(reason)} Call request_sign_in if it keeps failing.` };
    }
  }

  return { fillLoginForTurn };
}
