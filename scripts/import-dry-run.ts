// Read-only dry run of "bring what you already use" against this computer's real home: what each tool would bring,
// in counts and kinds only. Writes nothing (Metal's data folder is pointed at a throwaway one), uploads nothing,
// prints no names, text or values. Run: node --experimental-strip-types scripts/import-dry-run.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DUSK_DATA_DIR = mkdtempSync(join(tmpdir(), "dusk-dry-run-"));
const { lookForBots } = await import("../server/bot-move-local.ts");
const { detectSetup, thisMachine } = await import("../server/setup-import.ts");
const { grokMovePlan } = await import("../shared/grok-import.ts");
const { moveFrom } = await import("../shared/bot-move.ts");

const machine = thisMachine();
const look = lookForBots(machine);
const rows: Record<string, Record<string, number>> = {};
const add = (tool: string, key: string, n: number) => { (rows[tool] ??= {})[key] = (rows[tool]![key] ?? 0) + n; };
// the same bot kept in two apps comes over once, as the copy with the most in it (src/lib/bot-move.ts)
const weight = (bot: (typeof look.apps)[number]["bots"][number]) => bot.instructions.length + 400 * bot.skills.length
  + 200 * (bot.memories.length + bot.userFacts.length) + 300 * bot.routines.length + Object.values(bot.memoryFiles ?? {}).reduce((sum, text) => sum + text.length, 0);
const best = new Map<string, unknown>();
for (const bot of look.apps.flatMap((app) => app.bots)) {
  const key = bot.name.trim().toLowerCase();
  const held = best.get(key) as typeof bot | undefined;
  if (!held || weight(bot) > weight(held)) best.set(key, bot);
}
for (const app of look.apps) {
  for (const bot of app.bots) {
    if (best.get(bot.name.trim().toLowerCase()) !== bot) {
      add(app.app, "sameBotKeptFromAnotherApp", 1);
      continue;
    }
    const plan = grokMovePlan(bot, { timeZone: "UTC", from: moveFrom(app) });
    add(app.app, "bots", 1);
    add(app.app, "memories", plan.memories);
    add(app.app, "aboutMeFacts", plan.facts.length);
    add(app.app, "skills", plan.skills.length);
    add(app.app, "routines", plan.routines);
    add(app.app, "appsToReconnect", plan.apps);
    add(app.app, "personaChars", bot.instructions.length);
    add(app.app, "forEngineChunks", plan.distill.length);
    add(app.app, "noiseDropped", plan.dropped);
  }
  add(app.app, "channels", app.channels.length);
  add(app.app, "unreadableFiles", app.unreadable.length);
}
const host = { mcpServers: () => ({}), mcpPolicyRefusal: () => undefined, persistMcpServers: () => { throw new Error("dry run"); }, mcpConfigBusy: { get: () => false, set: () => {} } };
const setup = detectSetup(machine, host);
for (const skill of setup.skills) add(`setup:${skill.source}`, "skills", 1);
for (const tool of setup.tools) add(`setup:${tool.source}`, "mcpServers", 1);
for (const file of setup.instructions ?? []) add(`setup:${file.source}`, "instructionFiles", 1);
console.log(JSON.stringify(rows, null, 2));
