// The internal call behind the checklist tool. Runs inside index.ts's /api/internal/ block after the capability bearer is
// checked; the bot and the conversation are the capability's, so a bot only ever reads and ticks its own list.
import type { ServerResponse } from "node:http";

import {
  CHECKLIST_ITEM_MAX, CHECKLIST_MAX_ITEMS, checklistPath, counts, openItems, progressLine, readChecklist, startChecklist, tick, writeChecklist,
  type Checklist,
} from "../batch-checklist.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PASS } from "./table.ts";

const CHECKLIST = "/api/internal/checklist";
const SHOWN_OPEN = 15;
/** Between two sends: X and most sites limit how fast one account messages people, and a person never sends 94 in a minute. */
export const PACE_MIN_MS = 5_000;
export const PACE_MAX_MS = 15_000;
export const PAUSE_MIN_MINUTES = 1;
export const PAUSE_MAX_MINUTES = 60;

export interface ChecklistDeps {
  taskDir(botId: string, threadId: string): string;
  /** The carry-on waits until then before it starts the rest of the list. */
  pause(threadId: string, untilMs: number): void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  now?(): number;
}

export interface ChecklistContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;

function nextUp(list: Checklist): string {
  const open = openItems(list);
  if (!open.length) return " Every item is closed: tell the person the list is finished, with anything skipped and why.";
  const shown = open.slice(0, SHOWN_OPEN).join("; ");
  return ` Next: ${shown}${open.length > SHOWN_OPEN ? `; and ${open.length - SHOWN_OPEN} more` : ""}.`;
}

export function createChecklistRoutes(deps: ChecklistDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  return async (ctx: ChecklistContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== CHECKLIST) return PASS;
    const refuse = (error: string) => void ctx.json(ctx.res, 400, { error });
    const body = await ctx.readBody().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return refuse("Send a JSON object with an action.");
    if (!ctx.threadId) return refuse("The checklist belongs to a conversation, and this call has none.");
    const dir = deps.taskDir(ctx.botId, ctx.threadId);
    const current = readChecklist(dir);
    const action = body.action;

    if (action === "start") {
      const items = strings(body.items);
      if (!items?.length) return refuse("start needs items: every item of the list, one string each.");
      if (items.length > CHECKLIST_MAX_ITEMS) return refuse(`A checklist holds at most ${CHECKLIST_MAX_ITEMS} items; split the list.`);
      if (items.some((item) => item.length > CHECKLIST_ITEM_MAX)) return refuse(`Each item is at most ${CHECKLIST_ITEM_MAX} characters: the name or handle, not the message.`);
      const list = startChecklist(current, { title: typeof body.title === "string" ? body.title : "", items, ...(typeof body.verb === "string" ? { verb: body.verb } : {}) });
      writeChecklist(dir, list);
      const { done, skipped } = counts(list);
      const kept = done + skipped ? ` ${done + skipped} item(s) were already closed in this conversation and stay closed: never repeat them.` : "";
      return void ctx.json(ctx.res, 200, { text: `Checklist saved at ${checklistPath(dir)}: ${progressLine(list)}.${kept} Tick each item with action done right after it is finished, one call per item.${nextUp(list)}` });
    }

    if (!current) return refuse("There is no checklist in this conversation yet: call action start with the whole list first.");

    if (action === "status") {
      const item = typeof body.item === "string" ? body.item.trim() : "";
      if (item) {
        const { already, unknown } = tick(current, [item], "done");
        const state = unknown.length ? "is not on the checklist" : already.length ? "is already closed: never repeat it" : "is still open";
        return void ctx.json(ctx.res, 200, { text: `${item} ${state}. ${progressLine(current)}.` });
      }
      return void ctx.json(ctx.res, 200, { text: `${current.title}: ${progressLine(current)}.${nextUp(current)}` });
    }

    if (action === "done" || action === "skip") {
      const items = strings(body.items) ?? (typeof body.item === "string" && body.item.trim() ? [body.item.trim()] : null);
      if (!items?.length) return refuse(`${action} needs item: the item exactly as it is on the checklist.`);
      const note = typeof body.note === "string" ? body.note : undefined;
      if (action === "skip" && !note?.trim()) return refuse("skip needs a note: why this item could not be done, in a few words.");
      const result = tick(current, items, action === "done" ? "done" : "skipped", note);
      if (result.ticked.length) writeChecklist(dir, result.list);
      const parts = [`${progressLine(result.list)}.`];
      if (result.already.length) parts.push(`Already closed, so not repeated: ${result.already.join("; ")}.`);
      if (result.unknown.length) parts.push(`Not on the checklist: ${result.unknown.join("; ")}. Use the item exactly as listed.`);
      // the pause sits between two sends, never after the last one
      if (action === "done" && result.ticked.length && counts(result.list).open > 0) await sleep(PACE_MIN_MS + Math.floor(random() * (PACE_MAX_MS - PACE_MIN_MS)));
      return void ctx.json(ctx.res, 200, { text: `${parts.join(" ")}${nextUp(result.list)}` });
    }

    if (action === "pause") {
      const minutes = Number(body.minutes);
      if (!Number.isInteger(minutes) || minutes < PAUSE_MIN_MINUTES || minutes > PAUSE_MAX_MINUTES) {
        return refuse(`pause needs minutes: a whole number from ${PAUSE_MIN_MINUTES} to ${PAUSE_MAX_MINUTES}.`);
      }
      deps.pause(ctx.threadId, now() + minutes * 60_000);
      return void ctx.json(ctx.res, 200, { text: `Paused at ${progressLine(current)}. End your turn now with one short line saying you paused for the site's limit; Metal carries on with the ${counts(current).open} open item(s) in about ${minutes} minute${minutes === 1 ? "" : "s"}. Do not wait or retry in this turn.` });
    }

    return refuse("action is one of start, done, skip, status, pause.");
  };
}
