// A provider's normal browser sign-in returns to http://localhost:<port>/<path> on the machine running its CLI. When
// that CLI is on a remote workspace, this listens on the same loopback port here, where the browser is, and gives the
// callback to the page, which sends it to the workspace over its authenticated link. Nothing here reads, stores or
// logs the callback's code: it only holds the browser's request until the workspace answers.
import { createServer } from "node:http";

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + `<body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f5f2;color:#222">`
  + `<div style="text-align:center"><p style="font-size:18px;margin:0 0 6px">${title}</p><p style="margin:0;color:#666">${body}</p></div>`;
const DONE = PAGE("You're signed in", "You can close this tab and go back to Metal.");
const FAILED = PAGE("Sign-in did not finish", "Go back to Metal to try again.");

export function validLoopback(port, path) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && typeof path === "string" && /^\/[\w\-./]{0,200}$/.test(path) && !path.includes("..");
}

export function createLoopbackRelay({ lifetimeMs = 15 * 60_000, answerMs = 90_000 } = {}) {
  const relays = new Map();

  function close(port) {
    const relay = relays.get(port);
    if (!relay) return;
    relays.delete(port);
    clearTimeout(relay.lifetime);
    clearTimeout(relay.answerTimer);
    if (relay.response && !relay.response.headersSent) relay.response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FAILED);
    for (const resolve of relay.waiting) resolve(null);
    for (const server of relay.servers) server.close();
  }

  function handle(port, req, res) {
    const relay = relays.get(port);
    let url = null;
    try { url = new URL(req.url ?? "/", `http://localhost:${port}`); } catch {}
    const host = String(req.headers.host ?? "").toLowerCase();
    const hostOk = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host);
    if (!relay || req.method !== "GET" || !hostOk || !url || url.pathname !== relay.path || relay.response) {
      res.writeHead(404).end();
      return;
    }
    relay.response = res;
    // the host the browser used, so a provider that checks the redirect origin (Antigravity: 127.0.0.1) accepts it
    relay.callback = `http://${host}${url.pathname}${url.search}`;
    for (const resolve of relay.waiting.splice(0)) resolve(relay.callback);
    relay.answerTimer = setTimeout(() => done(port, { ok: false }), answerMs);
    relay.answerTimer.unref?.();
  }

  /** Listens on this computer's loopback; false when the port is taken here, and the sign-in then uses its fallback. */
  async function open(port, path) {
    if (!validLoopback(port, path)) return false;
    close(port);
    const relay = { path, servers: [], waiting: [], response: null, callback: null, lifetime: null, answerTimer: null };
    const listen = (host) => new Promise((resolve) => {
      const server = createServer((req, res) => handle(port, req, res));
      server.once("error", () => resolve(null));
      server.listen(port, host, () => resolve(server));
    });
    const v4 = await listen("127.0.0.1");
    if (!v4) return false;
    relay.servers.push(v4);
    const v6 = await listen("::1");
    if (v6) relay.servers.push(v6);
    relay.lifetime = setTimeout(() => close(port), lifetimeMs);
    relay.lifetime.unref?.();
    relays.set(port, relay);
    return true;
  }

  /** The callback the browser brought back, or null once the relay closed. */
  function next(port) {
    const relay = relays.get(port);
    if (!relay) return Promise.resolve(null);
    if (relay.callback) return Promise.resolve(relay.callback);
    return new Promise((resolve) => relay.waiting.push(resolve));
  }

  /** Answers the browser: the provider's https page when the workspace gave one, else a plain page; then closes. */
  function done(port, result) {
    const relay = relays.get(port);
    const res = relay?.response;
    if (res && !res.headersSent) {
      let location = null;
      try { location = result?.ok && result.location && new URL(result.location).protocol === "https:" ? new URL(result.location).href : null; } catch {}
      if (location) res.writeHead(302, { location }).end();
      else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(result?.ok ? DONE : FAILED);
    }
    close(port);
  }

  return { open, next, done, close, closeAll: () => { for (const port of relays.keys()) close(port); } };
}
