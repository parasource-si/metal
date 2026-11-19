// Seeds the test bots into a running Metal with only the requests the app itself makes: a team backup import
// (bots, looks, instructions, memory, room, conversation text), then section moves, approval level, skills, routines,
// webhooks, reactions and unread marks. Idempotent: anything already there by name in the "Test bots" section is kept
// as it is and skipped. Never reads, changes or deletes anything outside what it creates.
import { BOTS, D, MEMORY, ROOMS, ROUTINES, SECTION, SKILLS, WEBHOOKS, threads } from "./content.mjs";
import { backupProjection, buildThread } from "./transcripts.mjs";

// the dev app's server takes changes only from the desktop window; its seeding child is handed the same capability
const OWNER_HEADER = "X-Dusk-Desktop-Owner";
let ownerToken = null;
/** Sends the desktop owner capability with every request from here on; refuses anything but a well-formed one. */
export function useOwnerToken(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new Error("the desktop app handed over no valid owner capability");
  ownerToken = token;
}

/** The first line of `stream`, where the dev server writes the owner capability (never argv or env, which others read). */
export function readOwnerToken(stream, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let received = "";
    const done = (value) => { clearTimeout(timer); stream.removeAllListeners("data"); stream.pause?.(); resolve(value); };
    const timer = setTimeout(() => done(null), timeoutMs);
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      received += chunk;
      if (received.includes("\n") || received.length > 256) done(received.split("\n", 1)[0].trim() || null);
    });
    stream.once("end", () => done(received.trim() || null));
  });
}

export async function call(base, method, path, body) {
  const owner = ownerToken ? { [OWNER_HEADER]: ownerToken } : {};
  const response = await fetch(`${base}${path}`, body === undefined
    ? { method, headers: owner }
    : { method, headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${parsed?.error ?? text.slice(0, 300)}`);
  return parsed;
}

const day = (now, daysAgo) => new Date(now - daysAgo * D).toISOString().slice(0, 10);
const inSection = (record) => (record.section ?? "").trim() === SECTION;
const lower = (value) => value.trim().toLowerCase();

/** A dusk.backup with the given bots and rooms; every room member must be among the bots. */
export function teamBackup(now, bots = BOTS, rooms = ROOMS) {
  const conversations = threads();
  const backupBots = bots.map((bot) => {
    const tasks = conversations[bot.key].map((thread) => {
      const messages = backupProjection(buildThread(bot.key, thread, { now, attachmentsDir: "/unused" }));
      return { key: thread.key, title: thread.title, createdAt: messages[0].at - 60e3, activeLeafId: messages.at(-1).id, messages };
    });
    const memory = MEMORY[bot.key];
    return {
      key: bot.key, name: bot.name, title: bot.title, description: bot.description, soul: bot.soul,
      section: SECTION, color: bot.color, mascotBody: bot.mascotBody,
      chiefOfStaff: false, hidden: false, playbooks: [],
      activeTask: tasks[0].key, tasks,
      ...(memory ? { memory: { file: memory.file, topics: memory.topics, logs: memory.logs.map((log) => ({ name: `${day(now, log.day)}.md`, text: log.text })) } } : {}),
    };
  });
  const byKey = new Map(BOTS.map((bot) => [bot.key, bot]));
  const groups = rooms.map((room) => {
    let at = now - room.ago;
    const messages = room.lines.map((line, i) => {
      const speaker = line.from ? byKey.get(line.from) : null;
      at += 50e3;
      return {
        id: `test-room-${room.key}-${i + 1}`, role: speaker ? "bot" : "user", text: line.text, at,
        parentId: i === 0 ? null : `test-room-${room.key}-${i}`,
        ...(speaker ? { from: { botId: speaker.key, name: speaker.name, color: speaker.color } } : {}),
      };
    });
    return {
      key: room.key, name: room.name, section: SECTION, memberIds: room.members, dm: false,
      bulletin: room.bulletin, defaultResponder: room.responder, activeTask: "main",
      tasks: [{ key: "main", title: room.name, createdAt: now - room.ago, activeLeafId: messages.at(-1).id, messages }],
    };
  });
  return { format: "dusk.backup", version: 1, name: "Metal test bots", exportedAt: now, warnings: [], bots: backupBots, groups, routines: [] };
}

/**
 * @returns {{ created: { bots: Array<{ id, name }>, rooms: Array<{ id, name }>, routines: Array<{ id, name }>, webhooks: Array<{ id, name }>, sections: string[] },
 *   state: { now, bots: Record<string, { id, threads: Record<string, string> }>, routines: Record<string, { id, botId }> },
 *   credentials: Record<string, unknown>, skipped: string[] }}
 */
export async function seedBots(base, now, log = console.log) {
  const created = { bots: [], rooms: [], routines: [], webhooks: [], sections: [] };
  const skipped = [];
  const before = await call(base, "GET", "/api/bots?messages=0");
  const sectionsBefore = new Set(before.sections ?? []);
  const existingBots = new Map(before.bots.filter(inSection).map((bot) => [lower(bot.name), bot]));
  const existingRooms = new Map((before.groups ?? []).filter(inSection).map((group) => [lower(group.name), group]));
  const missingBots = BOTS.filter((bot) => !existingBots.has(lower(bot.name)));
  const missingRooms = ROOMS.filter((room) => !existingRooms.has(lower(room.name)));
  const roomsInImport = missingRooms.filter((room) => room.members.every((key) => missingBots.some((bot) => bot.key === key)));
  skipped.push(...BOTS.filter((bot) => existingBots.has(lower(bot.name))).map((bot) => bot.name));

  const ids = new Map([...existingBots.values()].map((bot) => [BOTS.find((entry) => lower(entry.name) === lower(bot.name)).key, bot.id]));
  const fresh = new Set();
  if (missingBots.length) {
    const imported = await call(base, "POST", "/api/teams/import?mode=add", teamBackup(now, missingBots, roomsInImport));
    // The import names its own section ("Test bots 2" when "Test bots" exists): move what it made into "Test bots".
    const importSections = new Set();
    for (const bot of missingBots) {
      const record = imported.bots.find((candidate) => candidate.name === bot.name)
        ?? imported.bots.find((candidate) => lower(candidate.name).startsWith(lower(bot.name)));
      if (!record) throw new Error(`the import did not create ${bot.name}`);
      ids.set(bot.key, record.id);
      fresh.add(bot.key);
      created.bots.push({ id: record.id, name: record.name });
      if (record.section !== SECTION) importSections.add(record.section);
    }
    for (const group of imported.groups) {
      created.rooms.push({ id: group.id, name: group.name });
      if (group.section !== SECTION) importSections.add(group.section);
    }
    await Promise.all([
      ...created.bots.map((bot) => call(base, "PATCH", `/api/bots/${bot.id}`, { section: SECTION, approvalMode: "ask" })),
      ...created.rooms.map((room) => call(base, "PATCH", `/api/groups/${room.id}`, { section: SECTION })),
    ]);
    const after = await call(base, "GET", "/api/bots?messages=0");
    for (const section of importSections) {
      const empty = section && !sectionsBefore.has(section) && !after.bots.some((bot) => bot.section === section) && !(after.groups ?? []).some((group) => group.section === section);
      if (empty) await call(base, "DELETE", `/api/sidebar-sections?section=${encodeURIComponent(section)}`);
    }
    if (!sectionsBefore.has(SECTION)) created.sections.push(SECTION);
    log(`  bots: ${missingBots.map((bot) => bot.name).join(", ")} (Ask me first, in "${SECTION}")`);
  }
  for (const room of missingRooms.filter((candidate) => !roomsInImport.includes(candidate))) {
    const made = await call(base, "POST", "/api/groups", {
      name: room.name, memberIds: room.members.map((key) => ids.get(key)), section: SECTION,
      setup: { bulletin: room.bulletin, defaultResponder: { kind: "member", botId: ids.get(room.responder.botId) } },
    });
    created.rooms.push({ id: made.group.id, name: made.group.name });
  }
  if (created.rooms.length) log(`  rooms: ${created.rooms.map((room) => room.name).join(", ")}`);

  await Promise.all(Object.entries(SKILLS).filter(([key]) => fresh.has(key)).flatMap(([key, skills]) => skills.map((skill) =>
    call(base, "POST", `/api/bots/${ids.get(key)}/skill-template`, {
      name: skill.name, description: skill.description, warnings: [], source: "duskbot-test-bots", text: skill.text, enabled: true,
    }))));

  const [routineList, webhookList] = await Promise.all([call(base, "GET", "/api/routines"), call(base, "GET", "/api/webhooks")]);
  const routines = {};
  for (const routine of ROUTINES) {
    const botId = ids.get(routine.bot);
    const existing = routineList.routines.find((candidate) => candidate.name === routine.name && candidate.botId === botId);
    if (existing) { routines[routine.name] = { id: existing.id, botId }; continue; }
    const schedule = routine.schedule.type === "interval" ? { ...routine.schedule, anchorAt: now } : routine.schedule;
    const made = await call(base, "POST", "/api/routines", {
      name: routine.name, prompt: routine.prompt, botId, target: "bot", runOn: "maus", schedule, enabled: false, durationMinutes: 15,
    });
    routines[routine.name] = { id: made.routine.id, botId };
    created.routines.push({ id: made.routine.id, name: routine.name });
  }
  if (created.routines.length) log(`  routines: ${created.routines.length}, all off`);

  const credentials = {};
  for (const hook of WEBHOOKS) {
    const botId = ids.get(hook.bot);
    if (webhookList.webhooks.some((candidate) => candidate.name === hook.name && candidate.botId === botId)) continue;
    const made = await call(base, "POST", "/api/webhooks", { name: hook.name, prompt: hook.prompt, botId, delivery: hook.delivery, enabled: true });
    created.webhooks.push({ id: made.webhook.id, name: hook.name });
    credentials[hook.name] = made.credential ?? null;
    // A "post" delivery writes into the chat with no AI turn: one sample shows what a delivery looks like.
    if (hook.sample && made.credential?.url) {
      const response = await fetch(made.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hook.sample) });
      if (!response.ok) log(`  (the sample delivery to ${hook.name} answered ${response.status})`);
    }
  }
  if (created.webhooks.length) log(`  webhooks: ${created.webhooks.map((hook) => hook.name).join(", ")}`);

  const conversations = threads();
  if (fresh.size) {
    const full = await call(base, "GET", "/api/bots");
    for (const bot of BOTS.filter((entry) => fresh.has(entry.key))) {
      const record = full.bots.find((candidate) => candidate.id === ids.get(bot.key));
      const main = conversations[bot.key][0];
      for (const step of main.script.filter((entry) => entry.reactions)) {
        const message = record?.messages?.find((candidate) => candidate.role === "bot" && candidate.text === step.b);
        if (!message) continue;
        for (const emoji of step.reactions) await call(base, "POST", `/api/threads/${record.threadId}/messages/${message.id}/reactions`, { emoji, on: true });
      }
    }
    await Promise.all(BOTS.filter((entry) => fresh.has(entry.key) && conversations[entry.key].some((thread) => thread.unread))
      .map((bot) => call(base, "PATCH", `/api/bots/${ids.get(bot.key)}`, { unread: true })));
  }

  const roster = await call(base, "GET", "/api/bots?messages=0");
  const state = { now, bots: {}, routines };
  for (const bot of BOTS) {
    const record = roster.bots.find((candidate) => candidate.id === ids.get(bot.key));
    const threadIds = {};
    for (const thread of conversations[bot.key]) {
      const task = record?.tasks?.find((candidate) => candidate.title === thread.title);
      if (task) threadIds[thread.key] = task.threadId;
    }
    state.bots[bot.key] = { id: ids.get(bot.key), threads: threadIds };
  }
  return { created, state, credentials, skipped };
}
