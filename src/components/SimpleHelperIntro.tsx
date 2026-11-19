import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { phoneAppPrompted } from "@/lib/feature-flags";
import { DEFAULT_BOT_NAME, introAsks, introAsksOffered, introChips, introStaged, stageIntro, useWelcomingBot } from "@/lib/default-bot";
import { activeLocale, t } from "@/lib/i18n";
import { detectSetupWithin, localSetupImport, setupImportApi } from "@/lib/setup-import";
import { api, useStore, type Bot, type InstanceInfo, type Message } from "@/state/store";
import { useTeamPeople, type TeamPeople } from "@/state/team-people";
import { freeFallback } from "../../shared/ai-ranking";
import { greetingName } from "../../shared/greeting-name";
import { CLOUD_FROM_COMPUTER } from "../../shared/cloud-hints";
import { hintSeen } from "@/lib/onboarding";
import { followupText, type HelperFollowupFacts } from "../../shared/helper-followup";
import { BotAvatar } from "./Avatar";
import { joinedCorners, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX } from "./chat-bubble";
import { loadAppCards } from "./bot-settings/useBotApps";
import { engineReady } from "./EngineLibrary";
import { returnFocusToComposer } from "./AskCard";
import { IntroChips } from "./HelperSetup";
import { usePrefersReducedMotion } from "./mascot-clock";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { CloudSignInLine, useMissingCloudAi } from "./onboarding/CloudSignInLine";

/** How long after the part before each part arrives, when a first run has just landed here: the three lines, the typing
 * row, the follow-up and its chips. With no AI there is no typing row, and the follow-up comes `noAi` after the last line. */
export const INTRO_TIMING = { first: 300, line: 700, typing: 600, followup: 2_400, chips: 150, noAi: 600 } as const;
const LOOK_MS = 3_000;
/** Parts in order: none, L1, L2, L3, typing, follow-up, chips. */
const ALL = 6;
const DELAYS = [INTRO_TIMING.first, INTRO_TIMING.line, INTRO_TIMING.line, INTRO_TIMING.typing, INTRO_TIMING.followup, INTRO_TIMING.chips];

/** Dusk's three lines: who it is, what it does here, and that it is looking around. A Dusk that is not the Chief
 * keeps its helper's lines; a Team Cloud member's leaves their day to the team's Chief. */
/** `fromComputer`: a cloud the desktop app set up, where the Chief greets the person by the name it brought along;
 * `carried`: what they told Metal there about themselves came too. */
export function introLines(input: { name: string; chief: boolean; person?: string; team?: string; fromComputer?: boolean; carried?: boolean }): string[] {
  const team = input.team ? t("helperIntro.team", { team: input.team }) : "";
  const carried = input.carried ? t("helperIntro.carried") : "";
  const lead = input.chief ? t("helperIntro.lead.chiefOfStaff") : input.team ? t("helperIntro.lead.member") : t("helperIntro.lead.helper");
  const hello = input.chief ? (input.person && input.fromComputer ? t("helperIntro.helloNamed", { name: input.name, person: input.person }) : t("helperIntro.hello", { name: input.name }))
    : input.person ? t("helperIntro.hi.helperNamed", { name: input.name, person: input.person }) : t("helperIntro.hi.helper", { name: input.name });
  return [hello, [lead, team, carried].filter(Boolean).join(" "), t("helperIntro.lookingAround")];
}

/** The follow-up in the viewer's language. */
export function followupLine(facts: HelperFollowupFacts): string {
  return followupText(facts, (key, params) => t(key, params), (items) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(items));
}

/** Who a User reads connects the AI, once the team's people are known; nothing for someone who can connect one themselves. */
export function whoConnectsAi(team: Pick<TeamPeople, "people" | "admin"> | null): string | undefined {
  return team && !team.admin ? team.people.find((person) => person.role === "owner")?.name ?? "" : undefined;
}

function thinksWith(bot: Bot | undefined, instances: readonly InstanceInfo[]): HelperFollowupFacts["ai"] {
  const works = (instance: InstanceInfo) => engineReady(instance) && !freeFallback(instance);
  if (instances.some((instance) => instance.instanceId === bot?.modelSelection.instanceId && works(instance)) || instances.some(works)) return "own";
  return instances.some((instance) => engineReady(instance) && freeFallback(instance)) ? "backup" : "none";
}

interface Look {
  apps: string[] | null;
  /** The connected apps' slugs, for fitting the first jobs (introAsks). */
  slugs?: string[];
  phonePaired?: boolean;
  importFound?: boolean;
  settled: boolean;
}

/** A real look around, without asking an AI: the apps connected here, a paired phone, skills to bring in. Settles within
 * LOOK_MS; anything not known by then is left out. `deep` also looks for skills on this computer. */
function useLookAround(deep: boolean): Look {
  const [found, setFound] = useState<Look>({ apps: null, settled: false });
  useEffect(() => {
    let active = true;
    const apps = Promise.all([preloadConnectedApps(), loadAppCards()])
      .then(([inventory, cards]) => Object.entries(inventory.services).filter(([, status]) => status.connected)
        .map(([slug]) => ({ slug, label: cards.get(slug)?.label ?? slug })))
      .catch(() => null);
    const phones = api<{ phones?: unknown[] }>("/api/phones").then((response) => (response.phones?.length ?? 0) > 0).catch(() => undefined);
    const look = deep && localSetupImport(false) ? detectSetupWithin(setupImportApi) : null;
    const timer = setTimeout(() => { if (active) setFound((now) => ({ ...now, settled: true })); }, LOOK_MS);
    void Promise.all([apps, phones, look?.found ?? null]).then(([connected, phonePaired, detection]) => {
      if (active) setFound({ apps: connected?.map((app) => app.label) ?? null, slugs: connected?.map((app) => app.slug), phonePaired, importFound: Boolean(detection), settled: true });
    });
    return () => {
      active = false;
      clearTimeout(timer);
      look?.cancel();
    };
  }, [deep]);
  return found;
}

/** How far the intro has come: everything at once, or part by part when a first run has just landed here (stageIntro).
 * The follow-up waits for its facts, and comes at once when they arrive after its time. Staging starts when the intro is
 * first seen, not when it mounts behind the Chief step. Reduced motion shows everything at once. */
function useArrival(first: boolean, ai: boolean, ready: boolean): { shown: number; staged: boolean } {
  const reduced = usePrefersReducedMotion();
  const animate = first && !reduced;
  const [run, setRun] = useState<number | null>(null);
  const [late, setLate] = useState(false);
  const readyNow = useRef(ready);
  readyNow.current = ready;
  useEffect(() => {
    if (animate) setRun(0);
  }, [animate]);
  useEffect(() => {
    if (run === null || run >= ALL) return;
    const next = run === 3 && !ai ? 5 : run + 1;
    if (next === 5 && late) {
      if (ready) setRun(5);
      return;
    }
    const wait = next === 5 && !ai ? INTRO_TIMING.noAi : DELAYS[next - 1]!;
    const timer = setTimeout(() => (next === 5 && !readyNow.current ? setLate(true) : setRun(next)), wait);
    return () => clearTimeout(timer);
  }, [run, ai, ready, late]);
  return { shown: run ?? (animate ? 0 : ALL), staged: run !== null };
}

/** Dusk's first messages in Simple mode, in the viewer's language: three short bubbles, its follow-up once it has looked
 * around (a real message, helperFollowup, which a first run asks the server for) and chips for what is still missing.
 * The chips go once the person writes anything after it (`answered`). */
export function SimpleHelperIntro({ botId, threadId, message, answered, followup }: {
  botId: string; threadId: string; message: Message; answered: boolean; followup?: Message;
}) {
  const { state, dispatch } = useStore();
  const welcoming = useWelcomingBot();
  const hidden = welcoming === botId;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const team = bot?.defaultBot?.person ? state.config?.team?.name : undefined;
  const person = greetingName(state.config?.profile?.name) || undefined;
  const fromComputer = hintSeen(state.config?.onboarding, CLOUD_FROM_COMPUTER);
  const carried = fromComputer && Boolean(state.config?.profile?.aboutMe?.trim());
  const lines = introLines({ name: bot?.name ?? DEFAULT_BOT_NAME, chief: Boolean(bot?.chiefOfStaff), person, team, fromComputer, carried });
  const look = useLookAround(!answered);
  const ai = thinksWith(bot, state.instances);
  // a new cloud whose AIs didn't come along: the one it misses is named, with its sign-in, in place of the AI chip
  const missing = useMissingCloudAi(fromComputer && state.config?.cloudHome === true, ai === "own");
  const connects = whoConnectsAi(useTeamPeople());

  // A first run's intro plays once: it asks for the follow-up, which then stays in the conversation.
  const [first, setFirst] = useState(false);
  const due = !hidden && introStaged(botId);
  useEffect(() => {
    if (!due) return;
    stageIntro(null);
    setFirst(true);
  }, [due]);
  const [posted, setPosted] = useState<HelperFollowupFacts | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  // the person's first line was already a job: no follow-up, and the intro ends without one
  const [skipped, setSkipped] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (!first || !look.settled || followup || asked.current) return;
    asked.current = true;
    void api<{ message?: Message; skipped?: boolean }>(`/api/bots/${encodeURIComponent(botId)}/helper-followup`, {
      method: "POST",
      body: JSON.stringify({ threadId, ai, apps: look.apps ?? [] }),
    }).then((answer) => (answer.skipped ? setSkipped(true) : answer.message?.helperFollowup ? setPosted(answer.message.helperFollowup) : setUnsaved(true)), () => setUnsaved(true));
  }, [first, look.settled, look.apps, followup, botId, threadId, ai]);

  // An intro from before follow-ups were written says what it sees, without saving it.
  const local: HelperFollowupFacts | null = look.settled && (unsaved || !(first || due))
    ? { ai, apps: look.apps ?? [], bots: state.bots.filter((candidate) => !candidate.hidden && !candidate.defaultBot).length, routines: 0 }
    : null;
  const said = followup?.helperFollowup ?? posted ?? local;
  const facts = said && connects !== undefined ? { connects, ...said } : said;
  const { shown, staged } = useArrival(first || due, ai !== "none", facts !== null || skipped);
  if (hidden) return null;

  const bubbles = [...lines.slice(0, Math.min(shown, 3)), ...(shown >= 5 && facts ? [followupLine(facts)] : [])];
  // the chips belong under these bubbles: none while the app connects, reconnects or the transcript is still loading
  const onScreen = state.connected && bot?.transcriptLoaded !== false && bubbles.length > 0;
  const chips = answered || !onScreen || shown < ALL || !facts ? [] : introChips({
    aiReady: ai === "own" || missing !== null,
    ownBots: state.bots.filter((candidate) => !candidate.hidden && !candidate.defaultBot).length,
    onCloud: state.config?.cloudHome === true,
    team: Boolean(state.config?.team),
    remote: typeof window !== "undefined" && window.duskDesktop?.remoteClient?.active === true,
    appsConnected: Boolean(look.apps?.length),
    phonePaired: look.phonePaired,
    phoneApp: phoneAppPrompted(),
    importFound: look.importFound,
  });
  const ready = !answered && onScreen && shown >= ALL && facts !== null && introAsksOffered(ai);
  const typing = staged && ai !== "none" && shown === 4 && Boolean(bot);
  return (
    <div data-helper-intro={message.id} className="flex w-full flex-col items-start gap-1">
      {bubbles.map((text, index) => (
        <div
          key={index}
          data-chat-bubble="simple"
          data-helper-line={index}
          {...(index === 3 ? { "data-helper-followup": "" } : {})}
          className={cn("w-fit", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE, joinedCorners("start", { above: index > 0, below: index < bubbles.length - 1 }),
            staged && "animate-msg-in")}
        >
          {text}
        </div>
      ))}
      {typing && bot && (
        <div role="status" data-helper-typing="" className="mt-1.5 flex items-center gap-2">
          <BotAvatar bot={bot} size={32} state="thinking" />
          <span className="text-[14px] leading-5 text-ink-tertiary">{t("helperIntro.typing")}</span>
        </div>
      )}
      {missing && onScreen && shown >= ALL && <CloudSignInLine tile={missing} />}
      <IntroChips chips={chips} asks={introAsks(look.slugs ?? [])} onAsk={ready ? (answer) => { dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer }); returnFocusToComposer(); } : undefined} />
    </div>
  );
}
