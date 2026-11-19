import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsSection } from "@/state/store";
import { SettingsModal } from "./SettingsModal";

// These pin the card as always offered; the server decides who may act.
const fixture = vi.hoisted(() => ({ section: "companion" as AppSettingsSection, config: undefined as { cloudHome?: boolean } | undefined, phonePairing: 0 }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, config: fixture.config, appSettingsPhonePairing: fixture.phonePairing }, dispatch: vi.fn() }),
}));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./CompanionSection", () => ({ CompanionSection: ({ focusRequest }: { focusRequest?: number }) => `COMPANION_SECTION focus=${focusRequest ?? 0}` }));
vi.mock("./PeopleSection", () => ({ PeopleSection: () => "PEOPLE" }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: ({ cloudHome, focusRequest }: { cloudHome?: boolean; focusRequest?: number }) => `SERVER_PAIRING_CARD_MARKER${cloudHome ? " cloud" : ""} focus=${focusRequest ?? 0}` }));

beforeEach(() => {
  // the phone app offered: these cases are about phones pairing
  vi.stubEnv("VITE_DUSK_PHONE_APP", "1");
  vi.clearAllMocks();
  fixture.section = "companion";
  fixture.config = undefined;
  fixture.phonePairing = 0;
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));

describe("Settings → Remote access: server pairing card visibility", () => {
  it("is offered on a hosted server reached from a browser (no window.duskDesktop)", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(),});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("is offered inside the desktop app when it owns the server being paired against", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: {} });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("is offered when this desktop is a remote client of a hosted workspace, whose phones pair only here", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: { remoteClient: { active: true } } });
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER");
  });

  it("on a dusk cloud home, which is personal, tells the card so and offers no People section to invite anyone", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(),});
    fixture.section = "people";
    expect(render()).toContain('data-panel-page="people"');
    fixture.config = { cloudHome: true };
    expect(render()).not.toContain('data-panel-page="people"');
    fixture.section = "companion";
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER cloud");
  });
});

describe("Settings → Remote access opened by Connect your phone", () => {
  it("on this computer, reveals the phone flow, not the server's pairing code", () => {
    fixture.phonePairing = 3;
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=3");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });

  it("on the person's own Cloud in this window, reveals the Cloud's own pairing code", () => {
    fixture.phonePairing = 2;
    fixture.config = { cloudHome: true };
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: { cloudPlan: {} } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER cloud focus=2");
    expect(html).toContain("COMPANION_SECTION focus=0");
  });

  it("on another server, in a browser or as a remote client, reveals that server's pairing code", () => {
    fixture.phonePairing = 1;
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(),});
    expect(render()).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: { companion: {}, remoteClient: { active: true } } });
    const html = render();
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=1");
    expect(html).not.toContain("COMPANION_SECTION");
  });

  it("a plain visit reveals nothing", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), duskDesktop: { companion: {} } });
    const html = render();
    expect(html).toContain("COMPANION_SECTION focus=0");
    expect(html).toContain("SERVER_PAIRING_CARD_MARKER focus=0");
  });
});
