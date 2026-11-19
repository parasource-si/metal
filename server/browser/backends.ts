// Where a profile's browser runs. Everything above the CDP connection (tools, control, viewers) is the same on every
// backend; a backend only decides how that connection is made and what the browser it reaches can do.
import { CdpBrowser, type BrowserOptions } from "./cdp/browser.ts";
import { loopbackPage, openOwnPage } from "./chrome/calibrate.ts";
import type { Identity } from "./cdp/identity.ts";
import { fitPage, pageLimit, type BrowserMode, type HostKind, type ScreenSpec } from "./chrome/flags.ts";
import { launchChrome, type ChromeProcess, type LaunchOptions } from "./chrome/launch.ts";
import { clearSingleton, staleSingletonLock, type ProcessRegistry } from "./chrome/processes.ts";
import { languageList } from "./chrome/wrapper.ts";
import { downgradeRefusal, ensureProfile, forgetOpenTabs, markCleanExit, profileDir, profileHash, recordOpenedBy, versionOf, workspaceId } from "./chrome/profile.ts";

export type BackendKind = "local" | "my-chrome" | "cdp-url";

export interface BackendCaps {
  persistentProfile: boolean;
  window: boolean;
  egressGate: boolean;
  identityOverride: boolean;
  /** False for the person's own Chrome: the bot acts only in tabs it opened. */
  ownsAllTabs: boolean;
  downloads: "local" | "none";
  uploads: "path" | "inject";
  botPasskeys: boolean;
}

export interface OpenRequest {
  key: string;
  mode: BrowserMode;
  /** Opens on one blank tab instead of reopening the last session's tabs. */
  fresh: boolean;
  viewport: { width: number; height: number };
  downloadDir: string;
}

export interface OpenedBrowser {
  readonly browser: CdpBrowser;
  /** The largest page its windows may show, as no real window is larger than its screen; null where Metal sizes no window. */
  readonly pageLimit?: { width: number; height: number } | null;
  readonly pid: number | null;
  /** The Chrome version that answered, e.g. 155.0.8059.80. */
  readonly version: string;
  readonly exited: Promise<void>;
  /** Chrome's own quit: session restore keeps the tabs and session cookies. */
  close(): Promise<void>;
}

export interface Backend {
  readonly kind: BackendKind;
  readonly caps: BackendCaps;
  open(request: OpenRequest): Promise<OpenedBrowser>;
}

export interface ResolvedBinary {
  path: string;
  identity: Identity;
}

export interface LocalBackendOptions {
  dataDir: string;
  host: HostKind;
  platform?: NodeJS.Platform;
  binary(): Promise<ResolvedBinary>;
  screen(): Promise<ScreenSpec>;
  /** The person's language, for --lang and the Accept-Language a page sees. */
  locale?: () => string | null;
  timezone?: () => string | null;
  /** The egress gate for this profile's Chrome; null runs it without one. */
  egressPort(key: string): Promise<number | null>;
  registry?: ProcessRegistry | null;
  /** False only when an operator turned Chrome's sandbox off. */
  sandbox?: boolean;
  sandboxHelper?: string | null;
  acceptLanguages?: () => string;
  handshakeTimeoutMs?: number;
  log?: (line: string) => void;
  /** Starts Chrome; tests pass a fake. */
  launch?: (options: LaunchOptions) => Promise<ChromeProcess>;
}

const LOCAL_CAPS: BackendCaps = { persistentProfile: true, window: true, egressGate: true, identityOverride: true, ownsAllTabs: true, downloads: "local", uploads: "path", botPasskeys: true };

/** A Chrome Metal launches on a profile folder of its own, driven over its DevTools pipe. */
export class LocalBackend implements Backend {
  readonly kind = "local" as const;
  readonly caps = LOCAL_CAPS;
  readonly #options: LocalBackendOptions;

  constructor(options: LocalBackendOptions) {
    this.#options = options;
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    const options = this.#options;
    const platform = options.platform ?? process.platform;
    const release = options.registry?.reserve(profileDir(options.dataDir, request.key));
    try {
      return await this.#open(request, platform);
    } finally {
      release?.();
    }
  }

  async #open(request: OpenRequest, platform: NodeJS.Platform): Promise<OpenedBrowser> {
    const options = this.#options;
    const binary = await options.binary();
    const { dir, record, created } = ensureProfile(options.dataDir, request.key, { acceptLanguages: options.acceptLanguages?.() ?? "en-US,en" });
    const binaryVersion = versionOf(binary.identity.product);
    const refusal = downgradeRefusal(record, binaryVersion);
    if (refusal) throw new Error(refusal);
    if (staleSingletonLock(dir)) clearSingleton(dir);
    markCleanExit(dir);
    if (request.fresh) forgetOpenTabs(dir);
    const headless = request.mode === "headless";
    const locale = options.locale?.() ?? null;
    const egressPort = await options.egressPort(request.key);
    const screen = headless ? await options.screen() : null;
    const limit = screen ? pageLimit(screen, platform) : null;
    const viewport = fitPage(request.viewport, limit);
    const chrome: ChromeProcess = await (options.launch ?? launchChrome)({
      executablePath: binary.path,
      userDataDir: dir,
      mode: request.mode,
      host: options.host,
      platform,
      userAgent: headless ? binary.identity.userAgent : null,
      screen,
      locale,
      egressPort,
      sandbox: options.sandbox ?? true,
      startUrl: request.fresh || created ? "about:blank" : null,
      viewport,
      timezone: options.timezone?.() ?? null,
      sandboxHelper: options.sandboxHelper ?? null,
      profileMarker: profileHash(workspaceId(options.dataDir), request.key),
      registry: options.registry ?? null,
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    });
    const version = versionOf(chrome.version.product);
    try {
      recordOpenedBy(dir, version);
      const browserOptions: BrowserOptions = {
        identity: headless ? binary.identity : null,
        acceptLanguage: locale ? languageList(locale) : undefined,
        headless,
        downloadDir: request.downloadDir,
        platform,
        maxPages: 8,
        viewport: headless ? viewport : null,
        screen: screen ? { width: screen.width, height: screen.height } : null,
        handleAuth: true,
      };
      const browser = await CdpBrowser.connect(chrome.transport, browserOptions);
      if (created && platform === "win32") await takeFirstNavigation(browser).catch(() => undefined);
      return {
        browser,
        pageLimit: limit,
        pid: chrome.pid,
        version,
        exited: chrome.exited.then(() => undefined),
        async close() {
          await browser.close();
          await chrome.close(5_000);
        },
      };
    } catch (error) {
      await chrome.kill();
      throw error;
    }
  }
}

/** A page of our own, in a tab of its own, takes the cancel `openOwnPage` describes before a bot's first page can: none of
 * 60 fresh starts on GitHub's Windows runner cancelled the bot's first navigation after it. */
async function takeFirstNavigation(browser: CdpBrowser): Promise<void> {
  const first = browser.activePage;
  const page = await loopbackPage();
  try {
    const tab = await browser.newPage();
    const gone = new Promise<void>((resolve) => {
      const off = browser.onPageClosed((closed) => { if (closed === tab) { off(); resolve(); } });
    });
    try {
      await openOwnPage(tab, page.url, 15_000);
    } finally {
      await browser.closePage(tab);
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  } finally {
    page.close();
    if (first && !first.closed) await browser.bringToFront(first);
  }
}
