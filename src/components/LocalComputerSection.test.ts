import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const storeFixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: storeFixture.config }, dispatch: vi.fn() }) };
});

import {
  LocalComputerSection,
  LocalVmIdleTimeoutField,
  LocalVmIdleTimeoutSetting,
  LocalVmInventoryCard,
  computerInventoryRequest,
  confirmComputerAction,
  localVmInventoryState,
  parseLocalVmIdleTimeoutMinutes,
  perBotLocalVmDeletePlan,
  vpsComputerRemovePlan,
  vpsComputerRestartPlan,
  vpsComputerInventoryState,
  vpsComputerShortId,
  type LocalVmInventoryInstance,
  type VpsComputerInventoryInstance,
} from "./LocalComputerSection";
import { VpsComputersCard } from "./VpsComputersCard";

const cloudVm: LocalVmInventoryInstance = {
  botId: "cloud-bot",
  name: "Research",
  destination: "cloud",
  container: "running",
  ready: true,
  managed: true,
  problem: null,
  inUse: false,
};

afterEach(() => setLocale("en"));

describe("computer inventory request wiring", () => {
  it("keeps every mount and refresh request observation-only", () => {
    const controller = new AbortController();
    const requests = ([
      ["status", "/api/local-computer"],
      ["local-vms", "/api/local-computer/instances"],
      ["vps", "/api/computers/vps"],
    ] as const).map(([kind, expectedUrl]) => ({
      expectedUrl,
      request: computerInventoryRequest(kind, controller.signal),
    }));

    for (const { expectedUrl, request: [url, init] } of requests) {
      expect(url).toBe(expectedUrl);
      expect(init).toEqual({ signal: controller.signal });
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it("does not expose a destructive request when confirmation is cancelled", () => {
    const confirm = vi.fn(() => false);
    const request = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);

    expect(request).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Delete Research's private desktop? Its durable folder and website sign-ins are kept. Apps installed inside the desktop and files outside the durable folder are deleted.",
    );
  });

  it("builds the exact confirmed Local VM and VPS lifecycle requests", () => {
    const confirm = vi.fn(() => true);
    const local = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);
    const vpsName = "duskbot-vps-current-123456abcdef";
    const vps = confirmComputerAction(vpsComputerRemovePlan({
      name: vpsName,
      state: "running",
      vpsAlias: "alpha-vps",
      ownerBotId: "current-owner",
      ownerName: "Research",
      orphaned: false,
      inUse: false,
    }), confirm);

    expect(local).toEqual([
      "/api/bots/cloud-bot/local-computer/remove",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ]);
    expect(vps).toEqual([
      `/api/computers/vps/${vpsName}/remove`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: vpsName, alias: "alpha-vps" }),
      },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("Local VM inventory UI", () => {
  it("shows capacity, current destinations, health, and an in-use deletion guard", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [
        cloudVm,
        {
          botId: "off-bot",
          name: "archive",
          destination: "off",
          container: "stopped",
          ready: false,
          managed: true,
          problem: "this desktop image cannot safely resume; recreate the Local VM",
          inUse: true,
        },
      ],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("2/4 created");
    expect(markup).toContain("Current destination: Cloud");
    expect(markup).toContain("Current destination: Off");
    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s turn before deleting its desktop.");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).not.toMatch(/viewer_url|workspace_path|password=/);
  });

  it("keeps state labels honest", () => {
    expect(localVmInventoryState(cloudVm)).toBe("Running");
    expect(localVmInventoryState({ ...cloudVm, ready: false })).toBe("Needs attention");
    expect(localVmInventoryState({ ...cloudVm, container: "stopped", ready: false })).toBe("Stopped");
    expect(localVmInventoryState({ ...cloudVm, inUse: true })).toBe("In use");
  });

  it("does not claim there are no VMs when the runtime cannot be inspected", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: "Start docker first",
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Inventory unavailable");
    expect(markup).toContain("Start docker first");
    expect(markup).not.toContain("No per-bot desktops have been created");
  });

  it("disables deletion while refreshing an existing inventory", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [cloudVm],
      maxInstances: 4,
      loading: true,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("shows unmanaged containers without offering an unsafe delete action", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [{
        ...cloudVm,
        managed: false,
        ready: false,
        problem: "Container labels do not match",
      }],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Not managed");
    expect(markup).toContain("This desktop wasn&#x27;t made by Metal.");
    expect(markup).toContain("Remove it in Docker or Podman.");
    expect(markup).not.toContain(">Delete</button>");
    expect(markup).not.toContain("Container labels do not match");
  });
});

describe("VPS computer inventory UI", () => {
  const ownedVps: VpsComputerInventoryInstance = {
    name: "duskbot-vps-current-123456abcdef",
    state: "running",
    vpsAlias: "production-vps",
    ownerBotId: "current-owner",
    ownerName: "Research",
    orphaned: false,
    inUse: false,
  };
  const renderCard = (overrides: Partial<Parameters<typeof VpsComputersCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(VpsComputersCard, {
      instances: [],
      configured: true,
      aliases: ["production-vps"],
      loading: false,
      removingName: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onRemove: vi.fn(),
      ...overrides,
    }));

  it("shows the configured host, owners, orphans, and status without raw container details", () => {
    const orphanName = "duskbot-vps-deleted-abcdef123456";
    const markup = renderCard({
      instances: [
        ownedVps,
        {
          name: orphanName,
          state: "exited",
          vpsAlias: "production-vps",
          ownerBotId: null,
          ownerName: null,
          orphaned: true,
          inUse: false,
        },
      ],
    });

    expect(markup).toContain("production-vps · 2 desktops");
    expect(markup).toContain("Research");
    expect(markup).toContain("Leftover desktop · ID ef123456");
    expect(markup).toContain("Running");
    expect(markup).toContain("Stopped");
    expect(markup).not.toMatch(new RegExp(`${ownedVps.name}|${orphanName}|containerId|VNC_PW|password`));
  });

  it("derives a stable identifier without exposing the bot-derived container name", () => {
    expect(vpsComputerShortId("duskbot-vps-deleted-abcdef123456")).toBe("ef123456");
    expect(vpsComputerShortId("unexpected-provider-name")).toBe("unknown");
  });

  it("disables removal while the owner is working", () => {
    const markup = renderCard({ instances: [{ ...ownedVps, inUse: true }] });

    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s work before removing its desktop.");
    expect(markup).toContain("disabled=\"\"");
  });

  it("offers restart on a running desktop even while bots are stuck on it, and posts only to its own name", () => {
    const markup = renderCard({ instances: [{ ...ownedVps, inUse: true }, { ...ownedVps, name: "duskbot-vps-asleep-123456abcdef", state: "exited" }], onRestart: vi.fn() });
    expect(markup.match(/>Restart<\/button>/g)).toHaveLength(1);
    expect(markup).toMatch(/<button type="button" title="Stop this desktop[^"]*" class="ui-button">Restart<\/button>/);
    const confirm = vi.fn(() => true);
    expect(confirmComputerAction(vpsComputerRestartPlan(ownedVps), confirm)).toEqual([
      `/api/computers/vps/${ownedVps.name}/restart`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ]);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Restart Research's desktop?"));
  });

  it("disables removal while refreshing an existing inventory", () => {
    const markup = renderCard({ instances: [ownedVps], loading: true });

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps disconnected, unavailable, and empty states distinct", () => {
    expect(renderCard({ configured: false, aliases: [] })).toBe("");
    expect(renderCard({ unavailableReason: "SSH host cannot be reached" })).toContain("SSH host cannot be reached");
    expect(renderCard()).toContain("None yet");
  });

  it("tags computers on more than one server and keeps reachable rows beside the warning", () => {
    const second = {
      ...ownedVps,
      name: "duskbot-vps-second-123456abcdef",
      vpsAlias: "alpha-vps",
      ownerName: "Ops",
    };
    const multi = renderCard({ aliases: ["production-vps", "alpha-vps"], instances: [ownedVps, second] });
    expect(multi).toContain("production-vps, alpha-vps · 2 desktops");
    expect(multi).toContain("alpha-vps");
    expect(multi).not.toMatch(new RegExp(`${second.name}|containerId|VNC_PW`));

    // One unreachable server must not hide the computers it could still list.
    const partial = renderCard({
      aliases: ["production-vps", "alpha-vps"],
      instances: [ownedVps, second],
      unavailableReason: "Docker over SSH could not list managed computers on alpha-vps",
    });
    expect(partial).toContain("Docker over SSH could not list managed computers on alpha-vps");
    expect(partial).toContain("Research");
    expect(partial).toContain("Ops");
  });

  it("uses honest status labels", () => {
    expect(vpsComputerInventoryState(ownedVps)).toBe("Running");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "exited" })).toBe("Stopped");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "paused" })).toBe("Paused");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "restarting" })).toBe("Restarting");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "dead" })).toBe("Needs attention");
    expect(vpsComputerInventoryState({ ...ownedVps, inUse: true })).toBe("In use");
  });

  it("keeps running and paused VPS badge colors when labels are translated", () => {
    setLocale("pt-br");
    const running = renderCard({ instances: [ownedVps] });
    expect(running).toContain('data-computer-state="good" class="shrink-0 text-[13px] leading-[18px] text-success">Em execução</span>');
    expect(running).toContain("Remover");
    expect(running).not.toContain(">Remove</button>");
    expect(renderCard({ instances: [{ ...ownedVps, state: "paused" }] }))
      .toContain('data-computer-state="idle" class="shrink-0 text-[13px] leading-[18px] text-ink-secondary">Pausado</span>');
  });
});

describe("Settings → Computers on a dusk cloud home", () => {
  afterEach(() => { storeFixture.config = null; });
  // the labels and row names the page draws
  const cards = () => [...renderToStaticMarkup(createElement(LocalComputerSection)).matchAll(/<(?:div|h3)[^>]*data-(?:row-title|settings-heading)=""[^>]*>([^<]+)<\/(?:div|h3)>/g)].map((match) => match[1]);

  it("sets up a Local VM on a desktop or self-hosted server", () => {
    expect(cards()).toEqual(expect.arrayContaining(["Your VPS", "Private desktop", "Setup and options"]));
  });

  it("shows no Local VM, and no steps to install one, where it cannot exist", () => {
    storeFixture.config = { cloudHome: true };
    const titles = cards();
    expect(titles).toContain("Your VPS");
    expect(titles).not.toContain("Private desktop");
    expect(titles).not.toContain("Setup and options");
  });
});

describe("Local VM idle timeout setting", () => {
  it.each([["5", 5], ["30", 30], [" 480 ", 480], ["1440", 1_440]])("accepts %j", (value, minutes) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBe(minutes);
  });

  it.each(["", "4", "1441", "1.5", "-30", "30m", "1e2"])("rejects %j", (value) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBeNull();
  });

  it("shows the confirmed window as the row's value, and its form as a bounded, labelled minutes field", () => {
    const row = renderToStaticMarkup(createElement(LocalVmIdleTimeoutSetting, {
      minutes: 30,
      disabled: false,
      onSave: async () => {},
    }));
    expect(row).toContain("Stop idle desktops after");
    expect(row).toContain("30 minutes");
    expect(row).not.toContain("<input");
    const field = renderToStaticMarkup(createElement(LocalVmIdleTimeoutField, { value: "30", disabled: false, error: "", onChange: () => {} }));
    expect(field).toMatch(/<label[^>]*>[\s\S]*Stop idle desktops after[\s\S]*<input[^>]*id="local-vm-idle-timeout"/);
    expect(field).toContain('min="5"');
    expect(field).toContain('max="1440"');
    expect(field).toContain('value="30"');
    expect(field).toContain("minutes");
  });
});
