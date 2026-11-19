import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectRefusedError, withDirect } from "./direct";
import type { DirectConn } from "./direct-rtc";
import { frameGuard, type RelayChannel, type RelayFrame } from "./relay";

const agentPath = "../../../apps/link-service/agent.mjs";
const agent = await import(agentPath);
const key = randomBytes(32);
const channel = "phoneaaaaa";
const big = randomBytes(1024 * 1024);
const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let server: Server | null = null;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server!.close(resolve)); server = null; }
});

/** the Metal server behind the agent: /slow answers after 2 s */
async function app() {
  const seen: Array<{ method: string; url: string; body: number }> = [];
  server = createServer((req, res) => {
    let body = 0;
    req.on("data", (chunk: Buffer) => { body += chunk.length; });
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const answer = () => {
        if (req.url === "/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(big); return; }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`direct ${req.method} ${req.url} ${body}`);
      };
      if (req.url === "/reset") req.socket.destroy();
      else if (req.url?.startsWith("/slow")) setTimeout(answer, 2000); else answer();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { seen, port: (server!.address() as AddressInfo).port };
}

/** a connection to the real agent's direct server (serveDirect) over an in-memory pipe, which a test can cut */
function pipe(port: number) {
  const toAgent = new PassThrough(), fromAgent = new PassThrough();
  const closes = new Set<(reason: string) => void>();
  let ended = false;
  const cut = () => {
    if (ended) return;
    ended = true;
    toAgent.end();
    fromAgent.destroy();
    for (const listener of closes) listener("cut");
  };
  agent.serveDirect({ input: toAgent, output: fromAgent, id: channel, key: key.toString("base64url"), server: { host: "127.0.0.1", port }, guard: agent.frameGuard(), log: () => {}, serving: { controls: false } });
  const conn: DirectConn = {
    path: "direct",
    send(bytes) { if (!ended) toAgent.write(Buffer.from(bytes)); },
    room: async () => {},
    onData(listener) { fromAgent.on("data", (chunk: Buffer) => listener(new Uint8Array(chunk))); },
    onClose(listener) { closes.add(listener); },
    close: cut,
  };
  return { conn, cut };
}

function fakeRelay(control?: RelayChannel["control"]) {
  const request = vi.fn(async (method: string, path: string, _headers?: HeadersInit, _body?: Uint8Array | null, signal?: AbortSignal) => {
    if (path === "/events") {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("data: relay\n\n"));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(`relay ${method} ${path}`);
  });
  return { request, close: vi.fn(), control: control ?? vi.fn(async (): Promise<RelayFrame> => ({ t: "ctl", r: "x", ok: false, error: "unused" })) };
}

function linked(relay: ReturnType<typeof fakeRelay>, connect: () => Promise<DirectConn>, extra: Partial<Parameters<typeof withDirect>[1]> = {}) {
  const linkedChannel = withDirect(relay, { channel, key, guard: frameGuard(), connect, linkOptions: { backoff: [50] }, ...extra });
  cleanups.push(() => linkedChannel.close());
  return linkedChannel;
}

describe("the phone's direct link", () => {
  it("takes requests once the agent says hello: small, a 1 MB download (acked) and an upload, none over the relay", async () => {
    const { seen, port } = await app();
    const relay = fakeRelay();
    const phone = linked(relay, async () => pipe(port).conn);
    await until(() => phone.direct!.ready());
    expect(await (await phone.request("GET", "/fast")).text()).toBe("direct GET /fast 0");
    const download = new Uint8Array(await (await phone.request("GET", "/big")).arrayBuffer());
    expect(Buffer.from(download).equals(big)).toBe(true);
    const upload = randomBytes(300_000);
    const progress: number[] = [];
    expect(await (await phone.request("POST", "/up", { "content-type": "application/octet-stream" }, upload, undefined, (sent) => progress.push(sent))).text()).toBe("direct POST /up 300000");
    expect(progress.at(-1)).toBe(300_000);
    expect(relay.request).not.toHaveBeenCalled();
    expect(phone.stats).toMatchObject({ direct: 3, relay: 0 });
    expect(seen.map((entry) => entry.url)).toEqual(["/fast", "/big", "/up"]);
  });

  it("sends an unanswered GET again over the relay when the link is cut, and never a POST", async () => {
    const { seen, port } = await app();
    const relay = fakeRelay();
    let current: ReturnType<typeof pipe> | null = null;
    const phone = linked(relay, async () => (current = pipe(port)).conn);
    await until(() => phone.direct!.ready());
    const get = phone.request("GET", "/slow-get");
    const post = phone.request("POST", "/slow-post", { "content-type": "text/plain" }, new TextEncoder().encode("once"));
    await until(() => seen.length === 2);
    current!.cut();
    expect(await (await get).text()).toBe("relay GET /slow-get");
    await expect(post).rejects.toThrow("The connection to your server changed. Try again.");
    expect(relay.request).toHaveBeenCalledTimes(1);
    expect(phone.stats).toMatchObject({ replayed: 1 });
    // the link comes back by itself and new requests go direct again
    await until(() => phone.direct!.ready());
    expect(await (await phone.request("GET", "/fast")).text()).toBe("direct GET /fast 0");
  });

  it("uses the relay while the link is not up, and a GET answered by an agent error is not sent twice", async () => {
    const { port } = await app();
    const relay = fakeRelay();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const phone = linked(relay, async () => { await gate; return pipe(port).conn; });
    expect(await (await phone.request("POST", "/early", {}, new Uint8Array([1]))).text()).toBe("relay POST /early");
    open();
    await until(() => phone.direct!.ready());
    // the agent says the server did not answer: that is an answer, not a lost request
    await expect(phone.request("GET", "/reset")).rejects.toThrow("relay request failed");
    expect(relay.request).toHaveBeenCalledTimes(1);
  });

  it("moves a relay event stream over once the link is up", async () => {
    const { port } = await app();
    const relay = fakeRelay();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const phone = linked(relay, async () => { await gate; return pipe(port).conn; });
    const events = await phone.request("GET", "/events", { accept: "text/event-stream" });
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: relay\n\n");
    open();
    await until(() => phone.direct!.ready());
    const started = Date.now();
    expect((await reader.read()).done).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(2000);
  });

  it("stays on the relay without webrtc, and asks a server that refused the offer again only much later", async () => {
    const relay = fakeRelay();
    expect(withDirect(relay, { channel, key, guard: frameGuard(), Peer: null }).direct).toBeNull();
    const { RTCPeerConnection } = await import("node-datachannel/polyfill");
    const control = vi.fn(async (): Promise<RelayFrame> => ({ t: "ctl", r: "x", ok: false, error: "not allowed" }));
    const old = fakeRelay(control);
    const phone = withDirect(old, { channel, key, guard: frameGuard(), Peer: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, rtc: { stun: [], turn: async () => [], gatherMs: 200 }, linkOptions: { backoff: [50] } });
    cleanups.push(() => phone.close());
    await until(() => control.mock.calls.length === 1 && phone.direct!.state() === "waiting");
    const [op, data] = control.mock.calls[0] as unknown[];
    expect(op).toBe("direct-rtc");
    expect(data).toMatchObject({ offer: { type: "offer", sdp: expect.stringMatching(/^v=0/) } });
    phone.direct!.nudge();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(control).toHaveBeenCalledTimes(1);
    expect(await (await phone.request("GET", "/x")).text()).toBe("relay GET /x");
    expect(new DirectRefusedError("x").name).toBe("DirectRefusedError");
  });
});
