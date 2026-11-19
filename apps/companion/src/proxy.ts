// The forwarding half of the sidecar. The harness serves only a loopback Host
// (a DNS-rebinding defence), so a device's request is replayed to 127.0.0.1
// as this process, never with the device's Host or Origin.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";

import { admitPhoneAppRequest, answerPhoneAppPreflight, isPhoneAppOrigin } from "./app-origin.ts";
import { bearerToken } from "./devices.ts";
import type { createMobileSessions } from "./mobile.ts";
import { createMobileAdmission, NOT_HERE, sessionEndedHere } from "./mobile-admit.ts";
import {
  COMPANION_ENDPOINT_KINDS,
  MAX_COMPANION_ENDPOINTS,
  type CompanionEndpoint,
} from "./endpoints.ts";
import {
  denyReason,
  isBrowserControlAccess,
  isCloudDesktopAccess,
  isMessageFileDownload,
} from "./routes.ts";
import { sendTunnelJson } from "./tunnel-gzip.ts";
import { CompanionViewerRelay, requestTarget } from "./viewer-relay.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";
import { hasTokenPrefix } from "../../../electron/legacy-names.mjs";

export interface ProxyOptions {
  harnessPort: number;
  mobile?: ReturnType<typeof createMobileSessions>;
  /** null: bootstrap is not ready yet; undefined: a plain Node harness. */
  mutationToken?: () => string | null;
  authenticate: (
    token: string | undefined,
  ) => { id?: string; cloudDesktopAccess: boolean; browserControlAccess: boolean } | null;
  /** Pairing is handled here and never forwarded: the harness has no such route. */
  redeem: (
    code: string,
    deviceName: unknown,
    pairRequestId?: unknown,
  ) => { token: string; device: unknown } | { error: string };
  serverName: () => string;
  /** Every host the phone could dial later, best first, sent with the pairing
   * response as an advisory fallback list. */
  hosts?: () => string[];
  /** Complete connection URLs for mobile clients. */
  endpoints?: () => CompanionEndpoint[];
  /** Register one authenticated, live event stream. The tracker can terminate
   * it synchronously on revoke; the returned disposer is called exactly once. */
  connected?: (deviceId: string, disconnect: () => void) => () => void;
  headersTimeoutMs?: number;
}

export interface CompanionEndpointSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
}

/** Headers only: an SSE stream deliberately never ends, so the body has no
 * deadline. */
const HEADERS_TIMEOUT_MS = 30_000;
// Must outlast the server's 90-second private-save deadline and stay inside
// the hosted proxy's.
const PHONE_SECRET_HEADERS_TIMEOUT_MS = 105_000;
const PHONE_SECRET_PROVIDE_PATH = /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide(?:\?|$)/;

export function proxyHeadersTimeoutMs(url: string, override?: number): number {
  return override
    ?? (PHONE_SECRET_PROVIDE_PATH.test(url) ? PHONE_SECRET_HEADERS_TIMEOUT_MS : HEADERS_TIMEOUT_MS);
}

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/** Bounded: an unbounded read on an unauthenticated route is a
 * memory-exhaustion vector. */
const readJson = (req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

const isPlainValue = (value: unknown): value is string | number | null | undefined =>
  value == null || typeof value === "string" || typeof value === "number";

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

/** Responses can cross a public CDN on the managed HTTPS endpoint, so none may
 * become a shared cache entry. Overrides the harness's own headers. */
const privateHeaders = (headers: IncomingMessage["headers"] = {}): IncomingMessage["headers"] => ({
  ...headers,
  ...PRIVATE_RESPONSE_HEADERS,
});

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  const headers = { "content-type": "application/json", ...PRIVATE_RESPONSE_HEADERS };
  if (sendTunnelJson(res, status, headers, text)) return;
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/** Validated and capped at the network boundary so no producer can publish an
 * extra field, a path-bearing URL or an unbounded list. */
const endpointSnapshot = (options: ProxyOptions): CompanionEndpointSnapshot => {
  const endpoints: CompanionEndpoint[] = [];
  const seen = new Set<string>();
  for (const candidate of options.endpoints?.() ?? []) {
    if (endpoints.length >= MAX_COMPANION_ENDPOINTS) break;
    if (
      !candidate ||
      !COMPANION_ENDPOINT_KINDS.includes(candidate.kind) ||
      typeof candidate.url !== "string" ||
      !Number.isSafeInteger(candidate.priority) ||
      candidate.priority < 0 ||
      candidate.priority > 10_000 ||
      Buffer.byteLength(candidate.url) > 2_048
    ) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      continue;
    }
    const url = parsed.origin;
    if (seen.has(url)) continue;
    seen.add(url);
    endpoints.push({
      kind: candidate.kind,
      priority: candidate.priority,
      url,
    });
  }
  return {
    serverName: [...options.serverName()].slice(0, 200).join(""),
    endpoints,
  };
};

export function companionIdentityHeaders(authenticatedDeviceId?: string, mutationToken?: string): Record<string, string> {
  const out: Record<string, string> = {
    // Carries no authority; it only narrows behavior at the harness.
    "x-dusk-companion": "1",
  };
  // Never a caller-supplied header: this id comes only from the registry entry
  // that authenticated the bearer.
  if (authenticatedDeviceId && /^[\w-]{1,128}$/.test(authenticatedDeviceId)) {
    out["x-dusk-companion-device"] = authenticatedDeviceId;
    if (mutationToken) out["x-dusk-companion-auth"] = mutationToken;
  }
  return out;
}

/** An allowlist: `host` and `origin` must not travel, `authorization` is the
 * sidecar's own credential, and hop-by-hop headers are not ours to relay. */
const forwardHeaders = (req: IncomingMessage, authenticatedDeviceId?: string, mutationToken?: string, companion = true): Record<string, string> => {
  const out: Record<string, string> = {
    accept: String(req.headers.accept ?? "*/*"),
    ...(companion ? companionIdentityHeaders(authenticatedDeviceId, mutationToken) : {}),
  };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // A trustworthy byte count lets the harness reserve disk quota up front.
  const contentLength = req.headers["content-length"];
  if (
    typeof contentLength === "string"
    && /^(?:0|[1-9]\d*)$/.test(contentLength)
    && Number.isSafeInteger(Number(contentLength))
  ) {
    out["content-length"] = contentLength;
  }
  // Last-Event-ID lets a reconnecting client resume instead of re-hydrating.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  // Only canonical single-range shapes travel; anything else gets the
  // complete file.
  const range = req.headers.range;
  if (typeof range === "string") {
    const canonical = range.trim();
    if (/^bytes=\d*-\d*$/.test(canonical)) out.range = canonical;
  }
  return out;
};

const redeemCalls: number[] = [];
const remoteHeaders = (req: IncomingMessage): Record<string, string> => ({
  "x-forwarded-for": isIP(req.socket.remoteAddress ?? "") ? req.socket.remoteAddress! : "192.0.2.11",
  "x-forwarded-proto": (req.socket as TLSSocket).encrypted || !req.socket.remoteAddress ? "https" : "http",
});

const responseHeaders = (headers: IncomingMessage["headers"]): IncomingMessage["headers"] => {
  const out = { ...headers };
  const hopHeaders = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "te", "trailer", "transfer-encoding", "upgrade",
    ...String(headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()),
  ];
  for (const name of hopHeaders) delete out[name];
  return privateHeaders(out);
};

const readBytes = async (stream: IncomingMessage, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const forgetMobile = (options: ProxyOptions, token: string): void => {
  try {
    options.mobile?.forget(token);
  } catch {
    console.warn("companion: could not save mobile session removal");
  }
};

type Admission = ReturnType<typeof createMobileAdmission>;

const endedHere = (options: ProxyOptions, admission: Admission, token: string): Promise<boolean> =>
  sessionEndedHere(options.mobile?.environmentOf(token) ?? null, () => admission.environment());

function forwardMobile(req: IncomingMessage, res: ServerResponse, options: ProxyOptions, admission: Admission, token?: string): void {
  const redeem = token === undefined;
  const headers = { ...forwardHeaders(req, undefined, undefined, false), ...remoteHeaders(req) };
  if (redeem) {
    delete headers["last-event-id"];
    delete headers.range;
  } else {
    headers.authorization = `Bearer ${token}`;
  }
  let timedOut = false;
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: options.harnessPort,
    method: req.method,
    path: req.url,
    headers,
  }, (harness) => {
    clearTimeout(deadline);
    if (token && harness.statusCode === 401) {
      void endedHere(options, admission, token).then((ended) => {
        if (!ended) {
          harness.resume();
          return sendJson(res, NOT_HERE.status, NOT_HERE.body);
        }
        forgetMobile(options, token);
        res.writeHead(401, responseHeaders(harness.headers));
        harness.on("error", () => res.destroy());
        harness.pipe(res);
      });
      return;
    }
    if (redeem) {
      void readBytes(harness, 256 * 1024).then((body) => {
        if (harness.statusCode === 200) {
          let parsed;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            parsed = null;
          }
          if (typeof parsed?.token === "string" && typeof parsed?.device?.id === "string") {
            options.mobile?.remember(parsed.token, parsed.device.id, typeof parsed.workspace?.environmentId === "string" ? parsed.workspace.environmentId : null);
          }
        }
        res.writeHead(harness.statusCode ?? 502, {
          "content-type": "application/json",
          "content-length": body.length,
          ...PRIVATE_RESPONSE_HEADERS,
        });
        res.end(body);
      }).catch(() => sendJson(res, 502, { error: "could not read the mobile pairing response" }));
      return;
    }
    res.writeHead(harness.statusCode ?? 502, responseHeaders(harness.headers));
    if (String(harness.headers["content-type"] ?? "").includes("text/event-stream")) {
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      res.socket?.setKeepAlive(true, 30_000);
    }
    harness.on("error", () => res.destroy());
    res.on("close", () => harness.destroy());
    harness.pipe(res);
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    upstream.destroy();
  }, proxyHeadersTimeoutMs(req.url ?? "", options.headersTimeoutMs));
  deadline.unref?.();
  upstream.on("close", () => clearTimeout(deadline));
  upstream.on("error", () => {
    clearTimeout(deadline);
    if (res.destroyed || res.writableEnded) return;
    sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? "Metal did not respond" : "Metal is not running on this computer",
    });
  });
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.on("error", () => upstream.destroy());
  if (redeem) {
    void readBytes(req, 64 * 1024).then((body) => upstream.end(body)).catch(() => {
      clearTimeout(deadline);
      sendJson(res, 413, { error: "mobile pairing body too large" });
      upstream.destroy();
    });
  } else {
    req.pipe(upstream);
  }
}

function upgradeMobile(req: IncomingMessage, socket: Duplex, head: Buffer, options: ProxyOptions, admission: Admission, token: string): void {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    upgrade: String(req.headers.upgrade ?? "websocket"),
    connection: "Upgrade",
    ...remoteHeaders(req),
  };
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = String(value);
  }
  const writeHeaders = (harness: IncomingMessage, status: string, upgraded = true): void => {
    const lines = [`HTTP/1.1 ${status}`];
    if (upgraded) {
      for (let i = 0; i < harness.rawHeaders.length; i += 2) {
        lines.push(`${harness.rawHeaders[i]}: ${harness.rawHeaders[i + 1]}`);
      }
    } else {
      for (const [name, value] of Object.entries(responseHeaders(harness.headers))) {
        for (const item of [value].flat()) {
          if (item !== undefined) lines.push(`${name}: ${item}`);
        }
      }
      lines.push("connection: close");
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  };
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: options.harnessPort,
    method: "GET",
    path: req.url,
    headers,
  });
  const deadline = setTimeout(() => upstream.destroy(), proxyHeadersTimeoutMs(req.url ?? "", options.headersTimeoutMs));
  deadline.unref?.();
  upstream.on("upgrade", (harness, peer, harnessHead) => {
    clearTimeout(deadline);
    writeHeaders(harness, "101 Switching Protocols");
    socket.write(harnessHead);
    peer.write(head);
    const close = () => { socket.destroy(); peer.destroy(); };
    socket.on("error", close);
    socket.on("close", close);
    peer.on("error", close);
    peer.on("close", close);
    socket.pipe(peer).pipe(socket);
  });
  upstream.on("response", async (harness) => {
    clearTimeout(deadline);
    if (harness.statusCode === 401) {
      if (!await endedHere(options, admission, token)) {
        harness.resume();
        socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify(NOT_HERE.body)}`);
        return;
      }
      forgetMobile(options, token);
    }
    writeHeaders(harness, `${harness.statusCode ?? 502} ${harness.statusMessage ?? ""}`, false);
    harness.on("error", () => socket.destroy());
    socket.on("close", () => harness.destroy());
    harness.pipe(socket);
  });
  upstream.on("close", () => clearTimeout(deadline));
  upstream.on("error", () => { clearTimeout(deadline); socket.destroy(); });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.end();
}

/** Read-only (`action: "check"`); every failure is "no". */
function harnessControlCheck(options: ProxyOptions) {
  return (deviceId: string, botId: string, controlLeaseId: string): Promise<boolean> => new Promise((resolve) => {
    const mutationToken = options.mutationToken?.();
    if (options.mutationToken && !mutationToken) return resolve(false);
    const body = JSON.stringify({ action: "check", controlLeaseId });
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-dusk-companion": "1",
      "x-dusk-companion-device": deviceId,
    };
    if (mutationToken) headers["x-dusk-companion-auth"] = mutationToken;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: options.harnessPort,
      path: `/api/bots/${encodeURIComponent(botId)}/computer/control`,
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) return request.destroy();
        chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { owned?: unknown };
          resolve(response.statusCode === 200 && parsed.owned === true);
        } catch {
          resolve(false);
        }
      });
      response.once("error", () => resolve(false));
    });
    request.setTimeout(5_000, () => request.destroy());
    request.once("error", () => resolve(false));
    request.end(body);
  });
}

/** an unremembered session: the harness says whether it is one of its phones, paired through the relay */
async function admitMobile(options: ProxyOptions, admission: Admission, req: IncomingMessage, token: string): Promise<{ status: number; body: unknown } | "forward" | "not-phone"> {
  const verdict = await admission.admit(token, remoteHeaders(req), req.socket.remoteAddress ?? "");
  if (verdict.kind === "phone") {
    try {
      options.mobile?.remember(token, verdict.deviceId, verdict.environmentId);
    } catch {
      console.warn("companion: could not save a relay-paired phone");
    }
    return "forward";
  }
  if (verdict.kind === "not-phone") return "not-phone";
  if (verdict.kind === "unknown") return NOT_HERE;
  if (verdict.kind === "limited") return { status: 503, body: { error: "too many phone checks; try again in a minute", code: "limited" } };
  return { status: 502, body: { error: "Metal is not running on this computer" } };
}

export function createProxyHandler(options: ProxyOptions) {
  const admission = createMobileAdmission({ harnessPort: options.harnessPort });
  const viewers = new CompanionViewerRelay({ checkControl: harnessControlCheck(options) });
  const capabilityStreams = new Map<string, Set<() => void>>();
  const handle = function handle(req: IncomingMessage, res: ServerResponse): void {
    const target = requestTarget(req.url);
    if (!target) return sendJson(res, 400, { error: "invalid request target" });
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    const token = bearerToken(req.headers.authorization);
    // Native http sends no Origin. Anything with one is a browser, refused before
    // the token is looked at, except the phone app's own WebView streaming a read.
    const origin = req.headers.origin;
    if (origin) {
      if (isPhoneAppOrigin(origin) && method === "OPTIONS") return answerPhoneAppPreflight(req, res, origin);
      if (!isPhoneAppOrigin(origin) || !admitPhoneAppRequest(req, res, origin, token)) {
        return sendJson(res, 403, { error: "forbidden: cross-origin request" });
      }
    }

    if (method === "POST" && path === "/api/mobile/redeem") {
      if (!options.mobile) {
        const authenticated = Boolean(options.authenticate(token));
        return sendJson(res, authenticated ? 404 : 401, {
          error: authenticated ? `no route: ${method} ${path}` : "pair this device from Remote access settings on the host computer",
        });
      }
      const now = Date.now();
      while (redeemCalls.length && redeemCalls[0] <= now - 60_000) redeemCalls.shift();
      if (redeemCalls.length >= 20) return sendJson(res, 429, { error: "too many mobile pairing attempts" });
      redeemCalls.push(now);
      forwardMobile(req, res, options, admission);
      return;
    }
    if (hasTokenPrefix(token, "sess") && options.mobile?.has(token)) {
      forwardMobile(req, res, options, admission, token);
      return;
    }
    if (hasTokenPrefix(token, "sess") && options.mobile && !options.authenticate(token)) {
      req.pause();
      void admitMobile(options, admission, req, token!).then((verdict) => {
        if (verdict === "forward") return forwardMobile(req, res, options, admission, token);
        req.resume();
        if (verdict === "not-phone") return sendJson(res, 401, { error: "pair this device from Remote access settings on the host computer" });
        sendJson(res, verdict.status, verdict.body);
      });
      return;
    }
    const device = options.authenticate(token);
    const browserRequest = isBrowserControlAccess(method, path);
    const browserRefusal = () => {
      if (!browserRequest) return null;
      const current = options.authenticate(token);
      if (!current || current.id !== device?.id) {
        return { status: 401, error: "pair this device from Remote access settings on the host computer" };
      }
      return current.browserControlAccess ? null : {
        status: 403,
        error: "browser control is off for this device: enable it in Remote access settings on the host computer",
      };
    };
    if (viewers.isViewerPath(req.url)) {
      viewers.handleHttp(req, res, device);
      return;
    }
    const denial = denyReason({
      path,
      method,
      authenticated: Boolean(device),
    });
    if (denial) return sendJson(res, denial.status, { error: denial.error });

    // Pairing grants the ordinary companion surface, not a computer's browser
    // session; the owner enables this per device, off by default.
    if (isCloudDesktopAccess(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "computer access is off for this device: enable it in Metal → Settings → Remote access",
      });
    }

    // A separate grant: this browser is normally signed into the person's own accounts.
    if (isBrowserControlAccess(method, path) && !device?.browserControlAccess) {
      return sendJson(res, 403, {
        error: "browser control is off for this device: open Remote access on the computer and turn on \"Allow browser control\" for it",
      });
    }

    const viewerClose = /^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/.exec(path);
    if (viewerClose && device?.id) viewers.close(device.id, viewerClose[1]);

    if (method === "POST" && path === "/api/pair") {
      readJson(req).then(
        (body) => {
          const credential = body.credential ?? body.code;
          if (!isPlainValue(credential) || !isPlainValue(body.deviceName)) {
            return sendJson(res, 400, { error: "invalid pairing request" });
          }
          const result = options.redeem(
            String(credential ?? ""),
            body.deviceName,
            body.pairRequestId,
          );
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          const hosts = options.hosts?.() ?? [];
          const endpoints = options.endpoints?.() ?? [];
          const response: typeof result & {
            serverName: string;
            hosts?: string[];
            endpoints?: CompanionEndpoint[];
          } = {
            ...result,
            serverName: options.serverName(),
          };
          if (hosts.length) response.hosts = hosts;
          if (endpoints.length) response.endpoints = endpoints;
          return sendJson(res, 201, response);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      ).catch((error: unknown) => {
        console.error("companion: pairing failed", error);
        sendJson(res, 500, { error: "could not complete the pairing" });
      });
      return;
    }

    // Sidecar-owned state: answered here after the bearer and default-deny
    // checks, never sent to the harness.
    if (method === "GET" && path === "/api/companion/endpoints") {
      return sendJson(res, 200, endpointSnapshot(options));
    }

    const mutationToken = device ? options.mutationToken?.() : undefined;
    if (device && options.mutationToken && !mutationToken) {
      return sendJson(res, 503, { error: "The desktop connection is starting. Please try again shortly." });
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.harnessPort,
        path: req.url,
        method,
        headers: forwardHeaders(req, device?.id, mutationToken ?? undefined),
      },
      (harness) => {
        clearTimeout(headersDeadline);
        // A grant revoked while the native browser opens must not expose frames.
        const refusal = browserRefusal();
        if (refusal) {
          harness.destroy();
          return sendJson(res, refusal.status, { error: refusal.error });
        }
        // Health comes from the harness, read under a tiny bound and replaced
        // whole so its pid/static fields never cross the public tunnel.
        if (method === "GET" && path === "/api/health") {
          const chunks: Buffer[] = [];
          let size = 0;
          let finished = false;
          const fail = () => {
            if (finished) return;
            finished = true;
            sendJson(res, 502, { error: "Metal is not ready on this computer" });
          };
          harness.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4_096) {
              harness.destroy();
              fail();
              return;
            }
            chunks.push(chunk);
          });
          harness.on("error", fail);
          harness.on("end", () => {
            if (finished) return;
            let identity: unknown;
            try {
              identity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              fail();
              return;
            }
            // SAFETY: identity is untrusted JSON; the assertion only permits
            // reading one optional property compared to a fixed literal.
            if (
              (harness.statusCode ?? 500) < 200 ||
              (harness.statusCode ?? 500) >= 300 ||
              (identity as { app?: unknown } | null)?.app !== "duskbot"
            ) {
              fail();
              return;
            }
            finished = true;
            sendJson(res, 200, { app: "duskbot" });
          });
          return;
        }

        const contentType = harness.headers["content-type"];
        const isStream = String(contentType ?? "").includes("text/event-stream");

        if (isStream) {
          const streamStatus = harness.statusCode ?? 500;
          const tracksDeviceConnection = method === "GET"
            && path === "/api/events"
            && streamStatus >= 200
            && streamStatus < 300
            && Boolean(device?.id);
          const currentDevice = tracksDeviceConnection ? options.authenticate(token) : device;
          if (tracksDeviceConnection && currentDevice?.id !== device?.id) {
            harness.destroy();
            return sendJson(res, 401, {
              error: "pair this device from Remote access settings on the host computer",
            });
          }
          const disconnect = () => {
            if (!harness.destroyed) harness.destroy();
            if (!res.destroyed) res.destroy();
          };
          let releaseConnection =
            tracksDeviceConnection && currentDevice?.id
              ? options.connected?.(currentDevice.id, disconnect) ?? null
              : null;
          // Capability-only streams must close when the capability is revoked;
          // `connected` covers only /api/events.
          const capabilityOwner = isBrowserControlAccess(method, path) ? device?.id : undefined;
          if (capabilityOwner) {
            const open = capabilityStreams.get(capabilityOwner) ?? new Set<() => void>();
            open.add(disconnect);
            capabilityStreams.set(capabilityOwner, open);
          }
          const release = () => {
            releaseConnection?.();
            releaseConnection = null;
            if (capabilityOwner) {
              const open = capabilityStreams.get(capabilityOwner);
              open?.delete(disconnect);
              if (open && open.size === 0) capabilityStreams.delete(capabilityOwner);
            }
          };
          // content-length is meaningless here, and content-encoding would be a
          // lie once the bytes are rewritten.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            ...PRIVATE_RESPONSE_HEADERS,
            "cache-control": "private, no-store, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);
          // TCP keepalive, so a vanished phone cannot leave the desktop
          // indicator green on a half-open connection.
          res.socket?.setKeepAlive(true, 30_000);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            let rewritten: string;
            try {
              rewritten = scrubStream(chunk);
            } catch {
              // Over the buffer ceiling: half an event cannot be forwarded safely.
              release();
              harness.destroy();
              res.end();
              return;
            }
            if (!rewritten) return;
            // Backpressure, or a slow phone buffers unbounded in this process.
            if (!res.write(rewritten)) harness.pause();
          });
          res.on("drain", () => harness.resume());
          harness.on("end", () => {
            release();
            res.end();
          });
          harness.on("error", () => {
            release();
            res.destroy();
          });
          // Otherwise the harness accumulates readers nobody is listening to.
          res.on("close", () => {
            release();
            harness.destroy();
          });
          return;
        }

        const encoding = String(harness.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        if (
          isMessageFileDownload(method, path)
          || !isJson(String(contentType ?? ""))
          || (encoding && encoding !== "identity")
        ) {
          // Byte-for-byte, unscrubbed. forwardHeaders never sends
          // accept-encoding, so an encoded body arriving here passes through
          // intact rather than scrubbed and broken.
          res.writeHead(harness.statusCode ?? 200, privateHeaders(harness.headers));
          // `pipe` does not carry a source failure to the destination; without
          // this a half-sent body leaves the phone waiting forever.
          harness.on("error", () => res.destroy());
          harness.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        harness.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_BODY_BYTES) {
            harness.destroy();
            if (res.headersSent) res.destroy();
            else sendJson(res, 502, { error: "the response from Metal was too large" });
            return;
          }
          chunks.push(chunk);
        });
        harness.on("error", () => res.destroy());
        harness.on("end", () => {
          const refusal = browserRefusal();
          if (refusal) return sendJson(res, refusal.status, { error: refusal.error });
          const body = Buffer.concat(chunks).toString("utf8");

          // A body that does not parse was never JSON (or an empty 204):
          // forward it verbatim.
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            forward(body, harness.headers, harness.statusCode ?? 200);
            return;
          }

          // A body that parses but will not scrub must not fall back to raw:
          // scrub keeps the resume cursors off the wire, and it recurses, so
          // deep nesting throws RangeError where JSON.parse does not.
          let text: string;
          try {
            parsed = viewers.rewriteJoinResponse(
              path,
              parsed,
              device?.id,
              target.searchParams.get("controlLeaseId"),
            );
            text = JSON.stringify(scrub(parsed));
          } catch {
            sendJson(res, 502, { error: "the response could not be prepared for this device" });
            return;
          }
          forward(text, harness.headers, harness.statusCode ?? 200);
        });

        /** The body was re-serialised, so the harness's framing headers are
         * dropped: Node's parser rejects transfer-encoding alongside
         * content-length. */
        function forward(text: string, upstreamHeaders: IncomingMessage["headers"], status: number): void {
          const headers = { ...upstreamHeaders };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          const reply = privateHeaders(headers);
          if (sendTunnelJson(res, status, reply, text)) return;
          res.writeHead(status, { ...reply, "content-length": Buffer.byteLength(text) });
          res.end(text);
        }
      },
    );

    // Tear down the upstream whenever the phone goes away; guarded on
    // `writableEnded` so a finished response keeps its keep-alive socket.
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());

    // `http.request` has no deadline of its own for the headers phase.
    let timedOut = false;
    const headersTimeoutMs = proxyHeadersTimeoutMs(req.url ?? "", options.headersTimeoutMs);
    const headersDeadline = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error("the harness sent no response headers"));
    }, headersTimeoutMs);
    headersDeadline.unref?.();

    upstream.on("error", () => {
      clearTimeout(headersDeadline);
      // Headers already sent: writeHead would throw ERR_HTTP_HEADERS_SENT out
      // of an event handler and take the sidecar down, so drop the socket.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      sendJson(
        res,
        timedOut ? 504 : 502,
        timedOut
          ? { error: "Metal did not respond" }
          : { error: "Metal is not running on this computer" },
      );
    });
    req.pipe(upstream);
  };

  handle.upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (req.headers.origin) {
      socket.destroy();
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (hasTokenPrefix(token, "sess") && options.mobile?.has(token)) {
      if (!requestTarget(req.url)) {
        socket.destroy();
        return;
      }
      upgradeMobile(req, socket, head, options, admission, token);
      return;
    }
    if (hasTokenPrefix(token, "sess") && options.mobile && requestTarget(req.url) && !options.authenticate(token)) {
      void admitMobile(options, admission, req, token!).then((verdict) => {
        if (verdict === "forward") upgradeMobile(req, socket, head, options, admission, token!);
        else socket.destroy();
      });
      return;
    }
    const device = options.authenticate(token);
    viewers.handleUpgrade(req, socket, head, device);
  };
  handle.closeViewers = (): void => viewers.closeAll();
  handle.disconnectDevice = (deviceId: string): void => {
    viewers.closeDevice(deviceId);
    // Revoking a capability closes the streams it already granted.
    const open = capabilityStreams.get(deviceId);
    if (!open) return;
    capabilityStreams.delete(deviceId);
    for (const close of open) close();
  };
  return handle;
}
