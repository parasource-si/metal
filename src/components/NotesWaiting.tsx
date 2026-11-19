// Notes from another AI, as the chat takes them: pasted or dropped into any chat, and one quiet card above the first
// bot's message box while they are on their way. When they come (from Downloads, a drop or a paste) that card says so
// for a few seconds and goes; the first bot says it got them, works through them on its working row, and ends with its
// summary. Nothing about the import is ever said inside the message box.
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, X } from "../icons";
import type { LocaleKey } from "@/locales";
import { localSetupImport } from "@/lib/setup-import";
import { arrivalFailed, dismissArrival, noteArrival, useNotesArrival, useNotesWork, type NotesVia } from "@/lib/notes-arrival";
import { copyNotesPrompt, importNotes, notesWatch, takeNotesFromDownloads, WATCH_EVERY_MS, isNotesPrompt, notesErrorLine, notesOutcomeLine, scheduleNotesReminder, stopWaiting, useNotesWaiting } from "@/lib/assistant-notes";
import { myDefaultBot, useViewerEmail } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { systemNotificationsAllowed } from "@/lib/notify";
import { useStore } from "@/state/store";

export type NotesSay = (line: string, state: "working" | "done" | "failed") => void;

/** Takes a pasted or dropped block. A chat passes no `say`: the card above its message box and the first bot's chat
 * say how it goes. A screen of its own (the bring step) passes `say` to hear "bringing in…", then the outcome. */
export function useNotesIntake() {
  const { state, dispatch } = useStore();
  const firstBotId = myDefaultBot(state.bots, useViewerEmail())?.id ?? null;
  return useCallback((text: string, say?: NotesSay, via: NotesVia = "paste", chatBot?: string | null) => {
    // the chat it was pasted or dropped into; a group's or none is the first bot's
    const here = (chatBot && state.bots.some((bot) => bot.id === chatBot) ? chatBot : null) ?? firstBotId;
    if (isNotesPrompt(text)) {
      if (say) say(t("composer.notes.error.prompt"), "failed");
      else { noteArrival(via, here); arrivalFailed(t("composer.notes.error.prompt")); }
      return;
    }
    if (say) say(t("composer.notes.working"), "working");
    else noteArrival(via, here);
    // in a chat, that chat's bot says how it goes; a screen of its own leaves it to the first bot
    const chatBotId = say ? null : here;
    void importNotes(text, { bots: state.bots, aboutMe: state.config?.profile?.aboutMe ?? "", team: Boolean(state.config?.team), firstBotId, chatBotId, dispatch }, { via })
      .then((outcome) => say?.(notesOutcomeLine(outcome), outcome.failed.length || outcome.lost?.length ? "failed" : "done"),
        (cause: unknown) => (say ? say(notesErrorLine(cause), "failed") : arrivalFailed(notesErrorLine(cause))));
  }, [state.bots, state.config?.profile?.aboutMe, state.config?.team, firstBotId, dispatch]);
}

/** While the prompt's answer may still come, Downloads is checked every few seconds for the metal-notes.md it
 * asks for, and a new one comes in by itself, with the first bot's note saying so. Only on the desktop app's own
 * computer; never before the prompt was copied. Paste and drop still work the whole time. */
export function useNotesFromDownloads() {
  const { state, dispatch } = useStore();
  const firstBotId = myDefaultBot(state.bots, useViewerEmail())?.id ?? null;
  const context = useRef({ bots: state.bots, aboutMe: "", team: false, firstBotId, dispatch });
  context.current = { bots: state.bots, aboutMe: state.config?.profile?.aboutMe ?? "", team: Boolean(state.config?.team), firstBotId, dispatch };
  const local = Boolean(state.config) && localSetupImport(state.config?.cloudHome === true);
  useEffect(() => {
    if (!local) return;
    let busy = false;
    const timer = setInterval(() => {
      const watch = notesWatch();
      if (busy || !watch || Date.now() > watch.until) return;
      busy = true;
      void takeNotesFromDownloads(context.current).finally(() => { busy = false; });
    }, WATCH_EVERY_MS);
    return () => clearInterval(timer);
  }, [local]);
}

/** One reminder 15 minutes after the prompt was copied, while its answer hasn't come: a system notification that opens
 * the first bot's chat. Without permission for one, the waiting line in that chat is the reminder. */
export function useNotesReminder() {
  const { state, dispatch } = useStore();
  const waiting = useNotesWaiting();
  const firstBotId = myDefaultBot(state.bots, useViewerEmail())?.id;
  useEffect(() => {
    if (!waiting || waiting.reminded || !firstBotId) return;
    return scheduleNotesReminder(() => {
      if (typeof Notification === "undefined" || !systemNotificationsAllowed() || Notification.permission !== "granted") return;
      try {
        new Notification(t("composer.notes.remindTitle"), { body: t("composer.notes.remindBody"), tag: "duskbot:notes", silent: true }).onclick = () => {
          window.focus();
          dispatch({ type: "select", id: firstBotId });
        };
      } catch {}
    });
  }, [waiting, firstBotId, dispatch]);
}

const GOT: Record<NotesVia, LocaleKey> = { downloads: "composer.notes.got.downloads", drop: "composer.notes.got.drop", paste: "composer.notes.got.paste" };

const cardClass = "mb-2 flex items-center gap-2 rounded-[14px] bg-ink/[0.04] py-1.5 pe-1.5 ps-3 text-[13px] leading-[18px] text-ink-secondary";
const xClass = "grid size-7 shrink-0 place-items-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

/** Above the message box: while notes are on their way (first bot's chat only), "waiting" with the prompt again and a
 * way to stop; once they come into this chat, that they came, for a few seconds, then nothing. */
export function NotesWaitingLine({ botId }: { botId: string | undefined }) {
  const { state } = useStore();
  const waiting = useNotesWaiting();
  const arrival = useNotesArrival();
  const first = myDefaultBot(state.bots, useViewerEmail());
  // while the first bot works through them, its chat says how it goes: no waiting card under that
  const working = useNotesWork(first?.id);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!botId) return null;
  if (arrival && (arrival.botId ?? first?.id) === botId) {
    return (
      <div data-notes-arrived={arrival.failed ? "failed" : arrival.via} role="status" aria-live="polite" className={cardClass}>
        {arrival.failed
          ? <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
          : <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink/60" />}
        <span className="min-w-0 flex-1 text-pretty">{arrival.failed ?? t(GOT[arrival.via])}</span>
        <button type="button" data-notes-dismiss="" onClick={dismissArrival} aria-label={t("composer.notes.dismiss")} title={t("composer.notes.dismiss")} className={xClass}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }
  if (!waiting || working || botId !== first?.id) return null;
  return (
    <div data-notes-waiting="" className={cardClass}>
      <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink/60" />
      <span className="min-w-0 flex-1 text-pretty">{t("composer.notes.waiting")}</span>
      <button type="button" data-notes-copy="" onClick={() => void copyNotesPrompt().then(setCopied)}
        className="shrink-0 rounded-full px-2 py-1 text-ink transition-colors hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
        {copied ? t("composer.notes.copied") : t("composer.notes.copyAgain")}
      </button>
      <button type="button" data-notes-stop="" onClick={stopWaiting} aria-label={t("composer.notes.stopWaiting")} title={t("composer.notes.stopWaiting")} className={xClass}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
