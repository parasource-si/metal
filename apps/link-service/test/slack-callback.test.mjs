import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLinkService } from "../src/app.mjs";

const STATE = "ab".repeat(32);
const CODE = "fixture.code_-123";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const log = vi.fn();
const outbound = vi.fn(() => { throw new Error("unexpected outbound request"); });
let dir, service, server, base;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-slack-callback-"));
  service = createLinkService({ base: "http://link.test", dataDir: dir, scriptPath: "fixture/install.sh", agentPath: "fixture/agent.mjs", trustProxy: false, log, fetch: outbound });
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  service.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const callback = (params, init) => fetch(`${base}/slack/callback?${new URLSearchParams(params)}`, init);

describe("Slack callback", () => {
  it("returns a secure, escaped, script-free code page without any side effects", async () => {
    const response = await callback({ code: CODE, state: STATE, ignored: '<script>"' });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries({
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "x-frame-options": "DENY", "content-security-policy": CSP,
    })) expect(response.headers.get(name)).toBe(value);
    const html = await response.text();
    const escaped = `duskbot://slack/oauth?code=${CODE}&amp;state=${STATE}`;
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<title>Returning to Metal</title>');
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${escaped}">`);
    expect(html).toContain(`<a href="${escaped}">Open Metal</a>`);
    expect(html).toContain(`<code>${escaped}</code>`);
    expect(html).toContain("user-select:all");
    expect(html).toContain("If nothing happens, open Metal yourself.");
    expect(html).toContain("Or copy this link and paste it into Metal:");
    expect(html).not.toContain(`&state=${STATE}`);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain("ignored");
    expect(outbound).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(service.store.sessions.size + service.store.tunnels.size + service.store.channels.size).toBe(0);
  });

  it("returns a denied page and still deep links to the app", async () => {
    const response = await callback({ error: "access_denied", state: STATE });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Slack didn&#39;t add the bot</h1>");
    expect(html).toContain("You can close this tab.");
    expect(html).toContain(`duskbot://slack/oauth?error=access_denied&amp;state=${STATE}`);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("returns other Slack errors to the app", async () => {
    const response = await callback({ error: "server_error", state: STATE });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`duskbot://slack/oauth?error=server_error&amp;state=${STATE}`);
  });

  it.each([
    { code: CODE, state: "wrong" }, { code: CODE, state: STATE.toUpperCase() },
    { code: CODE }, { state: STATE }, { code: CODE, error: "access_denied", state: STATE },
    { code: 'injection"<script>', state: STATE }, { code: "short", state: STATE },
    { error: "BAD", state: STATE }, { code: "x".repeat(257), state: STATE },
    [["code", CODE], ["state", STATE], ["state", STATE]],
    [["code", CODE], ["code", CODE], ["state", STATE]],
  ].map((params) => ({ params })))("rejects malformed callback %# without reflecting its values", async ({ params }) => {
    const response = await callback(params);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("This Slack link is not valid. Start again from Metal.");
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(STATE);
    expect(html).not.toContain("injection");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("duskbot://");
  });

  it("leaves POST to the existing not-found handling", async () => {
    const response = await callback({ code: CODE, state: STATE }, { method: "POST" });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
