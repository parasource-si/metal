// what a failed reply turns into for a person: what Metal tries by itself first, then one sentence and one button.
// the desktop words these in the reader's language; `line` is the English a phone shows above the real cause.
import type { FailedReplyReason } from "./failed-turn.ts";

/** Every way a reply can be lost, as the apps tell them apart: the server's reasons, plus what a client reads from the
 * row itself (`place`: the bot's computer or browser could not be used; `blocker`: Metal stopped a browser run that
 * kept failing; `no_answer`: the AI never replied; `other`: none of these). */
export type FailureKind = FailedReplyReason | "claude_update" | "place" | "restart_interrupted" | "no_answer" | "blocker" | "other";

/** What Metal does on its own before a card is shown: `retry`, the same AI again after a short wait; `backup`, the
 * backup AI the person picked for the bot; `wait`, the turn holds until the AI's limit resets and carries on. */
export type FailureHeal = "retry" | "backup" | "wait";

/** The one button a failure card offers. */
export type FailureAction =
  | "retry"
  | "sign_in"
  | "connect_ai"
  | "switch_ai"
  | "update_engine"
  | "set_up_engine"
  | "new_chat"
  | "continue_after_reset"
  | "place"
  | "take_over"
  | "open_ais";

export interface FailurePlan {
  heal: readonly FailureHeal[];
  action: FailureAction;
  /** the button when `action` can't be offered here (no message to send again, no known reset, a group chat) */
  instead?: FailureAction;
  /** a quiet second button beside it, for what comes right after the fix */
  after?: FailureAction;
  /** the English sentence a client without translations shows above the real cause: plain words, what to do next */
  line: string;
}

export const FAILURE_PLANS: Readonly<Record<FailureKind, FailurePlan>> = {
  signed_out: { heal: ["backup"], action: "sign_in", after: "retry", line: "Your AI is signed out. Sign in again to keep going." },
  credits: { heal: ["backup"], action: "switch_ai", line: "Your AI account is out of credit. Add credit there, or switch this bot to another AI." },
  usage_limit: { heal: ["backup", "wait"], action: "continue_after_reset", instead: "switch_ai", line: "Your AI's usage limit is reached. This carries on once it resets, or switch to another AI now." },
  rate_limit: { heal: ["retry", "backup"], action: "retry", instead: "switch_ai", line: "Your AI is getting too many requests. Try again in a moment." },
  overloaded: { heal: ["retry", "backup"], action: "retry", instead: "switch_ai", line: "Your AI is busy right now. Try again in a moment." },
  timeout: { heal: ["retry", "backup"], action: "retry", instead: "switch_ai", line: "Your AI took too long to answer. Try again." },
  no_ai: { heal: [], action: "connect_ai", after: "retry", line: "The free backup is busy. Connect an AI you already use to keep chatting." },
  model_not_found: { heal: ["backup"], action: "switch_ai", line: "Your AI doesn't offer this model. Pick another one for this bot." },
  bad_request: { heal: [], action: "retry", instead: "switch_ai", line: "Your AI turned this request down. Try again, or pick another model." },
  context: { heal: [], action: "new_chat", instead: "switch_ai", line: "This chat is too long for the model. Start a new chat to keep going." },
  session_lost: { heal: [], action: "new_chat", instead: "retry", line: "Your AI lost this chat's memory. Start a new chat to keep going." },
  provider_down: { heal: ["retry", "backup"], action: "retry", instead: "switch_ai", line: "Your AI is having trouble right now. Try again in a few minutes." },
  cli_missing: { heal: ["backup"], action: "set_up_engine", line: "Your AI isn't set up where this bot runs. Set it up again to keep going." },
  cli_exit: { heal: [], action: "retry", instead: "switch_ai", line: "Your AI stopped before it could reply. Try again." },
  claude_update: { heal: [], action: "update_engine", line: "Claude Code needs an update for this model. Update it to keep going." },
  place: { heal: [], action: "place", instead: "retry", line: "Your bot couldn't use its computer. Try again in a minute." },
  restart_interrupted: { heal: [], action: "retry", line: "Metal restarted while this was running. Some steps may already be done." },
  no_answer: { heal: [], action: "retry", instead: "switch_ai", line: "Your AI didn't answer. Try again, or switch this bot to another AI." },
  blocker: { heal: [], action: "take_over", line: "Your bot stopped so it doesn't keep repeating the same step." },
  other: { heal: [], action: "retry", instead: "switch_ai", line: "Your bot couldn't finish this reply. Try again." },
};

export function failurePlan(kind: FailureKind | undefined): FailurePlan {
  return (kind && FAILURE_PLANS[kind]) || FAILURE_PLANS.other;
}
