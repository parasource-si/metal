// @vitest-environment happy-dom
// docs/analytics.md is the promise of what the app sends: anonymous usage, on by default in the desktop app and stopped
// entirely by turning "help improve Metal" off; only the events its table lists; nothing from the phone app.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The event names in the first column of the "## Events" table; one row may name several. */
function eventRows(docs: string): string[] {
  const start = docs.indexOf("\n## Events\n");
  const end = docs.indexOf("\n## ", start + 1);
  return docs.slice(start, end === -1 ? undefined : end).split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) => [...line.split("|")[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("docs/analytics.md", () => {
  it("lists exactly the events the app's client accepts", () => {
    const accepted = [...read("src/lib/product-analytics.ts").matchAll(/case "(app_\w+)":/g)].map((match) => match[1]!);
    expect(accepted.length).toBeGreaterThan(0);
    expect(eventRows(read("docs/analytics.md")).sort()).toEqual([...new Set(accepted)].sort());
  });

  it("says it is on by default and how to turn it off, says the phone app sends none, and names no third-party SDK", () => {
    const docs = read("docs/analytics.md");
    expect(docs).toMatch(/on on a new\s+install \(an opt-out\)/);
    expect(docs).toMatch(/turn it off at any time/);
    expect(docs).toMatch(/phone app sends none/i);
    expect(docs).not.toMatch(/posthog|\bfork\b/i);
    expect(read("README.md")).toMatch(/on until you turn off "help improve Metal"/);
  });

  const harness = async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const relay = { send: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    return { storage, fetcher, relay, client: await import("../../src/lib/product-analytics") };
  };

  it("holds the desktop client to it: on by default, and off stops everything", async () => {
    const { relay, fetcher, client } = await harness();
    client.configure({ origin: null, token: null, relay, platform: "darwin", version: "1.2.3", kind: "desktop", force: true });
    client.feature("bot_created");
    await client.flush();
    expect(relay.send, "a new install sends").toHaveBeenCalledTimes(1);
    client.setUsageAnalytics(false);
    client.feature("bot_created");
    client.action("env", { os: "darwin" });
    client.messageSent();
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.send, "nothing after off").toHaveBeenCalledTimes(1);
    expect(relay.clear).toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("holds the phone app to it: nothing is recorded or sent", async () => {
    const { storage, fetcher, client } = await harness();
    client.configure({ origin: "https://accounts.example", token: null, platform: "ios", version: "1.2.3", kind: "mobile", force: true });
    client.feature("bot_created");
    client.messageSent();
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.has("dusk-install-id")).toBe(false);
  });
});
