// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  found: { device: { name: "Siddharth's Mac", platform: "macOS" }, userCode: "ABCD-1234", expiresAt: 0 } as Record<string, unknown>,
  approve: vi.fn(async (_code: string) => ({})),
  deny: vi.fn(async (_code: string) => ({})),
  moved: [] as string[],
}));
vi.mock("../data/session", () => ({ useSession: () => ({ account: { id: "a", email: "person@qa.dusk.test" }, toast: () => {} }) }));
vi.mock("../data/cloud", () => ({ useCloud: () => ({ account: null, finishOnboarding: async () => {} }) }));
vi.mock("../lib/flow-note", () => ({ setFlowNote: () => {} }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ query: new URLSearchParams("code=ABCD-1234") }), navigate: (path: string) => void state.moved.push(path) }));
vi.mock("../lib/api", () => ({
  api: { deviceLookup: async () => state.found, deviceApprove: state.approve, deviceDeny: state.deny },
  ApiError: class extends Error { status = 410 },
}));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; state.moved = []; vi.clearAllMocks(); });

async function open() {
  const { DeviceApprovalPage } = await import("./DeviceApproval");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(DeviceApprovalPage)));
  return host;
}
const press = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;

test("approving shows a signed-in step with an open Metal button and no automatic redirect", async () => {
  const host = await open();
  await act(async () => press(host, "approve").click());
  expect(state.approve).toHaveBeenCalledWith("ABCD-1234");
  expect(state.moved).toEqual([]);
  expect(host.textContent).toContain("you're signed in");
  expect(host.querySelector("[data-back-to-app]")?.textContent).toBe("open Metal");
  expect(host.querySelector<HTMLAnchorElement>("[data-back-to-app]")?.getAttribute("href")).toBe("duskbot://open");
});

test("deny is a quiet text action after the approve button, not a second button", async () => {
  const host = await open();
  const approve = press(host, "approve"), deny = host.querySelector<HTMLButtonElement>("[data-deny]")!;
  expect(deny.className).not.toContain("hover-btn");
  expect(deny.textContent).toBe("that wasn't me, deny");
  expect(approve.compareDocumentPosition(deny) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => deny.click());
  expect(state.deny).toHaveBeenCalledWith("ABCD-1234");
  expect(host.textContent).toContain("sign-in denied");
});

test("a brand new account carries on to its first steps instead", async () => {
  state.found = { ...state.found, created: true };
  const host = await open();
  await act(async () => press(host, "approve").click());
  expect(state.moved).toEqual(["/"]);
  state.found = { device: { name: "Siddharth's Mac", platform: "macOS" }, userCode: "ABCD-1234", expiresAt: 0 };
});
