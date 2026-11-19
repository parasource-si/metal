import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  localComputer: { available: false, message: "Accessibility required; grant access in System Settings" } as DesktopCapabilities["localComputer"],
}));
vi.stubGlobal("window", {
  duskDesktop: { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() },
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, localComputer: fixture.localComputer }, ready: true }),
}));

const { MacLocalControl } = await import("./MacLocalControl");
afterAll(() => vi.unstubAllGlobals());

describe("Mac local computer status", () => {
  it("shows the recorded Accessibility failure and its matching recovery actions", () => {
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("Accessibility is required for Metal");
    expect(markup).toContain("Open Accessibility settings");
    expect(markup).toContain("relaunch Metal");
    expect(markup).not.toContain("Open Screen Recording settings");
    expect(markup, "the driver detail shows inline, not folded").not.toContain("<details");
  });

  it("does not turn a missing reason into a claimed permission diagnosis", () => {
    fixture.localComputer = { available: false, status: "unavailable" } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("To use this Mac, turn on Accessibility and Screen Recording for Metal in System Settings, then retry.");
    expect(markup).not.toContain("Accessibility is required");
    expect(markup).not.toContain("relaunch Metal</button>");
  });

  it("does not offer host repair actions to a remote renderer", () => {
    fixture.localComputer = { available: false, status: "unavailable", reasonCode: "remote-server" } as DesktopCapabilities["localComputer"];
    expect(renderToStaticMarkup(createElement(MacLocalControl))).toBe("");
  });
});
