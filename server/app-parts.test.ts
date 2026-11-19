import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPartsDownloader, downloadPart, installPart, parsePartsManifest, partInstalled, partSources, verifyMacSignatures, type PartSpec,
} from "./app-parts.ts";
import { browserPartPending, browserEngineStatus, resolveAgentBrowserBinary } from "./browser-engine.ts";
import { createBrowserPartHost, type BrowserPartFrame } from "./host/browser-part.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-parts-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function spec(bytes: Uint8Array, over: Partial<PartSpec> = {}): PartSpec {
  return { name: "browser", id: "ab-1_chrome-2_linux-x64", target: "linux-x64", url: "https://example.test/part.zip", bytes: bytes.length, sha256: sha(bytes), teamId: null, ...over };
}

/** Serves `body`, honouring Range like GitHub's release storage, and counts what it was asked. */
function server(body: Uint8Array, options: { ignoreRange?: boolean; failFirst?: number; cutAt?: number } = {}) {
  const calls: Array<string | null> = [];
  let failures = options.failFirst ?? 0;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    calls.push(range);
    if (failures > 0) { failures -= 1; throw new Error("offline"); }
    const start = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const end = options.cutAt !== undefined && calls.length === 1 ? options.cutAt : body.length;
    const slice = body.subarray(start, end);
    let sent = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(slice); return; }
        if (end < body.length) controller.error(new Error("connection reset"));
        else controller.close();
      },
    });
    return new Response(stream, start > 0
      ? { status: 206, headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } }
      : { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A real zip of a fake browser bundle, as the release ships it. */
function bundleZip(target = "linux-x64"): Uint8Array {
  const root = temp();
  const bundle = join(root, "bundle");
  const chrome = join(bundle, "chrome", "chrome-headless-shell-linux64");
  mkdirSync(chrome, { recursive: true });
  mkdirSync(join(bundle, "licenses"));
  writeFileSync(join(bundle, "agent-browser"), "engine", { mode: 0o755 });
  writeFileSync(join(chrome, "chrome-headless-shell"), "chrome", { mode: 0o755 });
  writeFileSync(join(bundle, "licenses", "README.md"), "licenses");
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ target }));
  execFileSync("zip", ["-qr", join(root, "part.zip"), "."], { cwd: bundle });
  return readFileSync(join(root, "part.zip"));
}

describe("parts manifest", () => {
  it("accepts a pinned https part and refuses anything loose", () => {
    const good = spec(new Uint8Array([1]));
    expect(parsePartsManifest({ v: 1, parts: [good] }).parts[0]).toEqual(good);
    for (const bad of [{ url: "http://example.test/x.zip" }, { sha256: "abc" }, { bytes: 0 }, { id: "../up" }, { teamId: "nope" }, { name: "other" }]) {
      expect(() => parsePartsManifest({ v: 1, parts: [{ ...good, ...bad }] })).toThrow();
    }
    expect(() => parsePartsManifest({ v: 2, parts: [] })).toThrow();
  });
});

describe("downloadPart", () => {
  it("downloads, checks the SHA-256 and keeps the archive", async () => {
    const root = temp();
    const body = new Uint8Array(4096).map((_, index) => index % 251);
    const { fetchImpl } = server(body);
    const file = await downloadPart(spec(body), { root, fetchImpl });
    expect(sha(readFileSync(file))).toBe(sha(body));
  });

  it("refuses bytes that do not match the pinned digest and leaves nothing behind", async () => {
    const root = temp();
    const body = new Uint8Array(512).fill(7);
    const { fetchImpl } = server(body);
    const part = spec(body, { sha256: "0".repeat(64) });
    await expect(downloadPart(part, { root, fetchImpl })).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(root, ".downloads", `${part.sha256}.zip`))).toBe(false);
  });

  it("resumes a cut download where it stopped", async () => {
    const root = temp();
    const body = new Uint8Array(10_000).map((_, index) => index % 13);
    const first = server(body, { cutAt: 6000 });
    await expect(downloadPart(spec(body), { root, fetchImpl: first.fetchImpl })).rejects.toThrow();
    const file = await downloadPart(spec(body), { root, fetchImpl: first.fetchImpl });
    expect(first.calls).toEqual([null, "bytes=6000-"]);
    expect(sha(readFileSync(file))).toBe(sha(body));
  });

  it("starts over when the host ignores the range", async () => {
    const root = temp();
    const body = new Uint8Array(3000).map((_, index) => index % 7);
    mkdirSync(join(root, ".downloads"), { recursive: true });
    writeFileSync(join(root, ".downloads", `${sha(body)}.zip`), body.subarray(0, 1000));
    const { fetchImpl, calls } = server(body, { ignoreRange: true });
    const file = await downloadPart(spec(body), { root, fetchImpl });
    expect(calls).toEqual(["bytes=1000-"]);
    expect(sha(readFileSync(file))).toBe(sha(body));
  });

  it("gives up a connection that stops sending, keeping what came for the next try", async () => {
    const root = temp();
    const body = new Uint8Array(1000).fill(3);
    const fetchImpl = (async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(body.subarray(0, 400)); init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason)); },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(downloadPart(spec(body), { root, fetchImpl, stallMs: 50 })).rejects.toThrow(/stalled/);
    expect(readFileSync(join(root, ".downloads", `${sha(body)}.zip`)).length).toBe(400);
  });

  it("stops a body larger than its pinned size", async () => {
    const root = temp();
    const body = new Uint8Array(2000).fill(1);
    const { fetchImpl } = server(body);
    await expect(downloadPart({ ...spec(body), bytes: 1000 }, { root, fetchImpl })).rejects.toThrow(/larger than its pinned size/);
  });
});

describe("installPart", () => {
  it("unpacks a verified archive and marks it ready", async () => {
    const root = temp();
    const zip = bundleZip();
    const archive = join(temp(), "a.zip");
    writeFileSync(archive, zip);
    const part = spec(zip);
    const directory = await installPart(part, archive, { root, platform: "linux" });
    expect(readFileSync(join(directory, "agent-browser"), "utf8")).toBe("engine");
    expect(partInstalled(root, part)).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  it("installs nothing when a check fails", async () => {
    const root = temp();
    const zip = bundleZip();
    const archive = join(temp(), "a.zip");
    writeFileSync(archive, zip);
    const part = spec(zip);
    await expect(installPart(part, archive, { root, platform: "linux", check: () => { throw new Error("wrong machine"); } })).rejects.toThrow("wrong machine");
    expect(partInstalled(root, part)).toBe(false);
    expect(existsSync(join(root, "browser", part.id))).toBe(false);
  });

  it("asks codesign for every Mach-O, with the app's team when signed", async () => {
    const dir = temp();
    writeFileSync(join(dir, "tool"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    writeFileSync(join(dir, "data.pak"), "not code");
    const exec = vi.fn(async () => ({ code: 0, output: "" }));
    await expect(verifyMacSignatures(dir, "ABCDE12345", exec)).resolves.toBe(1);
    expect(exec).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict", '--test-requirement==anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"', join(dir, "tool")]);
    const refused = vi.fn(async () => ({ code: 3, output: "test-requirement: code failed to satisfy specified code requirement(s)" }));
    await expect(verifyMacSignatures(dir, "ABCDE12345", refused)).rejects.toThrow(/signature check/);
  });
});

describe("createPartsDownloader", () => {
  it("retries a failed download by itself and wakes the waiters once ready", async () => {
    const root = temp();
    const zip = bundleZip();
    const { fetchImpl } = server(zip, { failFirst: 1 });
    const states: string[] = [];
    const downloader = createPartsDownloader({
      manifest: { v: 1, parts: [spec(zip)] }, root, platform: "linux", fetchImpl, retryMs: [10],
      onChange: (_name, state) => states.push(state.phase),
    });
    downloader.start();
    expect(await downloader.ready("browser")).toBe(false);
    await vi.waitFor(() => expect(downloader.state("browser")?.phase).toBe("ready"));
    expect(await downloader.ready("browser")).toBe(true);
    expect(states).toContain("failed");
    expect(states.at(-1)).toBe("ready");
    downloader.stop();
  });

  it("GitHub failing for a downloads-repo part takes dusk.bot's copy on the next try, resuming the kept bytes", async () => {
    const root = temp();
    const zip = bundleZip();
    const github = "https://github.com/DuskBotAI/duskbot-releases/releases/download/v0.2.20/DuskBot-0.2.20-browser-darwin-arm64.zip";
    const mirror = "https://dusk.bot/releases/0.2.20/DuskBot-0.2.20-browser-darwin-arm64.zip";
    expect(partSources(github)).toEqual([github, mirror]);
    const metal = "https://github.com/parasource-si/metal/releases/download/v0.2.20/Metal-0.2.20-browser-darwin-arm64.zip";
    expect(partSources(metal)).toEqual([metal]);
    expect(partSources("https://example.test/part.zip")).toEqual(["https://example.test/part.zip"]);
    const cut = Math.floor(zip.length / 2);
    const asked: Array<[string, string | null]> = [];
    const { fetchImpl: served } = server(zip, { cutAt: cut });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push([url, (init?.headers as Record<string, string> | undefined)?.range ?? null]);
      if (url === github && asked.length > 1) return new Response("unavailable", { status: 503 });
      return served(url, init);
    }) as unknown as typeof fetch;
    const downloader = createPartsDownloader({ manifest: { v: 1, parts: [spec(zip, { url: github })] }, root, platform: "linux", fetchImpl, retryMs: [10] });
    downloader.start();
    await vi.waitFor(() => expect(downloader.state("browser")?.phase).toBe("ready"));
    expect(asked).toEqual([[github, null], [mirror, `bytes=${cut}-`]]);
    downloader.stop();
  });

  it("a download cut partway resumes from the kept bytes on its own retry and lands ready", async () => {
    const root = temp();
    const zip = bundleZip();
    const { fetchImpl, calls } = server(zip, { cutAt: Math.floor(zip.length * 0.8) });
    const downloader = createPartsDownloader({ manifest: { v: 1, parts: [spec(zip)] }, root, platform: "linux", fetchImpl, retryMs: [10] });
    downloader.start();
    await vi.waitFor(() => expect(downloader.state("browser")?.phase).toBe("ready"));
    expect(calls).toEqual([null, `bytes=${Math.floor(zip.length * 0.8)}-`]);
    downloader.stop();
  });

  it("keeps retrying when the one listening throws, without an unhandled rejection", async () => {
    const root = temp();
    const zip = bundleZip();
    const { fetchImpl } = server(zip, { failFirst: 2 });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const downloader = createPartsDownloader({
        manifest: { v: 1, parts: [spec(zip)] }, root, platform: "linux", fetchImpl, retryMs: [10],
        onChange: (_name, state) => { if (state.phase === "failed") throw new Error("listener broke"); },
      });
      downloader.start();
      await vi.waitFor(() => expect(downloader.state("browser")?.phase).toBe("ready"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      downloader.stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a part already unpacked is ready without a download", async () => {
    const root = temp();
    const zip = bundleZip();
    const part = spec(zip);
    const archive = join(temp(), "a.zip");
    writeFileSync(archive, zip);
    await installPart(part, archive, { root, platform: "linux" });
    const { fetchImpl } = server(zip);
    const downloader = createPartsDownloader({ manifest: { v: 1, parts: [part] }, root, platform: "linux", fetchImpl });
    downloader.start();
    expect(await downloader.ready("browser")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the packaged app's browser part", () => {
  function app(zip: Uint8Array) {
    const resources = temp();
    const userData = temp();
    const part = spec(zip, { target: `${process.platform}-${process.arch}` });
    writeFileSync(join(resources, "parts.json"), JSON.stringify({ v: 1, parts: [part] }));
    return { part, env: { DUSK_RESOURCES_PATH: resources, DUSK_USER_DATA: userData, PATH: process.env.PATH } as NodeJS.ProcessEnv };
  }

  it("waits instead of falling back to another browser while it downloads", () => {
    const { env } = app(new Uint8Array([1, 2, 3]));
    expect(browserPartPending(env)).toBe(true);
    expect(resolveAgentBrowserBinary({ env, exists: (path) => !path.includes("browser-engine"), dataDir: temp() })).toBeNull();
    expect(browserEngineStatus({ env, dataDir: temp() })).toMatchObject({ kind: "unavailable", installable: true, reason: expect.stringMatching(/still downloading/) });
  });

  it("an app whose installer carries the browser declares no pending part", () => {
    const { env } = app(new Uint8Array([1]));
    mkdirSync(join(env.DUSK_RESOURCES_PATH!, "browser-engine"));
    expect(browserPartPending(env)).toBe(false);
  });

  it("shows the progress line only in the chats of bots that needed it, and clears it once ready", async () => {
    const zip = bundleZip(`${process.platform}-${process.arch}`);
    const { env } = app(zip);
    const frames: BrowserPartFrame[] = [];
    let ready = 0;
    let finish: (ok: boolean) => void = () => {};
    let onChange: Parameters<typeof createPartsDownloader>[0]["onChange"];
    const host = createBrowserPartHost({
      env, throttleMs: 0, broadcast: (frame) => frames.push(frame), onReady: () => { ready += 1; },
      downloader: (options) => {
        onChange = options.onChange;
        return { start() {}, stop() {}, retry() {}, state: () => null, ready: () => new Promise((resolve) => { finish = resolve; }) };
      },
    });
    onChange!("browser", { phase: "download", received: 10, total: 100 });
    expect(frames).toEqual([]);
    const waiting = host.waitFor("bot-1");
    onChange!("browser", { phase: "download", received: 48, total: 100 });
    expect(frames.at(-1)).toEqual({ kind: "browser-part", phase: "download", received: 48, total: 100, botIds: ["bot-1"] });
    onChange!("browser", { phase: "failed", error: "offline", received: 48, total: 100 });
    finish(false);
    expect(await waiting).toBe(false);
    expect(frames.at(-1)).toMatchObject({ phase: "failed", botIds: ["bot-1"] });
    onChange!("browser", { phase: "ready", directory: "/x" });
    expect(frames.at(-1)).toMatchObject({ phase: "ready" });
    expect(ready).toBe(1);
  });
});
