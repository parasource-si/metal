// draws the hero demo's content in the real app and keeps what the app renders, so the demo is the app's own markup.
// needs `pnpm demo` running (its ui on DUSK_DEMO_UI_PORT, default 5299) and playwright:
//   PLAYWRIGHT=/path/to/node_modules/playwright DEMO_UI=http://127.0.0.1:5299 node apps/site/demo-src/capture/capture.mjs
// writes apps/site/demo-src/captured.json. the app's own state is only changed in the page (no server writes).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS, MODELS } from '../content.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const UI = process.env.DEMO_UI || 'http://127.0.0.1:5299';
const PAGE = `${UI}/apps/site/demo-src/capture/page.html`;
const OUT = path.join(here, '..', 'captured.json');

const DESK = { width: 1180, height: 680 };
const PHONE = { width: 390, height: 760 };
const H = 3600e3;
const NOW = Date.now();
// the chats happened this morning; every suggestion is answered a minute after the last line, so no time divider shows
const START = new Date(NOW).setHours(9, 12, 0, 0);

const ROLE = { dusk: 'Your main bot', researcher: 'Finds things out', writer: 'Writes and edits', inbox: 'Email', maya: 'Home and meals', books: 'Money and receipts', coder: 'Builds the website', leo: 'Trips and errands' };

// the demo's chats as the app's messages
function messages(bot, extra = []) {
  const out = [];
  let at = START - (BOTS.indexOf(bot) * 0.4 * H);
  let turn = null;
  const push = (m) => { m.parentId = out.at(-1)?.id ?? null; out.push(m); return m; };
  const play = (steps, prefix) => {
    let n = 0;
    for (const step of steps) {
      const id = `${prefix}-${++n}`;
      if (step.u) { push({ id, role: 'user', kind: 'text', text: step.u, at }); turn = id; at += 9e3; continue; }
      const inTurn = turn ? { turnId: `${turn}-turn`, requestMessageId: turn } : {};
      if (step.tool) { push({ id, role: 'bot', kind: 'activity', text: '', at, tool: { name: step.tool[0], input: JSON.stringify(step.tool[1]), ok: true }, ...inTurn }); at += 4e3; continue; }
      if (step.b) { push({ id, role: 'bot', kind: 'text', text: step.b, at, ...inTurn, turnTerminal: true, turnSucceeded: true, turnCompletedAt: at }); at += 3e3; continue; }
      if (step.file) {
        const last = out.findLast((m) => m.kind === 'text' && m.role === 'bot');
        last.attachments = [...(last.attachments ?? []), { kind: 'file', path: `/demo/${step.file.name}`, mime: step.file.mime, name: step.file.name }];
        continue;
      }
      if (step.card) {
        push({ id, role: 'bot', kind: 'options', text: '', at, ...inTurn, card: { title: step.card.title, subtitle: step.card.subtitle, options: step.card.options, requestType: 'question', requestId: `${prefix}-card`, ...(step.answered ? { answered: step.answered } : {}) } });
        at += 3e3;
      }
    }
  };
  play(bot.history, `h-${bot.key}`);
  at += 60e3;
  for (const [steps, prefix] of extra) play(steps, prefix);
  return out;
}

const exchangeSteps = (chip) => [{ u: chip.u }, ...(chip.tool ? [{ tool: chip.tool }] : []), ...chip.reply];

const browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });

async function open(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__cap?.ready, null, { timeout: 90_000 });
  await page.waitForTimeout(800);
  // the bots, their models and routines, as the demo has them
  await page.evaluate(({ BOTS, MODELS, ROLE }) => {
    const { state, dispatch } = window.__cap;
    const keep = { claude: ['claude-sonnet-5', 'claude-opus-5-5'], codex: ['gpt-6.1-terra'], antigravity: ['gemini-3.8-flash'], grok: ['grok-4.7'] };
    const instances = state.instances.filter((i) => keep[i.instanceId]).map((i) => ({
      ...i, snapshot: { ...i.snapshot, state: 'available', authenticated: true },
      models: { ...i.models, default: keep[i.instanceId][0], options: i.models.options.filter((o) => keep[i.instanceId].includes(o.id)) },
    }));
    dispatch({ type: 'instances', instances });
    const ids = {};
    for (const bot of BOTS) {
      const found = state.bots.find((b) => b.name === bot.name);
      ids[bot.key] = found.id;
      dispatch({ type: 'botPatched', bot: { ...found, messages: undefined, title: ROLE[bot.key], color: bot.color, mascotBody: bot.main ? found.mascotBody : bot.body, modelSelection: MODELS[bot.model], computer: 'cloud' } });
    }
    const routines = BOTS.flatMap((bot) => bot.routines.map((r, i) => ({
      id: `r-${bot.key}-${i}`, name: r.name, prompt: r.name, target: 'bot', botId: ids[bot.key], runOn: 'maus', enabled: r.enabled,
      schedule: { type: 'daily', time: r.time, weekdays: r.weekdays }, durationMinutes: 15, attachments: [], timing: 'around', nextRunAt: null, createdAt: 1, updatedAt: 1, strip: [],
    })));
    dispatch({ type: 'routinesHydrated', routines, runs: [] });
    window.__ids = ids;
  }, { BOTS, MODELS, ROLE });
  await page.waitForTimeout(300);
  return page;
}

let seq = 0;
// shows `list` as the bot's chat (a fresh thread each time, so nothing merges with what was there)
async function show(page, bot, list, { select = true, busy = false, unread } = {}) {
  await page.evaluate(({ key, list, select, busy, unread, t }) => {
    const { state, dispatch } = window.__cap;
    const found = state.bots.find((b) => b.id === window.__ids[key]);
    const last = list.at(-1);
    if (select) dispatch({ type: 'select', id: found.id });
    const waiting = last?.kind === 'options' && !last.card?.answered;
    dispatch({ type: 'taskSwitched', bot: { ...found, threadId: t, mainThreadId: t, messages: list, activeLeafId: last?.id ?? null, hasMore: false,
      busy, activity: waiting ? 'waiting-on-you' : busy ? 'working' : 'idle', ...(busy ? { turnStartedAt: Date.now() } : {}), ...(unread !== undefined ? { unread } : {}),
      tasks: [{ threadId: t, title: 'Chat', createdAt: list[0]?.at ?? 1, updatedAt: last?.at ?? 1, lastThreadOrderAt: last?.at ?? 1, unread: Boolean(unread), busy }] } });
  }, { key: bot.key, list, select, busy, unread, t: `demo-${bot.key}-${++seq}` });
  await page.waitForTimeout(700);
}

const grab = (page, selector) => page.evaluate((s) => document.querySelector(s)?.outerHTML ?? null, selector);
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-simple-rows] > [data-mid]')].map((el) => ({ mid: el.dataset.mid, html: el.outerHTML })));

const out = { capturedAt: new Date().toISOString(), viewport: DESK, bots: {} };
const page = await open(DESK);

// every bot's chat as it starts, so the sidebar previews are right before anything is selected
for (const bot of BOTS) await show(page, bot, messages(bot), { select: false, unread: Boolean(bot.unread) });

for (const bot of BOTS) {
  const rec = out.bots[bot.key] = { name: bot.name, color: bot.color, body: bot.body };
  await show(page, bot, messages(bot), { unread: false });
  rec.log = await rows(page);
  rec.head = await grab(page, '[data-chathead-identity]');
  rec.composer = await grab(page, '[data-composer-row]');
  rec.rowSelected = await grab(page, `[data-bot-reorder-row="${await page.evaluate((k) => window.__ids[k], bot.key)}"]`);
  rec.exchanges = [];
  const extras = [
    ...(bot.chips ?? []).map((chip, i) => ({ id: `x${i}`, steps: exchangeSteps(chip) })),
    ...Object.entries(bot.answers ?? {}).map(([answer, a], i) => ({ id: `a${i}`, answer, steps: [{ u: answer }, ...a.reply] })),
  ];
  for (const extra of extras) {
    let list;
    if (extra.answer) {
      // a card answered: the card goes and the choice is the person's message
      const answered = { ...bot, history: bot.history.map((s) => (s.card ? { card: s.card, answered: extra.answer } : s)) };
      list = messages(answered, [[extra.steps, extra.id]]);
    } else list = messages(bot, [[extra.steps, extra.id]]);
    await show(page, bot, list, { unread: false });
    const all = await rows(page);
    rec.exchanges.push({
      id: extra.id, answer: extra.answer ?? null,
      rows: all.filter((r) => r.mid.startsWith(`${extra.id}-`)).map((r) => r.html),
    });
  }
  // the composer while the bot works: the stop button beside the mic
  await show(page, bot, messages(bot, [[[{ u: '…' }], 'busy']]), { busy: true, unread: false });
  rec.composerBusy = await grab(page, '[data-composer-actions]');
}

// the sidebar with nothing selected: every row as it reads from another bot's chat
for (const bot of BOTS) await show(page, bot, messages(bot), { select: false, unread: false });
await show(page, BOTS[0], messages(BOTS[0]), { unread: false });
for (const bot of BOTS) {
  const id = await page.evaluate((k) => window.__ids[k], bot.key);
  if (bot.key !== BOTS[0].key) out.bots[bot.key].row = await grab(page, `[data-bot-reorder-row="${id}"]`);
}
await show(page, BOTS[1], messages(BOTS[1]), { unread: false });
out.bots[BOTS[0].key].row = await grab(page, `[data-bot-reorder-row="${await page.evaluate((k) => window.__ids[k], BOTS[0].key)}"]`);
for (const bot of BOTS.filter((b) => b.unread)) {
  await show(page, bot, messages(bot), { select: false, unread: true });
  out.bots[bot.key].row = await grab(page, `[data-bot-reorder-row="${await page.evaluate((k) => window.__ids[k], bot.key)}"]`);
}

// the bot panel, every tab, for every bot
for (const bot of BOTS) {
  await show(page, bot, messages(bot), { unread: false });
  await page.evaluate(() => window.__cap.dispatch({ type: 'toggleSettings', open: true, section: 'overview', botId: window.__cap.state.selectedId }));
  await page.waitForTimeout(900);
  const rec = out.bots[bot.key];
  rec.panel = {};
  const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `real-${name}.png`) }); };
  for (const [i, tab] of ['details', 'computer', 'advanced'].entries()) {
    if (tab === 'computer') await page.evaluate(() => window.__cap.dispatch({ type: 'configStatus', config: { ...window.__cap.state.config, cloudHome: true } }));
    await page.click(`#bot-panel [data-panel-tab]:nth-child(${i + 1})`);
    await page.waitForTimeout(tab === 'computer' ? 1600 : 800);
    rec.panel[tab] = await grab(page, '#bot-panel');
    await shot(`${bot.key}-${tab}`);
    if (tab === 'computer') await page.evaluate(() => window.__cap.dispatch({ type: 'configStatus', config: { ...window.__cap.state.config, cloudHome: false } }));
  }
  await page.click('#bot-panel [data-panel-tab]:nth-child(1)');
  await page.waitForTimeout(400);
  if (bot.key === 'dusk') {
    // the model picker, open
    await page.click('#bot-panel [data-panel-row] button:has-text("Claude Sonnet 5")').catch(async () => page.click('#bot-panel button:has-text("Claude Sonnet 5")'));
    await page.waitForTimeout(700);
    out.modelMenu = await page.evaluate(() => {
      const search = [...document.querySelectorAll('input')].find((i) => /search models/i.test(i.placeholder));
      let el = search;
      while (el && el.parentElement && el.parentElement !== document.body && !/fixed|absolute/.test(getComputedStyle(el.parentElement).position)) el = el.parentElement;
      el = el?.parentElement ?? el;
      const button = document.querySelector('#bot-panel [aria-expanded="true"]');
      const r = el.getBoundingClientRect(), b = button?.getBoundingClientRect();
      return { html: el.outerHTML, rect: { top: r.top, left: r.left, width: r.width, height: r.height }, button: b ? { top: b.top, left: b.left, width: b.width, height: b.height } : null };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

// the whole window: Metal's chat with its panel open, the demo's first frame
for (const bot of BOTS.slice(1)) await show(page, bot, messages(bot), { select: false, unread: Boolean(bot.unread) });
await show(page, BOTS[0], messages(BOTS[0]), { unread: false });
await page.waitForTimeout(500);
out.shell = await page.evaluate(() => document.querySelector('#root').innerHTML);
if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'real-shell.png') });
out.htmlAttrs = await page.evaluate(() => Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])));
await page.close();

// the phone: the chat, then the list over it
const phone = await open(PHONE);
await show(phone, BOTS[0], messages(BOTS[0]), { unread: false });
await phone.evaluate(() => window.__cap.dispatch({ type: 'toggleSettings', open: false }));
await phone.waitForTimeout(600);
out.phone = { chat: await phone.evaluate(() => document.querySelector('#root').innerHTML) };
if (process.env.SHOTS) await phone.screenshot({ path: path.join(process.env.SHOTS, 'real-phone-chat.png') });
await phone.click('button[aria-label="Open bot list"]').catch(() => {});
await phone.waitForTimeout(700);
out.phone.list = await phone.evaluate(() => document.querySelector('#root').innerHTML);
if (process.env.SHOTS) await phone.screenshot({ path: path.join(process.env.SHOTS, 'real-phone-list.png') });
await phone.close();

await browser.close();
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`captured ${Object.keys(out.bots).length} bots into ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
