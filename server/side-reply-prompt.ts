// The side responder's prompt and its answer. While a turn works, the person's new message gets a quick reply from a
// small fast model in the bot's voice, and that reply says what happens to the running task: nothing (answer), a note
// passed into it (steer), or it ends (stop) or makes way for the new ask (redirect).
import { z } from "zod";

import { redactSecretsInText } from "./redact.ts";

export type SideKind = "answer" | "steer" | "stop" | "redirect";

export interface SideDecision {
  kind: SideKind;
  reply: string;
}

export interface SideLine {
  who: "person" | "bot";
  text: string;
}

export interface SideTaskState {
  /** The request the running task works on. */
  ask: string;
  minutes: number;
  /** The status line's words for what it does right now. */
  status?: string;
  /** What it has done so far, in plain words, newest last. */
  steps: readonly string[];
  checklist?: { title?: string; done: number; total: number; next?: string };
  /** What the bot has told the person during this task. */
  said: readonly string[];
}

export interface SidePromptInput {
  name: string;
  soul?: string;
  task: SideTaskState;
  /** The conversation before the new message, oldest first. */
  recent: readonly SideLine[];
  message: string;
  /** The running task reads a note right away; otherwise it reads it when the current step ends. */
  notesNow: boolean;
}

const SOUL_CHARS = 800;
const ASK_CHARS = 800;
const LINE_CHARS = 300;
const MESSAGE_CHARS = 1_500;
const STEPS = 8;
const RECENT = 8;
export const REPLY_CHARS = 900;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function sideReplyPrompt(input: SidePromptInput): string {
  const { name, task } = input;
  const soul = clip(input.soul ?? "", SOUL_CHARS);
  const steps = task.steps.slice(-STEPS).map((step) => `- ${clip(step, 120)}`).join("\n") || "- (no steps yet)";
  const said = task.said.slice(-3).map((line) => `- ${clip(line, LINE_CHARS)}`).join("\n");
  const list = task.checklist;
  const recent = input.recent.slice(-RECENT).map((line) => `${line.who === "person" ? "Person" : name}: ${clip(line.text, LINE_CHARS)}`).join("\n");
  return [
    `You are ${name}, in a chat. You are in the middle of a task for the person and keep working on it; their new message arrived while you work. Write your quick reply to it and decide what happens to the task.`,
    soul ? `About ${name}, in its own setup: ${soul}` : `${name} is a helpful assistant.`,
    "",
    "The task you are working on (what the person asked):",
    "<<<",
    clip(task.ask, ASK_CHARS) || "(not known)",
    ">>>",
    `Working on it for about ${Math.max(1, Math.round(task.minutes))} min.${task.status ? ` Right now: ${clip(task.status, 80)}.` : ""}`,
    "Steps so far, newest last:",
    steps,
    ...(list ? [`Checklist${list.title ? ` "${clip(list.title, 80)}"` : ""}: ${list.done} of ${list.total} done${list.next ? `, next: ${clip(list.next, 100)}` : ""}.`] : []),
    ...(said ? ["What you told the person during this task:", said] : []),
    "",
    "The conversation before the new message, oldest first:",
    recent || "(none)",
    "",
    "The person's new message:",
    "<<<",
    clip(input.message, MESSAGE_CHARS),
    ">>>",
    "",
    "Pick one kind:",
    "- answer: a question or small talk, about the task, its progress, you, or anything else. Answer it from what is above; the task carries on untouched.",
    `- steer: extra information, a correction or a preference for the task in progress. Reply with a short acknowledgement of what you will do with it. ${input.notesNow
      ? "It reaches the work right away."
      : "It reaches the work as soon as the current step finishes: say so in a few words."}`,
    "- stop: they want the task stopped or cancelled and nothing new. Confirm in a few words.",
    "- redirect: they want the task dropped for something different they describe. Confirm in a few words what you will do instead.",
    "Never stop or redirect for a question, thanks, praise, impatience or extra details. When unsure, pick answer or steer.",
    "",
    "Rules for the reply:",
    `- Write as ${name}, in the first person, in the language of the new message. To the person you are the one doing the work: never mention another process, a helper, a model, tools or the app.`,
    "- Short and plain: one to three sentences, at most 60 words. No greeting, no emoji.",
    "- Never state results, numbers, prices or facts that are not given above, and never promise a time. If you do not know yet, say the task is still running.",
    "",
    'Answer with exactly one line of JSON and nothing else: {"kind": "answer" | "steer" | "stop" | "redirect", "reply": "..."}',
  ].join("\n");
}

const decisionShape = z.object({
  kind: z.enum(["answer", "steer", "stop", "redirect"]),
  reply: z.string(),
});

/** The model's decision, or null when it wrote anything but one valid decision with a usable reply. */
export function parseSideDecision(raw: string): SideDecision | null {
  const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = decisionShape.safeParse(value);
  if (!parsed.success) return null;
  const reply = redactSecretsInText(parsed.data.reply.replace(/\r/g, "").trim());
  if (!reply || reply.length > REPLY_CHARS || reply.includes("```")) return null;
  return { kind: parsed.data.kind, reply };
}

/** The note the running turn reads with the person's words when they steer it. */
export function steerNote(reply: string): string {
  return `[Metal: you already answered this message in the chat with ${JSON.stringify(reply)}. Take it into the work you are doing now; do not reply to it on its own.]`;
}

/** The note a continuation reads when the running turn could not take the message mid-turn. */
export function continuationNote(reply: string): string {
  return `[Metal: the person sent this while your last turn was running and you answered in the chat with ${JSON.stringify(reply)}. Take it into the task you were working on: carry on with what is left of it, and if that part is already done, adjust the result to fit.]`;
}

/** The note the new turn reads after the person redirected the running one. */
export function redirectNote(reply: string): string {
  return `[Metal: the person asked you to drop what you were doing for this, so that task was stopped. You answered in the chat with ${JSON.stringify(reply)}. Do this now.]`;
}
