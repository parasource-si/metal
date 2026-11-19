import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { validateBotCwd } from "./bot-cwd.ts";
import { DATA_DIR } from "./config.ts";
import { foreignDataDir, rebaseOwnFolder, rebaseStoredFolders, settleChatFolder } from "./own-folders.ts";
import { describeSpawnFailure } from "./procs.ts";
import { roomTurnFolder } from "./room-folder.ts";
import { Store } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "dusk-own-folders-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BOT = "b3ce933b-e438-49ee-8ff3-b5dff0a6043e", THREAD = "b056d17b-13cc-4569-9dd1-8524fbd97c2b";
const isBot = (id: string) => id === BOT;
const here = join(root, "dev-data");
const other = join(root, "daily-data");
const otherChat = join(other, "task-workspaces", BOT, THREAD);
mkdirSync(here, { recursive: true });
mkdirSync(otherChat, { recursive: true });
writeFileSync(join(other, "bots.json"), "[]");
const picked = join(root, "site");
mkdirSync(picked);

const settle = (stored: string | null | undefined, botCwd?: string) =>
  settleChatFolder({ stored, botCwd, botId: BOT, threadId: THREAD, dataDir: here, isBot, worksInFolders: true });

describe("rebaseOwnFolder", () => {
  it("maps a chat's and a bot's own folder from another data dir onto this one", () => {
    expect(rebaseOwnFolder(otherChat, here, isBot)).toBe(join(here, "task-workspaces", BOT, THREAD));
    expect(rebaseOwnFolder(join(other, "workspaces", BOT), here, isBot)).toBe(join(here, "workspaces", BOT));
    expect(rebaseOwnFolder(`C:\\Users\\me\\.duskbot\\task-workspaces\\${BOT}\\${THREAD}\\out`, here, isBot)).toBe(join(here, "task-workspaces", BOT, THREAD, "out"));
  });

  it("leaves a picked folder, another bot's id and an escaping tail alone", () => {
    expect(rebaseOwnFolder(picked, here, isBot)).toBeUndefined();
    expect(rebaseOwnFolder(join(other, "workspaces", "someone-else"), here, isBot)).toBeUndefined();
    expect(rebaseOwnFolder(join(other, "task-workspaces", BOT, THREAD, "..", "..", ".."), here, isBot)).toBeUndefined();
    expect(rebaseOwnFolder(null, here, isBot)).toBeUndefined();
  });
});

describe("settleChatFolder", () => {
  it("rebases a chat folder stored by another data dir and creates it here, never touching the other one", () => {
    const before = readdirSync(other).sort();
    expect(settle(otherChat)).toEqual({ cwd: join(here, "task-workspaces", BOT, THREAD), changed: true });
    expect(existsSync(join(here, "task-workspaces", BOT, THREAD))).toBe(true);
    expect(readdirSync(other).sort()).toEqual(before);
  });

  it("creates this data dir's own folder again when it was removed", () => {
    rmSync(join(here, "task-workspaces"), { recursive: true, force: true });
    expect(settle(join(here, "task-workspaces", BOT, THREAD))).toBeUndefined();
    expect(existsSync(join(here, "task-workspaces", BOT, THREAD))).toBe(true);
  });

  it("falls back to the chat's own folder for a picked folder that is gone, naming only the folder", () => {
    expect(settle(join(root, "moved-away"))).toEqual({ cwd: join(here, "task-workspaces", BOT, THREAD), changed: true, lost: "moved-away" });
    expect(settle(undefined, join(root, "moved-away"))).toMatchObject({ lost: "moved-away" });
  });

  it("refuses a picked folder inside another data dir", () => {
    const inOther = join(other, "projects");
    mkdirSync(inOther, { recursive: true });
    expect(foreignDataDir(inOther, here)).toBe(other);
    expect(settle(inOther)).toMatchObject({ cwd: join(here, "task-workspaces", BOT, THREAD), lost: "projects" });
    expect(validateBotCwd(inOther)).toEqual({ ok: false, error: expect.stringMatching(/another Metal/) });
  });

  it("keeps a picked folder that exists, no folder, and a chat not pinned yet", () => {
    expect(settle(picked)).toBeUndefined();
    expect(settle(null, join(root, "gone"))).toBeUndefined();
    expect(settle(undefined, picked)).toBeUndefined();
    expect(settle(undefined)).toBeUndefined();
  });

  it("never falls back for an engine that works in no folder", () => {
    expect(settleChatFolder({ stored: join(root, "gone"), botId: BOT, threadId: THREAD, dataDir: here, isBot, worksInFolders: false })).toBeUndefined();
  });
});

describe("rebaseStoredFolders", () => {
  it("rebases bots, chats and rooms and starts a moved chat's engine session afresh", () => {
    const bots = [{ cwd: join(other, "workspaces", BOT), tasks: [{ cwd: otherChat, resumeCursors: { claude: "s1" } }, { cwd: picked, resumeCursors: { claude: "s2" } }] }];
    expect(rebaseStoredFolders(bots, here, isBot)).toBe(true);
    expect(bots[0]).toMatchObject({ cwd: join(here, "workspaces", BOT), tasks: [{ cwd: join(here, "task-workspaces", BOT, THREAD), resumeCursors: {} }, { cwd: picked, resumeCursors: { claude: "s2" } }] });
    const rooms = [{ cwd: picked, pinnedCwd: join(other, "workspaces", BOT), tasks: [{ pinnedCwd: join(other, "workspaces", BOT) }] }];
    expect(rebaseStoredFolders(rooms, here, isBot)).toBe(true);
    expect(rooms[0]).toEqual({ cwd: picked, pinnedCwd: join(here, "workspaces", BOT), tasks: [{ pinnedCwd: join(here, "workspaces", BOT) }] });
    expect(rebaseStoredFolders(rooms, here, isBot)).toBe(false);
  });

  it("persists the rebased path when the store loads a copied bots.json", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const copied = structuredClone(store.bots);
    copied[0]!.tasks![0]!.cwd = join(other, "task-workspaces", bot.id, bot.threadId);
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(copied));
    const reloaded = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const want = join(DATA_DIR, "task-workspaces", bot.id, bot.threadId);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.cwd).toBe(want);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].tasks[0].cwd).toBe(want);
  });
});

describe("roomTurnFolder", () => {
  const member = join(here, "workspaces", BOT);

  it("runs a room whose picked folder is gone in the member's own folder and unpins the room once", () => {
    const repinned: Array<string | null> = [];
    expect(roomTurnFolder(join(root, "launch-site"), { dataDir: here, isBot, fallback: member, repin: (cwd) => repinned.push(cwd) }))
      .toEqual({ cwd: member, lost: "launch-site" });
    expect(repinned).toEqual([null]);
  });

  it("re-pins a room pinned to an own folder of another data dir", () => {
    const repinned: Array<string | null> = [];
    expect(roomTurnFolder(join(other, "workspaces", BOT), { dataDir: here, isBot, fallback: member, repin: (cwd) => repinned.push(cwd) })).toEqual({ cwd: member });
    expect(repinned).toEqual([member]);
  });

  it("keeps a room's folder that exists, and says plainly when there is no fallback", () => {
    expect(roomTurnFolder(picked, { dataDir: here, isBot, fallback: member, repin: () => { throw new Error("no repin"); } })).toEqual({ cwd: picked });
    const gone = join(root, "deep", "launch-site");
    expect(() => roomTurnFolder(gone, { dataDir: here, isBot, fallback: undefined, repin: () => {} }))
      .toThrow("This room's folder launch-site was moved or deleted. Pick a folder in the room's settings.");
  });
});

it("a spawn failure in a gone folder names the folder, never its full path", () => {
  const gone = join(root, "deep", "client-site");
  const failure = describeSpawnFailure(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), "claude", gone);
  expect(failure).toEqual({ message: "This bot's folder client-site was moved or deleted. Pick a folder in the bot's settings.", setup: false });
  expect(failure.message).not.toContain(root);
});
