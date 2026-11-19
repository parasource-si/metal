import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { PAIRING_PRESENCE_REASON, requireUserPresence } from "./user-presence";

describe("requireUserPresence", () => {
  it("asks the desktop app with the pairing reason and passes its answer through", async () => {
    const ask = vi.fn(async () => true);
    expect(await requireUserPresence(undefined, { requireUserPresence: ask })).toBe(true);
    expect(ask).toHaveBeenCalledWith(PAIRING_PRESENCE_REASON);
    expect(await requireUserPresence("x", { requireUserPresence: async () => false })).toBe(false);
  });

  it("treats a check that errors or answers oddly as a no", async () => {
    expect(await requireUserPresence("x", { requireUserPresence: async () => { throw new Error("denied"); } })).toBe(false);
    expect(await requireUserPresence("x", { requireUserPresence: async () => "yes" as unknown as boolean })).toBe(false);
  });

  it("falls back to a confirm on an older desktop app without the check", async () => {
    const confirm = vi.fn(async () => true);
    expect(await requireUserPresence("show a code", { confirm })).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Metal wants to show a code. Continue?");
    const pageConfirm = vi.fn(() => false);
    expect(await requireUserPresence("show a code", {}, pageConfirm)).toBe(false);
    expect(pageConfirm).toHaveBeenCalledOnce();
  });

  it("answers true outside the desktop app, where there is no OS check to ask", async () => {
    expect(await requireUserPresence("x", undefined)).toBe(true);
  });
});

const source = (file: string) => readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
const before = (text: string, gate: string, reveal: string) => {
  const at = text.indexOf(gate);
  expect(at, gate).toBeGreaterThan(-1);
  expect(text.indexOf(reveal, at), reveal).toBeGreaterThan(at);
};

describe("every pairing code waits for the presence check", () => {
  it("gates the workspace, server and team phone codes before they are made", () => {
    before(source("MobilePairingCard.tsx"), "if ((!codesInCloud && !(await requireUserPresence())) || generation.current !== epoch) return;", 'api<MobilePairingResponse>("/api/mobile/pairing"');
    before(source("ServerPairingCard.tsx"), "if (!(await requireUserPresence())) return;", 'api("/api/auth/pairing"');
    before(source("TeamPhoneCard.tsx"), "if (!(await requireUserPresence())) return;", "api(TEAM_PHONE_PAIRING");
    before(source("onboarding/FunnelSteps.tsx"), "if (!(await requireUserPresence()))", 'api<MobilePairingResponse>("/api/mobile/pairing"');
  });

  it("gates every way into the desktop phone setup flow, and forgets the pass when the flow ends", () => {
    const flow = source("PhoneSetupFlow.tsx");
    for (const entry of ["start", "useLocal", "useTailscale"]) {
      expect(flow).toContain(`const ${entry} = useCallback(() => afterPresence(() => entries.current.${entry}Now()), [afterPresence]);`);
    }
    expect(flow).toMatch(/refreshCode: \(\) => afterPresence\(\(\) => \{/);
    expect(flow).toMatch(/const cancel = useCallback\(\(\) => \{\s*presence\.current = "none";/);
    expect(flow).toMatch(/finish: \(\) => \{\s*presence\.current = "none";/);
    expect(flow.match(/dispatchFlow\(\{ type: "start"/g)).toHaveLength(4);
    expect(flow).toMatch(/if \(baseline\) dispatchFlow\(\{ type: "start"/);
  });

  it("knows every desktop component that draws a QR code", () => {
    const root = new URL("../", import.meta.url);
    const drawing = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".tsx") && !file.startsWith("mobile"))
      .filter((file) => readFileSync(new URL(file, root), "utf8").includes('from "qrcode.react"'))
      .map((file) => file.replace(/^components[\\/]/, "").split("\\").join("/"))
      .sort();
    expect(drawing).toEqual(["MobilePairingCard.tsx", "PhoneSetupFlow.tsx", "ServerPairingCard.tsx", "TeamPhoneCard.tsx", "onboarding/FunnelSteps.tsx"]);
    for (const file of drawing) expect(source(file)).toContain("requireUserPresence");
  });
});
