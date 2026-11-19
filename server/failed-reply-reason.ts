// what stopped a reply, in one word the app turns into plain words: read from the flags the driver set and the
// classifiers retries and account switching already use, so a failed row and the retry logic always agree.
import type { FailedReplyReason } from "../shared/failed-turn.ts";
import { engineFailureKind } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import { isServerLine } from "./server-lines.ts";
import { failureOf, type UsageReason } from "../shared/usage-signals.ts";

// the usage reasons the app has its own words for, beyond the ones above
const BY_USAGE: Partial<Record<UsageReason, FailedReplyReason>> = {
  model_not_found: "model_not_found", bad_request: "bad_request", context: "context", provider_down: "provider_down", cli_exit_early: "cli_exit", crashed: "cli_exit",
};

export function failedReplyReason(message: string, event: { setup?: boolean; claudeUpdate?: boolean; stalled?: boolean; limit?: string; limitResetsAt?: number; errorCode?: string }): FailedReplyReason | undefined {
  if (event.claudeUpdate) return undefined;
  // Claude Code 2.1.295: a session it can no longer open, after Metal already rebuilt it once from the chat
  if (/\bNo conversation found with session ID\b/i.test(message)) return "session_lost";
  if (isServerLine("server.freeModel.noReply", message) || isServerLine("server.freeModel.limit", message)) return "no_ai";
  const kind = engineFailureKind(message);
  const classified = classifyError({ text: message }).reason;
  const usage = failureOf(message, { code: event.errorCode }).reason;
  if (kind === "credits") return "credits";
  if (event.limit || event.limitResetsAt || kind === "usage_limit" || classified === "quota") return "usage_limit";
  // a cli that isn't installed is flagged for setup too, but signing in does not fix it
  if (usage === "cli_missing") return "cli_missing";
  if (event.setup || classified === "auth") return "signed_out";
  if (kind === "overloaded" || classified === "overloaded") return "overloaded";
  if (kind === "rate_limit" || classified === "rate_limited") return "rate_limit";
  if (event.stalled || classified === "timeout") return "timeout";
  return BY_USAGE[usage];
}
