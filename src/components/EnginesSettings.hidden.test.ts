// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ hidden: [] as Array<{ instanceId: string; displayName: string }>, calls: [] as Array<{ path: string; body?: unknown }>, refresh: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: fixture.refresh }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === "/api/instances/hidden") return { instances: fixture.hidden };
    fixture.hidden = [];
    return { instances: [] };
  },
}));

const { DisconnectProvider, FoundProvider, HiddenEngines } = await import("./EnginesSettings");
const instance = (extra: object) => ({ instanceId: "grok", driverKind: "grok", displayName: "Grok", snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] }, ...extra }) as never;

let root: Root;
let host: HTMLElement;
const settle = () => new Promise((done) => setTimeout(done, 0));
beforeEach(() => {
  fixture.calls = [];
  fixture.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("disconnected providers in Settings", () => {
  it("shows nothing while no provider is hidden", async () => {
    fixture.hidden = [];
    flushSync(() => root.render(createElement(HiddenEngines)));
    await settle();
    expect(host.querySelector("[data-hidden-engines]")).toBeNull();
  });

  it("lists disconnected providers as rows under their own label, and reconnects one with a click", async () => {
    fixture.hidden = [{ instanceId: "hermes", displayName: "Hermes" }, { instanceId: "pi", displayName: "pi" }];
    flushSync(() => root.render(createElement(HiddenEngines)));
    await settle();
    const list = host.querySelector("[data-hidden-engines]")!;
    expect(list.querySelector("[data-settings-heading]")!.textContent).toBe("Disconnected (2)");
    expect(list.textContent).toContain("Hermes");
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-unhide-engine="hermes"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/hermes", body: { hidden: false } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});

describe("a provider found on this computer", () => {
  it("says so and turns on with Use it; a chosen one shows nothing", async () => {
    flushSync(() => root.render(createElement(FoundProvider, { instance: instance({}) })));
    expect(host.textContent).toBe("");
    flushSync(() => root.render(createElement(FoundProvider, { instance: instance({ found: true }) })));
    expect(host.textContent).toContain("Found on this computer");
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-use-found="grok"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/grok", body: { chosen: true } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});

describe("disconnecting a provider", () => {
  it("asks first, then leaves it out of every list", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({}) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(fixture.calls).toEqual([]);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Disconnect" && !button.hasAttribute("data-disconnect-engine"))!;
    expect(document.body.textContent).toContain("Disconnect Grok?");
    flushSync(() => confirm.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/grok", body: { hidden: true } });
  });

  const confirmButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === label && !button.hasAttribute("data-disconnect-engine"))!;

  it("signs out first where Metal can, so the signed-in app cannot bring it back", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ authentication: { method: "device-code", signOut: true } }) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(document.body.textContent).toContain("Metal signs out of Grok");
    flushSync(() => confirmButton("Disconnect").click());
    await settle();
    expect(fixture.calls.map((call) => call.path)).toEqual(["/api/instances/grok/auth/sign-out", "/api/instances/grok"]);
    expect(fixture.calls[1]).toEqual({ path: "/api/instances/grok", body: { hidden: true } });
  });

  it("keeps the sign-in when asked and only hides the provider", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ authentication: { method: "device-code", signOut: true } }) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    flushSync(() => confirmButton("Keep sign-in").click());
    await settle();
    expect(fixture.calls).toEqual([{ path: "/api/instances/grok", body: { hidden: true } }]);
  });

  it("only hides a provider it cannot sign out of, and offers no second choice", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({}) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(document.querySelector("[data-confirm-alternative]")).toBeNull();
    flushSync(() => confirmButton("Disconnect").click());
    await settle();
    expect(fixture.calls).toEqual([{ path: "/api/instances/grok", body: { hidden: true } }]);
  });

  it("is not offered for a provider the organization runs", () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ readOnly: true }) })));
    expect(host.querySelector("[data-disconnect-engine]")).toBeNull();
  });
});

