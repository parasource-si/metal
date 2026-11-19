import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mailer } from "../auth/mail.ts";
import { render } from "../email/layout.ts";
import type { EmailConfig } from "../email/layout.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { BANNER_MAX_BYTES, checkBanner } from "../../../../server/workspace-banner.ts";
import { BUG_REPORT_STATUSES, type BugReportRow, type BugReportStatus, type BugReportStore, type ReportImage } from "./store.ts";

export const BUG_REPORT_PATH = "/api/bug-reports";
export const BUG_REPORT_STATUS_PATH = "/api/bug-reports/status";
/** the desktop keeps its own limits inside these (server/devs-report.ts DEVS_REPORT_LIMITS) */
export const BUG_REPORT_LIMITS = { body: 600 * 1024, description: 10_000, field: 40, diagnostics: 262_144, statusIds: 50,
  /** feedback's pictures: each a PNG, JPEG or WebP of at most BANNER_MAX_BYTES, its metadata taken out before it is kept */
  images: 3, imageBytes: BANNER_MAX_BYTES, bodyWithImages: 2_500 * 1024 } as const;
export const RATES = {
  reportsPerInstallHour: 10, reportsPerAddressHour: 30, statusPerAddressHour: 240,
  /** a retry of the same bytes within this long gets the first answer back and no second email */
  dedupeMs: 8 * 24 * 3_600_000,
  mailsPerDay: 50,
} as const;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export class BugReportError extends Error {
  status: number; code: string; retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

/** must match server/devs-report-send.ts bugReportsHomeSignature (bug-reports.test.ts holds them together) */
export function bugReportsHomeSignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`omb-bug-reports-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

export interface BugReportsOptions {
  store: BugReportStore;
  now?: () => number;
  json(res: ServerResponse, status: number, data: unknown): void;
  bodyObject(body: Buffer): Record<string, unknown>;
  /** the address a limit counts against */
  ip(req: IncomingMessage): string;
  /** throws unless the request is an admin's signed-in web session (with the CSRF check on changes); the admin's account id */
  admin(req: IncomingMessage, mutation: boolean): string;
  audit?(actor: string, action: string, target: string, detail: Record<string, string | number | boolean | null>): void;
  /** a Cloud home asking about its reports signs with the bootstrap secret it shares with this service */
  clouds?: { get(id: string): StoredCloud | null; unseal(sealed: string): string };
  /** one email per new report; off sends none */
  mail?: { on: boolean; to: () => string[]; mailers: Mailer[]; email: EmailConfig; panelUrl: string };
  log?: (line: string) => void;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
// oxlint-disable-next-line no-control-regex -- control characters are what a one-line field refuses
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/** what POST /api/bug-reports accepts; fields it does not know are ignored */
export function parseBugReport(input: Record<string, unknown>) {
  const installId = text(input.installId);
  if (!INSTALL_ID.test(installId)) throw new BugReportError(400, "invalid_install", "Invalid installId.");
  const source = text(input.source) || "bot";
  if (!/^[a-z][a-z-]{0,19}$/.test(source)) throw new BugReportError(400, "invalid_source", "Invalid source.");
  if (typeof input.description !== "string" || !input.description.trim()) throw new BugReportError(400, "invalid_description", "A description is required.");
  if (input.description.length > BUG_REPORT_LIMITS.description) throw new BugReportError(400, "invalid_description", `The description is longer than ${BUG_REPORT_LIMITS.description} characters.`);
  const field = (name: "appVersion" | "platform") => {
    const value = oneLine(text(input[name]));
    if (!value || value.length > BUG_REPORT_LIMITS.field) throw new BugReportError(400, `invalid_${name}`, `${name} must be 1 to ${BUG_REPORT_LIMITS.field} characters.`);
    return value;
  };
  if (input.diagnostics !== undefined && typeof input.diagnostics !== "string") throw new BugReportError(400, "invalid_diagnostics", "Invalid diagnostics.");
  const diagnostics = text(input.diagnostics);
  if (diagnostics.length > BUG_REPORT_LIMITS.diagnostics) throw new BugReportError(400, "invalid_diagnostics", `The diagnostics are longer than ${BUG_REPORT_LIMITS.diagnostics} characters.`);
  const given = [input.contactEmail, input.contact].filter(value => value !== undefined && value !== null && value !== "");
  const addresses = given.map(value => text(value).trim().toLowerCase());
  if (addresses.some(address => address.length > 254 || !EMAIL.test(address))) throw new BugReportError(400, "invalid_contact", "Invalid contact email.");
  return { installId, source, description: input.description, appVersion: field("appVersion"), platform: field("platform"), diagnostics, contact: addresses[0] ?? null, images: parseImages(input.images) };
}

function parseImages(input: unknown): ReportImage[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > BUG_REPORT_LIMITS.images) throw new BugReportError(400, "invalid_images", `Send at most ${BUG_REPORT_LIMITS.images} images.`);
  return input.map((item: unknown) => {
    const data = item && typeof item === "object" ? text((item as { data?: unknown }).data) : "";
    if (!data || data.length > Math.ceil(BUG_REPORT_LIMITS.imageBytes / 3) * 4 + 4) throw new BugReportError(400, "invalid_image", "Each image must be a PNG, JPEG or WebP of 400 KB or less.");
    const checked = checkBanner(Buffer.from(data, "base64"));
    if (!checked.ok) throw new BugReportError(400, "invalid_image", "Each image must be a still PNG, JPEG or WebP of 400 KB or less, at most 1600 pixels across.");
    return { mime: checked.mime, bytes: checked.bytes, width: checked.width, height: checked.height };
  });
}

const hasImages = (input: Record<string, unknown>) => Array.isArray(input.images) && input.images.length > 0;

/** the desktop's word for an admin status: it only shows received and fixed */
export const desktopStatus = (status: BugReportStatus) => (status === "fixed" ? "fixed" as const : "received" as const);

const LOWER = "abcdefghjkmnpqrstuvwxyz23456789";
/** short enough to read out, "dr-" so it reads as a report */
export function newReportId(random: (size: number) => Buffer = randomBytes): string {
  return `dr-${[...random(10)].map(byte => LOWER[byte % LOWER.length]).join("")}`;
}

export function createBugReports(options: BugReportsOptions) {
  const { store, json } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(`bug reports: ${line}`));
  const windows = new Map<string, number[]>();
  const mailed = { day: -1, count: 0 };
  const nonces = new Map<string, number>();

  /** throws 429 with the seconds until the oldest counted request leaves the hour */
  function limit(key: string, max: number) {
    const time = now(), list = (windows.get(key) ?? []).filter(at => at > time - HOUR);
    if (list.length >= max) { windows.set(key, list); const wait = Math.max(1, Math.ceil((list[0]! + HOUR - time) / 1000)); throw new BugReportError(429, "rate_limited", "Too many reports. Try again later.", wait); }
    list.push(time);
    windows.set(key, list);
    if (windows.size > 20_000) for (const [k, v] of windows) if (!v.some(at => at > time - HOUR)) windows.delete(k);
  }

  async function readCapped(req: IncomingMessage, max: number): Promise<Buffer> {
    if (Number(req.headers["content-length"] ?? 0) > max) { req.resume(); throw new BugReportError(413, "too_large", `The report is larger than ${Math.round(max / 1024)} KB.`); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > max) { req.resume(); throw new BugReportError(413, "too_large", `The report is larger than ${Math.round(max / 1024)} KB.`); }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  async function notify(report: BugReportRow) {
    const mail = options.mail;
    if (!mail?.on || !mail.to().length) return;
    const day = Math.floor(now() / DAY);
    if (mailed.day !== day) Object.assign(mailed, { day, count: 0 });
    if (mailed.count >= RATES.mailsPerDay) return;
    if (!await store.claimNotify(report.id, now())) return;
    mailed.count++;
    const first = oneLine(report.description.split("\n").find(line => line.trim()) ?? "").slice(0, 90);
    const feedback = report.source === "feedback";
    const subject = `${feedback ? "feedback" : "bug report"} ${report.id}: ${first}`;
    const { html, text: body } = render(mail.email, { subject, preheader: first, tag: "admin", say: feedback ? "someone sent feedback" : "someone hit a bug", accent: "pink",
      status: feedback ? ["new feedback", "ok"] : ["new report", "bad"],
      blocks: [{ t: "h1", text: feedback ? "new feedback from the app" : "a new @devs report" },
        { t: "facts", rows: [["report", report.id], ["app", `${report.appVersion} on ${report.platform}`], ["reply to", report.contact ?? "no address"],
          ...(report.images ? [["images", String(report.images)] as [string, string]] : [])] },
        { t: "log", text: report.description.slice(0, 2_000) },
        { t: "button", label: "open bug reports", href: mail.panelUrl }],
      reason: "you got this because your address gets the Metal alert emails. one email per report, never a repeat." });
    for (const mailer of mail.mailers) {
      try { await Promise.all(mail.to().map(to => mailer.send({ to, subject, text: body, html }))); return; } catch { /* the next mailer */ }
    }
    log(`the email for report ${report.id} failed`);
  }

  async function receive(req: IncomingMessage, res: ServerResponse) {
    limit(`ip:${options.ip(req)}`, RATES.reportsPerAddressHour);
    const raw = await readCapped(req, BUG_REPORT_LIMITS.bodyWithImages);
    const input = options.bodyObject(raw);
    if (raw.length > BUG_REPORT_LIMITS.body && !hasImages(input)) throw new BugReportError(413, "too_large", `The report is larger than ${Math.round(BUG_REPORT_LIMITS.body / 1024)} KB.`);
    const report = parseBugReport(input);
    limit(`install:${report.installId}`, RATES.reportsPerInstallHour);
    const hash = createHash("sha256").update(JSON.stringify([report.source, report.description, report.appVersion, report.platform, report.diagnostics, report.contact,
      ...report.images.map(image => createHash("sha256").update(image.bytes).digest("base64url"))])).digest("base64url");
    let kept: { report: BugReportRow; fresh: boolean } | null = null;
    for (let attempt = 0; !kept; attempt++) {
      try { kept = await store.add({ ...report, id: newReportId(), hash, receivedAt: now() }, now() - RATES.dedupeMs); }
      catch (error) { if (attempt >= 3 || !(error instanceof Error && error.message === "bug report id taken")) throw error; }
    }
    json(res, 201, { id: kept.report.id });
    if (kept.fresh) void notify(kept.report).catch(() => log("an email could not be sent"));
  }

  /** a signed question is a Cloud home's: valid only from a known machine, and it may tell about fixes only while its plan runs */
  function homeVerdict(req: IncomingMessage, body: Buffer): "unsigned" | "running" | "ended" {
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : ""; };
    const machine = header("x-dusk-cloud-machine"), timestamp = header("x-dusk-cloud-timestamp"), nonce = header("x-dusk-cloud-nonce"), signature = header("x-dusk-cloud-signature");
    if (!machine && !signature) return "unsigned";
    const bad = () => new BugReportError(401, "invalid_signature", "The signature is not valid.");
    const cloud = options.clouds?.get(machine);
    const time = now();
    for (const [key, until] of nonces) if (until <= time) nonces.delete(key);
    if (!cloud || !cloud.bootstrapSecret || !/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) * 1000 - time) > 300_000
      || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || nonces.has(`${machine}:${nonce}`) || nonces.size >= 10_000) throw bad();
    try {
      const expected = Buffer.from(`v1=${bugReportsHomeSignature(options.clouds!.unseal(cloud.bootstrapSecret), machine, timestamp, nonce, body.toString("utf8"))}`), actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw bad();
    } catch { throw bad(); }
    nonces.set(`${machine}:${nonce}`, time + 600_000);
    const ended = ["destroyed", "destroying", "suspended", "checkout"].includes(cloud.status) || !!cloud.ended || cloud.suspended !== null
      || (cloud.endsAt !== undefined && cloud.endsAt <= time) || (cloud.destroyAt !== null && cloud.destroyAt <= time);
    return ended ? "ended" : "running";
  }

  async function answerStatus(req: IncomingMessage, res: ServerResponse) {
    limit(`status:${options.ip(req)}`, RATES.statusPerAddressHour);
    const body = await readCapped(req, 16 * 1024);
    const verdict = homeVerdict(req, body);
    const input = options.bodyObject(body);
    const installId = text(input.installId);
    if (!INSTALL_ID.test(installId)) throw new BugReportError(400, "invalid_install", "Invalid installId.");
    if (!Array.isArray(input.ids) || input.ids.length > BUG_REPORT_LIMITS.statusIds || !input.ids.every(id => typeof id === "string" && REPORT_ID.test(id)))
      throw new BugReportError(400, "invalid_ids", `ids must be up to ${BUG_REPORT_LIMITS.statusIds} report ids.`);
    const ids = [...new Set(input.ids as string[])];
    const known = new Map((await store.statuses(installId, ids)).map(item => [item.id, item]));
    const reports = ids.map(id => {
      const item = known.get(id);
      if (!item) return { id, status: "unknown" as const, fixedIn: null };
      const status = desktopStatus(item.status);
      return { id, status, fixedIn: status === "fixed" && item.fixedIn && VERSION.test(item.fixedIn) ? item.fixedIn : null };
    });
    json(res, 200, { reports, notify: verdict !== "ended" });
  }

  const integer = (value: string | null, min: number, max: number) => {
    const n = Number(value);
    if (value === null || value === "" || !Number.isSafeInteger(n) || n < min || n > max) throw new BugReportError(400, "invalid_request", "Invalid request.");
    return n;
  };
  const isStatus = (value: unknown): value is BugReportStatus => typeof value === "string" && (BUG_REPORT_STATUSES as readonly string[]).includes(value);

  /** errors answer here, so a limit carries its wait as Retry-After and retryAfter, as the desktop reads it */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    try { return await route(req, res, url); } catch (error) {
      if (!(error instanceof BugReportError)) throw error;
      if (error.retryAfter !== undefined) res.setHeader("retry-after", String(error.retryAfter));
      json(res, error.status, { error: error.message, code: error.code, ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) });
      return true;
    }
  }
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET", path = url.pathname;
    if (path === BUG_REPORT_PATH || path === BUG_REPORT_STATUS_PATH) {
      if (method !== "POST") throw new BugReportError(405, "method_not_allowed", "Use POST.");
      if (path === BUG_REPORT_PATH) await receive(req, res); else await answerStatus(req, res);
      return true;
    }
    if (path !== "/v1/admin/bug-reports" && !path.startsWith("/v1/admin/bug-reports/")) return false;
    if (method === "GET" && path === "/v1/admin/bug-reports") {
      options.admin(req, false);
      const limitRows = url.searchParams.has("limit") ? integer(url.searchParams.get("limit"), 1, 100) : 30;
      const before = url.searchParams.has("before") ? integer(url.searchParams.get("before"), 1, Number.MAX_SAFE_INTEGER) : undefined;
      const status = url.searchParams.get("status") || undefined;
      if (status !== undefined && !isStatus(status)) throw new BugReportError(400, "invalid_request", "Invalid status.");
      const [reports, counts] = await Promise.all([store.list({ limit: limitRows, before, status }), store.counts()]);
      json(res, 200, { reports, counts, next: reports.length === limitRows ? reports.at(-1)!.receivedAt : null });
      return true;
    }
    const picture = /^\/v1\/admin\/bug-reports\/([A-Za-z0-9_-]{1,64})\/images\/(\d{1,2})$/.exec(path);
    if (picture && method === "GET") {
      options.admin(req, false);
      const image = await store.image(picture[1]!, Number(picture[2]));
      if (!image) throw new BugReportError(404, "not_found", "No such image.");
      // security: a picture someone sent is served as itself and nothing else, never as a page
      res.writeHead(200, { "content-type": image.mime, "content-length": image.bytes.length, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" });
      res.end(image.bytes);
      return true;
    }
    const one = /^\/v1\/admin\/bug-reports\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (one && method === "GET") {
      options.admin(req, false);
      const report = await store.get(one[1]!);
      if (!report) throw new BugReportError(404, "not_found", "No such report.");
      json(res, 200, { report });
      return true;
    }
    if (one && method === "PATCH") {
      const actor = options.admin(req, true);
      const input = options.bodyObject(await readCapped(req, 4 * 1024));
      if (!isStatus(input.status)) throw new BugReportError(400, "invalid_request", `status must be one of ${BUG_REPORT_STATUSES.join(", ")}.`);
      const fixedIn = input.status === "fixed" && input.fixedIn !== undefined && input.fixedIn !== null && input.fixedIn !== "" ? text(input.fixedIn).trim() : null;
      if (fixedIn !== null && !VERSION.test(fixedIn)) throw new BugReportError(400, "invalid_request", "fixedIn must be a version like 0.1.150.");
      const report = await store.setStatus(one[1]!, input.status, fixedIn, now());
      if (!report) throw new BugReportError(404, "not_found", "No such report.");
      options.audit?.(actor, "bug_report.status", report.id, { status: report.status, fixedIn: report.fixedIn });
      json(res, 200, { report });
      return true;
    }
    options.admin(req, false);
    throw new BugReportError(404, "not_found", "Not found.");
  }

  return { handle, notify };
}
export type BugReports = ReturnType<typeof createBugReports>;
