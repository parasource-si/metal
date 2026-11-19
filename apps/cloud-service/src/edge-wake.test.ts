// the public edge (edge/worker.js) in front of a sleeping home: a webhook or a signed-in client wakes it and is held
// until it answers; anonymous traffic never wakes it; strangers get a small hourly budget of wakes
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { deliveryId, wakeReason, QUEUE_LIMITS, type EdgeEnv } from "../edge/worker.js";
import { INSTABOX_RAILS } from "./instabox.ts";
import { homeFixture } from "./test-fixture.ts";
import { fakeHookQueues } from "./fake-hook-queue.ts";
import { askWake, lookupRoute, ROUTE_TIMEOUT_MS } from "../edge/route.js";

const TOKEN = "e".repeat(40), DOMAIN = "desktops.example.com", ROUTE_URL = "https://dash.example.test";
afterEach(() => vi.unstubAllGlobals());

async function edged(edgeWakesPerHour = 3, { queue = false } = {}) {
  const f = await homeFixture({ settings: { publicDomain: DOMAIN, edgeWakesPerHour }, edgeToken: TOKEN });
  const { c } = await f.paid();
  const handle = f.service.managed!.handle!;
  const hooks: Array<{ path: string; body: string }> = [];
  const raw: Array<{ bytes: Uint8Array; headers: Headers }> = [];
  // the account service's routes as the Worker reaches them, and the machine's hosted url, which answers only while up
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ROUTE_URL) {
      // the account service refuses any mutation that is not JSON (apps/dashboard/server/app.ts) before its routes run
      if (request.method !== "GET" && request.headers.get("content-type")?.split(";")[0] !== "application/json") return new Response(JSON.stringify({ error: "JSON is required." }), { status: 403 });
      const req = Object.assign(new PassThrough(), { method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), socket: { remoteAddress: "198.51.100.1" } }) as unknown as IncomingMessage;
      (req as unknown as PassThrough).end("");
      let status = 0, text = "";
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
      await handle(req, res, url, { publicUrl: ROUTE_URL, json: (r, code, data) => { r.writeHead(code); r.end(JSON.stringify(data)); }, readJson: async () => ({}), clientIp: () => "198.51.100.1" });
      return new Response(text, { status });
    }
    if (url.origin === c.managed!.upstream) {
      if (f.api.machines.get(c.serverId!)!.state !== "running") return new Response("down", { status: 502 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      raw.push({ bytes, headers: request.headers });
      hooks.push({ path: url.pathname, body: new TextDecoder().decode(bytes) });
      return new Response("ok", { status: 200, headers: { server: "machine", "x-powered-by": "x" } });
    }
    throw new Error(`unexpected request to ${url.href}`);
  });
  // the queue's own clock runs ahead of the real one by `skew`, to reach its give-up time without waiting
  const clock = { skew: 0 };
  const queues = fakeHookQueues(() => env, () => Date.now() + clock.skew);
  const env: EdgeEnv = { ROUTE_URL, EDGE_TOKEN: TOKEN, PUBLIC_DOMAIN: DOMAIN, ...(queue ? { HOOK_QUEUE: queues.namespace, HOOK_SEAL_KEY: "k".repeat(43) } : {}) }, ctx = { waitUntil() {} };
  const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${c.origin}${path}`, init), env, ctx);
  async function asleep() {
    await f.asleep(c);
    await f.service.reconcile();
    expect(f.api.machines.get(c.serverId!)!.state).toBe("suspended");
    f.power.idle = false; f.power.busy = ["recent-activity"];
  }
  const label = c.managed!.label!;
  return { f, c, hooks, raw, send, asleep, queues, label, clock };
}

describe("the public edge and a sleeping home", () => {
  it("forwards to an awake home and hides the machine's own headers", async () => {
    const { send, hooks } = await edged();
    const response = await send("/hooks/github", { method: "POST", body: "{\"a\":1}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("server")).toBeNull();
    expect(hooks).toEqual([{ path: "/hooks/github", body: "{\"a\":1}" }]);
  });

  it("wakes a sleeping home for a webhook, holds it, and delivers the payload as it was sent", async () => {
    const { f, c, send, hooks, asleep } = await edged();
    await asleep();
    const started = Date.now();
    const response = await send("/hooks/github", { method: "POST", body: "{\"ref\":\"main\"}", headers: { "x-hub-signature-256": "sha256=abc" } });
    expect(response.status).toBe(200);
    expect(hooks).toEqual([{ path: "/hooks/github", body: "{\"ref\":\"main\"}" }]);
    expect(c.status).toBe("running");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(f.audit.entries(c.id).map(e => `${e.action}:${e.actor}`)).toEqual(expect.arrayContaining(["wake_asked:edge", "awake:reconciler"]));
  }, 30_000);

  it("never wakes a home for anonymous traffic, and webhook storms never make it flap", async () => {
    const { f, c, send, asleep } = await edged(60);
    await asleep();
    const anonymous = await send("/");
    expect(anonymous.status).toBe(503);
    expect(anonymous.headers.get("retry-after")).toBe("5");
    // a page's read while it sleeps learns that it sleeps, so it wakes it on the person's next action instead of polling
    expect(anonymous.headers.get("x-dusk-cloud-power")).toBe("asleep");
    // and it is told the truth: nothing is waking it, so it never reads "waking up" and waits for a wake nobody started
    expect(await anonymous.text()).toBe("This Metal workspace is asleep. It wakes when someone uses it.");
    expect((await send("/api/events", { headers: { cookie: "s=1" } })).headers.get("x-dusk-cloud-power")).toBe("asleep");
    await f.service.reconcile();
    expect(f.api.machines.get(c.serverId!)!.state).toBe("suspended");
    // a stranger's webhook every few minutes: each wake is a start, held to the rails' hourly budget and spacing
    for (let n = 0; n < 12; n++) {
      expect((await send("/hooks/x", { method: "POST", body: "1" })).status).toBe(200);
      f.power.idle = true; f.power.busy = [];
      for (let k = 0; k < 2 && c.status !== "sleeping"; k++) { f.advance(4 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
    }
    const starts = f.audit.entries(c.id).filter(e => e.action === "wake" || e.action === "create").map(e => e.at);
    for (const t of starts) expect(starts.filter(x => x > t - 3_600_000 && x <= t).length).toBeLessThanOrEqual(INSTABOX_RAILS.maxStartsPerHour);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(INSTABOX_RAILS.flapMs);
    expect(starts.length).toBeLessThan(12);
  }, 90_000);

  it("caps the wakes strangers can cause at the edge", async () => {
    const { f, c, send, asleep } = await edged(1);
    await asleep();
    expect((await send("/hooks/x", { method: "POST", body: "1" })).status).toBe(200);
    await asleep();
    const capped = await send("/hooks/x", { method: "POST", body: "1" });
    expect(capped.status).toBe(429);
    expect(f.api.machines.get(c.serverId!)!.state).toBe("suspended");
  }, 90_000);

  it("never wakes a home whose plan ended or that an operator suspended", async () => {
    const { f, c, send, asleep } = await edged();
    await asleep();
    f.subscriptions[0]!.status = "canceled" as never;
    (f.subscriptions[0] as unknown as { currentPeriodEnd: number }).currentPeriodEnd = f.now() - 1;
    const ended = await send("/hooks/x", { method: "POST", body: "1", headers: { authorization: "Bearer x" } });
    expect(ended.status).toBe(503);
    expect(ended.headers.get("x-dusk-cloud-power")).toBeNull();
    expect(c.wantPower).toBe("off");
  });

  it("tells a webhook and a credentialed client from anonymous traffic", () => {
    const at = (path: string, headers: Record<string, string> = {}) => wakeReason(new Request(`https://d.example${path}`, { headers }), new URL(`https://d.example${path}`));
    expect(at("/hooks/slack")).toBe("webhook");
    // reading chats or opening the app never wakes: only an action does
    expect(at("/api/bots", { authorization: "Bearer t" })).toBeNull();
    expect(at("/", { cookie: "s=1" })).toBeNull();
    expect(wakeReason(new Request("https://d.example/api/bots/b1/messages", { method: "POST", headers: { authorization: "Bearer t" } }), new URL("https://d.example/api/bots/b1/messages"))).toBe("client");
    expect(wakeReason(new Request("https://d.example/api/bots/b1/messages", { method: "POST" }), new URL("https://d.example/api/bots/b1/messages"))).toBeNull();
    expect(at("/")).toBeNull();
    expect(at("/favicon.ico")).toBeNull();
  });

  it("never wakes a home for the app's background hints, even a credentialed send", () => {
    const focus = new Request("https://d.example/api/cloud/focus", { method: "POST", headers: { authorization: "Bearer t", "x-dusk-background": "1" } });
    expect(wakeReason(focus, new URL(focus.url))).toBeNull();
    const hook = new Request("https://d.example/hooks/github", { method: "POST", headers: { "x-dusk-background": "1" } });
    expect(wakeReason(hook, new URL(hook.url))).toBe("webhook");
  });

  it("never wakes a home for the app's egress link redialing it, with its cookie, after the home fell asleep", () => {
    const link = new Request("https://d.example/api/computer/egress/link", { headers: { cookie: "dusk_session=s", origin: "https://d.example", upgrade: "websocket", connection: "Upgrade" } });
    expect(wakeReason(link, new URL(link.url))).toBeNull();
  });
});

describe("the edge's hook queue for a sleeping home", () => {
  const dueOrForce = async (queues: ReturnType<typeof fakeHookQueues>, label: string, until: () => boolean) => {
    for (let n = 0; n < 60 && !until(); n++) { await new Promise(r => setTimeout(r, 250)); await queues.runAlarm(label, true); }
  };

  it("still forwards to an awake home directly, queueing nothing", async () => {
    const { send, hooks, queues, label } = await edged(3, { queue: true });
    const response = await send("/hooks/github", { method: "POST", body: "{\"a\":1}", headers: { "x-github-delivery": "d-1" } });
    expect(response.status).toBe(200);
    expect(hooks).toEqual([{ path: "/hooks/github", body: "{\"a\":1}" }]);
    expect(queues.storage(label).data.size).toBe(0);
  });

  it("accepts at once with 202, keeps the hook sealed, and delivers it byte for byte after the wake, across a new isolate", async () => {
    const { f, c, send, hooks, raw, asleep, queues, label } = await edged(3, { queue: true });
    await asleep();
    const body = new Uint8Array([0x7b, 0x22, 0x72, 0x22, 0x3a, 0xff, 0x00, 0xfe, 0x7d]);
    const started = Date.now();
    const response = await send("/hooks/github?x=1", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=secret-signature", "x-github-delivery": "d-2", "content-type": "application/json" } });
    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hooks).toEqual([]);
    expect(f.audit.entries(c.id).map(e => `${e.action}:${e.actor}`)).toContain("wake_asked:edge");
    // at rest: only ciphertext and a hash id, never the body, the path or the signature
    const stored = queues.storage(label);
    const dump = Buffer.concat([...stored.data.entries()].map(([k, v]) => Buffer.from(k + (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : JSON.stringify(v)), "latin1")));
    for (const secret of ["secret-signature", "hooks/github", "d-2", Buffer.from(body).toString("latin1")]) expect(dump.includes(Buffer.from(secret, "latin1"))).toBe(false);
    expect(stored.alarm).not.toBeNull();
    // the isolate that took it ends; the alarm in a fresh one delivers it once the home answers
    queues.restart(label);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await dueOrForce(queues, label, () => hooks.length > 0);
    expect(hooks.map(h => h.path)).toEqual(["/hooks/github"]);
    expect(raw[0]!.bytes).toEqual(body);
    expect(raw[0]!.headers.get("x-hub-signature-256")).toBe("sha256=secret-signature");
    expect(raw[0]!.headers.get("x-github-delivery")).toBe("d-2");
    expect(raw[0]!.headers.get("x-forwarded-host")).toBe(new URL(c.origin!).hostname);
    expect(c.status).toBe("running");
    expect(logged.mock.calls.map(call => JSON.parse(String(call[0])).event)).toContain("edge_hook_delivered");
    logged.mockRestore();
    expect([...stored.data.keys()].filter(k => !k.startsWith("s:") && k !== "meta")).toEqual([]);
  }, 30_000);

  it("deduplicates by delivery id, before and after delivery, without a second wake", async () => {
    const { f, c, send, hooks, asleep, queues, label } = await edged(3, { queue: true });
    await asleep();
    const hook = () => send("/hooks/github", { method: "POST", body: "{\"n\":1}", headers: { "x-github-delivery": "same" } });
    expect((await hook()).status).toBe(202);
    expect((await hook()).status).toBe(202);
    expect([...queues.storage(label).data.keys()].filter(k => k.startsWith("e:"))).toHaveLength(1);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await dueOrForce(queues, label, () => hooks.length > 0);
    await queues.runAlarm(label, true);
    expect(hooks).toHaveLength(1);
    // asleep again: a retry of the delivered hook is answered, not delivered twice, and wakes nothing
    await asleep();
    const wakes = f.audit.entries(c.id).filter(e => e.action === "wake_asked").length;
    expect((await hook()).status).toBe(202);
    expect(f.audit.entries(c.id).filter(e => e.action === "wake_asked").length).toBe(wakes);
    expect(hooks).toHaveLength(1);
    vi.restoreAllMocks();
  }, 60_000);

  it("gives up after the limit with an audit line, and keeps nothing", async () => {
    const { f, send, hooks, asleep, queues, label, clock } = await edged(3, { queue: true });
    await asleep();
    expect((await send("/hooks/x", { method: "POST", body: "late" })).status).toBe(202);
    // the home never comes up in time (the reconciler does not run here) and the clock passes the limit
    f.power.busy = ["recent-activity"];
    clock.skew = QUEUE_LIMITS.dropAfterMs;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await queues.runAlarm(label);
    const lines = logged.mock.calls.map(call => JSON.parse(String(call[0])));
    logged.mockRestore();
    expect(lines).toEqual([expect.objectContaining({ event: "edge_hook_dropped", label, reason: "expired" })]);
    expect(JSON.stringify(lines)).not.toContain("late");
    expect([...queues.storage(label).data.keys()].filter(k => k.startsWith("e:") || k.startsWith("c:"))).toEqual([]);
    expect(queues.storage(label).alarm).toBeNull();
    expect(hooks).toEqual([]);
  });

  it("keeps the wake cap and the size limit: a capped hook is refused and not kept", async () => {
    const { send, asleep, queues, label } = await edged(1, { queue: true });
    await asleep();
    expect((await send("/hooks/x", { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await send("/hooks/x", { method: "POST", body: "1" })).status).toBe(202);
    await dueOrForce(queues, label, () => queues.storage(label).data.size > 0 && ![...queues.storage(label).data.keys()].some(k => k.startsWith("e:")));
    await asleep();
    const capped = await send("/hooks/x", { method: "POST", body: "2" });
    expect(capped.status).toBe(429);
    expect([...queues.storage(label).data.keys()].filter(k => k.startsWith("e:"))).toEqual([]);
    vi.restoreAllMocks();
  }, 60_000);

  it("holds as before when the queue's secret is missing", async () => {
    const { c, hooks, asleep } = await edged(3);
    await asleep();
    const env: EdgeEnv = { ROUTE_URL, EDGE_TOKEN: TOKEN, PUBLIC_DOMAIN: DOMAIN };
    env.HOOK_QUEUE = fakeHookQueues(() => env).namespace;
    const response = await worker.fetch(new Request(`${c.origin}/hooks/github`, { method: "POST", body: "held" }), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(hooks).toEqual([{ path: "/hooks/github", body: "held" }]);
  }, 30_000);

  it("takes the sender's delivery id where there is one, else a hash of method, path and body", async () => {
    const id = (path: string, headers: Record<string, string>, body: string) => deliveryId(new Request(`https://d.example${path}`, { method: "POST", headers, body }), new URL(`https://d.example${path}`), new TextEncoder().encode(body).buffer as ArrayBuffer);
    expect(await id("/hooks/gh", { "x-github-delivery": "a" }, "1")).toBe(await id("/hooks/gh", { "x-github-delivery": "a" }, "2"));
    expect(await id("/hooks/gh", { "x-github-delivery": "a" }, "1")).not.toBe(await id("/hooks/gh", { "x-github-delivery": "b" }, "1"));
    expect(await id("/hooks/s", { "stripe-signature": "t=1" }, "{\"id\":\"evt_1\",\"n\":1}")).toBe(await id("/hooks/s", { "stripe-signature": "t=2" }, "{\"id\":\"evt_1\",\"n\":2}"));
    expect(await id("/hooks/x", {}, "1")).toBe(await id("/hooks/x", {}, "1"));
    expect(await id("/hooks/x", {}, "1")).not.toBe(await id("/hooks/x", {}, "2"));
    expect(await id("/hooks/x", {}, "1")).not.toBe(await id("/hooks/y", {}, "1"));
    expect(await id("/hooks/x", {}, "1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the edge's calls to the account service", () => {
  it("give up after a bounded time, so a hung service reads as unavailable instead of holding the request", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", (_input: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const env = { ROUTE_URL, EDGE_TOKEN: TOKEN };
    expect(ROUTE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    const looked = lookupRoute(`d${"a".repeat(20)}`, env), woke = askWake(`d${"a".repeat(20)}`, "client", env);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    // the timeout fires on its own; here it is fired at once to keep the test fast
    for (const signal of signals) (signal as AbortSignal).dispatchEvent(new Event("abort"));
    await expect(looked).rejects.toThrow("aborted");
    expect(await woke).toBe(503);
  }, 15_000);
});
