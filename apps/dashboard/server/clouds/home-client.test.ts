import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cloudRequestSignature, createCloudPairing, createCloudRequestVerifier } from "../../../../server/cloud-home.ts";
import { SessionRegistry } from "../../../../server/sessions.ts";
import { createHomeClient, signCloudRequest } from "./home-client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = 1_790_000_000_000, secret = "S".repeat(43);
it("pairs through the real home pairing handler and signs the exact health target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-cloud-pair-")); dirs.push(dir);
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => at });
  const pairing = createCloudPairing({ secret, sessions, now: () => at }), verifier = createCloudRequestVerifier({ secret, now: () => at });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url)), headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("x-dusk-cloud-nonce")).toMatch(/^[\w-]{22,}$/);
    const input = { timestamp: headers.get("x-dusk-cloud-timestamp")!, nonce: headers.get("x-dusk-cloud-nonce")!, signature: headers.get("x-dusk-cloud-signature")!, body: Buffer.from(String(init?.body ?? "")) };
    if (init?.method === "POST") { const result = pairing.handle({ ...input, source: "fixture" }); expect(result.status).toBe(200); return Response.json(result.body); }
    expect(target.pathname + target.search).toBe("/api/cloud/health?after=0");
    expect(verifier.verify({ ...input, method: "GET", target: target.pathname + target.search })).toEqual({ ok: true });
    return Response.json({ v: 1 });
  });
  const client = createHomeClient({ fetch: fetcher, now: () => at });
  const grant = await client.pair("https://cloud.example.test", secret, { label: "Metal app (Cloud)", ttlSeconds: 300 });
  expect(grant).toEqual({ code: expect.stringMatching(/^[\w]{4}-[\w]{4}-[\w]{4}$/), expiresAt: at + 300_000 });
  expect(Object.keys(grant).sort()).toEqual(["code", "expiresAt"]);
  expect(await client.healthy("https://cloud.example.test", secret)).toBe(true);
  expect(signCloudRequest(secret, "1790000000", "nonce", "GET", "/api/cloud/health?after=0", "")).toBe(cloudRequestSignature(secret, "1790000000", "nonce", "GET", "/api/cloud/health?after=0", ""));
});

it.each([
  { code: "AAAA-BBBB-CCCC", expiresAt: at },
  { code: "AAAA-BBBB-CCCC", expiresAt: at + 600_001 },
  { code: "0000-OOOO-IIII", expiresAt: at + 1000 },
  { credential: "never-return-this", expiresAt: at + 1000 },
  null,
])("refuses malformed or expired pairing grants", async answer => {
  const client = createHomeClient({ now: () => at, fetch: async () => Response.json(answer) });
  await expect(client.pair("https://home.example.test", secret, { label: "test" })).rejects.toThrow("Invalid cloud pairing answer");
});

it("bounds responses and sanitizes fetch failures, and requires https without injected transport", async () => {
  const bad = createHomeClient({ fetch: async () => { throw new Error(secret); } });
  await expect(bad.pair("https://home.example.test", secret, { label: "test" })).rejects.toThrow("Cloud home request failed.");
  expect(await bad.healthy("https://home.example.test", secret)).toBe(false);
  const large = createHomeClient({ fetch: async () => new Response("x".repeat(70_000)) });
  await expect(large.pair("http://127.0.0.1", secret, { label: "test" })).rejects.toThrow("Cloud home request failed.");
  expect(await large.healthy("http://127.0.0.1", secret)).toBe(false);
  await expect(createHomeClient().pair("http://home.example.test", secret, { label: "test" })).rejects.toThrow();
});

it("requires a canonical https origin even with an injected transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ v: 1 }));
  const client = createHomeClient({ fetch: fetcher });
  for (const origin of ["http://127.0.0.1", "http://169.254.169.254", "https://user@cloud.example.test", "https://cloud.example.test/path", "https://localhost"]) {
    expect(await client.healthy(origin, secret)).toBe(false);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
