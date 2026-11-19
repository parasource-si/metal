// Homes holding other agent apps as they lay out their folders (OpenClaw 2026.3 and 2026.11, Hermes Agent, Claude
// Code's and Gemini CLI's agents and saved commands, Codex prompts, Windsurf workflows, OpenHands microagents, dusk
// bot's older builds), for the import's tests and screenshots, built from each app's public docs. Every login, key,
// session and history file holds SENTINEL.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SENTINEL = "sk-ant-api03-SENTINELSECRETVALUE0123456789abcdefABCDEF";

type Put = (path: string, text: string) => string;

export function putter(home: string): Put {
  return (path, text) => {
    const full = join(home, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
}

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** OpenClaw 2026.3: agents.list in a JSON5 config, cron/jobs.json, JSONL sessions and auth-profiles.json. */
export function plantOpenClawList(home: string, dir = ".openclaw", config = "openclaw.json"): string[] {
  const put = putter(home);
  put(`${dir}/${config}`, `// written by openclaw onboard
{
  agents: {
    defaults: { workspace: "~/${dir}/workspace", model: "anthropic/claude-sonnet-4-5" },
    list: [
      { id: "main", default: true, identity: { name: "Molty", emoji: "🦞" } },
      { id: "scout", name: "Scout", identity: { avatar: "../workspace/avatar.png" } },
    ],
  },
  mcp: { servers: { linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${SENTINEL}" } }, files: { command: "npx", args: ["-y", "files-mcp"], env: { FILES_TOKEN: "${SENTINEL}" } } } },
  channels: { telegram: { botToken: "${SENTINEL}", dmPolicy: "pairing" }, discord: { enabled: false, token: "x" }, defaults: {} },
}
`);
  put(`${dir}/workspace/SOUL.md`, "# SOUL.md - Who You Are\n\nBe genuinely helpful, not performatively helpful. Have opinions.\n");
  put(`${dir}/workspace/IDENTITY.md`, "# IDENTITY.md\n\n- **Name:** Molty\n- **Creature:** space lobster\n- **Vibe:** warm, a little dry\n- **Emoji:** 🦞\n- **Avatar:** avatar.png\n");
  writeFileSync(join(home, dir, "workspace", "avatar.png"), PNG);
  put(`${dir}/workspace/USER.md`, "# USER.md\n\n- **Name:** Sam\n- **Timezone:** Europe/Lisbon\n- **Pronouns:**\n- Prefers short answers.\n");
  put(`${dir}/workspace/AGENTS.md`, "# AGENTS.md - Your Workspace\n\nRead SOUL.md and USER.md first. Write daily notes to memory/YYYY-MM-DD.md.\n");
  put(`${dir}/workspace/TOOLS.md`, "# TOOLS.md\n\n- The living room camera is `cam-1`.\n");
  put(`${dir}/workspace/HEARTBEAT.md`, "# HEARTBEAT.md\n\n- Check the inbox for anything urgent and tell me.\n");
  put(`${dir}/workspace/BOOTSTRAP.md`, "# BOOTSTRAP.md\n\nHello, world. Who am I?\n");
  put(`${dir}/workspace/MEMORY.md`, "# MEMORY.md\n\n- Sam's sister is called Ana.\n- The boat needs a new battery in spring.\n");
  put(`${dir}/workspace/memory/2026-03-01.md`, "# 2026-03-01\n\n- Booked the dentist for the 9th.\n");
  put(`${dir}/workspace/memory/2026-03-02.md`, "# 2026-03-02\n\n- Sam wants a weekly grocery list.\n");
  put(`${dir}/workspace/skills/groceries/SKILL.md`, skill("groceries", "Builds the weekly grocery list.", "Ask what is left in the fridge, then write the list."));
  put(`${dir}/workspace-scout/SOUL.md`, "You are Scout. You research things and answer with sources.\n");
  put(`${dir}/workspace-scout/skills/sources/SKILL.md`, skill("sources", "Cites sources.", "Always link where a fact came from."));
  put(`${dir}/skills/weather/SKILL.md`, skill("weather", "Gets the weather.", "Use wttr.in for the forecast."));
  put(`${dir}/cron/jobs.json`, JSON.stringify({ version: 1, jobs: [
    { id: "j1", agentId: "main", name: "Morning brief", enabled: true, schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Lisbon" },
      sessionTarget: "isolated", payload: { kind: "agentTurn", message: "Summarize my day ahead." }, delivery: { mode: "announce", channel: "telegram", to: "123" } },
    { id: "j2", agentId: "scout", name: "News sweep", enabled: false, schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { kind: "agentTurn", message: "Check for news about heat pumps." } },
    { id: "j3", agentId: "main", name: "Wake", schedule: { kind: "cron", expr: "*/5 * * * *" }, payload: { kind: "systemEvent", text: "Check reminders." } },
  ] }, null, 2));
  return [
    put(`${dir}/credentials/telegram-allowFrom.json`, SENTINEL),
    put(`${dir}/agents/main/agent/auth-profiles.json`, JSON.stringify({ profiles: { anthropic: { key: SENTINEL } } })),
    put(`${dir}/agents/main/sessions/sessions.json`, SENTINEL),
    put(`${dir}/agents/main/sessions/abc.jsonl`, JSON.stringify({ role: "user", content: SENTINEL })),
    put(`${dir}/.env`, `ANTHROPIC_API_KEY=${SENTINEL}`),
    put(`${dir}/workspace/.env`, `KEY=${SENTINEL}`),
  ];
}

/** OpenClaw 2026.11: agents.entries, defaults.systemAgent, and cron jobs in state/openclaw.sqlite beside sessions. */
export function plantOpenClawEntries(home: string): string[] {
  const put = putter(home);
  put(".openclaw/openclaw.json", JSON.stringify({
    agents: {
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { ops: { name: "Ops", description: "Keeps the servers up", identity: { name: "Opsy", theme: "calm engineer" } } },
    },
    channels: { slack: { botToken: SENTINEL } },
  }));
  put(".openclaw/workspace/SOUL.md", "You keep production calm. Page a human for anything that loses data.\n");
  put(".openclaw/workspace/MEMORY.md", "- The database fails over to us-east-2.\n");
  mkdirSync(join(home, ".openclaw", "state"), { recursive: true });
  const db = new DatabaseSync(join(home, ".openclaw", "state", "openclaw.sqlite"));
  db.exec("CREATE TABLE cron_jobs (job_id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, agent_id TEXT, payload_kind TEXT, job_json TEXT)");
  db.exec("CREATE TABLE sessions (id TEXT, transcript TEXT)");
  db.prepare("INSERT INTO sessions VALUES (?, ?)").run("s1", SENTINEL);
  const job = { id: "c1", agentId: "ops", name: "Disk check", enabled: true, schedule: { kind: "cron", expr: "0 */6 * * *", tz: "UTC" }, payload: { kind: "agentTurn", message: "Check disk usage on every host." } };
  const script = { id: "c2", agentId: "ops", name: "Rotate", schedule: { kind: "cron", expr: "0 0 * * *" }, payload: { kind: "script", script: "rotate.sh" } };
  for (const one of [job, script]) db.prepare("INSERT INTO cron_jobs VALUES (?, ?, 1, 'ops', ?, ?)").run(one.id, one.name, one.payload.kind, JSON.stringify(one));
  db.close();
  return [put(".openclaw/agents/ops/agent/openclaw-agent.sqlite", SENTINEL)];
}

/** Hermes Agent: the default home and one profile, bundled and own skills, § memory, cron/jobs.json, .env and auth.json. */
export function plantHermes(home: string): string[] {
  const put = putter(home);
  put(".hermes/config.yaml", `model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
agent:
  personalities:
    concise: "You answer in two sentences or fewer."
    pirate:
      system_prompt: "Talk like a pirate."
display:
  personality: concise
platforms:
  telegram:
    enabled: true
whatsapp:
  enabled: true
gateway:
  platforms:
    discord:
      enabled: true
      token: ${SENTINEL}
mcp_servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${SENTINEL}
  notion:
    url: https://mcp.notion.com/mcp
    headers:
      Authorization: Bearer ${SENTINEL}
`);
  put(".hermes/SOUL.md", "You are Hermes. Curious, patient, and honest about what you don't know.\n");
  put(".hermes/memories/MEMORY.md", "The user's server is a Contabo VPS.\n§\nDeploys go through a script called deploy.\n§\n");
  put(".hermes/memories/USER.md", "Name: Priya\n§\nWorks nights; never message before noon.\n");
  put(".hermes/skills/.bundled_manifest", "arxiv:3f2a\ngithub-pr:99aa\n");
  put(".hermes/skills/research/arxiv/SKILL.md", skill("arxiv", "Searches arXiv.", "Bundled with Hermes."));
  put(".hermes/skills/devops/github-pr/SKILL.md", skill("github-pr", "Opens pull requests.", "Bundled with Hermes."));
  put(".hermes/skills/devops/deploy-check/SKILL.md", skill("deploy-check", "Checks a deploy went out.", "Curl the health endpoint, then read the last 50 log lines."));
  put(".hermes/skills/standup/SKILL.md", skill("standup", "Writes my standup.", "List yesterday, today and blockers."));
  put(".hermes/cron/jobs.json", JSON.stringify({ jobs: [
    { id: "a1b2c3d4e5f6", name: "Standup", prompt: "Write my standup from yesterday's commits.", skills: ["standup"],
      schedule: { kind: "cron", expr: "30 13 * * 1-5", display: "30 13 * * 1-5" }, schedule_display: "30 13 * * 1-5", enabled: true,
      state: "scheduled", deliver: "telegram:123456", timezone: "Asia/Kolkata" },
    { id: "b1", name: "Ping", prompt: "Check the VPS is up.", schedule: { kind: "interval", minutes: 30, display: "every 30m" }, enabled: true, state: "paused" },
  ], updated_at: "2026-11-01T00:00:00Z" }));
  put(".hermes/profiles/coder/config.yaml", "agent:\n  system_prompt: You are a careful senior engineer.\n");
  put(".hermes/profiles/coder/profile.yaml", "display_name: Coder\ndescription: Reviews my pull requests\n");
  put(".hermes/profiles/coder/memories/MEMORY.md", "Prefers small diffs.\n");
  put(".hermes/profiles/empty-folder/notes.txt", "not a profile");
  return [
    put(".hermes/.env", `TELEGRAM_BOT_TOKEN=${SENTINEL}\nOPENROUTER_API_KEY=${SENTINEL}`),
    put(".hermes/auth.json", JSON.stringify({ token: SENTINEL })),
    put(".hermes/state.db", SENTINEL),
    put(".hermes/sessions/sessions.json", SENTINEL),
    put(".hermes/profiles/coder/.env", SENTINEL),
  ];
}

/** OpenClaw as a real install is often left: three agents in the config, but only the main one ever given a persona
 * (its SOUL.md rewritten, every other file still OpenClaw's template), one never set up (BOOTSTRAP.md waiting) and one
 * with an empty folder. Synthetic text in the templates' shape; only one bot is real here. */
export function plantOpenClawStock(home: string): void {
  const put = putter(home);
  const stock = {
    "AGENTS.md": "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n\n## First Run\n\nIf BOOTSTRAP.md exists, follow it.\n\n## Memory\n\n- Daily notes: memory/YYYY-MM-DD.md\n",
    "TOOLS.md": "# TOOLS.md - Local Notes\n\nSkills define how tools work. This file is for your specifics.\n\n## What Goes Here\n\n- Camera names and locations\n- SSH hosts and aliases\n",
    "USER.md": "# USER.md - About Your Human\n\n_Learn about the person you're helping._\n\n- **Name:**\n- **What to call them:**\n- **Pronouns:** _(optional)_\n- **Timezone:**\n- **Notes:**\n\n## Context\n\n_(What do they care about? What are they working on?)_\n",
    "IDENTITY.md": "# IDENTITY.md - Who Am I?\n\n- **Name:**\n  _(pick something you like)_\n- **Creature:**\n- **Vibe:**\n- **Emoji:**\n- **Avatar:**\n",
    "HEARTBEAT.md": "```markdown\n# Keep this file empty (or with only comments) to skip heartbeat calls.\n# Add tasks below when you want the agent to check something periodically.\n```\n\n## Related\n\n- [Heartbeat config](/gateway/heartbeat)\n",
  };
  put(".openclaw/openclaw.json", JSON.stringify({ agents: { defaults: { workspace: "~/.openclaw/workspace" }, list: [
    { id: "main" }, { id: "researcher", workspace: "~/.openclaw/workspace/researcher" }, { id: "writer", workspace: "~/.openclaw/workspace/writer" },
  ] }, channels: { whatsapp: { enabled: true } } }));
  for (const [file, text] of Object.entries(stock)) {
    put(`.openclaw/workspace/${file}`, text);
    put(`.openclaw/workspace/researcher/${file}`, text);
  }
  put(".openclaw/workspace/SOUL.md", "# nova\n\n## core truths\n\nYou are Nova, a warm and direct companion. You keep plans honest and remember what matters to the person.\n\n## voice\n\nShort sentences. Gentle humour. Never fake cheer.\n");
  put(".openclaw/workspace/researcher/SOUL.md", "# SOUL.md - Who You Are\n\nYou're not a chatbot. You're becoming someone.\n\n- Be genuinely helpful, not performatively helpful.\n- Have opinions.\n- Be resourceful before asking.\n");
  put(".openclaw/workspace/researcher/BOOTSTRAP.md", "# BOOTSTRAP.md - Hello, World\n\nYou just woke up. Time to figure out who you are.\n");
  mkdirSync(join(home, ".openclaw", "workspace", "writer"), { recursive: true });
}

/** A home in the shape of a real one seen on a desktop (synthetic values only): one persona run in both OpenClaw
 * (every other file still a template, two named agents never set up) and Hermes Agent (its long § notes about the
 * person, its own skills beside the bundled ones), Claude Code's own agents, skills, MCP servers and CLAUDE.md, Codex's
 * skills, MCP servers and AGENTS.md, Windsurf's MCP servers, and no Gemini CLI agents. */
export function plantRealShape(home: string): void {
  const put = putter(home);
  plantOpenClawStock(home);
  const persona = "# nova\n\n## core truths\n\nYou are Nova, a warm and direct companion who keeps plans honest.\n\n## voice\n\nShort sentences, gentle humour, never fake cheer.\n";
  put(".hermes/SOUL.md", `${persona}\n## how you help\n\nYou remember what matters and say it plainly.\n`);
  put(".hermes/config.yaml", "model:\n  default: anthropic/claude-sonnet-4-5\n  provider: openrouter\nagent:\n  personalities:\n    concise: \"Answer briefly.\"\ntelegram:\n  enabled: true\nwhatsapp:\n  enabled: true\n");
  put(".hermes/memories/USER.md", [
    "Sam is a product designer who runs a small studio and is building a habit tracker app on the side. Works late, usually 11am to 2am, and prefers voice notes over long texts when busy. The studio's main client this quarter is a coffee roaster rebrand, due before their spring launch, and Sam wants weekly check-ins on it every Monday.",
    "Close people: Ana (sister, lives in Lisbon), Ravi (cofounder of the habit app). Sam likes direct feedback, hates corporate tone, and writes in lowercase in chats.",
    "ok",
  ].join("\n§\n"));
  put(".hermes/skills/.bundled_manifest", "arxiv:3f2a\n");
  put(".hermes/skills/research/arxiv/SKILL.md", skill("arxiv", "Searches arXiv.", "Bundled with Hermes."));
  put(".hermes/skills/productivity/weekly-review/SKILL.md", skill("weekly-review", "Runs Sam's Monday review.", "List last week's wins, slips and next week's three priorities."));
  put(".hermes/skills/creative/moodboard/SKILL.md", skill("moodboard", "Builds a moodboard brief.", "Ask for three adjectives, then collect references."));
  put(".claude/agents/frontend.md", "---\nname: frontend\ndescription: Changes existing UI.\ncolor: green\n---\n\nYou change UI that already exists. Match the design system.\n");
  put(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews a change for bugs.\ncolor: red\n---\n\nYou review one change for correctness and security. One pass.\n");
  put(".claude/CLAUDE.md", "# My preferences\n\n- Concise answers, no em dashes.\n- Ask before deleting anything.\n");
  put(".claude/skills/pdf/SKILL.md", skill("pdf", "Works with PDFs.", "Extract text, then summarise."));
  put(".claude.json", JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } } }));
  put(".codex/AGENTS.md", "# Codex\n\nUse pnpm. Small commits.\n");
  put(".codex/skills/release/SKILL.md", skill("release", "Cuts a release.", "Bump, tag, write the changelog."));
  put(".codex/config.toml", "model = \"gpt-5\"\n[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n");
  put(".codeium/windsurf/mcp_config.json", JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "github-mcp"] } } }));
}

/** Another app's memory as it really piles up: durable facts among chatter, tool output, an old one-off, repeats and
 * near-repeats, a key, and a long passage. */
export const NOISY_MEMORIES = [
  "Priya runs a two-person design studio in Pune.",
  "ok",
  "Done!",
  "Prefers replies under five lines, no emoji.",
  "prefers replies under five lines and no emoji",
  "$ npm run build && npm test",
  "{\"status\": 200, \"ok\": true}",
  "Error: ENOENT: no such file or directory, open '/tmp/x.json'",
  "2025-01-10: remind Priya about the dentist appointment tomorrow",
  "Her sister Meera is moving to Lisbon in March.",
  "Today I'm checking the deploy logs",
  `My OpenAI key is ${SENTINEL}`,
  "Client: Hartwell Coffee, rebrand due before their spring launch.",
  "Client: Hartwell Coffee, rebrand due before their spring launch.",
  `Long passage: ${"She has explained how the studio works, every step and every tool, in great detail. ".repeat(6)}`,
];

/** A 1x1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** Claude Code's and Gemini CLI's own agents, and the saved commands, prompts and workflows of Claude Code, Codex,
 * Gemini CLI, Windsurf and OpenHands, as their docs lay them out. */
export function plantAgentTools(home: string): string[] {
  const put = putter(home);
  put(".claude/agents/code-reviewer.md", `---
name: code-reviewer
description: Expert code review specialist. Use right after writing or changing code.\\n\\n<example>user: review this</example>
tools: Read, Grep, Glob, Bash
model: sonnet
color: blue
---

You are a senior code reviewer. Run git diff, focus on the changed files, and report issues by priority: critical, warnings, suggestions.
`);
  put(".claude/agents/notes.txt", "not an agent");
  put(".gemini/agents/researcher.md", `---
name: researcher
description: Finds and cites sources.
kind: local
model: gemini-2.5-pro
mcpServers:
  search:
    httpUrl: https://search.example.com/mcp
---

Search first, then answer with a link for every claim.
`);
  put(".claude/commands/review-pr.md", "---\ndescription: Review a pull request\nargument-hint: [pr-number]\nallowed-tools: Bash(gh pr view:*)\n---\n\nReview pull request #$ARGUMENTS. Check tests and naming.\n");
  put(".claude/commands/git/commit.md", "Write a conventional commit message for the staged changes.\n");
  put(".codex/prompts/explain.md", "---\ndescription: Explain code simply\n---\nExplain $1 to a new teammate in five sentences.\n");
  put(".gemini/commands/plan.toml", 'description = "Plan a change"\nprompt = """\nWrite a step-by-step plan for: {{args}}\n"""\n');
  put(".codeium/windsurf/global_workflows/release.md", "# Release\n\n1. Bump the version.\n2. Write the changelog.\n");
  put(".openhands/microagents/repo-rules.md", "---\nname: repo-rules\ntriggers:\n- repo\n---\n\nAlways run the linter before committing.\n");
  return [
    put(".claude/commands/deploy.md", `Deploy with the key ${SENTINEL}.\n`),
    put(".claude/.credentials.json", SENTINEL),
    put(".gemini/oauth_creds.json", SENTINEL),
  ];
}

/** Metal's older folder, kept beside the new one: bots.json, workspaces and routines.json, with chats in messages.db. */
export function plantOpenMausBot(home: string): string[] {
  const put = putter(home);
  put(".openmausbot/bots.json", JSON.stringify([
    { id: "maus-1", name: "Maus", defaultBot: { person: "me" }, soul: "default", color: "chrome" },
    { id: "b-ledger", name: "Ledger", title: "Bookkeeper", description: "Keeps the books", soul: "You track every expense and flag anything odd.", color: "teal" },
    { id: "b-hidden", name: "Gone", hidden: true, soul: "x" },
  ]));
  put(".openmausbot/workspaces/b-ledger/MEMORY.md", "# Memory\n\n- Rent is due on the 1st.\n");
  put(".openmausbot/workspaces/b-ledger/memory/vendors.md", "# Vendors\n\n- Electricity: EDP\n");
  put(".openmausbot/workspaces/b-ledger/skills/receipts/SKILL.md", skill("receipts", "Files receipts.", "Rename each receipt by date and vendor."));
  put(".openmausbot/routines.json", JSON.stringify({ routines: [
    { id: "r1", name: "Month end", prompt: "Close the month.", botId: "b-ledger", enabled: true, target: "bot", runOn: "maus",
      schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30 },
  ] }));
  return [put(".openmausbot/messages.db", SENTINEL), put(".openmausbot/config.json", JSON.stringify({ key: SENTINEL }))];
}

/** A link from an old name to the folder, as OpenClaw leaves after a move. */
export function linkOldName(home: string, from: string, to: string): void {
  symlinkSync(join(home, to), join(home, from), "dir");
}
