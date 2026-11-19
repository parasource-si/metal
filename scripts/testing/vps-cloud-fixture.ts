// Two real servers for the move straight from a VPS to My Cloud: a server of the person's own ("vps", `metal serve`,
// paired with this app as a pairing link pairs it) and the person's Cloud home ("cloud", paired the way the Admin pairs
// it), with main's own wiring for the move (electron/vps-cloud-move.mjs) between them. Disposable homes, a synthetic
// Claude CLI; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_HEADERS } from "../../electron/cloud-power.mjs";
import { installVpsCloudMove } from "../../electron/vps-cloud-move.mjs";
import { oneHomeCloud } from "../../electron/one-home-main.mjs";
import { cloudPairingSignature } from "../../server/cloud-home.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));
const CLOUD_HOST = "dusk-t-5e6d7c8b9a0f.fly.dev";
const EDGE = { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${CLOUD_HOST}` };
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
type Answer = { status: number; body: any };
type Side = (method: string, path: string, body?: unknown) => Promise<Answer>;

export interface VpsCloudFixture {
  root: string;
  vpsBase: string;
  cloudBase: string;
  /** This app's sign-in at the VPS, as the window holds it. */
  vps: Side;
  /** My Cloud's owner. */
  cloud: Side;
  place: { id: string; kind: "remote"; name: string; origin: string };
  main: ReturnType<typeof installVpsCloudMove>;
  /** The dusk cloud sign-in's state main reads; a test empties `machine` for "no Cloud yet". */
  account: { state: any };
  journalFile: string;
  /** Throwing here is the app killed the moment that journal write would land. */
  beforeJournalWrite: ((value: any) => void) | null;
  /** A request main sends either server, answered here instead when this returns a response. */
  intercept: ((url: string, init: RequestInit) => Response | null) | null;
  spies: { opened: number; bought: Array<string | undefined>; viaMac: number; tracked: Array<{ name: string; props: Record<string, unknown> }> };
  /** Whether the way via this computer applies (this computer's bots are the ones on that VPS). */
  viaMacAvailable: boolean;
  relaunch(): Promise<void>;
  logs(): string;
  close(): Promise<void>;
}

export async function launchVpsCloudFixture({ vpsEnv = {} }: { vpsEnv?: NodeJS.ProcessEnv } = {}): Promise<VpsCloudFixture> {
  const root = mkdtempSync(join(tmpdir(), "dusk-vps-cloud-"));
  const secret = randomBytes(32).toString("base64url");
  const children = new Set<ChildProcess>();
  let logs = "";

  async function start(name: string, own: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
    const home = join(root, name);
    const dataDir = join(home, ".duskbot");
    mkdirSync(dataDir, { recursive: true });
    const cli = join(home, "fixture-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_FIXTURE_DIR = ${JSON.stringify(home)};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    if (!existsSync(join(dataDir, "config.json"))) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    } }));
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, DUSK_DATA_DIR: dataDir,
        DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1), DUSK_NO_TEST_BOTS: "1", ...own },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`${name} exited:\n${logs}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
      if (Date.now() > deadline) throw new Error(`${name} did not start:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const vpsPort = await freePortBlock([0, 1]);
  const vpsBase = `http://127.0.0.1:${vpsPort}`;
  await start("vps", { DUSK_ENVIRONMENT_LABEL: "Hetzner box", ...vpsEnv }, vpsPort);
  const minted = await fetch(`${vpsBase}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "My desktop" }) });
  const pairing = (await minted.json() as { code: string }).code;
  const paired = await fetch(`${vpsBase}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing, label: "Metal app" }) });
  const vpsToken = (await paired.json() as { token: string }).token;
  const vps: Side = async (method, path, body) => {
    const response = await fetch(`${vpsBase}${path}`, { method, headers: { authorization: `Bearer ${vpsToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: parse(await response.text()) };
  };

  const cloudPort = await freePortBlock([0, 1]);
  const cloudBase = `http://127.0.0.1:${cloudPort}`;
  await start("cloud", { DUSK_CLOUD_ROLE: "home", DUSK_CLOUD_MACHINE_ID: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", DUSK_CLOUD_ADMIN_URL: "https://cloud.example.test",
    DUSK_CLOUD_BOOTSTRAP_SECRET: secret, DUSK_PUBLIC_URL: `https://${CLOUD_HOST}` }, cloudPort);
  const mintCode = async (label: string) => {
    const body = JSON.stringify({ label, ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${cloudBase}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
      "x-dusk-cloud-timestamp": timestamp, "x-dusk-cloud-nonce": nonce, "x-dusk-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
    return ((await response.json()) as { code: string }).code;
  };
  const ownerPaired = await fetch(`${cloudBase}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: await mintCode("Metal app (Cloud)") }) });
  const owner = ((await ownerPaired.json()) as { token: string }).token;
  const cloud: Side = async (method, path, body) => {
    const response = await fetch(`${cloudBase}${path}`, { method, headers: { ...EDGE, authorization: `Bearer ${owner}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: parse(await response.text()) };
  };

  const fixture = { beforeJournalWrite: null as VpsCloudFixture["beforeJournalWrite"], intercept: null as VpsCloudFixture["intercept"], viaMacAvailable: false };
  /** The window's own requests: the VPS's sign-in goes only to the VPS; My Cloud's through its edge. */
  const windowFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const forged = fixture.intercept?.(String(url), init);
    if (forged) return forged;
    const toVps = String(url).startsWith(`${vpsBase}/`), toCloud = String(url).startsWith(`${cloudBase}/`);
    const headers = { ...init.headers as Record<string, string>, ...(toVps ? { authorization: `Bearer ${vpsToken}` } : {}), ...(toCloud ? EDGE : {}) };
    return fetch(url, { ...init, headers });
  }) as typeof fetch;

  const place = { id: "place-vps", kind: "remote" as const, name: "Hetzner box", origin: vpsBase };
  const account = { state: { status: "connected", account: { id: "acct-fixture", email: "person@example.test" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 },
    machine: { status: "ready", origin: cloudBase, moves: true } } as any };
  const spies: VpsCloudFixture["spies"] = { opened: 0, bought: [], viaMac: 0, tracked: [] };
  const journalFile = join(root, "vps-cloud-move.json");
  const file = (name: string) => ({
    read: () => JSON.parse(readFileSync(join(root, name), "utf8")),
    write: (value: unknown) => { if (name === "vps-cloud-move.json") fixture.beforeJournalWrite?.(value); writeFileSync(join(root, `${name}.tmp`), JSON.stringify(value ?? null)); renameSync(join(root, `${name}.tmp`), join(root, name)); },
  });
  const wire = () => installVpsCloudMove({
    fetch: windowFetch,
    environments: () => [place],
    cloud: () => oneHomeCloud(account.state),
    home: () => (account.state.machine?.origin ? { origin: cloudBase, grant: async () => ({ origin: cloudBase, code: await mintCode("Metal app (Cloud)") }) } : null),
    cloudRead: (route) => fetch(`${cloudBase}${route}`, { headers: { ...EDGE, authorization: `Bearer ${owner}`, accept: "application/json", ...BACKGROUND_HEADERS } }),
    cloudFetch: windowFetch,
    journal: file("vps-cloud-move.json"),
    choice: file("vps-cloud-choice.json"),
    sendState: file("vps-cloud-send.json"),
    viaMac: { available: () => fixture.viaMacAvailable, start: async () => { spies.viaMac++; }, view: () => null },
    buy: async (plan) => { spies.bought.push(plan); },
    openHome: () => { spies.opened++; },
    lastInput: () => 0,
    track: (name, props) => { spies.tracked.push({ name, props }); },
    version: "0.1.141",
    log: (line) => { logs += `[main] ${line}\n`; },
  });
  let main = wire();

  return {
    root, vpsBase, cloudBase, vps, cloud, place, account, journalFile, spies, logs: () => logs,
    get main() { return main; },
    get beforeJournalWrite() { return fixture.beforeJournalWrite; },
    set beforeJournalWrite(hook) { fixture.beforeJournalWrite = hook; },
    get intercept() { return fixture.intercept; },
    set intercept(hook) { fixture.intercept = hook; },
    get viaMacAvailable() { return fixture.viaMacAvailable; },
    set viaMacAvailable(on) { fixture.viaMacAvailable = on; },
    async relaunch() { main.close(); main = wire(); },
    async close() {
      main.close();
      for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(root);
    },
  };
}
