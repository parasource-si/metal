// "Let my cloud bots use this Mac", two processes: a real server booted as a dusk cloud home (behind a stand-in edge's
// headers, its link key in its data folder) and the Mac app's own core (electron/cloud-mac.mjs) signed in with the
// Admin's pairing, as the app is. A scripted engine calls the device server's mac_ tools from a bot's turn.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createCloudMac } from "../electron/cloud-mac.mjs";
import { macLogFile } from "../electron/mac-control-tools.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "dusk-t-0123456789ab.fly.dev";
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
const secret = randomBytes(32).toString("base64url");
const link = generateKeyPairSync("ed25519");
let root = "", home = "", dataDir = "", calls = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;
let app: ReturnType<typeof createCloudMac> | undefined;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...EDGE, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dusk-cloud-mac-e2e-"));
  dataDir = join(root, "cloud");
  home = realpathSync(mkdtempSync(join(tmpdir(), "dusk-cloud-mac-e2e-home-")));
  calls = join(root, "calls.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(calls, "[]");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ features: { smartSetupChoices: false }, instances: {
    claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") }, environment: { FAKE_CLAUDE_TOOL_CALLS_FILE: calls } },
  } }));
  writeFileSync(join(dataDir, "dashboard-link.json"), JSON.stringify({ v: 1, url: "https://cloud.example.test", workspaceId: "w1",
    publicKey: link.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: link.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), enrolledAt: Date.now(), claimed: true }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--experimental-strip-types", "--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: { PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, TMPDIR: root, DUSK_DATA_DIR: dataDir, DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1),
      DUSK_TEST_SEALED_PATH: "1", DUSK_NO_TEST_BOTS: "1", FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: join(root, "dump.json"),
      DUSK_CLOUD_ROLE: "home", DUSK_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", DUSK_CLOUD_ADMIN_URL: "https://cloud.example.test",
      DUSK_CLOUD_BOOTSTRAP_SECRET: secret, DUSK_PUBLIC_URL: `https://${HOST}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  await until(async () => {
    if (child!.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, "the cloud to start");
  // the Admin's signed pairing, as the app's pairHome() gets it, then the app's own sign-in
  const body = JSON.stringify({ label: "Metal app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
    "x-dusk-cloud-timestamp": timestamp, "x-dusk-cloud-nonce": nonce, "x-dusk-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body })).json() as { code: string };
  token = (await (await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: granted.code }) })).json() as { token: string }).token;
  expect(token).toMatch(/^dusk_sess_/);
}, 60_000);

afterAll(async () => {
  app?.close();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  removeTempDir(root);
  removeTempDir(home);
});

it("a dusk cloud's bot works on the person's Mac: ordinary work runs, a risky command waits for Allow, and off is off", async () => {
  let prefs: any = { enabled: true, mode: "auto" };
  app = createCloudMac({
    fetch: (input: string, init?: RequestInit) => fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, ...EDGE, authorization: `Bearer ${token}` } }),
    name: () => "Sid's MacBook", home,
    prefs: { read: () => prefs, write: (value: unknown) => { prefs = value; } },
    cloud: () => ({ origin: base, awake: true }), linkKey: async () => link.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  });
  await app.sync();
  await until(async () => (await api("GET", "/api/mac")).body?.online === true, "the Mac to reach its cloud");
  expect((await api("GET", "/api/mac")).body).toMatchObject({ available: true, name: "Sid's MacBook", cloud: { mode: "auto", limited: false } });

  const nova = (await api("POST", "/api/bots", { name: "Nova" })).body.bot;
  const messages = async () => (await api("GET", `/api/threads/${nova.threadId}/messages`)).body.messages as any[];
  const idle = () => until(async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === nova.id)?.busy === false, "Nova to settle", 60_000);
  let sends = 0;
  const say = async (text: string, script: unknown[]) => {
    writeFileSync(calls, JSON.stringify(script));
    expect((await api("POST", `/api/bots/${nova.id}/messages`, { threadId: nova.threadId, text, sendId: `cloud-mac-e2e-${String(++sends).padStart(4, "0")}` })).status).toBe(202);
  };

  await say("Make a site folder on my Mac", [{ server: "device", name: "mac_exec", input: { command: "mkdir -p site/build && echo made in $PWD" } }]);
  await idle();
  expect(existsSync(join(home, "site/build"))).toBe(true);
  expect(JSON.stringify(await messages())).toContain(`made in ${home}`);
  expect((await messages()).some((message) => message.card?.tool === "mac_exec")).toBe(false);

  await say("Clean the build", [{ server: "device", name: "mac_exec", input: { command: "rm -rf site/build" } }]);
  let card: any;
  await until(async () => { card = (await messages()).find((message) => message.card?.tool === "mac_exec" && !message.card.answered); return Boolean(card); }, "the risky command's card");
  expect(card.card).toMatchObject({ title: "Nova wants to run a command on your Mac", options: ["Allow", "Deny", "Always allow"], allowKey: "mac_exec:~:rm -rf site/build" });
  expect(card.card.subtitle).toBe("rm -rf site/build\nin ~\nAsking because it deletes many files.");
  expect(existsSync(join(home, "site/build"))).toBe(true);
  expect((await api("POST", `/api/threads/${nova.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
  await idle();
  expect(existsSync(join(home, "site/build"))).toBe(false);
  expect(readFileSync(macLogFile(home), "utf8")).toMatch(/ cloud Nova mac_exec rm -rf site\/build \(in ~\) \(allowed in chat\) -> ok\n/);

  await app.setEnabled(false);
  await until(async () => (await api("GET", "/api/mac")).body?.available === false, "the cloud to forget the Mac");
  await say("Anything on my Mac?", []);
  await idle();
  const dump = JSON.parse(readFileSync(join(root, "dump.json"), "utf8"));
  expect(JSON.stringify(dump.mcpConfig?.mcpServers ?? {})).not.toContain("mac_exec");
}, 180_000);
