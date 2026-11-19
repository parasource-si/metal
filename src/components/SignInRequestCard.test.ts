import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ setters: [] as Array<ReturnType<typeof vi.fn>>, states: {} as Record<number, unknown> }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (value: unknown) => {
    const index = fixture.setters.length;
    const setter = vi.fn(); fixture.setters.push(setter);
    return [index in fixture.states ? fixture.states[index] : value, setter];
  } };
});
const dispatch = vi.fn();
const storeApi = vi.fn();
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch, state: { computerControl: {} } }),
  api: (...args: unknown[]) => storeApi(...args),
}));
const answerSignIn = vi.fn();
const here = { value: true };
vi.mock("@/lib/sign-in", () => ({ answerSignIn: (...args: unknown[]) => answerSignIn(...args), signInHostIsHere: () => here.value }));
const saveLoginFromCard = vi.fn();
const cardSaveTarget = vi.fn();
vi.mock("@/lib/logins", () => ({
  saveLoginFromCard: (...args: unknown[]) => saveLoginFromCard(...args),
  cardSaveTarget: (...args: unknown[]) => cardSaveTarget(...args),
}));

import { LoginForm } from "./LoginForm";
import { SignInBanner, SignInRequestCard } from "./SignInRequestCard";
import { frameAddress, signInScreenPath } from "./SignInScreen";

const card = (signIn: Record<string, unknown> = {}): Message => ({
  id: "card-1",
  role: "bot",
  kind: "signin",
  at: 1,
  text: "Pepper needs you to sign in to example.com.",
  signIn: { url: "https://example.com/login", site: "example.com", place: "browser", reason: "The report is behind a login.", ...signIn } as Message["signIn"],
});
const props = (signIn?: Record<string, unknown>) => ({ botId: "pepper", botName: "Pepper", threadId: "thread-1", message: card(signIn) });
const view = (signIn?: Record<string, unknown>) => renderToStaticMarkup(createElement(SignInRequestCard, props(signIn)));

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const elements = (node: ReactNode): Node[] => {
  if (!isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
};
const tree = (signIn?: Record<string, unknown>) => {
  let root!: ReactNode;
  function Capture() { root = SignInRequestCard(props(signIn)); return root; }
  renderToStaticMarkup(createElement(Capture));
  const top = elements(root);
  return [...top, ...top.flatMap((node) => elements((node.props as { footer?: ReactNode }).footer))];
};
const button = (nodes: Node[], label: string) => nodes.find((node) => node.type === "button" && Children.toArray(node.props.children).includes(label))!;
const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal("window", {});
  dispatch.mockReset(); answerSignIn.mockReset().mockResolvedValue(undefined);
  saveLoginFromCard.mockReset().mockResolvedValue(undefined);
  cardSaveTarget.mockReset().mockResolvedValue({ site: "example.com" });
  fixture.setters = []; fixture.states = {}; here.value = true;
});

describe("SignInRequestCard while it waits", () => {
  it("is grok's action card: the place in the titlebar, Action needed, the step and the bot's reason, Skip, I'm done and Take over", () => {
    const html = view();
    expect(html).toMatch(/text-\[13px\] font-medium[^"]*">Browser</);
    expect(html).toContain("Action needed");
    expect(html).toMatch(/data-testid="sign-in-site"[^>]*>Sign in to example\.com</);
    expect(html).toContain("The report is behind a login.");
    expect(html).not.toContain("— Pepper");
    for (const label of [">Skip<", ">I&#x27;m done<", ">Take over<"]) expect(html).toContain(label);
    expect(html.indexOf(">Skip<")).toBeLessThan(html.indexOf(">Take over<"));
    expect(html).not.toContain("shadow-(--shadow-float)");
    expect(html).not.toContain("<input");
  });

  it("asks for a human check in one plain line, without the bot's own words", () => {
    const html = view({ check: true, reason: undefined });
    expect(html).toMatch(/data-testid="sign-in-site"[^>]*>example\.com wants a quick human check\. Tap Take over and I&#x27;ll carry on from there\.</);
    expect(html).not.toContain("sign in to example.com");
  });

  it("shows the computer's screen edge to edge with grok's Take over pill on a computer, in a box reserved before the first frame", () => {
    const html = view({ place: "vm", reason: undefined });
    expect(html).toMatch(/<button[^>]*aria-label="Take over the computer"[^>]*data-sign-in-screen=""[^>]*class="[^"]*aspect-\[16\/10\] w-full/);
    expect(html.indexOf("data-sign-in-screen")).toBeGreaterThan(html.indexOf("Action needed"));
    expect(html.indexOf("data-sign-in-screen")).toBeLessThan(html.indexOf(">Skip<"));
    expect(view({ place: "cloud" })).toContain("data-sign-in-screen");
  });

  it.each(["browser", "local"])("has no screen on %s, where no view-only frame exists", (place) => {
    expect(view({ place })).not.toContain("data-sign-in-screen");
  });

  it("paints Take over in ink and the other answers neutral, whatever the bot's colour", () => {
    const html = renderToStaticMarkup(createElement(SignInRequestCard, { ...props(), color: "teal" }));
    const tag = (label: string) => (html.match(/<button[^>]*>[^<]*<\/button>/g) ?? []).find((one) => one.includes(`>${label}<`))!;
    expect(tag("Take over")).toContain("ui-button-primary");
    expect(tag("Take over")).not.toContain("--bot-button");
    expect(tag("Skip")).toContain("bg-(--card-fill)");
    expect(tag("Skip")).toContain('title="Cancel this request without doing the step. Pepper continues without it."');
  });

  it.each([
    ["vm", "the private desktop Pepper works on"],
    ["cloud", "the cloud desktop Pepper works on"],
    ["local", "on this computer, in the browser Pepper is using"],
  ])("names the place for %s on Take over", (place, words) => {
    expect(view({ place })).toContain(words);
    expect(view({ place })).toMatch(/text-\[13px\] font-medium[^"]*">(Computer|This computer)</);
  });

  it("says the host computer, not this one, where this computer is somewhere else", () => {
    here.value = false;
    expect(view({ place: "local" })).toContain("the computer Metal runs on");
  });

  it("Take over goes to the place the bot works", () => {
    button(tree(), "Take over").props.onClick!();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "openSignIn", botId: "pepper", messageId: "card-1", url: "https://example.com/login", site: "example.com", place: "browser",
    });
  });

  it.each([["cloud", "vps/pepper"]])("Take over on a %s computer takes control right in the card, not by opening the panel", async (place, target) => {
    storeApi.mockReset().mockResolvedValue({ ready: true });
    const nodes = tree({ place });
    const takeOver = nodes.find((node) => node.type === "button" && (node.props as Record<string, unknown>)["data-sign-in-take-over"] === "")!;
    takeOver.props.onClick!();
    await settle();
    expect(dispatch).not.toHaveBeenCalled();
    // the card's own live desktop is pointed at the bot's computer
    expect(fixture.setters.some((setter) => setter.mock.calls.some(([value]) => value === target))).toBe(true);
    expect(storeApi).toHaveBeenCalledTimes(1);
  });

  it("wakes a cloud computer that went to sleep while the card waited, then opens its screen", async () => {
    storeApi.mockReset().mockResolvedValueOnce({ ready: false, container: "stopped" }).mockResolvedValueOnce({ ready: true });
    const nodes = tree({ place: "cloud" });
    nodes.find((node) => node.type === "button" && (node.props as Record<string, unknown>)["data-sign-in-take-over"] === "")!.props.onClick!();
    await settle();
    expect(storeApi.mock.calls.map(([path, init]) => [path, (init as { method?: string } | undefined)?.method ?? "GET"])).toEqual([
      ["/api/bots/pepper/computer?threadId=thread-1", "GET"],
      ["/api/bots/pepper/computer/provision?threadId=thread-1", "POST"],
    ]);
    expect(fixture.setters.some((setter) => setter.mock.calls.some(([value]) => value === "vps/pepper"))).toBe(true);
  });

  it("open on this computer explains where to sign in instead", () => {
    button(tree({ place: "local" }), "Open").props.onClick!();
    expect(dispatch).not.toHaveBeenCalled();
    // explained (the second useState) turns on
    expect(fixture.setters[1]).toHaveBeenCalledWith(true);
    fixture.setters = []; fixture.states = { 1: true };
    expect(view({ place: "local" })).toContain("Not the browser tab: it keeps its own sign-ins");
  });

  it("offers to save a login in the built-in browser, which opens a masked form in place of the buttons", () => {
    button(tree(), "Save a login").props.onClick!();
    // saving (the third useState) turns on
    expect(fixture.setters[2]).toHaveBeenCalledWith(true);
    fixture.setters = []; fixture.states = { 2: true };
    const html = view();
    expect(html).toContain("Save the username and password for example.com.");
    expect(html).toContain('type="password"');
    expect(html).toMatch(/type="password" autocomplete="new-password"/iu);
    expect(html).toContain("Save and continue");
    expect(html).not.toMatch(/>I&#x27;m done<|>Take over</);
    expect(saveLoginFromCard).not.toHaveBeenCalled();
  });

  it("names a sign-in page on another site, open in the browser, as a choice left unticked, and saves it only when ticked", async () => {
    const elsewhere = { site: "example.com", signInHost: "login.microsoftonline.com" };
    cardSaveTarget.mockResolvedValue(elsewhere);
    button(tree(), "Save a login").props.onClick!();
    await settle();
    expect(cardSaveTarget).toHaveBeenCalledExactlyOnceWith({ botId: "pepper", threadId: "thread-1", messageId: "card-1", place: "browser" });
    // target and the tick are the fourth and fifth useState
    expect(fixture.setters[3]).toHaveBeenCalledWith(elsewhere);
    fixture.setters = []; fixture.states = { 2: true, 3: elsewhere };
    const html = view();
    expect(html).toContain("Also fill it on login.microsoftonline.com, the sign-in page open in the browser now");
    const tick = /<input type="checkbox"[^>]*name="signInHost"[^>]*>/u.exec(html)?.[0];
    expect(tick).toBeDefined();
    expect(tick).not.toContain("checked");
    const fields = { username: "alice", password: "fake-card-pass", totp: "" };
    const form = (nodes: Node[]) => nodes.find((node) => node.type === LoginForm)!.props as unknown as { onSubmit: (value: typeof fields) => Promise<void> };
    fixture.setters = [];
    await form(tree()).onSubmit(fields);
    expect(saveLoginFromCard).toHaveBeenLastCalledWith({ botId: "pepper", threadId: "thread-1", messageId: "card-1" }, fields, undefined);
    fixture.setters = []; fixture.states = { 2: true, 3: elsewhere, 4: true };
    await form(tree()).onSubmit(fields);
    expect(saveLoginFromCard).toHaveBeenLastCalledWith({ botId: "pepper", threadId: "thread-1", messageId: "card-1" }, fields, "login.microsoftonline.com");
  });

  it.each(["vm", "cloud", "local"])("does not offer to save a login on %s, where fill_login cannot reach yet", (place) => {
    expect(view({ place })).not.toContain("Save a login");
  });

  it("does not offer to save a login from a desktop paired to another computer", () => {
    vi.stubGlobal("window", { duskDesktop: { remoteClient: { active: true } } });
    expect(view()).not.toContain("Save a login");
  });

  it.each(["done", "cancel"] as const)("%s settles this card", async (choice) => {
    button(tree(), choice === "done" ? "I'm done" : "Skip").props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledExactlyOnceWith({ botId: "pepper", threadId: "thread-1", messageId: "card-1", place: "browser" }, choice);
  });
});

describe("the sign-in card's screen", () => {
  it("asks each computer for its own view-only frame, for this conversation", () => {
    expect(signInScreenPath("vm", "pepper", "thread 1")).toBe("/api/bots/pepper/local-computer/screenshot?threadId=thread%201");
    expect(signInScreenPath("cloud", "pepper", "thread-1")).toBe("/api/bots/pepper/computer/screenshot?threadId=thread-1");
    expect(signInScreenPath("browser", "pepper", "thread-1")).toBeNull();
  });

  it("reads both frame shapes as an image address", () => {
    expect(frameAddress({ image: "data:image/png;base64,AAA" })).toBe("data:image/png;base64,AAA");
    expect(frameAddress({ png: "BBB", format: "jpeg" })).toBe("data:image/jpeg;base64,BBB");
    expect(frameAddress({ png: " " })).toBeNull();
  });
});

describe("SignInRequestCard once settled", () => {
  // the first node is the box the card settles in; the row sits inside it
  const row = (signIn: Record<string, unknown>) => tree(signIn)[1]!.props as unknown as { summary: string; title: string; detail: ReactNode; tone: string };
  const detailText = (signIn: Record<string, unknown>) => renderToStaticMarkup(createElement("div", null, row(signIn).detail));

  it("folds into grok's one row, Done and the step, and opens to what happened", () => {
    const html = view({ done: true, resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("Done · Sign in to example.com");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/>I&#x27;m done<|>Take over</);
    expect(detailText({ done: true, resumed: true })).toContain("Signed in to example.com · Pepper is continuing");
  });

  it("says a login was saved, for the site it was saved for", () => {
    expect(view({ done: true, resumed: true, savedLogin: "example.com and login.microsoftonline.com" })).toContain("Login saved · Sign in to example.com");
    expect(detailText({ done: true, resumed: true, savedLogin: "example.com and login.microsoftonline.com" })).toContain("Login saved for example.com and login.microsoftonline.com · Pepper is continuing");
  });

  it("says a human check cleared, never that anyone signed in", () => {
    expect(view({ check: true, done: true, resumed: true })).toContain("human check on example.com");
    expect(detailText({ check: true, done: true, resumed: true })).toContain("Human check on example.com cleared · Pepper is continuing");
    expect(detailText({ check: true, done: true, resumed: true })).not.toContain("signed in");
  });

  it("says a declined sign-in was skipped", () => {
    expect(view({ cancelled: true, resumed: true })).toContain("Skipped · Sign in to example.com");
    expect(detailText({ cancelled: true, resumed: true })).toContain("Sign-in to example.com declined");
  });

  it("keeps a retry with the same answer when resuming failed", async () => {
    const nodes = tree({ done: true, resumed: false, error: "The bot could not be resumed." });
    expect(row({ done: true, resumed: false, error: "The bot could not be resumed." }).tone).toBe("failed");
    expect(detailText({ done: true, resumed: false, error: "The bot could not be resumed." })).toContain("The bot could not be resumed.");
    const retry = nodes.flatMap((node) => elements((node.props as { action?: ReactNode }).action)).find((node) => node.type === "button")!;
    retry.props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledWith(expect.objectContaining({ messageId: "card-1" }), "done");
  });

  it("stops offering anything once superseded", () => {
    const html = view({ superseded: true });
    expect(html).toContain("Superseded by a newer request · Sign in to example.com");
    expect(html).not.toMatch(/>I&#x27;m done<|>Take over<|>Skip</);
  });
});

describe("SignInBanner", () => {
  const help = { botId: "pepper", threadId: "thread-1", messageId: "card-1", site: "example.com", place: "vm" as const };
  const banner = (takeControl?: { onClick: () => void }) => {
    let root!: ReactNode;
    function Capture() { root = SignInBanner({ help, askerName: "Pepper", takeControl }); return root; }
    return { html: renderToStaticMarkup(createElement(Capture)), nodes: elements(root) };
  };

  it("names the asking bot and the site, and answers the card", async () => {
    const { html, nodes } = banner();
    expect(html).toContain("<b>Pepper</b> Needs you to sign in to example.com");
    expect(html).not.toContain("Take control");
    button(nodes, "Done").props.onClick!();
    await settle();
    expect(answerSignIn).toHaveBeenCalledExactlyOnceWith(help, "done");
  });

  it("offers Take control only where it is given one", () => {
    const takeControl = { onClick: vi.fn() };
    const { html, nodes } = banner(takeControl);
    expect(html).toContain("Take control");
    nodes.find((node) => node.type === "button" && node.props.onClick === takeControl.onClick)!.props.onClick!();
    expect(takeControl.onClick).toHaveBeenCalledOnce();
  });
});
