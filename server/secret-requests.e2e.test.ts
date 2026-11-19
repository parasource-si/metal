// A real Cloud home and its agents tools: a bot asks for two secrets Metal does not keep, the person types each
// into its card, and the bot uses them. Each recognisable value is then searched for in everything the server wrote (the
// data folder, its events, transcripts, usage spans and logs), every answer it gave, every tool result and its own log.
// The file secret is found only in its private file; the ref secret only in the MCP server settings it was saved into.
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudHomeConfiguration, cloudPairingSignature } from "./cloud-home.ts";
import { cloudHomeChildEnvironments, spawnWithSecrets } from "./cloud-home-start.ts";
import { sealCardSecret } from "../src/lib/card-seal.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "dusk-t-5ec2e7f1a0b9.fly.dev";
const FILE_CANARY = `sk_test_FILECANARY${randomBytes(12).toString("hex")}`;
const REF_CANARY = `ntn_REFCANARY${randomBytes(12).toString("hex")}`;
const VAULT_CANARY = `or_VAULTCANARY${randomBytes(12).toString("hex")}`;
const bootstrap = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
const said: string[] = [];
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(owner ? { authorization: `Bearer ${owner}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  said.push(text);
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed };
}

async function pairOwner(): Promise<string> {
  const body = JSON.stringify({ label: "Metal app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-dusk-cloud-timestamp": timestamp, "x-dusk-cloud-nonce": nonce, "x-dusk-cloud-signature": `v1=${cloudPairingSignature(bootstrap, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { code: granted.code });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

async function proxyFor(start: () => Promise<void>) {
  const dump = join(home, "spawn.json");
  rmSync(dump, { force: true });
  await start();
  let agents: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    try { agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents; return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
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
  return {
    call: async (name: string, args: unknown = {}) => {
      const result = await request("tools/call", { name, arguments: args });
      said.push(JSON.stringify(result));
      return { text: String(result.content?.[0]?.text ?? ""), isError: result.isError === true };
    },
    list: () => request("tools/list", {}),
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dusk-secret-requests-"));
  const dataDir = join(home, ".duskbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const contract = { DUSK_CLOUD_ROLE: "home", DUSK_CLOUD_MACHINE_ID: "7d1c3b5a-2e4f-4a6b-8c9d-0e1f2a3b4c5d", DUSK_CLOUD_ADMIN_URL: "https://cloud.example.test",
    DUSK_CLOUD_BOOTSTRAP_SECRET: bootstrap, DUSK_PUBLIC_URL: `https://${HOST}` };
  const imageEnv = { PATH: process.env.PATH, DUSK_DUCKDB_DIR: join(home, "empty-tree"), ...contract };
  const { server, secrets } = cloudHomeChildEnvironments(cloudHomeConfiguration(imageEnv)!, imageEnv, home);
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawnWithSecrets(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    ...server, DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1), USERPROFILE: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }, secrets, null, true);
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await pairOwner();
}, hostTimeout(30_000));

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

/** Every file under `root` that holds `needle`, as a path from `root`; links are not followed. */
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

it("keeps a file secret and a ref secret out of every record, and the bot uses each once", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Ledger", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const tools = await proxyFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Set up Stripe test charges and Notion's MCP." })).status).toBe(202);
  });
  const listed = (await tools.list()).tools.find((tool: any) => tool.name === "request_credential");
  expect(Object.keys(listed.inputSchema.properties)).toEqual(["credential_id", "address", "site", "label", "reason", "placeholder", "delivery", "failed", "pasted_as"]);
  expect(listed.inputSchema.properties.credential_id.enum).toEqual(expect.arrayContaining(["composioApiKey", "openaiApiKey", "anthropicApiKey"]));
  const cards = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.filter((message: any) => message.kind === "secret");
  // Through a relay the app seals the value for this server first: the request never carries it in the clear.
  const save = async (cardId: string, value: string, remember = false) => {
    const path = `/api/bots/${bot.id}/secret-cards/${cardId}/save`;
    const prepared = await api("POST", path, { threadId: bot.threadId, prepare: true });
    if (prepared.status !== 200) return prepared;
    const card = (await cards()).find((message: any) => message.id === cardId);
    const sealed = await sealCardSecret(value, prepared.body.sealKey, { botId: bot.id, threadId: bot.threadId, messageId: cardId, requestKey: card.secret.requestKey, remember });
    return api("POST", path, { threadId: bot.threadId, sealed, remember });
  };

  // A file for the bot's own commands.
  expect((await tools.call("request_credential", { label: "Stripe secret key", reason: "To create test charges." })).text).toMatch(/needs delivery/u);
  const askedFile = await tools.call("request_credential", { label: "Stripe secret key", reason: "To create test charges.", placeholder: "sk_test_…", delivery: "file" });
  expect(askedFile).toEqual({ isError: false, text: expect.stringMatching(/^A secure card for Stripe secret key is now in this conversation/u) });
  const fileCard = (await cards()).at(-1);
  expect(fileCard.secret).toMatchObject({ target: "customSecret", label: "Stripe secret key", placeholder: "sk_test_…", helpUrl: "", delivery: "file", reason: "To create test charges." });
  expect(fileCard.secret.description).toBe("To create test charges. Ledger's commands can read it from a private file for 24 hours; it is never added to chat.");
  expect(await api("POST", `/api/bots/${bot.id}/secret-cards/${fileCard.id}/save`, { threadId: bot.threadId, value: "" })).toMatchObject({ status: 400, body: { code: "seal_required" } });
  expect(await save(fileCard.id, FILE_CANARY)).toMatchObject({ status: 200, body: { provided: true } });
  expect(await save(fileCard.id, FILE_CANARY)).toMatchObject({ status: 409, body: { error: "this secret was already saved" } });
  const fileText = (await tools.call("request_credential", { label: "Stripe secret key", reason: "To create test charges.", delivery: "file" })).text;
  const secretFile = join(home, ".duskbot", "workspaces", bot.id, ".duskbot-secrets", bot.threadId, fileCard.id);
  expect(fileText).toContain(`saved Stripe secret key to the file ${secretFile}`);
  expect(fileText).toContain("never print, echo, log or copy it anywhere else");
  expect(readFileSync(secretFile, "utf8")).toBe(FILE_CANARY);
  expect(statSync(secretFile).mode & 0o777).toBe(0o600);

  // A one-use secretRef for mcp_server.
  await tools.call("request_credential", { label: "Notion key", reason: "For Notion's MCP server.", delivery: "ref" });
  const refCard = (await cards()).at(-1);
  expect(refCard.secret.description).toBe("For Notion's MCP server. Ledger gets a one-use reference for Metal's own tools and never sees it.");
  expect(await save(refCard.id, REF_CANARY)).toMatchObject({ status: 200, body: { provided: true } });
  const refText = (await tools.call("request_credential", { label: "Notion key", reason: "For Notion's MCP server.", delivery: "ref" })).text;
  const ref = /secret-ref:[0-9a-f]{32}/u.exec(refText)?.[0];
  expect(ref, refText).toBeDefined();
  // The person agreed to Metal's tools only: a file needs a new card.
  const asFile = await tools.call("request_credential", { label: "Notion key", reason: "For a script.", delivery: "file" });
  expect(asFile.text).toContain("not as a file for your commands (not a file request), so this card asks for it again");
  expect((await cards()).at(-1).secret).toMatchObject({ label: "Notion key", delivery: "file" });

  const added = await tools.call("mcp_server", { action: "add", name: "notion", url: "https://mcp.notion.test/mcp", headers: { Authorization: `Bearer ${ref}`, "Notion-Version": "2022-06-28" } });
  expect(added).toEqual({ isError: false, text: expect.stringMatching(/^Added MCP server notion and turned it on\. Test: /u) });
  const config = JSON.parse(readFileSync(join(home, ".duskbot", "config.json"), "utf8"));
  expect(config.mcpServers.notion.headers).toEqual({ Authorization: `Bearer ${REF_CANARY}`, "Notion-Version": "2022-06-28" });
  const reused = await tools.call("mcp_server", { action: "add", name: "notion2", url: "https://mcp.notion.test/mcp", headers: { Authorization: `Bearer ${ref}` } });
  expect(reused).toEqual({ isError: true, text: `${ref} was already used: each secretRef works once. Ask again with request_credential.` });
  const pathAsRef = await tools.call("mcp_server", { action: "add", name: "stripe", command: "npx", env: { STRIPE_SECRET_KEY: secretFile } });
  expect(pathAsRef.isError).toBe(true);
  expect(pathAsRef.text).toMatch(/^That is a secret file for your own commands, not a secretRef/u);

  // Saved to the Vault: the same bot gets it again without a card, Settings lists it by label only, and Remove forgets it.
  await tools.call("request_credential", { label: "OpenRouter API key", reason: "To call OpenRouter models.", delivery: "file" });
  const vaultCard = (await cards()).at(-1);
  expect(await api("POST", `/api/bots/${bot.id}/secret-cards/${vaultCard.id}/save`, { threadId: bot.threadId, value: VAULT_CANARY })).toMatchObject({ status: 400, body: { code: "seal_required" } });
  expect(await save(vaultCard.id, VAULT_CANARY, true)).toMatchObject({ status: 200, body: { provided: true } });
  expect((await cards()).at(-1).secret).toMatchObject({ label: "OpenRouter API key", kept: "vault" });
  const before = (await cards()).length;
  const again = await tools.call("request_credential", { label: "openrouter api key", reason: "Again.", delivery: "ref" });
  expect(again.text).toMatch(/^OpenRouter API key is saved in the person's Vault, so no card was needed\. It is here as secret-ref:[0-9a-f]{32}\./u);
  expect((await cards()).length).toBe(before);
  const vaultList = await api("GET", "/api/saved-secrets");
  expect(vaultList).toMatchObject({ status: 200, body: { secrets: [{ label: "OpenRouter API key", bots: [bot.id] }] } });
  expect(Object.keys(vaultList.body.secrets[0]).sort()).toEqual(["bots", "createdAt", "id", "label", "lastUsedAt", "updatedAt"]);
  expect(await api("DELETE", `/api/saved-secrets/${vaultList.body.secrets[0].id}`)).toMatchObject({ status: 200, body: { removed: true } });
  expect((await api("GET", "/api/saved-secrets")).body.secrets).toEqual([]);
  expect((await tools.call("request_credential", { label: "OpenRouter API key", reason: "Once more.", delivery: "ref" })).text).toMatch(/^A secure card for OpenRouter API key/u);
  const vaultFile = join(home, ".duskbot", "workspaces", bot.id, ".duskbot-secrets", bot.threadId, vaultCard.id);

  // A bot that disobeys and writes a value into its memory still leaves it out of every record.
  expect((await tools.call("memory_update", { action: "append", text: `Stripe test key: ${FILE_CANARY}` })).isError).toBe(false);

  // Only the secret file holds one value, and only the MCP server's settings the other.
  expect(filesHolding(home, FILE_CANARY)).toEqual([relative(home, secretFile)]);
  expect(filesHolding(home, REF_CANARY)).toEqual([join(".duskbot", "config.json")]);
  // the Vault kept it sealed (and has since forgotten it): only the card's own private file ever held it in the clear
  expect(filesHolding(home, VAULT_CANARY)).toEqual([relative(home, vaultFile)]);
  for (const where of [...said, log]) {
    expect(where).not.toContain(FILE_CANARY);
    expect(where).not.toContain(REF_CANARY);
    expect(where).not.toContain(VAULT_CANARY);
  }
}, hostTimeout(60_000));

it("takes a value the person pasted in chat straight to the Vault with no card, and still asks for one they did not", async () => {
  const PASTED = `xa_PASTEDCANARY${randomBytes(12).toString("hex")}`;
  const bot = (await api("POST", "/api/bots", { name: "Rigger", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const tools = await proxyFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `Connect xactions for me.\nNITTER_URL=https://nitter.example.test\nXACTIONS_TOKEN=${PASTED}` })).status).toBe(202);
  });
  const cards = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.filter((message: any) => message.kind === "secret");

  const took = await tools.call("request_credential", { label: "xactions token", reason: "For the xactions MCP server.", delivery: "ref", pasted_as: "XACTIONS_TOKEN" });
  expect(took.isError).toBe(false);
  expect(took.text).toMatch(/^Metal took xactions token from the person's own message, so no card was needed, and saved it to their Vault\./u);
  expect(took.text).toContain("Continue the task.");
  expect(took.text).not.toContain(PASTED);
  expect(await cards()).toEqual([]);
  expect((await api("GET", "/api/saved-secrets")).body.secrets).toEqual(expect.arrayContaining([expect.objectContaining({ label: "xactions token", bots: [bot.id] })]));

  // the turn goes on: the ref works in mcp_server
  const ref = /secret-ref:[0-9a-f]{32}/u.exec(took.text)?.[0];
  expect(ref, took.text).toBeDefined();
  const added = await tools.call("mcp_server", { action: "add", name: "xactions", url: "https://xactions.example.test/mcp", headers: { Authorization: `Bearer ${ref}` } });
  expect(added.isError, added.text).toBe(false);
  expect(JSON.parse(readFileSync(join(home, ".duskbot", "config.json"), "utf8")).mcpServers.xactions.headers).toEqual({ Authorization: `Bearer ${PASTED}` });

  // nothing pasted under that name: the secure card, as before
  const asked = await tools.call("request_credential", { label: "Hindsight token", reason: "For Hindsight memory.", delivery: "ref" });
  expect(asked.text).toMatch(/^A secure card for Hindsight token is now in this conversation/u);
  expect((await cards()).map((card: any) => card.secret.label)).toEqual(["Hindsight token"]);

  for (const where of [...said.filter((text) => !text.includes("Connect xactions for me.")), log]) expect(where).not.toContain(PASTED);
}, hostTimeout(60_000));
