#!/usr/bin/env node
// App Review's demo account on preview.dusk.bot or dusk.bot: creates or repairs it, its dusk cloud, the cloud's review
// flag (never billed, never reclaimed, never revenue) and one friendly demo bot, then checks the bot replies. Idempotent:
// run it again any time (after a reviewer deleted the account, say) and it only fills in what is missing.
//
//   node apps/dashboard/scripts/review-account.mjs preview|production [--no-reply] [--measure-wake]
//
// Reads DUSK_REVIEW_EMAIL, DUSK_REVIEW_CODE and DUSK_OPS_TOKEN_<TARGET> from ~/.config/duskbot/dusk.env (DUSK_ENV
// overrides) and never prints them. It signs in the way the phone does (the fixed review code, no email), pairs with the
// cloud the way the phone does (waking it if asleep), and signs both sessions out at the end. The cloud comes from the
// review grant (POST /v1/billing/ops/review), which never goes through the payment provider, so it works with billing off,
// in test mode and live, and nothing is ever charged.
// --measure-wake[=N] waits for the cloud's idle sleep (up to 75 minutes) and times the phone's wake, N times.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pickReviewAi, REVIEW_AI_PROVIDERS, wireDemoAi } from "./review-ai.mjs";

const TARGETS = { preview: "https://preview.dusk.bot", production: "https://dusk.bot" };
const CLOUD_NAME = "Demo Cloud";
const BOT = {
  name: "Sunny",
  title: "friendly demo helper",
  description: "A cheerful, patient helper for quick everyday things: answering questions, explaining ideas simply, drafting short messages, "
    + "making lists and plans, and brainstorming. Keeps replies short, warm and clear, uses plain words, and asks a quick question when a request is unclear.",
};
const PROMPT = "Hi! In one short sentence, what can you help me with?";

const [target, ...flags] = process.argv.slice(2);
const origin = TARGETS[target];
if (!origin) { console.error("usage: review-account.mjs preview|production [--no-reply] [--measure-wake[=N]]"); process.exit(2); }
const log = (line) => console.log(`[review ${target}] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function secrets() {
  const file = process.env.DUSK_ENV || join(homedir(), ".config", "duskbot", "dusk.env");
  if ((statSync(file).mode & 0o777) !== 0o600) throw new Error(`${file} must be mode 600`);
  const values = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) values.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  const need = (name) => { const v = values.get(name); if (!v) throw new Error(`${name} is not set in ${file}`); return v; };
  return { email: need("DUSK_REVIEW_EMAIL").trim().toLowerCase(), code: need("DUSK_REVIEW_CODE").trim(), ai: pickReviewAi({ ...Object.fromEntries(REVIEW_AI_PROVIDERS.map((item) => [item.env, values.get(item.env)])), DUSK_REVIEW_AI_MODEL: process.env.DUSK_REVIEW_AI_MODEL || values.get("DUSK_REVIEW_AI_MODEL") }), ops: values.get(`DUSK_OPS_TOKEN_${target.toUpperCase()}`) || null };
}

async function call(base, path, { method = "GET", body, token, timeoutMs = 30_000, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, ok: response.ok, data };
}
const must = (answer, what) => { if (!answer.ok) throw new Error(`${what} answered ${answer.status} (${answer.data?.code ?? answer.data?.error ?? "no detail"})`); return answer.data; };

const { email, code, ai, ops } = secrets();
const device = { deviceName: "dusk review setup", platform: "ios", appVersion: "1.0.0" };
let appToken = null, home = null;

async function signIn() {
  const started = must(await call(origin, "/api/cloud/app/sign-in/start", { method: "POST", body: { email, ...device } }), "the review sign-in start");
  const granted = must(await call(origin, "/api/cloud/app/sign-in/verify", { method: "POST", body: { attempt: started.attempt, code } }), "the review code");
  if (typeof granted?.accessToken !== "string") throw new Error("the review code signed nothing in");
  appToken = granted.accessToken;
  log(`signed in with the review code as account ${granted.account?.id ?? "?"}`);
}
const session = async () => must(await call(origin, "/api/cloud/desktop/session", { token: appToken }), "the app session");
const ownCloud = (s) => (s.clouds ?? []).find((c) => c.status !== "ended" && c.status !== "checkout") ?? null;

const opsToken = () => { if (!ops) throw new Error(`DUSK_OPS_TOKEN_${target.toUpperCase()} is not set, so ${target} has no operator routes for the grant and the review flag`); return ops; };
async function grant() {
  const answer = await call(origin, "/v1/billing/ops/review", { method: "POST", token: opsToken(), body: { email, grant: true, name: CLOUD_NAME }, timeoutMs: 60_000 });
  if (answer.status === 404) throw new Error(`${target} has no review grant (the service needs DUSK_OPS_TOKEN and DUSK_REVIEW_EMAIL)`);
  const data = must(answer, "the review grant");
  log(`granted cloud ${data.granted?.cloudId} (${data.granted?.created ? "new" : "already there"}), never through the payment provider`);
}

async function markReview() {
  const marked = must(await call(origin, "/v1/billing/ops/review", { method: "POST", token: opsToken(), body: { email } }), "the review flag");
  log(`review flag on: ${marked.subscriptions.filter((s) => s.review).length} plan(s), clouds ${marked.clouds.map((c) => `${c.id} ${c.status} review=${c.review}`).join(", ") || "none"}`);
  return marked;
}

async function readyCloud() {
  const since = Date.now();
  for (;;) {
    const cloud = ownCloud(await session());
    if (cloud?.status === "ready") { log(`cloud ${cloud.id} "${cloud.name}" is ready${Date.now() - since > 5_000 ? ` after ${Math.round((Date.now() - since) / 1000)}s` : ""}`); return cloud; }
    if (Date.now() - since > 20 * 60_000) throw new Error(`the cloud is not ready after 20 minutes (${cloud?.status ?? "none"} ${cloud?.setup?.step ?? ""})`);
    await sleep(5_000);
  }
}

/** the phone's way in: a pairing grant, waking the cloud first when it is asleep; returns the seconds it took to wake */
async function pair(cloud) {
  let answer = await call(origin, "/api/cloud/desktop/pairing", { method: "POST", token: appToken, body: { cloudId: cloud.id } });
  let wokeIn = null;
  if (answer.status === 409 && (answer.data?.error ?? answer.data?.code) === "not_running") {
    const since = Date.now();
    must(await call(origin, "/api/cloud/desktop/wake", { method: "POST", token: appToken, body: { intent: "click" } }), "the wake");
    for (let tries = 0; tries < 90 && answer.status === 409; tries++) { await sleep(2_000); answer = await call(origin, "/api/cloud/desktop/pairing", { method: "POST", token: appToken, body: { cloudId: cloud.id } }); }
    wokeIn = Math.round((Date.now() - since) / 1000);
    log(`the cloud was asleep; the phone's pairing wake took ${wokeIn}s`);
  }
  const grantCode = must(answer, "the cloud pairing");
  const paired = must(await call(grantCode.origin, "/api/pair", { method: "POST", body: { code: grantCode.code.replace(/-/g, ""), deviceName: device.deviceName } }), "pairing with the cloud");
  home = { origin: grantCode.origin, token: paired.token };
  log(`paired with the cloud at ${new URL(grantCode.origin).host}`);
  return wokeIn;
}

async function demoBot() {
  const roster = must(await call(home.origin, "/api/bots?messages=20", { token: home.token }), "the bot list");
  let existing = (roster.bots ?? []).find((bot) => bot.name === BOT.name);
  // the reviewer opens a fresh chat: a demo bot that already holds someone's messages (an earlier check, a reviewer) is made again
  if (existing && (existing.messages ?? []).some((m) => m.role === "user")) {
    must(await call(home.origin, `/api/bots/${existing.id}`, { method: "DELETE", token: home.token }), "clearing the demo bot's chat");
    log(`made the demo bot again so its chat starts fresh`);
    existing = null;
  }
  if (!existing) {
    const made = must(await call(home.origin, "/api/bots", { method: "POST", token: home.token, body: BOT }), "making the demo bot");
    log(`made the demo bot ${made.bot.id} (${BOT.name})`);
    return made.bot.id;
  }
  if (existing.busy) {
    must(await call(home.origin, `/api/bots/${existing.id}/interrupt`, { method: "POST", token: home.token, body: {} }), "stopping the demo bot's stuck turn");
    log(`stopped a turn the demo bot was stuck in`);
  }
  if (existing.title !== BOT.title || existing.description !== BOT.description) {
    must(await call(home.origin, `/api/bots/${existing.id}`, { method: "PATCH", token: home.token, body: { title: BOT.title, description: BOT.description } }), "repairing the demo bot");
    log(`repaired the demo bot ${existing.id}`);
  } else log(`the demo bot ${existing.id} (${BOT.name}) is there`);
  return existing.id;
}

/** sends as the phone does (a POST with its bearer, which through the edge wakes a sleeping cloud) and waits for the reply */
async function reply(botId) {
  const since = Date.now(), text = `${PROMPT} (${randomUUID().slice(0, 6)})`;
  let sent = null, accepted = null;
  for (let tries = 0; tries < 40 && !sent?.ok; tries++) {
    sent = await call(home.origin, `/api/bots/${botId}/messages`, { method: "POST", token: home.token, body: { text, sendId: randomUUID() }, timeoutMs: 40_000 }).catch((error) => ({ ok: false, status: 0, data: { error: error.message } }));
    if (!sent.ok) { if (![0, 502, 503, 504].includes(sent.status)) must(sent, "sending to the demo bot"); await sleep(2_000); }
  }
  must(sent, "sending to the demo bot");
  accepted = Math.round((Date.now() - since) / 1000);
  for (;;) {
    const roster = must(await call(home.origin, "/api/bots?messages=20", { token: home.token }), "reading the chat");
    const messages = (roster.bots ?? []).find((bot) => bot.id === botId)?.messages ?? [];
    const asked = messages.findIndex((m) => m.role === "user" && m.text === text);
    const answer = asked >= 0 ? messages.slice(asked + 1).find((m) => m.role !== "user" && m.kind === "text" && m.text?.trim()) : null;
    if (answer) return { accepted, total: Math.round((Date.now() - since) / 1000), text: answer.text.trim() };
    if (Date.now() - since > 180_000) {
      await call(home.origin, `/api/bots/${botId}/interrupt`, { method: "POST", token: home.token, body: {} }).catch(() => {});
      const seen = messages.slice(-4).map((m) => `${m.role}/${m.kind}: ${String(m.text ?? m.error ?? "").slice(0, 160).replace(/\s+/g, " ")}`).join(" | ");
      throw Object.assign(new Error(`the demo bot did not reply within 3 minutes, its turn was stopped (last: ${seen || "nothing"})`), { accepted });
    }
    await sleep(2_000);
  }
}

async function measureWake(botId) {
  log("waiting for the cloud's idle sleep (no activity from here)");
  await call(home.origin, "/api/auth/logout", { method: "POST", token: home.token }).catch(() => {});
  home = null;
  const since = Date.now();
  for (;;) {
    // a redeploy of the account service while we wait is a few 502s, not a failed measurement
    const cloud = await session().then(ownCloud, (error) => { log(`session read failed (${error.message}), waiting on`); return null; });
    if (cloud?.power?.state === "asleep") break;
    if (Date.now() - since > 75 * 60_000) throw new Error("the cloud did not sleep within 75 minutes");
    await sleep(60_000);
  }
  log(`asleep after ${Math.round((Date.now() - since) / 60_000)} minutes idle`);
  const started = Date.now();
  const woke = await pair(ownCloud(await session()));
  const paired = Math.round((Date.now() - started) / 1000);
  const timed = await reply(botId).catch((error) => ({ accepted: error.accepted ?? null, total: null, error: error.message }));
  log(`after sleep: the app could pair after ${woke ?? 0}s, paired with the home after ${paired}s, then send accepted in ${timed.accepted ?? "?"}s, ${timed.total === null ? `no reply (${timed.error})` : `reply in ${timed.total}s`}`);
}

async function cleanup() {
  if (home) await call(home.origin, "/api/auth/logout", { method: "POST", token: home.token }).catch(() => {});
  if (appToken) await call(origin, "/api/cloud/desktop/session", { method: "DELETE", token: appToken, body: {} }).catch(() => {});
  log("signed out of the cloud and the account");
}

try {
  await signIn();
  let cloud = ownCloud(await session());
  if (!cloud) { log("no live cloud on the account; granting one"); await grant(); }
  cloud = await readyCloud();
  await markReview();
  if (!cloud.entitlement) log("warning: the session carries no entitlement for the cloud");
  await pair(cloud);
  const botId = await demoBot();
  const homeCall = (path, init = {}) => call(home.origin, path, { ...init, token: home.token });
  const wired = await wireDemoAi(homeCall, { botId, ai });
  log(wired.wired ? `the demo bot answers through ${wired.model} on ${wired.provider}${wired.added ? " (engine added)" : ""}${wired.pointed ? " (bot switched to it)" : ""}` : `warning: ${wired.reason}`);
  // every other bot on the cloud (its own pinned Metal) answers through the same AI, so any chat the reviewer opens replies
  if (wired.wired) {
    for (const other of must(await homeCall("/api/bots?messages=0"), "the bot list").bots ?? []) {
      if (other.id === botId) continue;
      const also = await wireDemoAi(homeCall, { botId: other.id, ai });
      if (also.pointed) log(`${other.name} answers through ${also.model} too`);
    }
  }
  if (!flags.includes("--no-reply")) {
    // the check talks to a throwaway bot on the same AI, so the demo bot's chat stays as the reviewer should first see it
    const check = must(await homeCall("/api/bots", { method: "POST", body: { name: "Reply check", title: "setup check", description: "Answers one setup check, then is deleted." } }), "making the check bot").bot.id;
    try {
      await wireDemoAi(homeCall, { botId: check, ai });
      const answered = await reply(check);
      log(`the demo AI replied in ${answered.total}s: "${answered.text.slice(0, 160).replace(/\s+/g, " ")}"`);
    } finally {
      await homeCall(`/api/bots/${check}`, { method: "DELETE" }).catch(() => {});
    }
  }
  const cycles = Number(flags.find((flag) => flag.startsWith("--measure-wake="))?.split("=")[1] ?? (flags.includes("--measure-wake") ? 1 : 0));
  for (let cycle = 1; cycle <= cycles; cycle++) { log(`wake cycle ${cycle} of ${cycles}`); await measureWake(botId); }
  log("done");
} catch (error) {
  console.error(`[review ${target}] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
