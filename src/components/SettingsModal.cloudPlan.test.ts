import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({ section: "cloudAccount" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config }, dispatch: vi.fn() }),
}));
vi.mock("./CloudAccountSettings", () => ({
  CloudAccountSettings: ({ cloudHome, onAddCloud }: { cloudHome?: boolean; onAddCloud?: () => void }) => `CLOUD_PLAN_MARKER${cloudHome ? " home" : ""}${onAddCloud ? " offer" : ""}`,
}));

const plan = { state: vi.fn(), manage: vi.fn() };
beforeEach(() => {
  fixture.section = "cloudAccount"; fixture.config = undefined;
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.unstubAllGlobals(); });
const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Usage & Billing → dusk cloud on a server open in the app's window", () => {
  const reachable = 'data-settings-block="cloudAccount"';
  it("is not offered on a server that is not a dusk cloud home", () => {
    vi.stubGlobal("window", { duskDesktop: { cloudPlan: plan } });
    const html = render();
    expect(html).not.toContain("CLOUD_PLAN_MARKER"); expect(html).not.toContain(reachable);
  });
  it("shows the plan, read only, on the person's own Cloud", () => {
    vi.stubGlobal("window", { duskDesktop: { cloudPlan: plan } });
    fixture.config = { cloudHome: true };
    const html = render();
    expect(html).toContain("CLOUD_PLAN_MARKER home"); expect(html).toContain(reachable);
    expect(html).toMatch(/data-settings-page="usage" aria-current="page"/);
  });
  it("is the full account section in the app on this computer, the plan row above it carrying the offer", () => {
    vi.stubGlobal("window", { duskDesktop: { cloudAccount: {}, cloudPlan: plan } });
    const html = render();
    expect(html).toContain("CLOUD_PLAN_MARKER");
    expect(html).not.toContain("CLOUD_PLAN_MARKER home");
    expect(html).not.toContain("CLOUD_PLAN_MARKER offer");
    expect(html).toContain(reachable);
  });
});
