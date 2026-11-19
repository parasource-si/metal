import { describe, expect, it } from "vitest";

import { isNotesPrompt, looksLikeNotes, NOTES_PROMPT, parseNotes } from "./assistant-notes.ts";
import { GrokImportError } from "./grok-import.ts";

const file = (body: string, front = "format: dusk-bot-notes\nversion: 3\nfrom: ChatGPT\nexported: 2026-11-14") => `---\n${front}\n---\n\n${body}`;
const code = (run: () => unknown) => {
  try { run(); return "none"; } catch (error) { return error instanceof GrokImportError ? error.code : String(error); }
};

const whole = file(`# SETUP INSTRUCTIONS FOR METAL

This export is from ChatGPT for Priya Shah. It lists 1 bot under Bots: recreate it as its own bot.

# About me
## Basics
- Priya Shah, lives in Pune, Asia/Kolkata
## Work
- Product manager at Acme,
  leading the billing revamp
## Writing style
- Short, no emoji

# Contacts
- Ravi Kumar: my manager, prefers Slack

# How I like answers
~~~text
Be brief.
# This heading is part of the instructions
~~~

# Memories
- Prefers metric units (2025-03-01)
- <each saved memory, word for word>

# Open threads
- Pick a payment provider

# Routines
## Morning brief
- Schedule: weekdays at 8
- Cron: 0 8 * * 1-5
- Time zone: Asia/Kolkata
~~~text
Summarize my calendar and inbox.
~~~
## Weekly meal plan
- Bot: Recipe helper
- Cron: 0 9 * * 0
~~~text
Plan meals for the week.
~~~

# Connected apps
- Gmail
- Google Calendar

# Skills
## Tone check
- When to use: before I send an email
~~~text
Read the draft and flag anything curt.
~~~

# Bots
## Bot: Recipe helper
- Kind: Custom GPT
- Description: Scales recipes
### Instructions
~~~text
You scale recipes.
## Units
Use grams.
~~~
### Personality
- Warm and encouraging
### Memories
- Cooks for a family of 4
### Knowledge files
- pantry.pdf
### Skills
#### Convert units
- When to use: a recipe in cups
~~~text
Convert cups to grams.
~~~
### Apps
- Recipe search (https://mcp.example.com/recipes)

END OF METAL NOTES
`);

describe("the markdown notes file", () => {
  it("reads every section into the person's facts, their own routines and skills, and a bot with everything it had", () => {
    expect(looksLikeNotes(whole)).toBe(true);
    expect(isNotesPrompt(whole)).toBe(false);
    const notes = parseNotes(`Here is your file:\n\n\`\`\`\`markdown\n${whole}\`\`\`\`\n`);
    expect(notes.from).toEqual({ name: "ChatGPT", key: "chatgpt" });
    expect(notes.partial).toBe(false);
    expect(notes.setup).toContain("recreate it as its own bot");
    expect(notes.aboutMe).toEqual([
      "Priya Shah, lives in Pune, Asia/Kolkata",
      "Work: Product manager at Acme, leading the billing revamp",
      "Writing style: Short, no emoji",
      "Person: Ravi Kumar: my manager, prefers Slack",
    ]);
    expect(notes.instructions).toBe("Be brief.\n# This heading is part of the instructions");
    expect(notes.memories, "a template line left in is not a memory").toEqual(["Prefers metric units (2025-03-01)"]);
    expect(notes.openThreads).toEqual(["Pick a payment provider"]);
    expect(notes.apps).toEqual(["Gmail", "Google Calendar"]);
    expect(notes.recurring).toEqual([{ name: "Morning brief", instruction: "Summarize my calendar and inbox.", when: "weekdays at 8 (0 8 * * 1-5, Asia/Kolkata)", cron: "0 8 * * 1-5", timeZone: "Asia/Kolkata" }]);
    expect(notes.skills).toEqual([{ name: "Tone check", description: "before I send an email", instructions: "Read the draft and flag anything curt." }]);
    expect(notes.bots).toHaveLength(1);
    const bot = notes.bots[0]!;
    expect(bot.name).toBe("Recipe helper");
    expect(bot.title).toBe("Custom GPT");
    expect(bot.description).toBe("Scales recipes");
    expect(bot.instructions).toBe("You scale recipes.\n## Units\nUse grams.\n\n## Personality\n\n- Warm and encouraging");
    expect(bot.memories).toEqual(["Cooks for a family of 4"]);
    expect(bot.skills).toEqual([{ name: "Convert units", description: "a recipe in cups", instructions: "Convert cups to grams." }]);
    expect(bot.routines.map((one) => [one.name, one.cron])).toEqual([["Weekly meal plan", "0 9 * * 0"]]);
    expect(bot.apps).toEqual([{ name: "Recipe search", mcpUrl: "https://mcp.example.com/recipes", transport: "", headerNames: [] }]);
    expect(bot.memoryFiles!["memory/knowledge-files.md"]).toContain("- pantry.pdf");
  });

  it("keeps the setup block and final marker from earlier exports", () => {
    const legacy = whole.replace("SETUP INSTRUCTIONS FOR METAL", "SETUP INSTRUCTIONS FOR DUSK BOT").replace("END OF METAL NOTES", "END OF DUSK BOT NOTES");
    expect(parseNotes(legacy)).toEqual(parseNotes(whole));
  });

  it("joins the parts of a split answer, and says when the last part never came", () => {
    const one = file("# Memories\n- Likes tea\n");
    const two = file("# Memories\n- Likes tea\n- Runs on Sundays\n\nEND OF METAL NOTES\n");
    const joined = parseNotes(`${one}\n\n${two}`);
    expect(joined.memories).toEqual(["Likes tea", "Runs on Sundays"]);
    expect(joined.partial).toBe(false);
    expect(parseNotes(one).partial, "no end line: something is missing").toBe(true);
  });

  it("looks through a heading wrapped around everything and bold field names", () => {
    const notes = parseNotes(file("# My export\n## About me\n- Lives in Oslo\n## Routines\n### Standup\n- **Cron:** 0 9 * * 1-5\n- **Time zone:** Europe/Oslo\n~~~text\nAsk what I'm doing today.\n~~~\n\nEND OF METAL NOTES"));
    expect(notes.aboutMe).toEqual(["Lives in Oslo"]);
    expect(notes.recurring[0]).toMatchObject({ name: "Standup", cron: "0 9 * * 1-5", timeZone: "Europe/Oslo" });
  });

  it("a bot answering for itself keeps its own instructions, memories, skills and routines, never the person's too", () => {
    const notes = parseNotes(file([
      "# How I like answers", "~~~text", "You run the shop.", "~~~", "# Memories", "- Tidepool sells out fastest", "- Maya hates phone calls",
      "# Routines", "## Morning orders", "- Cron: 30 8 * * *", "~~~text", "Check new orders.", "~~~",
      "# Skills", "## Order triage", "~~~text", "List new orders.", "~~~",
      "# Bots", "## Bot: Kiln", "### Instructions", "~~~text", "You run the shop.", "~~~", "### Memories", "- Tidepool sells out fastest",
      "### Skills", "#### Order triage", "~~~text", "List new orders.", "~~~", "### Routines", "#### Morning orders", "- Cron: 30 8 * * *", "~~~text", "Check new orders.", "~~~",
      "", "END OF METAL NOTES",
    ].join("\n")));
    expect(notes.instructions).toBe("");
    expect(notes.memories).toEqual(["Maya hates phone calls"]);
    expect(notes.recurring).toEqual([]);
    expect(notes.skills).toEqual([]);
    expect(notes.bots[0]).toMatchObject({ name: "Kiln", memories: ["Tidepool sells out fastest"] });
    expect(notes.bots[0]!.routines).toHaveLength(1);
  });

  it("refuses the prompt itself, a template never filled in, and credentials", () => {
    expect(code(() => parseNotes(NOTES_PROMPT))).toBe("cutOff");
    expect(code(() => parseNotes(file("# Memories\n- <each saved memory>\n\nEND OF METAL NOTES")))).toBe("notExport");
    expect(code(() => parseNotes(file("# Memories\n- Likes tea", "format: dusk-bot-notes\nversion: 9\nfrom: Claude")))).toBe("newerVersion");
    const notes = parseNotes(file("# Memories\n- My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n\nEND OF METAL NOTES"));
    expect(notes.memories[0]).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
