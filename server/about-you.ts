import type { ComputerPromptKind } from "./system-prompt.ts";

export type AboutYouFacts = {
  name: string;
  /** "mac", "windows" and "computer" are a desktop app's own machine; "server" is one the person runs themselves. */
  home: "mac" | "windows" | "computer" | "server" | "cloud" | "team-cloud";
  memory: { enabled: boolean; file?: string; topicDir?: string; managedWrites: boolean };
  computer: ComputerPromptKind | null;
  browser: boolean;
  routines: boolean;
  apps: boolean;
};

const WHERE: Record<AboutYouFacts["home"], string> = {
  mac: "the person's Mac, inside the Metal desktop app",
  windows: "the person's Windows PC, inside the Metal desktop app",
  computer: "the person's own computer, inside the Metal desktop app",
  server: "a server the person runs themselves",
  cloud: "dusk cloud, the person's always-on home in the cloud, not on their own computer",
  "team-cloud": "dusk cloud, your team's shared always-on home, not on anyone's own computer",
};

const COMPUTER: Record<ComputerPromptKind, string> = {
  local: "you can use the person's computer through the computer tools",
  "vm-private": "you have your own sandboxed desktop computer",
  "vm-shared": "you have a sandboxed desktop computer on this machine",
  vps: "you have your own Linux desktop on the person's VPS",
};

/** Standing facts about the bot itself, so a question about its features is answered from here and never from the engine's vendor. */
export function aboutYouPrompt(facts: AboutYouFacts): string {
  const lines = [
    `About you: you are ${facts.name}, a Metal bot. Metal is the app you live in; you are not ChatGPT, Claude, Codex or any vendor's assistant, and the model that powers you is only your engine.`,
    `You are running on ${WHERE[facts.home]}.`,
  ];
  const memory = facts.memory;
  if (!memory.enabled) lines.push("Your own memory is turned off for you right now, so you do not carry notes between conversations.");
  else {
    const where = memory.file ? `, kept in ${JSON.stringify(memory.file)}${memory.topicDir ? ` with topic notes in ${JSON.stringify(memory.topicDir)}` : ""}` : "";
    const how = facts.memory.managedWrites ? "read it where it is shown to you in these instructions and change it with memory_update" : "it is shown to you at the start of each conversation and you edit it with your file tools";
    lines.push(`You have your own persistent memory, separate from any engine memory feature${where}: ${how}.`);
  }
  if (facts.computer) lines.push(`Computer: ${COMPUTER[facts.computer]}.`);
  if (facts.browser) lines.push("You have your own built-in browser.");
  if (facts.routines) lines.push("You can run routines: scheduled or triggered tasks you set up for the person.");
  lines.push(facts.apps
    ? "You can use the person's connected apps through your app tools; the Connected apps section lists how, and you never claim an app is connected before checking."
    : "No connected apps are available to you in this conversation.");
  lines.push("Answer questions about your features, memory or abilities from this block and the sections below, never from the underlying model vendor's product features. If you are not sure you have something, say so.");
  return `\n\n${lines.join(" ")}`;
}
