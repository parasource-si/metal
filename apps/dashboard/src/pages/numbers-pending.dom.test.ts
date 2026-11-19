// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CloudDesktop } from "../data/contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ cloud: { power: async (_id: string, _on: boolean) => {}, refresh: () => {} } }));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));

const roots: Root[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });

async function render(node: Parameters<Root["render"]>[0]) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}

const resting = { id: "c1", name: "My Cloud", status: "running", resting: true } as CloudDesktop;
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

test("a resting cloud shows a skeleton for a few seconds, then words and a retry that wakes it again", async () => {
  const { NumbersPending, SKELETON_MS } = await import("./numbers-pending");
  const power = vi.spyOn(state.cloud, "power"), refresh = vi.spyOn(state.cloud, "refresh"), retry = vi.fn();
  const host = await render(createElement(NumbersPending, { cloud: resting, error: null, retry }));
  expect(host.querySelector(".skeleton")).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(SKELETON_MS); });
  expect(host.querySelector(".skeleton")).toBeNull();
  expect(host.textContent).toContain("waking My Cloud");
  expect(refresh).toHaveBeenCalled();
  await act(async () => { button(host, "try again")!.click(); });
  expect(power).toHaveBeenCalledWith("c1", true);
  expect(retry).toHaveBeenCalled();
});

test("a failed wake says why instead of spinning", async () => {
  const { NumbersPending, SKELETON_MS } = await import("./numbers-pending");
  vi.spyOn(state.cloud, "power").mockRejectedValue(new Error("too many wakes in the last hour."));
  const host = await render(createElement(NumbersPending, { cloud: resting, error: null, retry: () => {} }));
  await act(async () => { vi.advanceTimersByTime(SKELETON_MS); });
  await act(async () => { button(host, "try again")!.click(); });
  expect(host.querySelector("[role=alert]")?.textContent).toBe("too many wakes in the last hour.");
});

test("a failing detail read shows the error with retry at once", async () => {
  const { NumbersPending } = await import("./numbers-pending");
  const retry = vi.fn();
  const host = await render(createElement(NumbersPending, { cloud: { ...resting, resting: undefined }, error: "could not reach Metal.", retry }));
  expect(host.querySelector(".skeleton")).toBeNull();
  expect(host.textContent).toContain("could not reach Metal.");
  await act(async () => { button(host, "retry")!.click(); });
  expect(retry).toHaveBeenCalled();
});
