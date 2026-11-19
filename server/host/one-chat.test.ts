import { describe, expect, it } from "vitest";
import { mainThread } from "../main-thread.ts";
import { Store } from "../store.ts";
import { createOneChat, storageOrder } from "./one-chat.ts";

function setup(options: { team?: boolean; confined?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "codex", model: "gpt-5.5" }));
  const asker = store.createBot({ name: "content" });
  const helper = store.createBot({ name: "Metal" });
  const main = store.bot(helper.id)!.threadId;
  const oneChat = createOneChat({
    store, team: options.team ?? false, confined: () => options.confined ?? false,
    mainThread: (botId, apart) => mainThread((store.bot(botId)?.tasks ?? []).filter((task) => !apart.has(task.threadId)), store.bot(botId)?.threadId),
  });
  return { store, asker, helper, main, oneChat };
}

describe("one chat per bot", () => {
  it("sends a teammate's message to the bot's own chat", () => {
    const { oneChat, asker, helper, main, store } = setup();
    const from = store.bot(asker.id)!.threadId;
    expect(oneChat.home(helper.id, from, "standing", new Set())?.threadId).toBe(main);
    expect(oneChat.home(helper.id, from, "new", new Set())?.threadId).toBe(main);
    expect(oneChat.home(helper.id, from, main, new Set())?.threadId).toBe(main);
  });

  it("keeps the old routing where the bot's chat waits on the sender's work, or another thread is named", () => {
    const { oneChat, asker, helper, main, store } = setup();
    const from = store.bot(asker.id)!.threadId;
    expect(oneChat.home(helper.id, from, "standing", new Set([main]))).toBeUndefined();
    expect(oneChat.home(helper.id, from, "some-other-thread", new Set())).toBeUndefined();
  });

  it("keeps the old thread where work from outside or a team's Cloud would reach the bot's own chat", () => {
    const outside = setup({ confined: true });
    expect(outside.oneChat.home(outside.helper.id, "from", "standing", new Set())).toBeUndefined();
    const team = setup({ team: true });
    expect(team.oneChat.home(team.helper.id, "from", "standing", new Set())).toBeUndefined();
  });

  it("folds an old work thread into the bot's chat by time, moves the asker's link and removes the thread", () => {
    const { store, asker, helper, main, oneChat } = setup();
    const askerThread = store.bot(asker.id)!.threadId, t0 = Date.now();
    store.appendMessage(main, { role: "user", kind: "text", text: "morning", at: t0 + 1_000 });
    store.appendMessage(main, { role: "bot", kind: "text", text: "hi", at: t0 + 1_500 });
    const work = store.createTask(helper.id, "@content · work", false, undefined, { botId: asker.id, name: "content", threadId: askerThread, kind: "work", at: t0 + 1_900 })!;
    const request = store.appendMessage(work.threadId, { role: "bot", kind: "text", text: "@Metal what is the plan?", from: { botId: asker.id, name: "content", color: "blue" }, roomRequest: { id: "r1", phase: "request" }, at: t0 + 2_000 });
    const reply = store.appendMessage(work.threadId, { role: "bot", kind: "text", text: "Ship on Friday", at: t0 + 2_500 });
    store.appendMessage(main, { role: "user", kind: "text", text: "later", at: t0 + 3_000 });
    const ref = store.appendMessage(askerThread, { role: "bot", kind: "activity", tool: { name: "Sent to Metal", ok: true }, threadRef: { botId: helper.id, threadId: work.threadId, title: "@content · work" } });

    expect(oneChat.fold({ inUse: () => false, apart: () => false })).toBe(1);

    expect(store.bot(helper.id)!.tasks!.map((task) => task.threadId)).toEqual([main]);
    expect(store.activePath(main).map((row) => row.text).slice(-5)).toEqual(["morning", "hi", "@Metal what is the plan?", "Ship on Friday", "later"]);
    expect(store.messagesFor(main).map((row) => row.id)).toEqual(expect.arrayContaining([request.id, reply.id]));
    expect(store.messagesFor(askerThread).find((row) => row.id === ref.id)?.threadRef?.threadId).toBe(main);
    expect(oneChat.fold({ inUse: () => false, apart: () => false })).toBe(0);
  });

  it("leaves a work thread that is still in use, or came from outside, for a later start", () => {
    const { store, asker, helper, oneChat } = setup();
    const opened = { botId: asker.id, name: "content", threadId: store.bot(asker.id)!.threadId, kind: "work" as const, at: 1 };
    const busy = store.createTask(helper.id, "@content · work", false, undefined, opened)!;
    const outside = store.createTask(helper.id, "@content · work", false, undefined, opened)!;
    store.patchTask(helper.id, outside.threadId, { outside: true });
    expect(oneChat.fold({ inUse: (threadId) => threadId === busy.threadId, apart: () => false })).toBe(0);
    expect(store.bot(helper.id)!.tasks!.map((task) => task.threadId)).toEqual(expect.arrayContaining([busy.threadId, outside.threadId]));
  });

  it("stores the visible path in order with other branches by time", () => {
    const row = (id: string, at: number, parentId: string | null) => ({ id, at, parentId, role: "bot" as const, kind: "text" as const, text: id });
    const rows = [row("a", 1, null), row("c", 3, "a"), row("b", 2, "a"), row("d", 4, "c")];
    expect(storageOrder(rows, "d").map((one) => one.id)).toEqual(["a", "b", "c", "d"]);
  });
});
