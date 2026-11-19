// Metal's recovery from bot walls on real Chrome. Fixture pages mimic each kind of wall; every connection goes through
// a SOCKS stand-in for the route a bot computer's browser takes, which sends a host to the "datacenter" listener or, once
// that host is routed home (what computer-egress.ts routeSite does with the PAC), to the "home" listener. The bot's
// request (request_sign_in with human_check) runs the real request flow and ladder against the real page.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, createServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROBE_EXPRESSION, settlePage, type PageProbe } from "../browser/cdp/settle.ts";
import type { CdpPage } from "../browser/cdp/page.ts";
import { CHROME, startChrome, type RunningChrome } from "../browser/cdp/testing/real-chrome.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import type { BotRecord, Message } from "../store.ts";
import { HUMAN_CHECK_PAGE, parseHumanCheckPage, RELOAD_PAGE } from "./human-check-watch.ts";
import { createSignInRequests } from "./sign-in-requests.ts";
import { runSiteBlockLadder, wallState } from "./site-block-ladder.ts";

const suite = CHROME ? describe : describe.skip;

const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const CONTENT = html("New paste", `<h1>New paste</h1><form><textarea name="paste"></textarea><button>Create new paste</button></form>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(80)}`);

/** Cloudflare's managed challenge as a person sees it: it sets its clearance cookie by itself after a few seconds and reloads. */
const VERIFYING = html("Just a moment...", `<div id="challenge-running"><h1>verify.test</h1><p>Performing security verification</p><p>Verifying...</p></div>
<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0"></iframe>
<script>setTimeout(() => { document.cookie = "cf_clearance=ok; path=/"; location.reload(); }, 4000);</script>`);

type Where = "datacenter" | "home";
function answer(where: Where, request: IncomingMessage, response: ServerResponse): void {
  const host = (request.headers.host ?? "").split(":")[0];
  const send = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(body); };
  switch (host) {
    case "verify.test": return send(/cf_clearance=ok/.test(request.headers.cookie ?? "") ? 200 : 403, /cf_clearance=ok/.test(request.headers.cookie ?? "") ? CONTENT : VERIFYING);
    case "blocked.test": return where === "home" ? send(200, CONTENT) : send(403, html("Access denied", "<h1>Access denied</h1><p>Your request was blocked.</p>"));
    case "hold.test": return send(403, html("Before we continue", "<p>Press &amp; Hold to confirm you are a human (and not a bot).</p><button>Press &amp; Hold</button>"));
    case "traffic.test": return send(429, html("Sorry", `<p>Our systems have detected unusual traffic from your computer network.</p><iframe src="https://www.google.com/recaptcha/api2/anchor?k=1"></iframe>`));
    case "busy.test": return send(429, html("429 Too Many Requests", "<h1>Too Many Requests</h1>"));
    case "wall.test": return send(200, html("Video", "<p>Sign in to confirm you're not a bot</p><a href='/login'>Sign in</a>"));
    default: return send(200, CONTENT);
  }
}

suite("bot walls on real Chrome", () => {
  const servers: Array<Server | NetServer> = [];
  const sockets = new Set<Socket>();
  const ports = { datacenter: 0, home: 0 };
  const routedHome = new Set<string>();
  let gatePort = 0;
  let run: RunningChrome;
  let page: CdpPage;

  async function listen(server: Server | NetServer): Promise<number> {
    servers.push(server);
    server.on("connection", (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    ports.datacenter = await listen(createHttpServer((req, res) => answer("datacenter", req, res)));
    ports.home = await listen(createHttpServer((req, res) => answer("home", req, res)));
    // a minimal SOCKS5 CONNECT: .test hosts go to the datacenter listener, or home once routed; anything else is refused
    gatePort = await listen(createServer((client) => {
      client.on("error", () => client.destroy());
      client.once("data", (hello: Buffer) => {
        if (hello[0] !== 5) return client.destroy();
        client.write(Buffer.from([5, 0]));
        client.once("data", (ask: Buffer) => {
          const host = ask[3] === 3 ? ask.subarray(5, 5 + ask[4]!).toString() : "";
          const refuse = () => client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (!host.endsWith(".test")) return refuse();
          const upstream = connect(routedHome.has(host) ? ports.home : ports.datacenter, "127.0.0.1", () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            upstream.pipe(client).pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
          client.on("close", () => upstream.destroy());
        });
      });
    }));
    run = await startChrome("bot-walls", { launch: { egressPort: gatePort } });
    page = await run.browser.waitForPage();
  }, hostTimeout(180_000));

  afterAll(async () => {
    await run?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const read = async () => parseHumanCheckPage(await page.evaluate(HUMAN_CHECK_PAGE).catch(() => null));
  const open = async (host: string) => { await page.navigate(`http://${host}/`).catch(() => undefined); };

  it("one detector names every kind of wall, and an ordinary page as clear", async () => {
    const seen: Record<string, string> = {};
    for (const host of ["verify.test", "blocked.test", "hold.test", "traffic.test", "busy.test", "wall.test", "plain.test"]) {
      await open(host);
      const probe = await read();
      seen[host] = probe ? wallState(probe) : "unreadable";
    }
    expect(seen).toEqual({
      "verify.test": "checking", "blocked.test": "blocked", "hold.test": "check", "traffic.test": "check", "busy.test": "blocked", "wall.test": "blocked", "plain.test": "clear",
    });
  }, hostTimeout(60_000));

  function bot() {
    const messages: Message[] = [];
    const nova = { id: "b1", name: "Nova", color: "green" } as BotRecord;
    const flow = createSignInRequests({
      store: {
        appendMessage: ((_t: string, row: Partial<Message>) => { const message = { id: `m${messages.length + 1}`, at: Date.now(), ...row } as Message; messages.push(message); return message; }) as never,
        activePath: () => messages, patchMessage: (() => null) as never,
      },
      connectorThread: () => ({ bot: nova, group: undefined }), signInPlace: () => "cloud", threadLanguage: () => undefined, followCard: () => undefined,
      computerControl: { requestHelp: () => ({ held: false, helpReason: null, heldSinceMs: null }), settleHelp: () => [] }, signInControlKey: () => "b1",
      recoverCheck: (ref, { quick }) => runSiteBlockLadder({
        read, reload: () => page.evaluate(RELOAD_PAGE).catch(() => null),
        homeRoute: async () => { routedHome.add(ref.site); return true; },
      }, { quick }),
    });
    return { ask: (site: string) => flow.requestSignIn(nova, "t1", site, "", true), cards: () => messages.filter((message) => message.kind === "signin") };
  }

  it("the browser tool's first pass waits out a self-clearing \"Verifying...\" page and reads the site", async () => {
    await open("verify.test");
    const report = await settlePage({ probe: async () => (await page.evaluate(PROBE_EXPRESSION).catch(() => null)) as PageProbe | null, frameUrls: () => [], loaded: async () => undefined },
      { deadline: Date.now() + 30_000 });
    expect(report.challenge).toMatchObject({ vendor: "Cloudflare", cleared: true });
    expect(wallState((await read())!)).toBe("clear");
    await page.evaluate(`document.cookie = "cf_clearance=; max-age=0; path=/"`);
  }, hostTimeout(60_000));

  it("a bot that asks at once about a self-clearing \"Verifying...\" page carries on with no ask", async () => {
    await open("verify.test");
    expect(wallState((await read())!)).toBe("checking");
    const nova = bot();
    expect(await nova.ask("verify.test")).toMatchObject({ outcome: "cleared", via: "wait" });
    expect(nova.cards()).toEqual([]);
    expect(await page.evaluate("document.title")).toBe("New paste");
  }, hostTimeout(90_000));

  it("a site that blocks the datacenter and lets the home route through: cleared through the person's connection, no ask", async () => {
    await open("blocked.test");
    expect(wallState((await read())!)).toBe("blocked");
    const nova = bot();
    expect(await nova.ask("blocked.test")).toMatchObject({ outcome: "cleared", via: "home" });
    expect(routedHome).toEqual(new Set(["blocked.test"]));
    expect(nova.cards()).toEqual([]);
    expect(await page.evaluate("document.title")).toBe("New paste");
    // only that site took the home route
    await open("hold.test");
    expect(wallState((await read())!)).toBe("check");
  }, hostTimeout(120_000));
});
