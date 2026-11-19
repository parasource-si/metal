import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageSignalsSwitch } from "./usage-signals-switch.ts";

describe("help improve Metal switch, one setting with the account's", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const make = () => { const dir = mkdtempSync(join(tmpdir(), "usage-switch-")); dirs.push(dir); return { dir, open: () => createUsageSignalsSwitch(dir, {}) }; };

  it("keeps a change made in the app until a report carries it, across a restart", () => {
    const { open } = make(), first = open();
    expect(first.pending()).toBeNull();
    first.set({ enabled: false });
    expect(first.pending()).toBe(true);
    const again = open();
    expect(again.enabled()).toBe(false); expect(again.pending()).toBe(true);
    again.pushed(false);
    expect(again.pending()).toBe(true);
    again.pushed(true);
    expect(again.pending()).toBeNull();
    expect(open().pending()).toBeNull();
  });
  it("turns off when the account turned it off, and back on when the account turns it on again", () => {
    const { open } = make(), sw = open();
    expect(sw.fromAccount(false)).toBeNull(); expect(sw.enabled()).toBe(true);
    expect(sw.fromAccount(true)).toEqual({ enabled: false }); expect(sw.enabled()).toBe(false);
    expect(open().enabled()).toBe(false);
    expect(sw.pending()).toBeNull();
    expect(sw.fromAccount(true)).toBeNull();
    expect(sw.fromAccount(false)).toEqual({ enabled: true }); expect(sw.enabled()).toBe(true);
  });
  it("never lets an answer undo a change the account has not heard yet", () => {
    const { open } = make(), sw = open();
    sw.fromAccount(false);
    sw.set({ enabled: false });
    expect(sw.fromAccount(false)).toBeNull(); expect(sw.enabled()).toBe(false);
    sw.pushed(true);
    expect(sw.fromAccount(true)).toBeNull(); expect(sw.enabled()).toBe(false);
    // the person turns it on in the app while the account still says off: the app's change goes up and wins
    sw.set({ enabled: true });
    expect(sw.fromAccount(true)).toBeNull(); expect(sw.enabled()).toBe(true); expect(sw.pending()).toBe(false);
  });
  it("tells the account about a choice made before the account was in the loop", () => {
    const { dir, open } = make();
    createUsageSignalsSwitch(dir, {}).set({ enabled: false });
    const file = join(dir, "usage-signals.json"), saved = JSON.parse(readFileSync(file, "utf8"));
    delete saved.push;
    writeFileSync(file, JSON.stringify(saved));
    const sw = open();
    expect(sw.pending()).toBeNull();
    expect(sw.fromAccount(false)).toBeNull();
    expect(sw.pending()).toBe(true); expect(sw.enabled()).toBe(false);
  });
});
