import { AnimatePresence } from "motion/react";
import { directMessageSent, roomMessageSent } from "@/lib/product-events";
import { cueMascot } from "./mascot-events";
import { NoRecognizerNote, useComposerDictation } from "@/lib/use-composer-dictation";
import { CARD_ACTION, ChatErrorCard } from "./ChatErrorBanner";
import { OpenVoiceSettings } from "./OpenVoiceSettings";
import { isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Mic } from "../icons";
import { useStore, visibleMessages, currentTaskBot, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { useMenuMotion } from "./MenuMotion";
import { ELEVATED_CARD, ELEVATED_FLOAT } from "./elevated";
import { activeLocale, t } from "@/lib/i18n";
import { imeComposing, sendKeyLabel, sendsMessage, useSendKey } from "@/lib/send-key";
import { phoneApp } from "@/lib/store-app";
import { alternateSend, useFollowUpDefault } from "@/lib/follow-up"; import { resolveFollowUp, sentFollowUp, type FollowUp } from "../../shared/follow-up";
import {
  draftRevision,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  editFailedComposerSend,
  forgetFailedComposerSend,
  markDraftEdited,
  prependComposerDraft,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  restoredSendId,
  restoredRequestText,
  useComposerDraft,
  useComposerChannelMode,
  useDraftAttachmentPending,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { DEVS_CHOICE, MentionMenu, teammateChoices, type MentionChoice } from "./MentionMenu"; import { useTeammates } from "@/state/team-people"; import { hiddenFromSidebar, useViewerEmail } from "@/lib/default-bot";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments, ComposerAttachmentStrip, pathForFile } from "./ComposerAttachments"; import { ComposerFailedSends } from "./ComposerFailedSends"; import { useComposerFilePickers } from "./ComposerFilePickers";
import { PointedChips } from "./app/PointedChips"; import { SetupRequestChip, setupRequestPlaceholder } from "./SetupOffer";
import { takePointedChips } from "@/lib/pointed-chips";
import { withoutCitationMarkers } from "@/lib/citations";
import { approvalModeFor } from "../../shared/approval-mode";
import { useOnCall } from "@/lib/call";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import {
  appendPastedText,
  attachmentUnsent,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  discardUnsentUpload,
  composerShouldRefocus,
  composerTakesFocusOnOpen,
  imageBytesLeft, imageSlotsLeft, imagesThatFit,
  replyTargetTakesFocus,
  intakeFiles,
  isLongPaste,
  optimisticImageAttachment,
  pasteAttachment,
  pastedTextFile,
  pendingFileAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type FileAttachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { retryPlacedUpload, sendPlacedUpload } from "@/lib/placed-upload";
import { cancelUpload } from "@/lib/upload-progress";
import { goalCoordinatorForComposer, openTaskWorking, roomRouteForComposer } from "@/lib/group-routing";
import { composerPlaceholder, pendingQuestion, sendLabels, SIMPLE_COMPOSER, SIMPLE_CONTROL, slotColors } from "./composer-simple"; import { ComposerSendButton } from "./ComposerSendButton"; import { Icon } from "./Icon";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { CallButton } from "./CallView";
import { ApprovalChip, ComposerPlusMenu, GoalToggle } from "./ComposerPlusMenu";
import { PhoneMicGhost, PhonePlus } from "./PhonePlus";
import { useThreadApproval } from "./thread-approval";
import { usePillHeight, useSlideOnChange, useStackedField } from "./composer-wrap";
import "@/styles/composer.css";
import { ComposerReplyStrip, ComposerSelectionQuote } from "./ReplyQuote";
import { SelectionAskPill } from "./SelectionAskPill";
import { setSelectionQuote, useSelectionQuote, withSelectionQuote } from "@/lib/selection-quote";
import { ComposerVoiceStrip } from "./ComposerVoiceStrip";
import { useSendHold } from "./use-send-hold";
import { useSlotHandoff } from "./use-slot-handoff";
import { VoiceFirstRunSheet } from "./VoiceFirstRunSheet";
import { voiceShortcut, voiceShortcutLabel } from "@/lib/voice-input/shortcut";
import { openSettings } from "@/lib/open-settings";
import { NotesWaitingLine, useNotesIntake } from "./NotesWaiting"; import { looksLikeNotes, notesInFiles } from "@/lib/assistant-notes";
import { escapeCancelsReply } from "@/lib/replies";
import { useStopPress } from "@/lib/stop-turn";
import { useThreadRefs } from "./ThreadRefs";
import {
  QueuedComposerMessages,
  composerCanSteerQueuedMessages,
  doubleEnterSteerWindowExpiresAt,
  doubleEnterSteersQueue,
} from "./ComposerQueuedMessages";
import { liveCallEnabled, voiceCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { mentionChoicesForQuery, mentionQueryAt } from "@/lib/mentions"; import { mentionPicksFor, restoreMentionPicks } from "@/lib/mention-picks";
import { serializeThreadRefs, threadTokenFromPaste, threadTokenSpacing } from "@/lib/thread-refs";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  skillSlashCommands,
  slashMenuRows,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";
import { useSlashSkills } from "@/lib/use-slash-skills";
import { randomUuid } from "@/lib/random-uuid";
import { noteSendLaunch } from "./bubble-entrance";
import { friendlyError } from "@/lib/plain-error";

const supportsAgents = (instances: InstanceInfo[], candidate?: Bot) =>
  Boolean(candidate && instances.find((instance) => instance.instanceId === candidate.modelSelection.instanceId)?.capabilities?.agentsMcp);

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
  quote: string | null;
}

type SlotGlyph = "waveform" | "mic" | "arrow-up" | "stop";
export { SEND_HOLD_MAX_MS } from "./use-send-hold";

function SlotGlyphGhost({ glyph, ink }: { glyph: SlotGlyph; ink: string }) {
  return (
    <span aria-hidden="true" data-composer-glyph-ghost className="pointer-events-none absolute bottom-0 right-0 z-[1] flex size-7 items-center justify-center" style={{ color: ink }}>
      {glyph === "stop" ? <span aria-hidden className="composer-glyph-out block size-[10px] rounded-[2.5px] bg-current" /> : <Icon name={glyph} variant="filled" size={16} className="composer-glyph-out" />}
    </span>
  );
}

export function Composer({
  bot: profile,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked: setupLocked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  locked?: boolean;
}) {
  const bot = profile ? currentTaskBot(profile) : undefined;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot);
  const { state, dispatch } = useStore();
  const { threads, currentBotId } = useThreadRefs();
  // On a phone the composer is a dock: a round + (attach and every other tool), then one pill with the field and the mic.
  const singleRow = useMediaQuery(PHONE_LAYOUT);
  // On a wider screen: one pill holding a round +, the field, the mic and one round button in the bot's colour.
  const simpleDock = !singleRow;
  // a software keyboard has no shift to hold for a new line, so a phone's return adds one and Send sends
  const storedSendKey = useSendKey(); const sendKey = phoneApp() ? "mod-enter" : storedSendKey; const followUpDefault = useFollowUpDefault();
  const sendLabel = sendKeyLabel(sendKey);
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  const currentGroupTask = group?.tasks?.find((task) => task.threadId === threadId);
  const groupBusyBotId = currentGroupTask?.busyBotId ?? (currentGroupTask?.working ? group?.busyBotId : (group?.threadId === threadId ? group?.busyBotId : null));
  const groupWorking = group ? openTaskWorking(group) : false;
  const busy = group ? Boolean(groupWorking || groupBusyBotId) : Boolean(bot?.busy);
  const steerInstanceId = group
    ? members?.find((member) => member.id === groupBusyBotId)?.modelSelection.instanceId
    : bot?.modelSelection.instanceId;
  const canSteer =
    state.instances.find((i) => i.instanceId === steerInstanceId)?.capabilities?.queueing === true;
  // Visible branch only: an approval left on an abandoned branch must not block the composer.
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  // A Turn on card can wait while the person walks to their computer: they can still write meanwhile.
  const blocking = Boolean(approval);
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === groupBusyBotId)
    : state.bots.find((one) => one.id === approval?.message.inbox?.from.botId) ?? bot;
  const busyName = group
    ? (members?.find((b) => b.id === groupBusyBotId)?.name ??
      (groupWorking ? t("composer.busy.team") : t("composer.busy.aBot")))
    : (bot?.name ?? t("composer.busy.theBot"));
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const attachmentPending = useDraftAttachmentPending(draftId);
  const unsentUpload = attachments.some(attachmentUnsent);
  const failedSends = useFailedComposerSends(draftId); const picks = mentionPicksFor(draftId);
  const [channelMode, setChannelMode] = useComposerChannelMode(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      if (recoverFailedComposerSend(sent) === "restored") {
        restoreMentionPicks(sent.draftId, sent.mentions); if (sent.reply) onRestoreReply?.(sent.reply, sent.threadId);
        if (sent.quote) setSelectionQuote(sent.draftId, sent.quote);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => appendDraftAttachments(draftId, next),
    [draftId],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      cancelUpload(id);
      if (removed?.kind === "image") releaseAttachmentImagePreview(removed);
      if (removed) discardUnsentUpload(removed);
      editAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    },
    [attachments, editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const dictation = useComposerDictation({ draftId, text, onText: editText });
  const { recording, ready: micReady, speechError, toggle: toggleMic, stop: stopDictation, discard: discardDictation } = dictation;
  // Send while talking: the heard words land first, then this render's successor sends them
  const [sendAfterVoice, setSendAfterVoice] = useState<{ followUp: FollowUp | undefined } | null>(null);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const [caret, setCaret] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const takeNotes = useNotesIntake();
  const stacked = useStackedField(inputRef, !singleRow, text, simpleDock) || (simpleDock && (attachments.length > 0 || Boolean(attachmentNotice)));
  // grok's expanded composer: the text above the buttons, attachments or a reply strip; corners and height change together
  const quote = useSelectionQuote(draftId);
  const clearQuote = () => { markDraftEdited(draftId); setSelectionQuote(draftId, null); refocusInput(); };
  const askAboutSelection = (words: string) => {
    const shell = shellRef.current;
    if (!shell || shell.getClientRects().length === 0) return;
    markDraftEdited(draftId);
    setSelectionQuote(draftId, words);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const multiline = simpleDock && (stacked || Boolean(replyTo) || Boolean(quote));
  const [composing, setComposing] = useState(false);
  const pillContentRef = useRef<HTMLDivElement>(null);
  const pillHeight = usePillHeight(shellRef, pillContentRef, simpleDock, multiline, composing);
  useSlideOnChange(() => inputRef.current?.parentElement, stacked, simpleDock);
  const [dragOver, setDragOver] = useState(false);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const caretRef = useRef(0);
  caretRef.current = caret;
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerShouldRefocus(document.activeElement, input)) return;
      const at = Math.min(caretRef.current, input.value.length);
      input.focus();
      input.setSelectionRange(at, at);
    });
  }, []);
  // Touch screens are skipped: focusing there pops the on-screen keyboard over the conversation.
  useEffect(() => {
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const replyToId = replyTo?.id ?? null;
  const focusedReplyRef = useRef(replyToId);
  useEffect(() => {
    const previous = focusedReplyRef.current;
    focusedReplyRef.current = replyToId;
    if (!replyTargetTakesFocus(previous, replyToId)) return;
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [replyToId]);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string, mode: "chat" | "goal") => {
    if (!group) return botSupportsImages(bot);
    if (mode === "goal") {
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group, picks.ids(message)) ?? undefined);
    }
    const route = roomRouteForComposer(message, members ?? [], group, picks.ids(message));
    return route.ambiguous || (route.responders.length > 0 && route.responders.every(botSupportsImages));
  };
  const typedGoalText = !group?.dm ? goalTextFromComposer(text) : null;
  const effectiveText = typedGoalText ?? text;
  const effectiveChannelMode = typedGoalText !== null ? "goal" : channelMode;
  const engineSupportsImages = imageTargetsSupport(effectiveText, effectiveChannelMode);

  const slash = composerSlashTrigger(text, caret);
  const locale = activeLocale();
  const slashSkills = useSlashSkills(group ? undefined : bot?.id, threadId, Boolean(slash) && slash?.start !== dismissedSlashAt);
  const canLearn = skillAuthoringEnabled(state.config) &&
    (group ? (members ?? []).some((member) => supportsAgents(state.instances, member)) : supportsAgents(state.instances, bot));
  // the other AI tools' skills wait behind one More row for each / typed
  const [slashMoreAt, setSlashMoreAt] = useState<number | null>(null);
  const slashMoreOpen = slash !== null && slashMoreAt === slash.start;
  const commandCandidates = useMemo(() => {
    if (!slash || slash.start === dismissedSlashAt) return [];
    const available: ComposerSlashCommand[] = [];
    const builtIns = slash.start === 0; // Built-in commands only work at the start of a message; skills can be named anywhere.
    if (builtIns && !group?.dm) available.push({
      kind: "command",
      id: "goal",
      label: "/goal",
      description: t(group ? "composer.command.goalDesc" : "composer.command.goalBotDesc"),
    });
    if (builtIns && canLearn) {
      available.push({
        kind: "command",
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    if (builtIns && !group && supportsAgents(state.instances, bot)) available.push({
      kind: "command",
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    });
    return slashMenuRows(available, skillSlashCommands(slashSkills), slash.query, slashMoreOpen, () => ({
      label: t("composer.commands.more"), description: t("composer.commands.moreHint"),
    }));
  }, [slash, dismissedSlashAt, group, bot, canLearn, state.instances, locale, slashSkills, slashMoreOpen]);
  const commandPickerOpen = commandCandidates.length > 0;

  const mention = mentionQueryAt(text, caret); const teammates = useTeammates(); const viewer = useViewerEmail();
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden && !hiddenFromSidebar(member, viewer))
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery([...pool, ...teammateChoices(teammates.people), DEVS_CHOICE], mention.query);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members, teammates, viewer]);
  const mentionEveryoneCount = (members ?? []).filter((member) => !member.hidden).length;
  const mentionPickerOpen = candidates.length > 0;
  const commandMotion = useMenuMotion(commandPickerOpen);
  const mentionMotion = useMenuMotion(mentionPickerOpen);

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!commandPickerOpen) return;
    setHighlight((current) => Math.min(current, commandCandidates.length - 1));
  }, [commandCandidates.length, commandPickerOpen]);

  useEffect(() => {
    if (!commandPickerOpen) return;
    commandListRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, commandPickerOpen]);

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    picks.pick(peer); editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand | undefined) => {
    if (!slash || !command) return;
    // More opens in place: the highlight stays on its row, now the first of the other tools' skills
    if (command.kind === "more") { setSlashMoreAt(slash.start); return; }
    const spaceAfter = /^\s/.test(text.slice(slash.end)) ? "" : " ";
    const replacement = command.kind === "skill" ? `${command.label}${spaceAfter}`
      : command.id === "learn" ? "/learn " : command.id === "setup" ? "/setup " : "";
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.kind === "command" && command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const teachTask = () => {
    const learn = "/learn ";
    editText(learn + text.replace(/^\/learn\s*/, "").trimStart());
    setCaret(learn.length);
    setChannelMode("chat");
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(learn.length, learn.length); });
  };

  const pendingCount = (state.pendingQueued[threadId] ?? []).length;
  const queuedMessages = state.pendingQueued[threadId] ?? [];
  const canSteerQueued = composerCanSteerQueuedMessages(
    busy,
    locked,
    pendingCount,
    blocking,
  );
  const [steering, setSteering] = useState(false);
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
  };
  const queueHeadId = queuedMessages[0]?.queueId;
  const steerQueued = () => {
    if (!queueHeadId) return;
    setSteering(true);
    const settle = () => setSteering(false);
    if (group && canSteer) {
      dispatch({ type: "steerGroupQueued", groupId: group.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (group) {
      dispatch({ type: "interruptGroup", groupId: group.id, threadId, onError: settle });
    } else if (bot && canSteer) {
      dispatch({ type: "steerQueued", botId: bot.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (bot) {
      dispatch({ type: "interrupt", botId: bot.id, threadId, onError: settle });
    }
  };
  useEffect(() => setSteering(false), [threadId, queueHeadId]);
  // Only a confirmed removal hands the words back, so a message that already drained into a turn is never resent.
  const editQueued = (queueId: string) => {
    const queued = queuedMessages.find((item) => item.queueId === queueId);
    if (!queued) return;
    const targetDraftId = draftId;
    const onCancelled = () => {
      const words = withoutCitationMarkers(queued.text);
      if (words) prependComposerDraft(targetDraftId, words);
      if (targetDraftId !== draftIdRef.current) return;
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(words.length, words.length);
      });
    };
    if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId, onCancelled });
    else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId, onCancelled });
  };
  const steerAgainUntilRef = useRef(0);
  const prevPendingCountRef = useRef(pendingCount);
  useEffect(() => {
    const expiresAt = doubleEnterSteerWindowExpiresAt(
      prevPendingCountRef.current,
      pendingCount,
      busy,
      canSteer,
    );
    if (expiresAt !== null) steerAgainUntilRef.current = expiresAt;
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount, busy, canSteer]);
  useEffect(() => {
    if (!busy || pendingCount === 0) {
      setSteering(false);
      return;
    }
    if (!steering) return;
    const timeout = window.setTimeout(() => setSteering(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [busy, pendingCount, steering]);
  const modeBot = group ? undefined : bot;
  const { choice: approvalChoice, dialogs: approvalDialogs } = useThreadApproval(modeBot);
  const uploadImage = useCallback(async (file: File): Promise<Attachment | null> => {
    const optimistic = optimisticImageAttachment(file);
    if (!optimistic) return null;
    appendDraftAttachments(draftId, [optimistic]);
    await sendPlacedUpload(draftId, optimistic, file);
    return null;
  }, [draftId]);
  const uploadFile = useCallback(async (file: File): Promise<FileAttachment | "placed" | null> => {
    const pending = pendingFileAttachment(file);
    if (!pending) return null;
    appendDraftAttachments(draftId, [pending]);
    await sendPlacedUpload(draftId, pending, file);
    return "placed";
  }, [draftId]);
  const retryUpload = useCallback((id: string) => {
    const failed = attachments.find((attachment) => attachment.id === id);
    if (!failed || failed.kind === "paste") return;
    changeDraftAttachmentPending(draftId, true);
    void retryPlacedUpload(draftId, failed)
      .catch((error: unknown) => setAttachmentNotice(`${failed.name}: ${friendlyError(error, "upload failed")}`))
      .finally(() => changeDraftAttachmentPending(draftId, false));
  }, [attachments, draftId]);
  const pickFiles = async (picked: ArrayLike<File> | null) => {
    if (!picked?.length) return;
    let files = Array.from(picked);
    // a notes file from another AI comes in as notes, never as an attachment
    const notes = await notesInFiles(files);
    if (notes) {
      takeNotes(notes.text, undefined, "drop", group ? null : bot?.id);
      files = files.filter((file) => !notes.names.includes(file.name));
      if (!files.length) return;
    }
    changeDraftAttachmentPending(draftId, true);
    try {
      const { attachments: added, notice } = await intakeFiles(files, {
        allowImages: engineSupportsImages,
        getPath: pathForFile,
        uploadImage,
        uploadFile,
        imageSlots: imageSlotsLeft(attachments),
        imageBytes: imageBytesLeft(attachments),
      });
      if (added.length) addAttachments(added);
      if (notice) setAttachmentNotice(notice);
    } finally {
      changeDraftAttachmentPending(draftId, false);
    }
    refocusInput();
  };

  const pickers = useComposerFilePickers((files) => void pickFiles(files));
  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0;
  const { sendHeld, holdSend } = useSendHold(busy, singleRow, `${threadId}|${bot?.id}|${group?.id}`);
  const held = Boolean(sendHeld) && !hasContent && !locked;
  const filled = hasContent || held;
  const onCall = useOnCall();
  const media = useLiveMedia();
  const callTarget = group ? undefined : bot?.id;
  const calling = callTarget !== undefined && (onCall === callTarget || (isLiveCallRunning(media.phase) && media.botId === callTarget));
  // a Stop pressed here takes the button away at once: the turn reads as over before the server says so
  const stopPressed = Boolean(useStopPress(threadId || undefined));
  const stoppable = (busy || Boolean(!group && bot?.waitingForTeammates)) && !stopPressed;
  const live = liveCallEnabled() || voiceCallsEnabled();
  // the composer never shows Stop (the owner's rule): only send and voice, even while the bot works
  const stopInSlot = false;
  const callShown = !filled;
  // with live calls off the mic takes the call's place: the one round button at rest
  const micInSlot = !live && callShown && !locked && !recording;
  // the round button's glyph pops in only when it swaps here (call, send, stop); a fresh composer, as on a chat
  // switch, shows it at rest like grok's
  const glyphShape = `${filled}|${held}|${stopInSlot}|${callShown}`;
  const slotColor = bot?.color; const room = Boolean(group);
  const slot = useMemo(() => slotColors(slotColor, room), [slotColor, room]);
  // A one-to-one bot at work: Enter does the chosen follow-up and Ctrl/⌘ with it the other one. Rooms keep their own queue.
  const followUpFor = (alternate: boolean) => sentFollowUp({ running: busy && !group && Boolean(bot), alternate, preferred: followUpDefault }) ?? undefined;
  const steersNow = group ? canSteer : resolveFollowUp({ running: busy && !group && Boolean(bot), alternate: false, preferred: followUpDefault, canSteer }) === "steer";
  const sendNames = sendLabels({ busy, canSteer: steersNow, name: busyName, sendLabel });
  // grok's round button keeps one glyph stack and crossfades it; ours swaps the button, so the glyph it showed fades
  // out over the new one's
  const slotGlyph: SlotGlyph | null = !simpleDock || calling || locked ? null
    : held ? "arrow-up"
    : hasContent ? (busy && !steersNow ? null : "arrow-up")
    : stopInSlot ? "stop"
    : callShown ? (live ? (bot && !group ? "waveform" : null) : "mic") : null;
  const [glyphs, setGlyphs] = useState({ shape: glyphShape, swapped: false, glyph: slotGlyph, from: null as SlotGlyph | null, swaps: 0, held, fromHeld: false });
  // the mic is its own button that only changes colour beside Send, so a swap to or from it lands at once: no pop, no
  // fading ghost of it over Send
  // ...except after Stop: the square fades out over the mic coming back, as Send's arrow does
  // ...and after a held send lets go, the arrow fades out over whatever comes back; the press itself changes no glyph
  // ...and the mic turns into Stop in place: the round button holds its spot and only its glyph changes
  if (glyphs.shape !== glyphShape) {
    setGlyphs(slotGlyph === glyphs.glyph
      ? { ...glyphs, shape: glyphShape, held }
      : { shape: glyphShape, swapped: (slotGlyph !== "mic" && glyphs.glyph !== "mic") || glyphs.glyph === "stop" || slotGlyph === "stop" || glyphs.held, glyph: slotGlyph, from: glyphs.glyph, swaps: glyphs.swaps + 1, held, fromHeld: glyphs.held });
  }
  // the mic at the end of the bar and the small one beside Send are two buttons, so neither slides across when the field
  // fills or empties (only Send or the reserved spot takes a place); focus on the old one carries to the new
  // beside a working bot's Stop the small mic springs in where the spacer was, so it mounts fresh there too
  // a phone's Stop takes the mic's place at the end of the pill the same way
  // the phone listens with two controls only, discard beside and keep in the round button's place
  const phoneVoice = singleRow && phoneApp() && recording;
  const phoneStop = false;
  const micPlace = filled && !phoneVoice ? "beside" : (stopInSlot && !singleRow) || phoneStop ? "stop" : "end";
  // when the turn ends on a phone the square fades out over the mic coming back to its place
  const [micTrail, setMicTrail] = useState({ place: micPlace, from: micPlace, swaps: 0 });
  const actionsRef = useSlotHandoff(singleRow);
  const [listenedFrom, setListenedFrom] = useState<{ on: boolean; empty: boolean }>({ on: false, empty: true });
  if (listenedFrom.on !== phoneVoice) setListenedFrom({ on: phoneVoice, empty: !hasContent });
  if (micTrail.place !== micPlace) setMicTrail({ place: micPlace, from: micTrail.place, swaps: micTrail.swaps + 1 });
  const micBack = singleRow && micPlace === "end" && micTrail.from === "stop";
  // a phone's mic comes out of the round button as the field fills and slips back into it as it empties
  const micOut = singleRow && micPlace === "beside" && micTrail.from === "end", micIn = singleRow && micPlace === "end" && micTrail.from === "beside";
  const micFocused = useRef(false);
  useLayoutEffect(() => {
    if (micFocused.current && document.activeElement !== micButtonRef.current) micButtonRef.current?.focus({ preventScroll: true });
  }, [micPlace]);
  const ghostGlyph = glyphs.swapped && glyphs.from && slotGlyph && glyphs.from !== slotGlyph ? glyphs.from : null;
  const retryFailedSend = (failed: FailedComposerSend) => {
    const failedMode = failed.channelMode ?? "chat";
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText, failedMode)) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId, mentions: failed.mentions,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId, mentions: failed.mentions,
          channelMode: failed.channelMode, attachments: failed.attachments,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, mode: failedMode, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, mode: failedMode, ...retry });
    }
  };
  const editFailedSend = (failed: FailedComposerSend) => {
    const next = editFailedComposerSend(draftId, failed); restoreMentionPicks(draftId, failed.mentions); setCaret(next.length);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.length, next.length); });
  };
  const send = (followUp: FollowUp | undefined = followUpFor(false)) => {
    if (locked || attachmentPending || unsentUpload) return;
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !imageTargetsSupport(effectiveText, effectiveChannelMode)
    ) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    if (recording && dictation.takeForSend()) {
      setSendAfterVoice({ followUp });
      return;
    }
    const composed = composeMessage(serializeThreadRefs(effectiveText, threads, currentBotId), attachments);
    if (!composed) return;
    stopDictation();
    const body = restoredRequestText(draftId) ?? withSelectionQuote(quote, composed);
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? randomUuid(),
      text,
      requestText: body,
      attachments: [...attachments],
      reply: replyTo ?? null,
      quote,
      replyToId: replyTo?.id,
      threadId,
      channelMode: effectiveChannelMode, mentions: picks.ids(body),
    };
    const sendId = sentDraft.sendId;
    const onSettled = holdSend(sendId);
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        mode: effectiveChannelMode, mentions: sentDraft.mentions,
        onError: () => restoreDraft(sentDraft), onSettled,
      });
      roomMessageSent(effectiveChannelMode, busy);
    } else if (bot) {
      const points = effectiveChannelMode === "goal" ? null : takePointedChips(threadId);
      noteSendLaunch(sendId);
      dispatch({
        type: "send", botId: bot.id, text: body, sendId: sentDraft.sendId, replyToId: replyTo?.id, threadId, mode: effectiveChannelMode, mentions: sentDraft.mentions,
        ...(points ? { pointed: points.pointed } : {}), ...(followUp ? { followUp } : {}),
        onError: () => { points?.restore(); restoreDraft(sentDraft); }, onSettled,
      });
      directMessageSent(state.instances, bot.modelSelection?.instanceId, busy && (followUp !== "steer" || !canSteer));
    }
    setText("");
    setAttachments([]); picks.clear();
    onConsumeReply?.(); setSelectionQuote(draftId, null);
    setChannelMode("chat");
    // a click on the round button takes focus, and the button unmounts once the field is empty; grok hands it back
    if (!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) refocusInput();
  };
  useLayoutEffect(() => {
    if (!sendAfterVoice || recording) return;
    setSendAfterVoice(null);
    send(sendAfterVoice.followUp);
  });
  // voice input from anywhere in the chat: the shortcut starts and ends it, Esc cancels, the send key sends what was heard
  const voiceKeys = useRef({ toggle: toggleMic, discard: discardDictation, send: () => send(followUpFor(false)), recording, sendKey });
  voiceKeys.current = { toggle: toggleMic, discard: discardDictation, send: () => send(followUpFor(false)), recording, sendKey };
  const voiceKeysOn = micReady && !locked;
  useEffect(() => {
    if (!voiceKeysOn) return;
    const onKey = (event: KeyboardEvent) => {
      const shell = shellRef.current;
      if (event.defaultPrevented || !shell || shell.getClientRects().length === 0) return;
      const keys = voiceKeys.current;
      if (voiceShortcut(event)) {
        // another field (a search, a dialog) keeps its own keys
        const active = document.activeElement;
        const typingElsewhere = active instanceof HTMLElement && !shell.contains(active) && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
        if (typingElsewhere || document.querySelector('[aria-modal="true"]')) return;
        event.preventDefault();
        keys.toggle();
        return;
      }
      if (!keys.recording || imeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        keys.discard();
      } else if (sendsMessage(event, keys.sendKey)) {
        event.preventDefault();
        keys.send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceKeysOn]);
  // the field hides while voice listens: focus waits on the mic's Done button, then returns to the words
  const voiceWasOn = useRef(false);
  useEffect(() => {
    const was = voiceWasOn.current;
    voiceWasOn.current = recording;
    if (recording && !was) {
      const active = document.activeElement;
      if (!active || active === document.body || active === inputRef.current) micButtonRef.current?.focus({ preventScroll: true });
    } else if (!recording && was && document.activeElement === micButtonRef.current && !window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) {
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input || input.disabled) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }, [recording]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const copiedFiles = Array.from(e.clipboardData.files ?? []);
    if (copiedFiles.some((file) => /\.(?:json|md|txt)$/i.test(file.name))) {
      // a file copied in Finder, such as the metal-notes.md another AI made
      e.preventDefault();
      void pickFiles(copiedFiles);
      return;
    }
    const imageFiles = clipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0 || clipboardHasImages(e.clipboardData)) {
      e.preventDefault();
      if (!engineSupportsImages) {
        dispatch({
          type: "error",
          message: t("composer.error.noImages"),
        });
        return;
      }
      if (!imageFiles.length) {
        dispatch({ type: "error", message: t("composer.error.clipboardImage") });
        return;
      }
      const kept = imagesThatFit(imageFiles, imageSlotsLeft(attachments), setAttachmentNotice, imageBytesLeft(attachments));
      changeDraftAttachmentPending(draftId, true);
      void (async () => {
        try {
          const results = await Promise.allSettled(kept.map(uploadImage));
          for (const result of results) {
            if (result.status === "rejected") {
              dispatch({
                type: "error",
                message: friendlyError(result.reason, "image upload failed"),
              });
            }
          }
        } finally {
          changeDraftAttachmentPending(draftId, false);
        }
      })();
      return;
    }
    const pasted = e.clipboardData.getData("text/plain");
    // notes another AI wrote for Metal come in, wherever they are pasted, instead of being sent
    if (looksLikeNotes(pasted)) {
      e.preventDefault();
      takeNotes(pasted, undefined, "paste", group ? null : bot?.id);
      return;
    }
    const reference = threadTokenFromPaste(pasted, threads, currentBotId);
    if (reference) {
      e.preventDefault();
      const start = e.currentTarget.selectionStart ?? text.length;
      const end = e.currentTarget.selectionEnd ?? start;
      const { lead, trail } = threadTokenSpacing(text, start, end);
      const token = lead + reference.token + trail;
      editText(text.slice(0, start) + token + text.slice(end));
      const at = start + token.length;
      setCaret(at);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(at, at);
      });
      return;
    }
    if (!isLongPaste(pasted)) return;
    e.preventDefault();
    const start = e.currentTarget.selectionStart;
    const end = e.currentTarget.selectionEnd;
    if (start !== end) {
      editText(`${text.slice(0, start)}${text.slice(end)}`);
      setCaret(start);
    }
    const file = pastedTextFile(pasted);
    if (!file) {
      editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
      return;
    }
    changeDraftAttachmentPending(draftId, true);
    void uploadFile(file)
      .catch((error: unknown) => setAttachmentNotice(friendlyError(error, "upload failed")))
      .finally(() => changeDraftAttachmentPending(draftId, false));
  };

  const toggleGoal = () => {
    markDraftEdited(draftId);
    if (typedGoalText !== null) {
      const nextCaret = Math.max(0, caret - (text.length - typedGoalText.length));
      editText(typedGoalText);
      setCaret(nextCaret);
      setChannelMode("chat");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
      return;
    }
    setChannelMode((current) => current === "goal" ? "chat" : "goal");
  };
  const goal = !group?.dm ? { on: effectiveChannelMode === "goal", onToggle: toggleGoal, solo: !group } : undefined;

  return (
    <div className={cn("pointer-events-none relative px-5", simpleDock ? "pb-4" : "pb-3")}>
      {speechError && (
        // any settings button on it is a way out of it too
        <div className="pointer-events-auto mb-2 w-full" data-speech-note=""
          onClickCapture={(event) => { if ((event.target as Element).closest?.("[data-open-voice-settings],[data-open-system-settings]")) dictation.dismissError(); }}>
          {isValidElement(speechError) && speechError.type === NoRecognizerNote ? (
            <ChatErrorCard tone="warning" icon="mic" title={t("composer.voice.unavailableTitle")} onDismiss={dictation.dismissError}
              actions={<OpenVoiceSettings labelKey="composer.voice.chooseService" className={CARD_ACTION} />}>
              <p dir="auto" className="text-ink-secondary">{speechError}</p>
            </ChatErrorCard>
          ) : (
            <ChatErrorCard tone="warning" icon="mic" title={speechError} onDismiss={dictation.dismissError} />
          )}
        </div>
      )}
      {dictation.tidying && !speechError && (
        <div role="status" data-voice-tidying="" className="pointer-events-auto mb-2 w-full px-0.5 text-[12px] leading-4 text-ink/56">
          {t("composer.voice.tidying")}
        </div>
      )}
      {/* portalled over the window, so it adds nothing to the bar's height */}
      <AnimatePresence>
        {dictation.firstRun.open && (
          <VoiceFirstRunSheet
            key="voice-first-run"
            where={dictation.firstRun.where}
            onContinue={dictation.firstRun.accept}
            onClose={dictation.firstRun.dismiss}
            onSetUp={() => {
              dictation.firstRun.dismiss();
              dispatch(openSettings("voice"));
            }}
          />
        )}
      </AnimatePresence>
      <div className="pointer-events-auto relative w-full">
        <ComposerFailedSends sends={failedSends} onRetry={retryFailedSend} onEdit={editFailedSend} onDismiss={(failed) => forgetFailedComposerSend(draftId, failed.id)} />
        <SlashCommandMenu listRef={commandListRef} motion={commandMotion} commands={commandCandidates} highlight={highlight}
          onPick={pickCommand} onHighlight={setHighlight} />
        <MentionMenu listRef={mentionListRef} motion={mentionMotion} choices={candidates} highlight={highlight}
          everyoneCount={mentionEveryoneCount} onPick={pickMention} onHighlight={setHighlight} />
        {approval && (
          <div className={cn("mb-2 overflow-hidden rounded-[24px]", ELEVATED_CARD)}>
            <PendingApprovalPanel
              key={approval.requestId}
              pending={approval}
              botName={approvalBot?.name} asker={approvalBot}
              count={approvals.length}
              index={0}
              locale={activeLocale()}
              actions={<PendingApprovalActions part="primary" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
              more={approval.message.inbox ? undefined : <PendingApprovalActions part="more" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
            />
          </div>
        )}
        {!group && <PointedChips threadId={threadId} />}{!group && bot && <SetupRequestChip bot={bot} threadId={threadId} />}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          allowImages={engineSupportsImages}
          onNotice={setAttachmentNotice}
          onNotes={(notes) => takeNotes(notes, undefined, "drop", group ? null : bot?.id)}
          onPendingChange={(pending) => changeDraftAttachmentPending(draftId, pending)}
          onDraggingChange={setDragOver}
          uploadImage={uploadImage}
          uploadFile={uploadFile}
        />
        <NotesWaitingLine botId={group ? undefined : bot?.id} />
        <QueuedComposerMessages
          items={queuedMessages}
          oneThreadPerBot={state.config?.cloudStarter === true}
          onSeePlans={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}
          onSteer={canSteerQueued ? steerQueued : undefined}
          steerInterrupts={!canSteer}
          steerMode={group ? "next" : "all"}
          steering={steering}
          onCancel={(queueId) => {
            if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId });
            else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId });
          }}
          onEdit={locked ? undefined : editQueued}
        />
        <div className="relative">
          {/* Plain canvas behind the composer and the strip below it, from the composer's top edge, so the transcript
              ends at the composer with no fade. */}
          <div
            aria-hidden
            data-composer-backdrop
            className={cn("pointer-events-none absolute -left-5 -right-5 top-0 bg-app", simpleDock ? "-bottom-4" : "-bottom-3")}
          />
        <div ref={shellRef} data-tour="composer" data-multiline={multiline ? "" : undefined} data-drag-over={simpleDock && dragOver ? "" : undefined}
          style={pillHeight === undefined ? undefined : { height: pillHeight }} className={cn("@container/composer relative z-[1]", singleRow ? "flex items-end gap-2" : simpleDock ? cn(SIMPLE_COMPOSER, multiline ? "rounded-[18px]" : "rounded-[22px]") : cn("rounded-2xl px-2 py-1.5", ELEVATED_FLOAT))}>
        <div ref={pillContentRef} className={singleRow ? cn("flex min-h-[48px] min-w-0 flex-1 flex-col justify-center rounded-[24px] p-2", ELEVATED_FLOAT) : simpleDock ? "flex shrink-0 flex-col" : "contents"}>
        {replyTo && <ComposerReplyStrip message={replyTo} fallbackName={bot?.name} onClear={onClearReply} />}
        {quote && <ComposerSelectionQuote quote={quote} onClear={clearQuote} />}<SelectionAskPill enabled={!singleRow && !locked} onAsk={askAboutSelection} /><ComposerAttachmentStrip items={attachments} onRemove={removeAttachment} onRetry={retryUpload} onDisplayInChatBox={displayPasteInChatBox} notice={attachmentNotice} onNotice={setAttachmentNotice} />
        <div data-composer-row data-glyph-swap={glyphs.swapped ? "" : undefined} data-glyph-from-held={glyphs.swapped && glyphs.fromHeld ? "" : undefined} style={simpleDock ? slot.vars : undefined} className={cn("flex items-end", simpleDock ? cn("gap-2", stacked && "gap-y-2") : "gap-1", !singleRow && !simpleDock && "@max-[30rem]/composer:flex-wrap", stacked && "flex-wrap")}>
          {pickers.inputs}
          {/* the phone's + is the pill's first control, at its left edge, the size of the others */}
          {singleRow && !locked && <PhonePlus onAttach={pickers.files} attachChoices={pickers.choices} goal={goal} teach={canLearn ? teachTask : undefined} approval={approvalChoice && modeBot && { name: modeBot.name, choice: approvalChoice }} callBotId={live && bot && !group ? bot.id : undefined} />}
          {!locked && !singleRow && (
            <div className={cn("flex items-center gap-1", simpleDock ? "shrink-0" : "flex-wrap")}>
              {simpleDock && <ComposerPlusMenu onAttach={pickers.files} attachChoices={pickers.choices} goal={goal} teach={canLearn ? teachTask : undefined} />}
              {/* a mode's chip shows only while it is on, so a choice made in the + menu or the bot panel stays in view */}
              {goal?.on && <GoalToggle {...goal} compact={simpleDock} />}
              {simpleDock && approvalChoice && profile && bot && approvalModeFor(bot) !== approvalModeFor(profile) && <ApprovalChip choice={approvalChoice} />}
            </div>
          )}
          <MentionTextarea
          // grok keeps 80px clear at the field's end for its mic and voice buttons, whether or not the mic shows
          wrapperClassName={cn(singleRow ? "px-1.5" : simpleDock ? cn(stacked ? "order-first basis-full" : locked && "me-9") : cn("@max-[30rem]/composer:order-first @max-[30rem]/composer:basis-full", stacked && "order-first basis-full"), recording && "hidden")}
          inputRef={inputRef}
          peers={[...(group ? members ?? [] : state.bots.filter((member) => member.id !== bot?.id)), ...teammates.peers]}
          everyone={Boolean(group && !group.dm)}
          dir="auto"
          rows={1}
          enterKeyHint={sendKey === "enter" ? "send" : "enter"}
          value={text}
          onChange={(e) => {
            if (bot && !group) cueMascot(bot.id, "watch");
            // a typed "/goal " becomes the goal chip, so the field never says it a second time
            const goalToken = !group?.dm ? /^\/goal\s+/i.exec(e.target.value) : null;
            if (goalToken) {
              const at = Math.max(0, (e.target.selectionStart ?? e.target.value.length) - goalToken[0].length);
              editText(e.target.value.slice(goalToken[0].length));
              setChannelMode("goal");
              setCaret(at);
              requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
              setDismissedAt(null);
              setDismissedSlashAt(null);
              return;
            }
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setDismissedSlashAt(null);
          }}
          onPaste={handlePaste}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // An input method's confirming Enter and arrows pick its own candidates, not a mention or command.
            if (imeComposing(e.nativeEvent)) return;
            if (commandPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) =>
                  (current + delta + commandCandidates.length) % commandCandidates.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(commandCandidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedSlashAt(slash?.start ?? null);
                return;
              }
            }
            if (mentionPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            if (onClearReply && escapeCancelsReply(e.nativeEvent, { replying: Boolean(replyTo), recording })) {
              e.preventDefault();
              onClearReply();
              return;
            }
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            if (sendsMessage(e.nativeEvent, sendKey)) {
              e.preventDefault();
              if (
                canSteer &&
                doubleEnterSteersQueue(steerAgainUntilRef.current, Date.now(), pendingCount, hasContent)
              ) {
                steerAgainUntilRef.current = 0;
                steerQueued();
                return;
              }
              send(followUpFor(alternateSend(e.nativeEvent, sendKey)));
            }
          }}
          // Not disabled during an upload: a disabled element drops keyboard focus for good. send() refuses while one
          // is pending.
          disabled={blocking || locked}
          aria-busy={bot?.awaitingThreadSnapshot || undefined}
          placeholder={composerPlaceholder({
            locked: setupLocked, approval: blocking, attaching: attachmentPending, attached: attachments.length > 0, listening: recording,
            replying: Boolean(replyTo), busy, group, members: members ?? [], goal: channelMode === "goal", botName: bot?.name ?? "",
            setupHint: group ? null : setupRequestPlaceholder(bot, threadId),
            question: !group && pendingQuestion(bot?.messages),
          })}
          aria-label={t("composer.placeholder.bot", { name: group ? group.name : (bot?.name ?? "") })}
            className={cn(
              // the hint stays on one line and trails off: a long name must not make the empty bar taller than the
              // typed one, or the bar grows each time the field empties
              "block max-h-[9rem] w-full resize-none overflow-y-auto bg-transparent focus:outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap",
              !simpleDock && "px-1 text-[15px] placeholder:text-ink-tertiary",
              simpleDock
                ? cn("text-[14px] leading-5 tracking-[0.01em] placeholder:text-ink/40", stacked ? "min-h-6 px-1 pt-1 pb-0" : "min-h-5 p-0 mt-[3px] mb-px")
                : "min-h-6 py-1 leading-6",
            )}
          />
          {recording && (
            <ComposerVoiceStrip
              phase={dictation.phase}
              preview={dictation.preview}
              levels={dictation.levels}
              hasLevels={dictation.hasLevels}
              compact={singleRow}
              className={singleRow ? "flex-1 py-1.5" : "mb-px mt-[3px] flex-1"}
            />
          )}
          <div ref={actionsRef} data-composer-actions className={cn("flex items-center", simpleDock ? "relative gap-2" : cn("gap-1", singleRow && "relative"), !singleRow && !simpleDock && "@max-[30rem]/composer:ml-auto", stacked && "ml-auto")}>
        {!locked && recording && (
          <button
            type="button"
            onClick={discardDictation}
            data-composer-discard=""
            aria-label={t("composer.dictation.discard")}
            title={t("composer.voice.cancelHint")}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              simpleDock ? "size-7" : "size-8",
              singleRow ? "text-ink-secondary hover:bg-raised hover:text-ink" : SIMPLE_CONTROL,
              phoneVoice && cn("composer-press", listenedFrom.empty && "composer-mic-in"),
            )}
          >
            <Icon name="close" size={phoneVoice ? 16 : 14} />
          </button>
        )}
        {/* the mic in the round button's place keeps the small control's place beside it, so Send or Discard takes
            that spot and nothing in the bar moves when the field fills, empties or starts listening */}
        {micInSlot && !stoppable && <span aria-hidden="true" data-mic-spacer="" className={cn("shrink-0", simpleDock ? "size-7" : "size-8")} />}
        {!locked && (
          <button
            key={micPlace}
            ref={micButtonRef}
            type="button"
            onFocus={() => { micFocused.current = true; }}
            onBlur={() => { micFocused.current = false; }}
            // on a phone the button that ends listening sends what was heard: one tap from speaking to sent
            onClick={toggleMic}
            data-voice-mic={recording ? "done" : "start"}
            disabled={dictation.phase === "finishing"}
            aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              simpleDock ? "size-7" : "size-8",
              (micPlace === "stop" || micOut) && "composer-mic-in",
              micBack && "composer-mic-back",
              phoneVoice ? cn("composer-press", slot.button.className)
              : recording
                ? "composer-press bg-ink text-app hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))] disabled:opacity-40"
                : micInSlot ? singleRow ? "composer-press bg-ink text-app hover:opacity-90" : "composer-press hover:brightness-[0.88]"
                : singleRow ? "text-ink-secondary hover:bg-raised hover:text-ink" : SIMPLE_CONTROL,
            )}
            style={phoneVoice ? slot.button.style : micInSlot && !singleRow ? { backgroundColor: slot.fill, color: slot.ink } : undefined}
            title={recording ? t("composer.voice.stopHint", { key: voiceShortcutLabel() }) : t("composer.voice.hint", { key: voiceShortcutLabel() })}
          >
            {recording ? <Icon name="check" size={phoneVoice ? 16 : 14} />
              : simpleDock ? <Icon name="mic" variant="filled" size={16} className={micInSlot ? "composer-glyph" : undefined} /> : <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />}
          </button>
        )}
        {live && callShown && bot && !group && <CallButton bot={bot} placement="composer" fill={singleRow ? undefined : slot.fill} ink={slot.ink} inverse={singleRow} live={liveCallEnabled()} />}
        {filled && !locked && !phoneVoice && (
          <ComposerSendButton compact={simpleDock} waits={!held && busy && !steersNow && !phoneApp()} label={sendNames.label} title={sendNames.title} look={slot.button}
            disabled={(held && !singleRow) || attachmentPending || unsentUpload} onSend={(alternate) => { if (!held) send(followUpFor(alternate)); }} onChoose={send}
            menu={undefined} />
          )}
          {ghostGlyph && <SlotGlyphGhost key={glyphs.swaps} glyph={ghostGlyph} ink={slot.ink} />}
          {micBack && (
            <span aria-hidden="true" data-composer-stop-ghost key={`stop-${micTrail.swaps}`} className="composer-glyph-out pointer-events-none absolute bottom-0 right-0 z-[1] flex size-8 items-center justify-center rounded-full bg-ink text-app">
              <span className="block size-[12px] rounded-[2.5px] bg-current" />
            </span>
          )}
          {micIn && !recording && <PhoneMicGhost key={`mic-in-${micTrail.swaps}`} />}
          {ghostGlyph === "stop" && !singleRow && (
            <span aria-hidden="true" data-composer-mic-ghost key={`mic-${glyphs.swaps}`} className={cn(SIMPLE_CONTROL, "composer-mic-out pointer-events-none absolute bottom-0 right-9 flex items-center justify-center")}>
              <Icon name="mic" variant="filled" size={16} />
            </span>
          )}
          </div>
        </div>
        </div>
        </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      {approvalDialogs}
      </div>
    </div>
  );
}
