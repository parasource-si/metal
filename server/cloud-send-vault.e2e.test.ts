// The whole Vault moves to the person's own Cloud: saved logins with their passwords and 2FA keys, 1Password, the
// secrets saved to the Vault from a bot's card, and a card's file secret, each sealed for My Cloud's server and kept there
// under its own key. This computer's server and a Cloud home (scripts/testing/cloud-send-fixture.ts) with main's own
// wiring between them; disposable homes, no network, obvious fakes only.
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cardFileKey, vaultSecretKey } from "../electron/cloud-send.mjs";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const TOKEN = `ops_fake-vault-${hex(12)}`;
const PASSWORD = `fake-vault-Passw0rd-${hex(6)}`;
const TOTP = "JBSWY3DPEHPK3PXP";
const FILE_SECRET = `sk_test_fake_file_${hex(12)}`;
const REF_SECRET = `fake-notion-key-${hex(12)}`;
const SECRETS = [TOKEN, PASSWORD, FILE_SECRET, REF_SECRET];

let fx: CloudSendFixture;
let scratch = "";
let release = "";
const proxies: ChildProcess[] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "dusk-vault-move-"));
  release = join(scratch, "release");
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN,
    desktopEngine: `if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(release)}; process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(scratch, "spawn.json"))}; }` });
}, hostTimeout(90_000));
afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await fx?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** The bot's own Metal tools, as its turn reaches them: the MCP proxy the turn was started with. */
async function botTools(home: string) {
  let agents: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    try { agents = JSON.parse(readFileSync(join(scratch, "spawn.json"), "utf8")).mcpConfig.mcpServers.agents; return true; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
  const proxy = spawn(agents!.command, agents!.args, { env: { PATH: process.env.PATH, HOME: home, ...agents!.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return { call: async (name: string, args: unknown) => String((await request("tools/call", { name, arguments: args })).content?.[0]?.text ?? "") };
}

/** Every file under `root` holding `needle`, as a path from `root`. */
function filesHolding(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile() && readFileSync(path).includes(needle)) found.push(relative(root, path));
    }
  };
  walk(root);
  return found;
}

it("moves every Vault item with its value, sealed, and no value shows anywhere on the way", async () => {
  const { local, onCloud } = fx;
  const bot = (await local("POST", "/api/bots", { name: "Vera", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect((await local("PATCH", `/api/bots/${bot.id}`, { soul: "You are Vera." })).status).toBe(200);
  expect((await local("POST", "/api/logins", { site: "accounts.example.test", username: "alice", password: PASSWORD, totp: TOTP, bots: [bot.id] })).status).toBe(201);
  expect((await local("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);

  // The bot asks on two cards: a file for its own commands, and a ref for Metal's tools; the person saves both to the Vault.
  expect((await local("POST", `/api/bots/${bot.id}/messages`, { text: "Set up Stripe test charges and Notion's MCP." })).status).toBe(202);
  const tools = await botTools(join(fx.root, "desktop"));
  const cards = async () => (await local("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.filter((message: any) => message.kind === "secret");
  await tools.call("request_credential", { label: "Stripe secret key", reason: "To create test charges.", delivery: "file" });
  const fileCard = (await cards()).at(-1);
  expect((await local("POST", `/api/bots/${bot.id}/secret-cards/${fileCard.id}/save`, { threadId: bot.threadId, value: FILE_SECRET, remember: true })).status).toBe(200);
  await tools.call("request_credential", { label: "Notion key", reason: "For Notion's MCP server.", delivery: "ref" });
  const refCard = (await cards()).at(-1);
  expect(refCard.id).not.toBe(fileCard.id);
  expect((await local("POST", `/api/bots/${bot.id}/secret-cards/${refCard.id}/save`, { threadId: bot.threadId, value: REF_SECRET, remember: true })).status).toBe(200);
  expect((await local("GET", "/api/saved-secrets")).body.secrets.map((secret: { label: string }) => secret.label)).toEqual(["Notion key", "Stripe secret key"]);
  const desktopFiles = join(fx.root, "desktop", ".duskbot");
  const fileHere = filesHolding(desktopFiles, FILE_SECRET);
  expect(fileHere).toEqual([expect.stringMatching(new RegExp(`\\.duskbot-secrets/${bot.threadId}/${fileCard.id}$`, "u"))]);
  writeFileSync(release, "");
  await expect.poll(async () => (await local("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy),
    { timeout: 30_000, interval: 200 }).toBe(true);

  const moved = await fx.move();
  expect(moved.result.failed).toEqual([]);
  const final = await fx.move({ final: true });
  expect(final.result.failed).toEqual([]);

  // My Cloud holds each one, as the check proves by fingerprints on both sides.
  const report = await fx.check();
  expect(report.secrets.missing).toEqual([]);
  expect(report.secrets.differs).toEqual([]);
  expect(report.secrets.equal).toEqual(expect.arrayContaining([itemKey.login("example.test", "alice"), "1password",
    vaultSecretKey("Stripe secret key"), vaultSecretKey("Notion key"), cardFileKey({ bot: bot.id, thread: bot.threadId, card: fileCard.id })]));
  expect(report.ok).toBe(true);

  // And reads them as its own: the Vault's labels for the same bot, the login with its 2FA, the card's file in the bot's folder.
  const vault = (await onCloud("GET", "/api/saved-secrets")).body.secrets;
  expect(vault.map((secret: { label: string; bots: string[] }) => [secret.label, secret.bots])).toEqual([["Notion key", [bot.id]], ["Stripe secret key", [bot.id]]]);
  const logins = (await onCloud("GET", "/api/logins")).body;
  expect(JSON.stringify(logins)).toContain("alice");
  const cloudData = join(fx.root, "cloud", ".duskbot");
  expect(filesHolding(cloudData, FILE_SECRET)).toEqual([expect.stringMatching(new RegExp(`^workspaces/.*\\.duskbot-secrets/${bot.threadId}/${fileCard.id}$`, "u"))]);
  const kept = join(cloudData, filesHolding(cloudData, FILE_SECRET)[0]!);
  expect(readFileSync(kept, "utf8")).toBe(FILE_SECRET);
  expect(lstatSync(kept).mode & 0o777).toBe(0o600);
  // Sealed at rest on My Cloud: no other file there holds a value in the clear.
  for (const value of [PASSWORD, REF_SECRET, TOKEN]) expect(filesHolding(cloudData, value)).toEqual([]);
  expect(existsSync(join(cloudData, "saved-secrets.json.enc"))).toBe(true);

  // Nothing either server answered, nor any log line, ever held a value.
  for (const where of [...fx.answers, fx.logs()]) for (const value of SECRETS) expect(where).not.toContain(value);
}, hostTimeout(300_000));

it("refuses a Vault item sent to My Cloud in the clear", async () => {
  const bot = (await fx.onCloud("GET", "/api/bots?messages=0")).body.bots.find((entry: { name: string }) => entry.name === "Vera");
  const plain = await fx.onCloud("POST", "/api/cloud-send/vault/secret", { label: "Plain", bots: [bot.id], value: "fake-plain-value" });
  expect(plain.status).toBe(400);
  const unsealed = await fx.onCloud("POST", "/api/cloud-send/vault/secret", { label: "Plain", bots: [bot.id], sealed: { not: "sealed" } });
  expect(unsealed.status).toBe(400);
  expect((await fx.onCloud("GET", "/api/saved-secrets")).body.secrets.map((secret: { label: string }) => secret.label)).not.toContain("Plain");
});
