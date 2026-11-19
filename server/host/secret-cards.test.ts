import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { BotRecord, Message } from "../store.ts";
import { fileSavedSecretsKey, SavedSecretStore } from "../saved-secrets.ts";
import { createSecretCards } from "./secret-cards.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(language?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "dusk-secret-cards-"));
  dirs.push(dataDir);
  const lines: Message[] = [];
  let ids = 0;
  const store = {
    activePath: () => lines,
    messagesFor: () => lines,
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message;
      lines.push(full);
      return full;
    },
    patchMessage: () => null,
    botByThread: () => null,
    groupByThread: () => undefined,
    onChange: () => () => {},
  };
  const bot = { id: "ledger", name: "Ledger" } as BotRecord;
  const cards = createSecretCards({
    store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
    phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: {} as never,
    connectorThread: () => ({ bot, group: undefined }), answerCardNode: () => true, followCard: () => {}, dataDir,
    layerFolder: () => dataDir, turnVm: () => undefined, ...(language ? { threadLanguage: () => language } : {}),
  });
  return { cards, lines, bot };
}

describe("the card a bot asks for a key or secret with", () => {
  it("asks in the language of the conversation's person", () => {
    const { cards, lines, bot } = fixture("de");
    expect(cards.requestCredential(bot, "ledger-main", { credentialId: "xaiApiKey" }).status).toBe(201);
    expect(cards.requestCredential(bot, "ledger-main", { label: "Stripe-Testschlüssel", reason: "Für Testzahlungen.", delivery: "file" }).status).toBe(201);
    expect(lines.map((line) => line.text)).toEqual([
      "Gib xAI API key sicher in Metal auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
      "Gib Stripe-Testschlüssel sicher in Metal auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
    ]);
    expect(lines[0]!.secret!.description).toBe("Used by the built-in Grok provider. Ledger kann es verwenden, aber nie auslesen.");
    expect(lines[1]!.secret!.description)
      .toBe("Für Testzahlungen. Die Befehle von Ledger können es 24 Stunden lang aus einer privaten Datei lesen; es wird nie in den Chat übernommen.");
  });

  it("asks in English where no language is known", () => {
    const { cards, lines, bot } = fixture();
    cards.requestCredential(bot, "ledger-main", { label: "Notion token", reason: "For Notion's MCP server.", delivery: "ref" });
    expect(lines[0]!.text).toBe("Securely provide the Notion token from Metal on your phone or computer. It is never added to chat.");
    expect(lines[0]!.secret!.description).toBe("For Notion's MCP server. Ledger gets a one-use reference for Metal's own tools and never sees it.");
  });
});

describe("the mailbox card", () => {
  const PASSWORD = "fake-mailbox-password";
  const ACCOUNT = { address: "me@shop.example", imapHost: "imap.shop.example", smtpHost: "smtp.shop.example", connectedAt: "2026-11-04T00:00:00.000Z" };
  function mail(options: { refusal?: string; connected?: boolean; profile?: string; connect?: (request: Record<string, unknown>) => unknown } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "dusk-secret-cards-"));
    dirs.push(dataDir);
    const lines: Message[] = [];
    let ids = 0;
    const store = {
      activePath: () => lines,
      messagesFor: () => lines,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message; lines.push(full); return full; },
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
      botByThread: () => null, groupByThread: () => undefined, onChange: () => () => {},
    };
    const connects: Array<Record<string, unknown>> = [];
    const resumed: string[] = [];
    const bot = { id: "ledger", name: "Ledger" } as BotRecord;
    const cards = createSecretCards({
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
      phoneSecrets: { provide: async () => {}, open: async () => PASSWORD } as never, phoneSecretSubmissions: { has: () => false, run: async (_card: unknown, _op: unknown, work: () => Promise<void>) => work() } as never,
      connectorThread: () => ({ bot, group: undefined }), answerCardNode: (_thread, _id, text) => { resumed.push(text); return true; }, followCard: () => {}, dataDir,
      layerFolder: () => dataDir, turnVm: () => undefined,
      email: {
        connect: async (request) => { connects.push(request as never); return (options.connect?.(request as never) ?? { ok: true, account: ACCOUNT, inbox: { messages: 3 }, sending: { ok: true } }) as never; },
        refusal: () => options.refusal, connected: () => options.connected === true, profileAddress: () => options.profile,
      },
    });
    return { cards, lines, bot, connects, resumed };
  }
  const ask = (fixture: ReturnType<typeof mail>, body: Record<string, unknown> = {}) => fixture.cards.requestCredential(fixture.bot, "t1", { credentialId: "email", ...body });
  const card = (fixture: ReturnType<typeof mail>) => fixture.lines.findLast((line) => line.kind === "secret")!;

  it("is one card, which a phone shows as any secret, naming the address the bot knows", () => {
    const fixture = mail();
    expect(ask(fixture, { address: "me@shop.example", reason: "To read today's invoices." })).toMatchObject({ status: 201, body: { delivery: "email" } });
    expect(card(fixture).secret).toMatchObject({ target: "customSecret", delivery: "email", address: "me@shop.example", label: "Connect your mailbox", placeholder: "Mailbox password", helpUrl: "" });
    expect(card(fixture).secret!.description).toContain("To read today's invoices.");
    expect(card(fixture).secret!.description, "the footer says how it is kept, once").not.toContain("never sees");
  });

  it("names the person's own address when the bot knows none, and none at all when it can't", () => {
    const known = mail({ profile: "owner@shop.example" });
    ask(known);
    expect(card(known).secret!.address).toBe("owner@shop.example");
    const unknown = mail();
    ask(unknown, { address: "not an address" });
    expect(card(unknown).secret!.address).toBeUndefined();
  });

  it("doesn't ask again for a mailbox that works, and a newer card replaces an older one", () => {
    const working = mail({ connected: true });
    expect(ask(working, { address: "me@shop.example" })).toEqual({ status: 200, body: { alreadyConfigured: true, label: "me@shop.example" } });
    expect(working.lines).toEqual([]);
    const fixture = mail();
    ask(fixture);
    const first = card(fixture);
    ask(fixture);
    expect(first.secret!.superseded).toBe(true);
  });

  it("is refused where a place can't have mailboxes, in its words", () => {
    const fixture = mail({ refusal: "Email isn't on a Team Cloud yet." });
    expect(ask(fixture)).toEqual({ status: 403, body: { error: "Email isn't on a Team Cloud yet." } });
    expect(fixture.lines).toEqual([]);
  });

  it("a refused password leaves the card open with why; the right one connects and resumes the bot without it", async () => {
    let good = false;
    const fixture = mail({ connect: () => (good ? undefined : { ok: false, error: "The mail server did not accept this address and password." }) });
    ask(fixture, { address: "me@shop.example" });
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toEqual({ status: 400, body: { error: "The mail server did not accept this address and password." } });
    expect(card(fixture).secret).not.toMatchObject({ provided: true });
    expect(fixture.resumed).toEqual([]);
    good = true;
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toMatchObject({ status: 200, body: { provided: true, resumed: true } });
    expect(fixture.connects.at(-1)).toEqual({ address: "me@shop.example", password: PASSWORD });
    expect(card(fixture).secret).toMatchObject({ provided: true, resumed: true, address: "me@shop.example" });
    expect(fixture.resumed).toHaveLength(1);
    expect(fixture.resumed[0]).toContain("me@shop.example");
    expect(JSON.stringify([fixture.lines, fixture.resumed])).not.toContain(PASSWORD);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD }), "only once").toMatchObject({ status: 409 });
  });

  it("the address and the server the person types win, and asking for a server is passed on", async () => {
    const fixture = mail({ connect: (request) => (request.imapHost ? undefined : { ok: false, needsServer: true, error: "We couldn't find your mail server." }) });
    ask(fixture, { address: "wrong@shop.example" });
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example" })).toEqual({ status: 400, body: { error: "We couldn't find your mail server.", needsServer: true } });
    await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example", imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1", other: "ignored" });
    expect(fixture.connects.at(-1)).toEqual({ address: "me@shop.example", password: PASSWORD, imapHost: "post.example", imapPort: 993, smtpHost: "out.example", smtpPort: 587, username: "m1" });
  });

  it("needs an address and a password, and goes no further on a dismissed card", async () => {
    const fixture = mail();
    ask(fixture);
    const { id } = card(fixture);
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD })).toMatchObject({ status: 400 });
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: "", address: "me@shop.example" })).toMatchObject({ status: 400 });
    expect(fixture.connects).toEqual([]);
    card(fixture).secret!.dismissed = true;
    expect(await fixture.cards.saveEmailSecret("ledger", "t1", id, { value: PASSWORD, address: "me@shop.example" })).toMatchObject({ status: 409 });
    expect(fixture.connects).toEqual([]);
  });

  it("the bot hears that it may go on, or that the person declined, never a value", () => {
    const fixture = mail();
    ask(fixture, { address: "me@shop.example" });
    const secret = card(fixture).secret!;
    expect(fixture.cards.updateText(card(fixture).id, secret, "provided")).toContain("EMAIL_LIST_MESSAGES");
    expect(fixture.cards.updateText(card(fixture).id, secret, "dismissed")).toContain("chose not to connect a mailbox");
  });
});

describe("the login card", () => {
  const PASSWORD = "fake-Card!pass";
  function loginCards(options: { saved?: boolean } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "dusk-secret-cards-"));
    dirs.push(dataDir);
    const lines: Message[] = [];
    let ids = 0;
    const store = {
      activePath: () => lines,
      messagesFor: () => lines,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message; lines.push(full); return full; },
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
      botByThread: () => null, groupByThread: () => undefined, onChange: () => () => {},
    };
    const kept: Array<Record<string, unknown>> = [];
    const resumed: string[] = [];
    const bot = { id: "vaultie", name: "Vaultie" } as BotRecord;
    const cards = createSecretCards({
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
      phoneSecrets: { provide: async () => {}, open: async () => PASSWORD } as never, phoneSecretSubmissions: { has: () => false, run: async (_card: unknown, _op: unknown, work: () => Promise<void>) => work() } as never,
      connectorThread: () => ({ bot, group: undefined }), answerCardNode: (_thread, _id, text) => { resumed.push(text); return true; }, followCard: () => {}, dataDir,
      layerFolder: () => dataDir, turnVm: () => undefined,
      logins: { has: () => options.saved === true, keep: (login) => { kept.push(login); } },
    });
    return { cards, lines, kept, resumed, bot };
  }

  it("asks for a site's login on one card, keeps what is typed for fill_login, and tells the bot to fill it, never the password", () => {
    const { cards, lines, kept, resumed, bot } = loginCards();
    const asked = cards.requestCredential(bot, "t1", { credentialId: "login", site: "https://the-internet.herokuapp.com/login", reason: "To read the secure area." });
    expect(asked).toEqual({ status: 201, body: { messageId: "m1", site: "the-internet.herokuapp.com", delivery: "login" } });
    expect(lines[0]!.secret).toMatchObject({ delivery: "login", site: "the-internet.herokuapp.com", label: "the-internet.herokuapp.com" });
    expect(lines[0]!.secret!.reason, "the footer says how it is kept, once").toBe("To read the secure area.");
    const saved = cards.saveLoginSecret(bot.id, "t1", "m1", { username: "tomsmith", value: JSON.stringify({ password: PASSWORD, totp: "" }) }, true);
    expect(saved.status).toBe(200);
    expect(kept).toEqual([{ botId: "vaultie", host: "the-internet.herokuapp.com", username: "tomsmith", password: PASSWORD, totp: null, remember: true }]);
    expect(lines[0]!.secret).toMatchObject({ kept: "vault" });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain("call fill_login");
    expect(resumed[0]).toContain("saved it to their Vault");
    for (const text of [JSON.stringify(lines), ...resumed, JSON.stringify(saved.body)]) expect(text).not.toContain(PASSWORD);
  });

  it("keeps a login given with Save to Vault off for this task only, and takes a 2FA key", () => {
    const { cards, lines, kept, resumed, bot } = loginCards();
    cards.requestCredential(bot, "t1", { credentialId: "login", site: "example.com" });
    expect(cards.saveLoginSecret(bot.id, "t1", "m1", { username: "me", value: JSON.stringify({ password: PASSWORD, totp: "JBSWY3DPEHPK3PXP" }) }, false).status).toBe(200);
    expect(kept[0]).toMatchObject({ remember: false, totp: { secret: "JBSWY3DPEHPK3PXP" } });
    expect(lines[0]!.secret!.kept).toBe("once");
    expect(resumed[0]).toContain("for this task only");
  });

  it("refuses an empty password and a second answer, and needs no card when a login is saved already", () => {
    const { cards, bot } = loginCards();
    cards.requestCredential(bot, "t1", { credentialId: "login", site: "example.com" });
    expect(cards.saveLoginSecret(bot.id, "t1", "m1", { username: "me", value: JSON.stringify({ password: "" }) }, true).status).toBe(400);
    expect(cards.saveLoginSecret(bot.id, "t1", "m1", { username: "me", value: JSON.stringify({ password: PASSWORD }) }, true).status).toBe(200);
    expect(cards.saveLoginSecret(bot.id, "t1", "m1", { username: "me", value: JSON.stringify({ password: PASSWORD }) }, true).status).toBe(409);
    const known = loginCards({ saved: true });
    const answer = known.cards.requestCredential(known.bot, "t1", { credentialId: "login", site: "example.com" });
    expect(answer.status).toBe(200);
    expect(String(answer.body.text)).toContain("call fill_login");
    expect(known.lines).toHaveLength(0);
    expect(cards.requestCredential(bot, "t1", { credentialId: "login", site: "javascript:alert(1)" }).status).toBe(400);
  });

  it("tells the bot what to do when the person declines", () => {
    const { cards, resumed, bot } = loginCards();
    cards.requestCredential(bot, "t1", { credentialId: "login", site: "example.com" });
    cards.resumeSecretCard(bot.id, "t1", "m1", "dismissed");
    expect(resumed[0]).toContain("declined to give their login for example.com");
    expect(resumed[0]).toContain("request_sign_in");
  });
});

describe("a Vault secret the service refused", () => {
  const VALUE = "sk-fake-vault-canary";
  function vaultCards() {
    const dataDir = mkdtempSync(join(tmpdir(), "dusk-secret-cards-"));
    const keyHome = mkdtempSync(join(tmpdir(), "dusk-secret-key-"));
    dirs.push(dataDir, keyHome);
    const savedSecrets = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, join(keyHome, "saved.key")) });
    const lines: Message[] = [];
    let ids = 0;
    const store = {
      activePath: () => lines,
      messagesFor: () => lines,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message; lines.push(full); return full; },
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
      botByThread: () => null, groupByThread: () => undefined, onChange: () => () => {},
    };
    const bot = { id: "ledger", name: "Ledger" } as BotRecord;
    const cards = createSecretCards({
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
      phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: {} as never,
      connectorThread: () => ({ bot, group: undefined }), answerCardNode: () => true, followCard: () => {}, dataDir,
      layerFolder: () => dataDir, turnVm: () => undefined, savedSecrets,
      logins: { has: () => false, keep: () => {} },
    });
    savedSecrets.save({ label: "Stripe key", botId: bot.id, value: VALUE });
    const ask = (extra: Record<string, unknown> = {}) => cards.requestCredential(bot, "t1", { label: "Stripe key", reason: "For Stripe.", delivery: "ref", ...extra });
    return { cards, lines, bot, savedSecrets, ask };
  }

  it("removes it on a clear auth failure, and tells the person once on a fresh card", () => {
    const { lines, savedSecrets, ask } = vaultCards();
    expect(ask().body.fromVault).toBe(true);
    const failed = ask({ failed: "HTTP 401 Unauthorized: Invalid API key provided" });
    expect(failed.status).toBe(201);
    expect(failed.body.vault).toBe("removed");
    expect(savedSecrets.list()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.secret!.reason).toBe("That Stripe key didn't work, so I removed it. Add it again?");
    expect(JSON.stringify([lines, failed.body])).not.toContain(VALUE);
    // gone, so asking again is a plain card with no second note
    const again = ask({ failed: "HTTP 401" });
    expect(again.body.vault).toBeUndefined();
    expect(lines[1]!.secret!.reason).toBe("For Stripe.");
  });

  it("keeps it on a rate limit or a network fault, with no card", () => {
    const { lines, savedSecrets, ask } = vaultCards();
    ask();
    for (const failed of ["429 Too Many Requests", "fetch failed: ECONNRESET", "503 Service Unavailable"]) {
      const answer = ask({ failed });
      expect(answer.status).toBe(200);
      expect(String(answer.body.text)).toContain("stays saved");
    }
    expect(lines).toHaveLength(0);
    expect(savedSecrets.list()[0]!.needsCheck).toBeUndefined();
  });

  it("only marks it to check, and asks once, when unsure or when it was never handed out here", () => {
    const { lines, savedSecrets, ask } = vaultCards();
    // never used in this conversation: even a 401 cannot prove it is the saved one that failed
    const unproven = ask({ failed: "401 Unauthorized" });
    expect(unproven.body.vault).toBe("flagged");
    expect(savedSecrets.list()).toHaveLength(1);
    expect(savedSecrets.list()[0]!.needsCheck).toBeTypeOf("number");
    expect(lines[0]!.secret!.reason).toBe("That Stripe key might not be working. Add a new one?");
    const twice = ask({ failed: "403 Forbidden" });
    expect(twice.status).toBe(200);
    expect(String(twice.body.text)).toContain("already marked");
    expect(lines).toHaveLength(1);
  });

  it("clears the mark when a new value is saved", () => {
    const { savedSecrets, ask, bot } = vaultCards();
    ask({ failed: "403 Forbidden" });
    savedSecrets.save({ label: "Stripe key", botId: bot.id, value: "sk-fake-new" });
    expect(savedSecrets.list()[0]!.needsCheck).toBeUndefined();
  });

  it("re-shows a login card with one line when a saved login was removed or marked", () => {
    const { cards, lines, bot } = vaultCards();
    const told = cards.loginRejected(bot.id, "t1", { site: "instagram.com", host: "www.instagram.com", change: "removed" });
    expect(told).toContain("removed it from the Vault");
    expect(lines[0]!.secret).toMatchObject({ delivery: "login", site: "www.instagram.com", label: "instagram.com", reason: "That instagram.com password didn't work, so I removed it. Add it again?" });
    cards.loginRejected(bot.id, "t1", { site: "instagram.com", host: "www.instagram.com", change: "flagged" });
    expect(lines[0]!.secret!.superseded).toBe(true);
    expect(lines[1]!.secret!.reason).toBe("That instagram.com login might not be working. Add a new one?");
    expect(cards.loginRejected(bot.id, "t1", null)).toBeNull();
    expect(lines).toHaveLength(2);
  });
});

describe("a secret the person already gave", () => {
  const NITTER = "nk_fake0123456789abcdef";
  function cardsWith(history: Message[], vaulted?: { label: string; value: string }) {
    const dataDir = mkdtempSync(join(tmpdir(), "dusk-secret-cards-"));
    const keyHome = mkdtempSync(join(tmpdir(), "dusk-secret-key-"));
    dirs.push(dataDir, keyHome);
    const savedSecrets = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, join(keyHome, "saved.key")) });
    const lines: Message[] = [...history];
    let ids = 0;
    const store = {
      activePath: () => lines,
      messagesFor: () => lines,
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => { const full = { id: `c${++ids}`, at: Date.now(), ...message } as Message; lines.push(full); return full; },
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id)!; Object.assign(line, patch); return line; },
      botByThread: () => null, groupByThread: () => undefined, onChange: () => () => {},
    };
    const bot = { id: "ledger", name: "Ledger" } as BotRecord;
    const cards = createSecretCards({
      store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
      phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: {} as never,
      connectorThread: () => ({ bot, group: undefined }), answerCardNode: () => true, followCard: () => {}, dataDir,
      layerFolder: () => dataDir, turnVm: () => undefined, savedSecrets,
    });
    if (vaulted) savedSecrets.save({ ...vaulted, botId: bot.id });
    const ask = (label: string) => cards.requestCredential(bot, "t1", { label, reason: "To verify access.", delivery: "ref" });
    return { lines, savedSecrets, ask };
  }
  const chat = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({
    id: `h${index}`, at: index, kind: "text", role: index % 2 ? "bot" : "user", text: index % 2 ? "Done." : `Step ${index}, carry on.`,
  }) as Message);
  const secretCards = (lines: Message[]) => lines.filter((line) => line.kind === "secret");

  it("takes NITTER_KEY pasted 20+ messages back for a card labelled Nitter access key, with no card", () => {
    const pasted = { id: "p", at: 0, kind: "text", role: "user", text: `here are my keys\nNITTER_URL=https://nitter.example.test\nNITTER_KEY=${NITTER}` } as Message;
    const { lines, savedSecrets, ask } = cardsWith([pasted, ...chat(44)]);
    const answer = ask("Nitter access key");
    expect(answer).toMatchObject({ status: 200, body: { fromMessage: true, vault: "saved" } });
    expect(String(answer.body.text)).not.toContain(NITTER);
    expect(secretCards(lines)).toEqual([]);
    expect(savedSecrets.find("Nitter access key", "ledger")?.value).toBe(NITTER);
  });

  it("uses a Vault secret saved under another wording of the same name, with no card", () => {
    const { lines, ask } = cardsWith(chat(4), { label: "NITTER_KEY", value: NITTER });
    expect(ask("Nitter access key")).toMatchObject({ status: 200, body: { fromVault: true } });
    expect(secretCards(lines)).toEqual([]);
  });

  it("still asks on a card when nothing like it was given, and never takes a bot's text or a placeholder", () => {
    const misleading = [
      { id: "b", at: 0, kind: "text", role: "bot", text: `Set NITTER_KEY=${NITTER} like this` },
      { id: "u", at: 1, kind: "text", role: "user", text: "NITTER_URL=https://nitter.example.test\nNITTER_KEY=<your key>" },
    ] as Message[];
    const { lines, ask } = cardsWith(misleading);
    expect(ask("Nitter access key").status).toBe(201);
    expect(secretCards(lines)).toHaveLength(1);
  });
});
