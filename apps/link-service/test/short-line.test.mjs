// the short line: `curl -fsSL <shortBase>/s/<code>[/<way>] | sh` serves a tiny script that fetches the session's whole
// installer (installLine's loop, inside) and runs it, while the session is waiting or installing
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SHORT_CODE, bootstrapScript, createLinkService } from "../src/app.mjs";
import { createRelayClient, newLinkKeys, vpsTokenOf } from "../../../electron/vps-link-protocol.mjs";
import { SHORT_URL, shortInstallLine } from "../../../electron/vps-link.mjs";

const open = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "short-line-"));
  const scriptPath = join(dir, "install.sh");
  writeFileSync(scriptPath, 'echo "ran __LINK_TOKEN__ $*"\n');
  let service;
  const server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  service = createLinkService({ base, shortBase: base, scriptPath, agentPath: join(dir, "agent.mjs"), trustProxy: true });
  open.push(async () => { service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const relay = createRelayClient({ base });
  const keys = newLinkKeys();
  const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
  return { service, base, relay, keys, made, token: `${made.id}-${keys.secret}` };
}

const run = (line) => new Promise((resolve) => execFile("sh", ["-c", line], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
const get = (url, ip = "8.8.8.8") => fetch(url, { headers: { "x-real-ip": ip } });

describe("short line", () => {
  it("is minted only with the session's own secret, once, and names the session's installer", async () => {
    const t = await fixture();
    await expect(t.relay.short(t.made.id, t.made.watch, "a".repeat(26))).rejects.toThrow(/secret/);
    await expect(t.relay.short(t.made.id, "not-the-watch", t.keys.secret)).rejects.toThrow();
    const first = await t.relay.short(t.made.id, t.made.watch, t.keys.secret);
    expect(first.code).toMatch(SHORT_CODE);
    expect(first.url).toBe(`${t.base}/s/${first.code}`);
    expect(await t.relay.short(t.made.id, t.made.watch, t.keys.secret)).toEqual(first);
    const script = await (await get(first.url)).text();
    expect(script).toBe(bootstrapScript(t.base, t.token, undefined));
    expect(await (await get(`${first.url}/tailscale`)).text()).toContain(`/i/${t.token}); then printf '%s\\n' "$s" | sh -s -- --tailscale; exit $?`);
    expect((await get(`${first.url}/rm-rf`)).status).toBe(404);
  });

  it("runs the installer with its way through curl | sh, exactly as the app shows it", async () => {
    const t = await fixture();
    const { url } = await t.relay.short(t.made.id, t.made.watch, t.keys.secret);
    expect(SHORT_URL.test(url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "https://dusk.bot"))).toBe(true);
    const ran = await run(`curl -fsSL ${url}/cloudflare | sh`);
    expect(ran).toMatchObject({ code: 0, stdout: `ran ${t.token} --cloudflare\n` });
    expect((await run(shortInstallLine(url))).stdout).toBe(`ran ${t.token} \n`);
  });

  it("keeps working while installing (a failed step's line again), and ends with the session", async () => {
    const t = await fixture();
    const { url } = await t.relay.short(t.made.id, t.made.watch, t.keys.secret);
    const claim = await fetch(`${t.base}/v1/sessions/${t.made.id}/claim`, { method: "POST", headers: { authorization: `Bearer ${vpsTokenOf(t.keys.secret)}`, "content-type": "application/json" }, body: "{}" });
    expect(claim.status).toBe(200);
    expect((await get(url)).status).toBe(200);
    await t.relay.cancel(t.made.id, t.made.watch);
    expect((await get(url)).status).toBe(404);
    expect(t.service.store.sessions.get(t.made.id).shortSecret).toBeUndefined();
    await expect(t.relay.short(t.made.id, t.made.watch, t.keys.secret)).rejects.toThrow(/already used/);
  });

  it("counts misses: past 30 an hour from one address, every try from there is refused", async () => {
    const t = await fixture();
    const { url } = await t.relay.short(t.made.id, t.made.watch, t.keys.secret);
    for (let i = 0; i < 30; i++) expect((await get(`${t.base}/s/zzzzzz${"23456789"[i % 8]}`, "9.9.9.9")).status).toBe(404);
    expect((await get(`${t.base}/s/zzzzzzz`, "9.9.9.9")).status).toBe(429);
    expect((await get(url, "9.9.9.9")).status, "a right guess past the limit gets nothing either").toBe(429);
    expect((await get(url, "7.7.7.7")).status).toBe(200);
    expect((await get(`${t.base}/s/zzzzzzz`, "7.7.7.7")).status).toBe(404);
  });

  it("a server that cannot reach the installer gets a plain message and exit 1", async () => {
    const script = bootstrapScript("http://127.0.0.1:9", "abcdefghij-abcdefghijklmnopqrstuvwxyz", "cloudflare");
    const ran = await run(`printf '%s' '${script.replaceAll("'", "'\\''")}' | sh`);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("Metal could not be downloaded");
  }, 30_000);

  it("a download that stalls is given up on, never waited on forever", () => {
    expect(bootstrapScript("https://link.example.test", "abcdefghij-abcdefghijklmnopqrstuvwxyz", "tailscale")).toContain("curl -fsSL --connect-timeout 15 -m 120 $f https://link.example.test/i/");
  });
});
