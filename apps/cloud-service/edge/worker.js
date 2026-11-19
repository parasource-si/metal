// The public front of managed cloud desktops: https://<label>.<DUSK_MANAGED_PUBLIC_DOMAIN> -> the machine's own hosted
// URL at the provider. The client only ever sees our domain. The label is opaque (it names no person, cloud id or
// provider); the account service answers which upstream it maps to and whether that home is awake, for this Worker only.
// A sleeping home is woken for a webhook (/hooks/*) or a signed-in client's action (a send or click, never a read);
// reads, anonymous traffic and the app's background hints never wake one. The service caps the wakes per home per hour,
// since each is a provider start. A webhook for a sleeping home is taken at once (202) and queued sealed in the
// HookQueue Durable Object (hook-queue.js), which delivers it when the home answers; without that binding, and for a
// client's action, the request is held until the home answers.
//
// Bindings: ROUTE_URL (the account service origin, or several comma-separated: route.js routeServices), EDGE_TOKEN
// (secret, its DUSK_MANAGED_EDGE_TOKEN, or one per origin in the same order),
// PUBLIC_DOMAIN (the wildcard's parent, e.g. desktops.example.com), and for the queue HOOK_QUEUE (Durable Object,
// class HookQueue) with HOOK_SEAL_KEY (secret, 32+ characters, only here). Route: *.<PUBLIC_DOMAIN>/*.
import { DOWN, LABEL, askWake, lookupRoute, upstreamRequest } from "./route.js";
import { envelope, queueReady } from "./hook-queue.js";

export { HookQueue, QUEUE_LIMITS } from "./hook-queue.js";
const ROUTE_TTL_S = 60;
/**
 * a label the account service maps to no home is not asked about again for this long, per colo (cache api). short,
 * because a home being set up or restored has no upstream yet and must become reachable soon after it gets one
 */
export const MISSING_TTL_S = 60;
/** unknown labels one client address may have looked up per minute, per isolate, before it gets 404s without a lookup */
export const MISSES_PER_MINUTE = 120;
const MISS_WINDOW_MS = 60_000, MAX_MISS_KEYS = 10_000;
const misses = new Map();
function tooManyMisses(ip, now) {
  const seen = misses.get(ip);
  return !!seen && now - seen.from < MISS_WINDOW_MS && seen.count >= MISSES_PER_MINUTE;
}
function noteMiss(ip, now) {
  const seen = misses.get(ip);
  if (seen && now - seen.from < MISS_WINDOW_MS) { seen.count += 1; return; }
  if (misses.size >= MAX_MISS_KEYS) misses.clear();
  misses.set(ip, { from: now, count: 1 });
}
/** a held request waits this long for a waking home; webhook senders time out not much later */
export const HOLD_MS = 25_000;
const MAX_HELD_BODY = 2 * 1024 * 1024;

function cacheKey(label) { return new Request(`https://route.cache/${label}`); }

export async function routeFor(label, env, ctx, { fresh = false } = {}) {
  const cache = globalThis.caches?.default, key = cacheKey(label);
  if (!fresh && cache) {
    const hit = await cache.match(key);
    if (hit) {
      const cached = await hit.json();
      return cached.missing ? null : { ...cached, awake: true };
    }
  }
  const route = await lookupRoute(label, env);
  if (!route) {
    // floods of made-up labels must not each reach the account service
    if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ missing: true }), { headers: { "cache-control": `max-age=${MISSING_TTL_S}` } })));
    return null;
  }
  // only an awake home's route is cached: a sleeping one is asked again until it answers
  if (route.awake && cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ upstream: route.upstream }), { headers: { "cache-control": `max-age=${ROUTE_TTL_S}` } })));
  return route;
}

/** a request a sleeping home is woken for: a webhook, or a signed-in client acting (a send, a click: never a read).
 *  Opening the app or reading chats never wakes a home; the app shows its cached chats until the person acts. */
export function wakeReason(request, url) {
  if (url.pathname.startsWith("/hooks/")) return "webhook";
  // the app's background pings (focus and the like) are hints, never intent
  if (request.headers.get("x-dusk-background") === "1" || request.headers.get("x-omb-background") === "1") return null;
  const acting = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (acting && (request.headers.has("authorization") || request.headers.has("cookie"))) return "client";
  return null;
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wakeAndWait(label, reason, env, ctx, now = () => Date.now()) {
  const asked = await askWake(label, reason, env);
  if (asked === 429) return { status: 429 };
  if (asked !== 200 && asked !== 202) return { status: 503 };
  const deadline = now() + HOLD_MS;
  while (now() < deadline) {
    await sleepFor(1_000);
    const route = await routeFor(label, env, ctx, { fresh: true }).catch(() => null);
    if (route?.awake) return { status: 200, route };
  }
  return { status: 503 };
}

/** `asleep`: the home sleeps and a person's action would wake it, so the page's x-dusk-cloud-power answer (src/lib/cloud-power.ts)
 *  tells it to stop polling and wake it on the next key press or click, instead of reconnecting forever */
function waking(status, { asleep = false, wakeable = true } = {}) {
  // asleep and not being woken (a read never wakes a home): say so, never "waking up", or a reader waits for a wake that
  // nobody started
  const text = status === 429 ? "This Metal workspace was woken too often this hour. Try again later."
    : asleep ? "This Metal workspace is asleep. It wakes when someone uses it." : "This Metal workspace is waking up. Try again in a few seconds.";
  return new Response(text, { status: status === 429 ? 429 : 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": status === 429 ? "300" : "5", "cache-control": "no-store",
    ...(status === 429 || !wakeable ? {} : { "x-dusk-cloud-power": asleep ? "asleep" : "waking", "x-omb-cloud-power": asleep ? "asleep" : "waking" }) } });
}

async function forward(request, url, upstream, body) {
  const response = await fetch(upstreamRequest(upstream, url.hostname, { method: request.method, path: url.pathname + url.search, headers: request.headers, body: body !== undefined ? body : request.body }));
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  for (const name of ["server", "via", "x-powered-by"]) out.headers.delete(name);
  const location = out.headers.get("location");
  if (location?.startsWith(upstream)) out.headers.set("location", `https://${url.hostname}${location.slice(upstream.length)}`);
  return out;
}

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async data => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));

/** the id a queued hook is deduplicated by: the sender's own delivery id where it sends one (GitHub's
 *  X-GitHub-Delivery, Standard Webhooks' webhook-id, Svix's svix-id, the event id in a Stripe body), else a hash of
 *  method, path and body; hashed again with the path so it is always 64 hex characters */
export async function deliveryId(request, url, body) {
  const h = request.headers;
  let source = h.get("x-github-delivery") ? `github:${h.get("x-github-delivery")}` : h.get("webhook-id") ? `webhook-id:${h.get("webhook-id")}` : h.get("svix-id") ? `svix:${h.get("svix-id")}` : null;
  if (!source && h.has("stripe-signature") && body) {
    try { const id = JSON.parse(new TextDecoder().decode(body)).id; if (typeof id === "string" && id.startsWith("evt_")) source = `stripe:${id}`; } catch { /* not json: hashed below */ }
  }
  if (!source) source = `body:${request.method}:${await sha256(body ?? new Uint8Array(0))}`;
  return sha256(`${url.pathname}${url.search}\n${source}`);
}

/** a webhook for a sleeping home: queued sealed, then the wake asked; null when the queue cannot take it (held instead) */
async function queueHook(request, url, label, body, env) {
  const id = await deliveryId(request, url, body);
  const queue = env.HOOK_QUEUE.get(env.HOOK_QUEUE.idFromName(label));
  const accepted = await queue.fetch("https://hook-queue/accept", { method: "POST", headers: { "x-hook-id": id, "x-hook-label": label, "x-hook-host": url.hostname },
    body: envelope({ method: request.method, path: url.pathname + url.search, headers: request.headers, body }) });
  await accepted.body?.cancel().catch(() => {});
  const taken = () => new Response("Accepted. This Metal workspace is waking up and gets it as soon as it answers.", { status: 202, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-dusk-delivery": id } });
  // already queued or delivered: a sender's retry, and no second wake
  if (accepted.status === 200) return taken();
  if (accepted.status !== 202) return accepted.status === 507 ? waking(503) : null;
  const asked = await askWake(label, "webhook", env);
  if (asked === 200 || asked === 202) return taken();
  // not woken (over the cap, or no longer wakeable): the hook is not kept, and the sender hears why
  await queue.fetch("https://hook-queue/forget", { method: "POST", headers: { "x-hook-id": id } }).then(r => r.body?.cancel()).catch(() => {});
  return waking(asked === 429 ? 429 : 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const label = url.hostname.endsWith(`.${env.PUBLIC_DOMAIN}`) ? url.hostname.slice(0, -env.PUBLIC_DOMAIN.length - 1) : "";
    if (!LABEL.test(label)) return new Response("Not found", { status: 404 });
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown", at = Date.now();
    if (tooManyMisses(ip, at)) return new Response("Not found", { status: 404 });
    let route;
    try { route = await routeFor(label, env, ctx); } catch { return new Response("Unavailable", { status: 503, headers: { "retry-after": "5" } }); }
    if (!route) { noteMiss(ip, at); return new Response("Not found", { status: 404 }); }
    const reason = wakeReason(request, url);
    // a webhook's body is read first, so it can still reach the home after a wake, exactly as it was sent
    let body;
    if (request.body && reason === "webhook") {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_HELD_BODY) return new Response("Too large", { status: 413 });
      body = buffer;
    }
    if (route.awake) {
      const response = await forward(request, url, route.upstream, body).catch(() => null);
      if (response && !DOWN.includes(response.status)) return response;
      // a cached route can outlive the home's sleep: ask again, and wake it if it sleeps
      ctx.waitUntil(globalThis.caches?.default?.delete(cacheKey(label)) ?? Promise.resolve());
      if (request.body && body === undefined) return response ?? waking(503);
      route = await routeFor(label, env, ctx, { fresh: true }).catch(() => null);
      if (!route || route.awake) return response ?? waking(503);
    }
    if (!reason || !route.wakeable) return waking(503, { asleep: !reason && route.wakeable && !route.awake, wakeable: route.wakeable });
    if (request.body && body === undefined) {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_HELD_BODY) return new Response("Too large", { status: 413 });
      body = buffer;
    }
    if (reason === "webhook" && queueReady(env)) {
      const queued = await queueHook(request, url, label, body, env).catch(() => null);
      if (queued) return queued;
    }
    const woke = await wakeAndWait(label, reason, env, ctx);
    if (woke.status !== 200) return waking(woke.status);
    return forward(request, url, woke.route.upstream, body);
  },
};
