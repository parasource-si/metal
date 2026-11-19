import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the menus as the app ships; the developer row is checked on its own below
vi.stubEnv("VITE_DUSK_DEV_TOOLS", "0");
vi.mock("react-dom", async (importOriginal) => ({ ...await importOriginal<typeof import("react-dom")>(), createPortal: (children: unknown) => children }));

import {
  adoptedAccountName,
  cloudUsageSummary,
  phoneMenuItems,
  placeMenuItems,
  planUsageSummary,
  profileInitials,
  profileMenuItems,
  resetsIn,
  simplePhoneItems,
  simpleUpdateTop,
  accountDot,
  accountLabel,
  toolMenuItems,
  type PlanUsageWindows,
  selectPhoneDestination,
  profileLabel,
  grokProfileMenuItems,
  ProfileFace,
} from "./SidebarProfileMenu";
import { DOCS_URL, FEEDBACK_URL, HELP_CENTER_URL, platformLabel } from "@/lib/app-links";
import { profileForSession } from "@/lib/session";
import {
  cloudPhoneDestination,
  connectPhoneEntry,
  phoneDestinations,
  phonePairingSettingsAction,
  type PhonePairingAccess,
  type PhonePairingTarget,
} from "@/lib/phone-pairing";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudMachine } from "../../electron/cloud-home.mjs";
import { PhoneAppDialog, type PhoneAppConnect } from "./PhoneAppDialog";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import { moveMenuItems } from "./AccountMove";
import { moveLine } from "@/lib/cloud-send";
import { InitialsAvatar } from "./Avatar";


describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Milind Soni" })).toBe("MS");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Omkar", email: "o@x.dev" })).toBe("Omkar");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("the sidebar profile for a signed-in visitor", () => {
  it("uses the fallback while the session identity is still loading", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      null,
    );
    expect(profileLabel(visible)).toBe("You");
    expect(profileInitials(visible)).toBe("?");
    expect(visible?.avatarUrl).toBeUndefined();
  });

  it("shows the verified email and initials without the configured owner's name or avatar", () => {
    const visible = profileForSession(
      { name: "Owner", email: "owner@example.test", avatarUrl: "/owner.png" },
      { kind: "session", id: "s", label: "Ada's iPad", email: "ada@example.test", scopes: ["client"], expiresAt: 1 },
    );
    expect(profileLabel(visible)).toBe("ada@example.test");
    expect(profileInitials(visible)).toBe("A");
    expect(visible?.avatarUrl).toBeUndefined();
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("outward links", () => {
  it("sends Help Center to the docs the website also links to", () => {
    expect(HELP_CENTER_URL).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://github.com/parasource-si/metal/tree/main/docs");
  });

  it("sends Send Feedback to the Metal issue tracker", () => {
    expect(FEEDBACK_URL).toBe("https://github.com/parasource-si/metal/issues");
  });
});

describe("the phone entries", () => {
  const admin: PhonePairingAccess = { session: { kind: "session", id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 }, pairingCodes: true };
  const chatOnly: PhonePairingAccess = { session: { kind: "session", id: "s", label: "phone", scopes: ["client"], expiresAt: 1 }, pairingCodes: true };
  const signedIn = { status: "connected", account: { id: "a", email: "p@example.test" } } as const;
  const paid = (tier: string, machine?: CloudMachine): CloudAccountState => ({ ...signedIn, entitlement: { plan: "pro", tier, status: "active", expiresAt: null, version: 1 }, ...(machine ? { machine } : {}) });
  const ready: CloudMachine = { status: "ready", origin: "https://home-7f3k2.fly.dev" };
  const free: CloudAccountState = { ...signedIn, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
  const items = (target: PhonePairingTarget, access: PhonePairingAccess | null, account: CloudAccountState | null = null, connected = false) => {
    const onConnect = vi.fn();
    const destinations = phoneDestinations(connectPhoneEntry(target, access), cloudPhoneDestination(account));
    return { list: phoneMenuItems({ destinations, connected, onConnect }), onConnect };
  };
  const shown = (...args: Parameters<typeof items>) => items(...args).list.map((item) => [item.label, item.subtitle ?? null, ...(item.note ? [item.note] : [])]);

  it("on this computer: offers pairing without a separate download entry", () => {
    expect(shown("computer", null)).toEqual([["Connect your phone", "To this computer"]]);
  });

  it("on this computer with a paid Cloud that is Ready: both, the Cloud first", () => {
    for (const tier of ["personal", "pro", "max"]) {
      expect(shown("computer", null, paid(tier, ready))).toEqual([
        ["Connect your phone", "To the cloud (always available)"],
        ["Connect your phone", "To this computer"],
      ]);
    }
  });

  it("on this computer, free or signed out: only this computer", () => {
    for (const account of [free, { status: "signed-out" } as CloudAccountState, null]) {
      expect(shown("computer", null, account)).toEqual([["Connect your phone", "To this computer"]]);
    }
    expect(shown("computer", null, { ...paid("pro", ready), entitlement: { plan: "pro", status: "inactive", expiresAt: null, version: 2 } }))
      .toEqual([["Connect your phone", "To this computer"]]);
    expect(shown("computer", null, { status: "unavailable", lastPlan: { tier: "pro", active: true }, machine: ready }))
      .toEqual([["Connect your phone", "To this computer"]]);
  });

  it("on this computer with a paid Cloud that is not Ready: only this computer, and a hint", () => {
    for (const machine of [undefined, { status: "provisioning" }, { status: "stopped", origin: ready.origin }, { status: "failed", origin: ready.origin }] as Array<CloudMachine | undefined>) {
      expect(shown("computer", null, paid("pro", machine))).toEqual([
        ["Connect your phone", "To this computer", "The cloud shows here once it's ready."],
      ]);
    }
  });

  it("on the person's own Cloud: unchanged, one Connect your phone to My Cloud", () => {
    expect(shown("cloud", admin)).toEqual([["Connect your phone", "To the cloud"]]);
    expect(shown("cloud", admin, paid("max", ready))).toEqual([["Connect your phone", "To the cloud"]]);
    expect(shown("cloud", admin, paid("max"))).toEqual([["Connect your phone", "To the cloud"]]);
  });

  it("on another server: to this server, and gone for a session that cannot make a pairing code", () => {
    expect(shown("server", admin, paid("pro", ready))).toEqual([["Connect your phone", "To the bots here"]]);
    expect(shown("server", chatOnly)).toEqual([]);
    expect(shown("server", { ...admin, pairingCodes: false })).toEqual([]);
    expect(shown("cloud", chatOnly)).toEqual([]);
  });

  it("never offers the iOS-only entry it replaced", () => {
    for (const target of ["computer", "server"] as const) {
      expect(items(target, null).list.map((item) => item.label)).not.toContain("Get Metal for iOS");
    }
  });

  it("each line hands on its own destination", () => {
    const { list, onConnect } = items("computer", null, paid("pro", ready));
    list[0]!.onSelect();
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "cloud" }));
    list[1]!.onSelect();
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "here", target: "computer" }));
    expect(list).toHaveLength(2);
  });

  it("shows this computer's live phone on this computer's line only", () => {
    expect(items("computer", null, null, true).list[0]!.trailing).toBeTruthy();
    expect(items("computer", null, null, false).list[0]!.trailing).toBeUndefined();
    const both = items("computer", null, paid("pro", ready), true).list;
    expect(both[0]!.trailing).toBeUndefined();
    expect(both[1]!.trailing).toBeTruthy();
    expect(items("cloud", admin, null, true).list[0]!.trailing).toBeUndefined();
  });
});

describe("choosing where the phone connects", () => {
  const destinations = (account: CloudAccountState | null) => phoneDestinations(connectPhoneEntry("computer", null), cloudPhoneDestination(account));
  const readyCloud: CloudAccountState = { status: "connected", entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 }, machine: { status: "ready", origin: "https://home-7f3k2.fly.dev" } };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it("to My Cloud opens the Cloud on its phone pairing, as Use the Cloud on your phone does, sending nothing", async () => {
    const bridge = { connectHomeForPhone: vi.fn().mockResolvedValue({ status: "connected" }) };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[0]!, { bridge, dispatch });
    await flush();
    expect(bridge.connectHomeForPhone).toHaveBeenCalledExactlyOnceWith();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("when the Cloud cannot be opened, lands on Settings → dusk cloud, which says what to do", async () => {
    const bridge = { connectHomeForPhone: vi.fn().mockRejectedValue(new Error("offline")) };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[0]!, { bridge, dispatch });
    await flush();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("to this computer opens this computer's phone pairing and never touches the Cloud", () => {
    const bridge = { connectHomeForPhone: vi.fn() };
    const dispatch = vi.fn();
    selectPhoneDestination(destinations(readyCloud)[1]!, { bridge, dispatch });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(phonePairingSettingsAction());
    expect(bridge.connectHomeForPhone).not.toHaveBeenCalled();
  });
});

describe("phone pairing", () => {
  const render = (connect?: PhoneAppConnect[]) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", { body: {} });
    try {
      return renderToStaticMarkup(createElement(PhoneAppDialog, { open: true, onClose: () => {}, connect }));
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const to = (key: string, subtitle: string): PhoneAppConnect => ({ key, subtitle, onSelect: () => {} });

  it("offers phone pairing without upstream application downloads", () => {
    const html = render([to("here", "to this computer")]);
    expect(html).toContain("Connect your phone");
    expect(html).toContain("Show a one-time code to scan or type on your phone");
    expect(html).toContain("to this computer");
    expect(html).not.toContain("apps.apple.com");
    expect(html).not.toContain("download the APK");
    expect(html).not.toContain("data-phone-app=\"ios\"");
    expect(html).not.toContain("data-phone-app=\"android\"");
  });

  it("offers every destination the menu does, in the same order", () => {
    const html = render([to("cloud", "to the cloud (always available)"), to("here", "to this computer")]);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-phone-app-connect="cloud"')).toBeLessThan(html.indexOf('data-phone-app-connect="here"'));
  });

  it("is not drawn while closed", () => {
    expect(renderToStaticMarkup(createElement(PhoneAppDialog, { open: false, onClose: () => {} }))).toBe("");
  });
});

describe("profileMenuItems", () => {
  const noop = () => {};
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    phone: [{ key: "phone-app", label: "Get the phone app", onSelect: noop }],
    usage: true,
    update: null,
    account: "dusk cloud",
    onUsage: noop, onSettings: noop, onShortcuts: noop, onAbout: noop, onHelp: noop, onFeedback: noop, onAccount: noop,
    ...patch,
  });

  it("groups usage and the phone, then help and settings, then the account under a divider", () => {
    const items = build();
    expect(items.map((item) => item.key)).toEqual(["usage", "phone-app", "support", "feedback", "settings", "account"]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.key)).toEqual(["account"]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "shortcuts", "about"]);
    expect(items.find((item) => item.key === "account")!.label).toBe("dusk cloud");
  });

  it("ends Support with start fresh in a developer build, never over the chat", async () => {
    vi.stubEnv("VITE_DUSK_DEV_TOOLS", "");
    try {
      const support = build().find((item) => item.key === "support")!.submenu!;
      expect(support.map((item) => item.key)).toEqual(["help", "shortcuts", "about", "dev-fresh-install"]);
      expect(support.at(-1)!.label).toBe("Dev: start fresh on this computer");
    } finally {
      vi.stubEnv("VITE_DUSK_DEV_TOOLS", "0");
    }
  });

  it("only offers what this window has: no usage on a remote server, no account without one", () => {
    const items = build({ usage: false, account: null });
    expect(items.map((item) => item.key)).toEqual(["phone-app", "support", "feedback", "settings"]);
    expect(items.some((item) => item.separatorBefore)).toBe(false);
  });

  it("keeps the update entry beside settings", () => {
    const update = { key: "update", label: "check for updates", onSelect: noop };
    expect(build({ update }).map((item) => item.key)).toEqual(["usage", "phone-app", "support", "feedback", "settings", "update", "account"]);
  });

  it("opens the Usage and account pages of Settings", () => {
    const onUsage = vi.fn(), onAccount = vi.fn();
    const items = build({ onUsage, onAccount });
    items.find((item) => item.key === "usage")!.onSelect();
    items.find((item) => item.key === "account")!.onSelect();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onAccount).toHaveBeenCalledOnce();
  });
});

describe("Simple mode's account menu", () => {
  const noop = () => {};
  const tools = toolMenuItems({ archived: { count: 2, open: noop } });
  const place = (patch: Partial<Parameters<typeof placeMenuItems>[0]> = {}) => ({
    bridge: { state: async () => ({ local: true, name: "This computer" }), menu: async () => {} },
    current: { local: true, name: "This computer" },
    cloudHome: false,
    onLine: "",
    openMenu: vi.fn(),
    switchable: true,
    ...patch,
  });
  const build = (patch: Partial<Parameters<typeof profileMenuItems>[0]> = {}) => profileMenuItems({
    phone: simplePhoneItems({ connected: false, onGetApp: noop }),
    usage: true,
    update: { key: "update", label: "check for updates", onSelect: noop },
    account: "dusk cloud",
    simple: { tools, places: placeMenuItems(place(), { owner: null, onCloudSettings: noop }) },
    onUsage: noop, onSettings: noop, onShortcuts: noop, onAbout: noop, onHelp: noop, onFeedback: noop, onAccount: noop,
    ...patch,
  });
  const groups = (items: SidebarMenuItem[]) => items.reduce<string[][]>((all, item) => {
    if (item.separatorBefore || all.length === 0) all.push([]);
    all[all.length - 1]!.push(item.key);
    return all;
  }, []);

  it("leads with usage, the phone app, support and Settings, then Archived bots, then where this window is and Cloud", () => {
    const items = build();
    expect(groups(items)).toEqual([
      ["usage", "phone-app", "support", "feedback", "settings"],
      ["archived"],
      ["place", "account"],
    ]);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).toEqual(["help", "shortcuts", "about", "update"]);
  });

  it("raises an update that is ready or failed to its own top row with a pill, and keeps it out of support", () => {
    const update = { key: "update", label: "Restart to update to Metal 0.2.0", subtitle: "notes", attention: true, onSelect: noop };
    const items = build({ update, updateTop: { label: "update ready", action: "restart" } });
    expect(groups(items)[0]).toEqual(["update"]);
    expect(items[0]).toMatchObject({ label: "update ready", subtitle: undefined, attention: false });
    expect(renderToStaticMarkup(createElement("div", null, items[0]!.trailing))).toContain(">restart</span>");
    expect(items[1]!.separatorBefore).toBe(true);
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).not.toContain("update");
  });

  it("raises a newer server and nothing else", () => {
    expect(simpleUpdateTop({ source: "server", phase: "available" })).toEqual({ label: "Update ready", action: "Install" });
    expect(simpleUpdateTop({ source: "server", phase: "reload" })).toEqual({ label: "Update ready", action: "Restart" });
    for (const phase of ["idle", "checking", "up-to-date"] as const) expect(simpleUpdateTop({ source: "server", phase })).toBeNull();
    expect(simpleUpdateTop({ source: "server", phase: "error" })).toBeNull();
    expect(simpleUpdateTop(null)).toBeNull();
  });

  it("gives the usage row a trailing meta and a chevron, with the reset as its second line", () => {
    const usage = build({ usageSummary: { value: "12% used", weekly: true, resets: "resets in 3 days" } })[0]!;
    expect(usage).toMatchObject({ label: "Weekly usage", value: "12% used", subtitle: "resets in 3 days", chevron: true });
    expect(build()[0]).toMatchObject({ label: "Usage", chevron: true });
    expect(build()[0]!.value).toBeUndefined();
  });

  it("keeps Advanced's account menu as it was", () => {
    const items = build({ simple: undefined, usageSummary: { value: "12% used" } });
    expect(items.map((item) => item.key)).toEqual(["usage", "phone-app", "support", "feedback", "settings", "update", "account"]);
    expect(items[0]!.chevron).toBeUndefined();
  });

  it("lists Archived bots while there are any, and no Files or Automations page", () => {
    const open = vi.fn();
    const items = toolMenuItems({ archived: { count: 3, open } });
    expect(items.map((item) => [item.key, item.value])).toEqual([["archived", "3"]]);
    items[0]!.onSelect();
    expect(open).toHaveBeenCalledOnce();
    expect(toolMenuItems({ archived: { count: 0, open } }).map((item) => item.key)).toEqual([]);
  });

  it("names the account button after the person and whatever its dot is raised for", () => {
    expect(accountLabel("You", { automationsNeedYou: false, update: null })).toBe("You");
    expect(accountLabel("Ada", { automationsNeedYou: true, update: "Update failed. Try again." })).toBe("Ada · Automations need you · Update failed. Try again.");
  });

  it("adds the move to My Cloud: a short warning once failing, shared with automations, and a quiet segment on its way", () => {
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "failed" })).toBe("Omkar · Your move to dusk cloud needs you");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "failed" })).toBe("Omkar · Your move and routines need you");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: "update ready", move: "failed" })).toBe("Omkar · Your move and routines need you · update ready");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "sending" })).toBe("Omkar · Moving to dusk cloud…");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "sending" })).toBe("Omkar · Automations need you · Moving to dusk cloud…");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: "done" })).toBe("Omkar");
    expect(accountLabel("Omkar", { automationsNeedYou: true, update: null, move: "done" })).toBe("Omkar · Automations need you");
    expect(accountLabel("Omkar", { automationsNeedYou: false, update: null, move: null })).toBe("Omkar");
  });

  it("raises the avatar's dot red for a failing move like automations, and none on its way or once done", () => {
    expect(accountDot({ automationsNeedYou: false, update: null, move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: true, update: null, move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "failed" })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: null, move: "sending" })).toBeNull();
    expect(accountDot({ automationsNeedYou: false, update: null, move: "done" })).toBeNull();
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "done" })).toBe("accent");
    expect(accountDot({ automationsNeedYou: false, update: null, move: null })).toBeNull();
    expect(accountDot({ automationsNeedYou: true, update: null, move: null })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "failed", move: null })).toBe("danger");
    expect(accountDot({ automationsNeedYou: false, update: "news", move: "sending" })).toBe("accent");
  });

  it("puts the move's row first, in its own group, above a raised update", () => {
    const move = [{ key: "cloud-move", label: "Try moving to dusk cloud again", title: "My Cloud did not answer.", onSelect: noop }];
    const update = { key: "update", label: "Metal 0.2.0 ready, restart", onSelect: noop };
    expect(groups(build({ move }))).toEqual([
      ["cloud-move"],
      ["usage", "phone-app", "support", "feedback", "settings"],
      ["archived"],
      ["place", "account"],
    ]);
    expect(groups(build({ move, update, updateTop: { label: "update ready", action: "restart" } })).slice(0, 2)).toEqual([["cloud-move"], ["update"]]);
    expect(groups(build({ move: [] }))[0]).toEqual(["usage", "phone-app", "support", "feedback", "settings"]);
  });

  it("gives a moving move one row shaped like Usage and Settings, and a failing one a friendly line under its Try again", () => {
    const shape = (item: SidebarMenuItem) => ({ lines: [item.subtitle, item.note].filter(Boolean).length, wrap: item.wrap === true, icon: Boolean(item.icon) });
    const failing = moveMenuItems(moveLine({ phase: "copy", failing: { error: "Some of this computer's things did not reach My Cloud." } }, "local"), { onOpen: noop, onRetry: noop, onClose: noop });
    const moving = moveMenuItems(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "local"), { onOpen: noop, onRetry: noop, onClose: noop });
    const items = build({ move: moving });
    expect(groups(items)[0]).toEqual(["cloud-move"]);
    expect(shape(items[0]!)).toEqual(shape(items.find((item) => item.key === "settings")!));
    const failed = build({ move: failing });
    expect(groups(failed)[0]).toEqual(["cloud-move"]);
    expect(shape(failed[0]!)).toEqual({ lines: 1, wrap: true, icon: true });
    expect(failed[0]!.note).toBe("Something got in the way. Your bots are safe here.");
  });

  it("puts the move's row first in Advanced's account menu too, under its own divider", () => {
    const move = [{ key: "cloud-move", label: "moving to dusk cloud…", title: "moving your bots to dusk cloud… 34 of 120 chats", onSelect: noop }];
    expect(groups(build({ simple: undefined, move }))).toEqual([["cloud-move"], ["usage", "phone-app", "support", "feedback", "settings", "update"], ["account"]]);
    expect(groups(build({ simple: undefined }))).toEqual([["usage", "phone-app", "support", "feedback", "settings", "update"], ["account"]]);
  });

  it("draws a person instead of a question mark for someone with no name, at the trigger's own size", () => {
    const glyph = createElement("svg", { "data-glyph": "" });
    const nameless = renderToStaticMarkup(createElement(InitialsAvatar, { initials: profileInitials({}), size: 36, fallback: glyph, fontSize: 14 }));
    expect(nameless).toContain("data-glyph");
    expect(nameless).not.toContain("?");
    expect(nameless).toContain("font-size:14px");
    expect(renderToStaticMarkup(createElement(InitialsAvatar, { initials: "AL", size: 50 }))).toContain("font-size:19px");
    expect(renderToStaticMarkup(createElement(ProfileFace, { face: null, initials: profileInitials({}), size: 26 }))).not.toContain(">?<");
    expect(renderToStaticMarkup(createElement(ProfileFace, { face: null, initials: "AL", size: 26 }))).toContain(">AL<");
  });

  it("ticks the current place, which opens the same native list as the top row's place button; no second switch to…", () => {
    const here = place();
    const items = placeMenuItems(here, { owner: null, onCloudSettings: noop });
    expect(items.map((item) => [item.key, item.label])).toEqual([["place", "This computer"]]);
    expect(items[0]!.trailing).toBeTruthy();
    items[0]!.onSelect();
    expect(here.openMenu).toHaveBeenCalledTimes(1);
  });

  it("names My Cloud and opens its settings when it is the window's only place, and offers nothing without either", () => {
    const onCloudSettings = vi.fn();
    const home = placeMenuItems(place({ switchable: false, cloudHome: true, onLine: "always available" }), { owner: "ada@example.test", onCloudSettings });
    expect(home.map((item) => [item.label, item.subtitle])).toEqual([["My cloud", "always available · ada@example.test’s cloud"]]);
    home[0]!.onSelect();
    expect(onCloudSettings).toHaveBeenCalledOnce();
    expect(placeMenuItems(place({ bridge: undefined, switchable: false }), { owner: null, onCloudSettings })).toEqual([]);
  });

  it("names a team's Cloud by the team", () => {
    const team = placeMenuItems(place({ switchable: false, cloudHome: true, onLine: "" }), { owner: null, name: "Acme Labs", onCloudSettings: noop });
    expect(team.map((item) => item.label)).toEqual(["Acme Labs"]);
  });

  it("shows one Get the phone app row, dotted while this computer's phone is connected", () => {
    expect(simplePhoneItems({ connected: true, onGetApp: noop }).map((item) => [item.key, Boolean(item.trailing)])).toEqual([["phone-app", true]]);
    expect(simplePhoneItems({ connected: false, onGetApp: noop })[0]!.trailing).toBeUndefined();
  });
});

describe("the usage meta", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const window = (usedPercent: number | null, resetsAt: string | null = null) => ({ available: usedPercent !== null, usedPercent, resetsAt });
  const provider = (patch: Partial<PlanUsageWindows["providers"][number]> = {}) => ({ ok: true, plan: null, weekly: window(null), fiveHour: window(null), ...patch });

  it("reads the tightest weekly window, then the 5-hour one, with when it resets", () => {
    const report = { providers: [provider({ weekly: window(12, "2026-10-30T12:00:00Z") }), provider({ weekly: window(31.6, "2026-10-28T12:00:00Z") }), provider({ ok: false, weekly: window(90) })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "32% used", weekly: true, resets: "Resets tomorrow" });
    expect(planUsageSummary({ providers: [provider({ fiveHour: window(40, "2026-10-27T15:00:00Z") })] }, now)).toEqual({ value: "40% used", weekly: false, resets: "Resets in 3 hours" });
  });

  it("falls back to a plan's monthly budget when it has no rolling window", () => {
    const report = { providers: [provider({ extra: [{ label: "Monthly spend", usedPercent: 9.3 }, { label: "Other", usedPercent: 80 }] })] };
    expect(planUsageSummary(report, now)).toEqual({ value: "9% used" });
    expect(planUsageSummary({ providers: [provider({ extra: [{ label: "Other", usedPercent: 80 }] })] }, now)).toBeNull();
  });

  it("shows nothing without a percent, not even the plan's name", () => {
    expect(planUsageSummary({ providers: [provider({ plan: "Max" })] }, now)).toBeNull();
    expect(planUsageSummary({ providers: [provider()] }, now)).toBeNull();
    expect(planUsageSummary(null, now)).toBeNull();
  });

  it("says when a reset is days away, and nothing once it has passed", () => {
    expect(resetsIn(now + 3 * 86_400_000, now)).toBe("Resets in 3 days");
    expect(resetsIn(now - 1, now)).toBeUndefined();
    expect(resetsIn(null, now)).toBeUndefined();
  });

  it("reads a paid Cloud's tightest meter, and nothing without one", () => {
    const usage = { tier: "pro", resetsAt: Date.parse("2026-11-01T00:00:00Z"), meters: [{ kind: "voice", used: 30, max: 100 }, { kind: "decisions", used: 85, max: 100 }] };
    expect(cloudUsageSummary({ status: "paid", tier: "pro", usage } as never)).toMatchObject({ value: "85% used" });
    expect(cloudUsageSummary({ status: "paid", tier: "pro" } as never)).toBeNull();
    expect(cloudUsageSummary({ status: "none" } as never)).toBeNull();
  });
});

describe("grok's profile menu", () => {
  const base = {
    onGetApp: vi.fn(), onHelp: vi.fn(), onShortcuts: vi.fn(), onFeedback: vi.fn(), onAbout: vi.fn(), onSettings: vi.fn(), onAddAccount: vi.fn(),
    accounts: { view: null, openSheet: undefined, signOut: vi.fn(), add: vi.fn() } as never,
  };

  it("leads with the automation the avatar's red dot is for, so the dot always has somewhere to go", () => {
    const onNeedsYou = vi.fn();
    const items = grokProfileMenuItems({ ...base, onNeedsYou });
    expect(items[0]).toMatchObject({ key: "needs-you", label: "Automations need you", attention: true, attentionTone: "danger" });
    expect(items[1]).toMatchObject({ key: "sign-in", separatorBefore: true });
    items[0]!.onSelect();
    expect(onNeedsYou).toHaveBeenCalledOnce();
  });

  it("has no phone row while the phone app is hidden, and still sets the needs-you row apart", () => {
    const items = grokProfileMenuItems({ ...base, onGetApp: undefined, onNeedsYou: vi.fn() });
    expect(items.map((item) => item.key)).toEqual(["needs-you", "sign-in", "support", "feedback", "settings"]);
    expect(items[1]).toMatchObject({ key: "sign-in", separatorBefore: true });
  });

  it("always offers Give feedback as its own row, outside Support, opening the feedback sheet", () => {
    const onFeedback = vi.fn();
    const items = grokProfileMenuItems({ ...base, onFeedback });
    const row = items.find((item) => item.key === "feedback")!;
    expect(row.label).toBe("Give feedback");
    expect(items.find((item) => item.key === "support")!.submenu!.map((item) => item.key)).not.toContain("feedback");
    row.onSelect();
    expect(onFeedback).toHaveBeenCalledOnce();
  });

  it("keeps grok's own rows alone while nothing needs the person", () => {
    const items = grokProfileMenuItems(base);
    // signed out, the account block's place is the sign-in, by name, and nothing signs out
    expect(items.map((item) => item.key)).toEqual(["sign-in", "mobile", "support", "feedback", "settings"]);
    expect(items[0]).toMatchObject({ label: "Sign in" });
    expect(items[0]!.separatorBefore).toBeUndefined();
    expect(items[1]).toMatchObject({ key: "mobile", separatorBefore: true });
  });

  it("signs in right there on this app's own page, not in Settings and not about dusk cloud", () => {
    const add = vi.fn(), onAddAccount = vi.fn();
    const items = grokProfileMenuItems({ ...base, onAddAccount, accounts: { view: { active: null, others: [] }, openSheet: null, signOut: vi.fn(), add } as never });
    items[0]!.onSelect();
    expect(add).toHaveBeenCalledOnce();
    expect(onAddAccount).not.toHaveBeenCalled();
  });

  it("signed in, leads with the account block (address, plan below) and ends with Sign out on its own row", () => {
    const signOut = vi.fn(), onSettings = vi.fn(), onDashboard = vi.fn();
    const active = { id: "acc-1", email: "ada@qa.dusk.test", name: "Ada Lovelace", plan: { status: "active", tier: "starter" } };
    const items = grokProfileMenuItems({ ...base, onSettings, onDashboard, accounts: { view: { active }, openSheet: null, signOut, add: vi.fn(), editAvatar: vi.fn() } as never });
    expect(items.map((item) => item.key)).toEqual(["who", "mobile", "dashboard", "support", "feedback", "settings", "log-out"]);
    expect(items[0]).toMatchObject({ label: "Ada Lovelace", labelNote: "Plus", subtitle: "ada@qa.dusk.test", title: "ada@qa.dusk.test", large: true });
    expect(items[1]).toMatchObject({ key: "mobile", separatorBefore: true });
    expect(items.at(-1)).toMatchObject({ label: "Sign out", separatorBefore: true });
    const trial = grokProfileMenuItems({ ...base, accounts: { view: { active: { ...active, plan: { status: "active", tier: "starter", trial: true } } }, openSheet: null, signOut, add: vi.fn(), editAvatar: vi.fn() } as never });
    expect(trial[0]).toMatchObject({ labelNote: "Plus trial" });
    expect(items.some((item) => item.label === "Account and sign out")).toBe(false);
    items[0]!.onSelect();
    expect(onDashboard).toHaveBeenCalledOnce();
    items.at(-1)!.onSelect();
    expect(signOut).toHaveBeenCalledWith("acc-1");
    const free = grokProfileMenuItems({ ...base, accounts: { view: { active: { id: "acc-2", email: "bo@qa.dusk.test", plan: { status: "free" } } }, openSheet: null, signOut, add: vi.fn() } as never });
    expect(free[0]).toMatchObject({ key: "who", label: "bo@qa.dusk.test", labelNote: "Free" });
    const unknown = grokProfileMenuItems({ ...base, accounts: { view: { active: { id: "acc-3", email: "cy@qa.dusk.test" } }, openSheet: null, signOut, add: vi.fn() } as never });
    expect(unknown[0]?.subtitle).toBeUndefined();
  });

  it("on a Cloud's page shows the block it is given and a Sign out that opens the sheet, never one combined row", () => {
    const openSheet = vi.fn();
    const header = { email: "ada@qa.dusk.test", plan: "dusk cloud · Pro", face: null };
    const items = grokProfileMenuItems({ ...base, header, accounts: { view: null, openSheet, signOut: vi.fn(), add: vi.fn() } as never });
    expect(items.map((item) => item.key)).toEqual(["who", "mobile", "support", "feedback", "settings", "log-out"]);
    expect(items[0]).toMatchObject({ label: "ada@qa.dusk.test", labelNote: "Pro" });
    items.at(-1)!.onSelect();
    expect(openSheet).toHaveBeenCalledOnce();
    const lent = grokProfileMenuItems({ ...base, header, accounts: { view: null, openSheet: null, signOut: vi.fn(), add: vi.fn() } as never });
    expect(lent[0]).toMatchObject({ key: "who", label: "ada@qa.dusk.test" });
    const nobody = grokProfileMenuItems({ ...base, accounts: { view: null, openSheet, signOut: vi.fn(), add: vi.fn() } as never });
    expect(nobody.map((item) => item.key)).toEqual(["mobile", "support", "feedback", "settings", "log-out"]);
    expect(nobody.at(-1)).toMatchObject({ label: "Sign out" });
  });

  it("puts the account dashboard right under the phone row when the menu can open it", () => {
    const onDashboard = vi.fn();
    const items = grokProfileMenuItems({ ...base, onDashboard });
    expect(items.map((item) => item.key)).toEqual(["sign-in", "mobile", "dashboard", "support", "feedback", "settings"]);
    expect(items[2]).toMatchObject({ label: "Account dashboard" });
    items[2]!.onSelect();
    expect(onDashboard).toHaveBeenCalledOnce();
  });
});

describe("personFace", () => {
  it("draws the dusk cloud account's face, else this place's photo, else a head from the address or name; nothing for nobody", async () => {
    const { personFace } = await import("./SidebarProfileMenu");
    const account = { id: "acc_1", email: "ada@example.test", avatar: "g:abc123" };
    expect(personFace({ email: "ada@example.test" }, account)).toEqual({ id: "acc_1", avatar: "g:abc123" });
    expect(personFace({ email: "Bob@Example.test" }, account)).toEqual({ id: "bob@example.test" });
    expect(personFace({ name: "Bob", avatarUrl: "/bob.png" }, null)).toEqual({ id: "Bob", avatarUrl: "/bob.png", avatar: "photo" });
    expect(personFace({}, null)).toBeNull();
  });
});

describe("withAccountFace", () => {
  it("lends the dusk cloud account's photo and name to the same person's profile, or to none, never to someone else's", async () => {
    const { withAccountFace } = await import("./SidebarProfileMenu");
    const account = { email: "ada@example.test", name: "Ada", avatarUrl: "https://photos.example.test/ada.png" };
    expect(withAccountFace(undefined, account)).toEqual(account);
    expect(withAccountFace({ email: "ADA@example.test" }, account)).toEqual({ email: "ADA@example.test", name: "Ada", avatarUrl: account.avatarUrl });
    expect(withAccountFace({ email: "ada@example.test", name: "Own", avatarUrl: "/own.png" }, account)).toEqual({ email: "ada@example.test", name: "Own", avatarUrl: "/own.png" });
    expect(withAccountFace({ email: "bob@example.test" }, account)).toEqual({ email: "bob@example.test" });
    expect(withAccountFace({ email: "bob@example.test" }, null)).toEqual({ email: "bob@example.test" });
    // a profile with no address of its own (this computer's) takes the account's, so the computer's initial never stands in
    expect(withAccountFace({}, { ...account, id: "acc_1" })).toMatchObject({ email: "ada@example.test", face: { id: "acc_1" } });
    expect(withAccountFace({ name: "Siddharth" }, account)).toMatchObject({ email: "ada@example.test", name: "Siddharth" });
  });

  it("shows a real photo over a drawn head unless the person picked a drawing", async () => {
    const { personFace } = await import("./SidebarProfileMenu");
    const { userAvatarFace } = await import("../../shared/user-avatar");
    const own = { email: "ada@example.test", avatarUrl: "https://photos.example.test/own.png" };
    const photo = (account: { id: string; email: string; avatarUrl?: string; avatar?: string }) => userAvatarFace(personFace(own, account)!);
    expect(photo({ id: "acc_1", email: "ada@example.test", avatar: "photo" })).toEqual({ kind: "photo", url: own.avatarUrl });
    expect(photo({ id: "acc_1", email: "ada@example.test", avatarUrl: "https://photos.example.test/google.png" })).toEqual({ kind: "photo", url: own.avatarUrl });
    expect(userAvatarFace(personFace({ email: "ada@example.test" }, { id: "acc_1", email: "ada@example.test", avatarUrl: "https://photos.example.test/google.png" })!)).toEqual({ kind: "photo", url: "https://photos.example.test/google.png" });
    expect(photo({ id: "acc_1", email: "ada@example.test", avatar: "g:abc123" })).toEqual({ kind: "drawn", seed: "abc123" });
  });
});

describe("the account on a Cloud's page", () => {
  it("takes the Cloud owner's address and the face main lends, and nothing without either", async () => {
    const { placeAccount, snapshotPlanText } = await import("./SidebarProfileMenu");
    const face = { id: "acc_1", avatarUrl: "https://photos.example.test/ada.png", plan: { status: "active" as const, tier: "pro" } };
    expect(placeAccount(undefined, { face, owner: "ada@example.test" })).toEqual({ profile: { email: "ada@example.test" }, account: { ...face, email: "ada@example.test" } });
    expect(placeAccount({ email: "own@example.test", name: "Ada" }, { face, owner: "ada@example.test" })?.account.email).toBe("own@example.test");
    expect(placeAccount(undefined, { face: null, owner: "ada@example.test" })).toBeNull();
    expect(placeAccount(undefined, { face, owner: null })).toBeNull();
    // the app's own session on a Cloud names no owner: the address main lends is the account's
    const lent = { ...face, email: "ada@example.test" };
    expect(placeAccount(undefined, { face: lent, owner: null })).toEqual({ profile: { email: "ada@example.test" }, account: lent });
    expect(placeAccount({}, { face: lent, owner: null })?.profile.email).toBe("ada@example.test");
    expect(snapshotPlanText({ status: "paid", tier: "starter" })).toBe("dusk cloud · Plus");
    expect(snapshotPlanText({ status: "none" })).toBeNull();
  });
});

describe("the account's name on this computer", () => {
  const account = { email: "robin@example.com", name: "Robin Field" };
  const copy = { name: "Robin Field", accountName: "Robin Field" };
  it("takes the name set on the website where the profile has none or only the computer's", () => {
    expect(adoptedAccountName(undefined, account, null)).toEqual(copy);
    expect(adoptedAccountName({ name: "" }, account, "Siddharth Meena")).toEqual(copy);
    expect(adoptedAccountName({ name: "Siddharth Meena" }, account, "Siddharth Meena")).toEqual(copy);
    expect(adoptedAccountName({ name: "Siddharth Meena", email: "ROBIN@example.com" }, account, "Siddharth Meena")).toEqual(copy);
  });
  it("follows a rename on the website while the profile still has the name it copied from the account", () => {
    expect(adoptedAccountName({ name: "Rob Field", accountName: "Rob Field" }, account, null)).toEqual(copy);
    expect(adoptedAccountName({ name: " Rob Field ", accountName: "Rob Field", email: "robin@example.com" }, account, null)).toEqual(copy);
  });
  it("follows a change of letter case on the website, even for a copy made before copies were marked", () => {
    expect(adoptedAccountName({ name: "robin field" }, account, null)).toEqual(copy);
    expect(adoptedAccountName({ name: "ROBIN FIELD", accountName: "Someone Else" }, account, null)).toEqual(copy);
  });
  it("marks a profile that already has the account's name as its copy, once", () => {
    expect(adoptedAccountName({ name: "Robin Field" }, account, null)).toEqual(copy);
    expect(adoptedAccountName(copy, account, null)).toBeNull();
  });
  it("keeps a name the person typed, another person's profile, and an account without a name", () => {
    expect(adoptedAccountName({ name: "Rob" }, account, "Siddharth Meena")).toBeNull();
    expect(adoptedAccountName({ name: "Rob", accountName: "Robin" }, account, null)).toBeNull();
    expect(adoptedAccountName({ name: "" , email: "someone@example.com" }, account, null)).toBeNull();
    expect(adoptedAccountName({ name: "Rob Field", accountName: "Rob Field", email: "someone@example.com" }, account, null)).toBeNull();
    expect(adoptedAccountName({ name: "" }, { email: "robin@example.com" }, null)).toBeNull();
    expect(adoptedAccountName({ name: "" }, null, null)).toBeNull();
  });
});
