import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { RichMessageRow, richRowKind } from "./RichMessageRow";
import { WatchSuggestion } from "./WatchSuggestion";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));
const message = (answer?: "on" | "notNow"): Message => ({
  id: "m1", role: "bot", kind: "text", at: 0, text: "Want me to keep an eye on your day?", setupSuggestion: { kind: "watch", ...(answer ? { answer } : {}) },
} as Message);
function render(of: Message) {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = WatchSuggestion({ threadId: "t1", message: of }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return { html, on: all.find((node) => node.props["data-testid"] === "watch-suggestion-on"), notNow: all.find((node) => node.props["data-testid"] === "watch-suggestion-not-now") };
}

beforeEach(() => {
  fixture.values = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true });
});

describe("the keep-an-eye-on-my-day suggestion card", () => {
  it("is a plain message with Turn it on and Not now, in the device's words, drawn as this card", () => {
    const view = render(message());
    expect(view.html).toContain("Want me to keep an eye on your day?");
    expect(view.html).toContain("Turn it on");
    expect(view.html).toContain("Not now");
    expect(richRowKind(message())).toBe("widget");
    expect(nodes(RichMessageRow({ botId: "b1", botName: "Metal", threadId: "t1", message: message() })).some((node) => node.type === WatchSuggestion)).toBe(true);
  });

  it("sends the answer, and once answered says so with no buttons", async () => {
    (render(message()).on!.props.onClick as () => void)();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/watch/suggestion", { method: "POST", body: JSON.stringify({ threadId: "t1", messageId: "m1", answer: "on" }) });
    const on = render(message("on"));
    expect(on.html).toContain("every morning at 8");
    expect(on.on).toBeUndefined();
    const declined = render(message("notNow"));
    expect(declined.html).toContain("Okay, I won&#x27;t ask again.");
    expect(declined.notNow).toBeUndefined();
  });
});
