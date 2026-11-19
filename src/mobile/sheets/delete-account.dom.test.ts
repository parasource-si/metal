// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetStack } from "../Sheet";
import { DeleteAccountPage } from "./DeleteAccountPage";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = (onDelete: () => Promise<boolean>, onCancel = vi.fn(), onDone = vi.fn()) => {
  act(() => root.render(createElement(SheetStack, { value: { back: onCancel } }, createElement(DeleteAccountPage, { email: "person@example.com", onDelete, onCancel, onDone }))));
  return { onCancel, onDone };
};
const confirm = () => host.querySelector<HTMLButtonElement>("[data-delete-account-confirm]")!;
const button = (text: string) => [...host.querySelectorAll("button")].find((el) => el.textContent === text)!;

describe("delete account confirm step", () => {
  it("says what goes and that a plan is cancelled before anything is deleted", () => {
    const onDelete = vi.fn(async () => true);
    show(onDelete);
    expect(host.textContent).toContain("Delete your Dusk account?");
    expect(host.textContent).toContain("person@example.com");
    expect(host.textContent).toContain("cancelled and does not renew");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("cancel leaves the account alone", () => {
    const onDelete = vi.fn(async () => true);
    const { onCancel, onDone } = show(onDelete);
    act(() => button("Cancel").click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("deletes once on confirm and closes Settings", async () => {
    const onDelete = vi.fn(async () => true);
    const { onDone } = show(onDelete);
    await act(async () => { confirm().click(); });
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("stays on the step with a reason when the service could not delete", async () => {
    const { onDone } = show(vi.fn(async () => false));
    await act(async () => { confirm().click(); });
    expect(onDone).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Couldn't delete the account");
    expect(confirm().disabled).toBe(false);
  });
});
