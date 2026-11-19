import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudComposioConnect, removeActionOf, type CloudComposioConnectDeps } from "./cloud-composio-connect.ts";
import { COMPOSIO_CONNECT_URL, createComposioConnectRoutes, type AppConnection } from "./composio-connect.ts";
import { dashboardApps } from "./dashboard-apps.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cloud(answers: Record<string, AppConnection> = {}, removes = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "dusk-cloud-connect-"));
  dirs.push(dataDir);
  const servers: Record<string, unknown> = {};
  const state = { signedIn: false, signIns: 0, asked: [] as string[] };
  const deps: CloudComposioConnectDeps = {
    dataDir, servers: () => servers,
    add: (name, url) => { servers[name] = { type: "http", url, enabled: true }; },
    enable: () => {},
    signedIn: () => state.signedIn,
    withToken: async (_name, server) => ({ type: "http", url: server.url } as never),
    startSignIn: async () => { state.signIns++; return { authorizationUrl: `https://connect.composio.dev/oauth/authorize?client_id=c&state=st${state.signIns}` }; },
    remove: async (_spec, slug) => { state.asked.push(`remove:${slug}`); return removes; },
    manage: async (_spec, slug, _signal, action) => { state.asked.push(`${action}:${slug}`); return answers[`${action}:${slug}`] ?? { status: "none" }; },
  };
  return { connect: createCloudComposioConnect(deps), state, servers };
}

describe("connecting an app on a dusk cloud with no Composio key", () => {
  it("first time: Composio's own sign-in, and its callback sends the same tab on to the app's page", async () => {
    const c = cloud({ "add:gmail": { status: "started", url: "https://connect.composio.dev/link/lk_1" } });
    expect(await c.connect.connect("gmail")).toEqual({ url: "https://connect.composio.dev/oauth/authorize?client_id=c&state=st1" });
    expect(Object.values(c.servers)).toEqual([{ type: "http", url: COMPOSIO_CONNECT_URL, enabled: true }]);
    expect(await c.connect.afterSignIn("?code=x&state=nope")).toBeNull();
    c.state.signedIn = true;
    expect(await c.connect.afterSignIn("?code=x&state=st1")).toBe("https://connect.composio.dev/link/lk_1");
    // each state sends a tab on once
    expect(await c.connect.afterSignIn("?code=x&state=st1")).toBeNull();
  });

  it("once signed in: straight to the app's own sign-in page", async () => {
    const c = cloud({ "add:gmail": { status: "started", url: "https://connect.composio.dev/link/lk_2" } });
    c.state.signedIn = true;
    expect(await c.connect.connect("Gmail")).toEqual({ url: "https://connect.composio.dev/link/lk_2" });
    expect(c.state.signIns).toBe(0);
  });

  it("says why when Composio cannot hand back a page Metal trusts", async () => {
    const c = cloud({ "add:gmail": { status: "started", url: "https://evil.example/link" }, "add:slack": { status: "connected" }, "add:notion": { status: "failed", message: "Toolkit is not available." } });
    c.state.signedIn = true;
    await expect(c.connect.connect("gmail")).rejects.toMatchObject({ status: 502 });
    await expect(c.connect.connect("slack")).rejects.toMatchObject({ status: 409, message: "slack is connected already." });
    await expect(c.connect.connect("notion")).rejects.toMatchObject({ message: "Toolkit is not available." });
  });

  it("reports the apps connected this way to the dashboard", async () => {
    const c = cloud({ "add:gmail": { status: "started", url: "https://connect.composio.dev/link/lk_3" }, "list:gmail": { status: "connected" } });
    expect(await c.connect.apps()).toBeNull();
    c.state.signedIn = true;
    await c.connect.connect("gmail");
    const source = { connectorAvailability: () => "unconfigured" as const, connectedServicesInventory: async () => { throw new Error("unused"); } };
    expect(await dashboardApps({} as never, source, () => c.connect.apps())).toEqual({ available: true, complete: true, services: [{ slug: "gmail", connected: true, pending: false }] });
    expect(await dashboardApps({} as never, source)).toEqual({ available: false, complete: true, services: [] });
  });

  it("reports apps connected from a desktop's own apps page, where there is no key or broker", async () => {
    const c = cloud({ "list:gmail": { status: "connected" }, "list:github": { status: "waiting" } });
    c.state.signedIn = true;
    c.servers["composio-connect"] = { type: "http", url: COMPOSIO_CONNECT_URL, enabled: true };
    const answers: Record<string, AppConnection> = { "list:gmail": { status: "connected" }, "add:github": { status: "started", url: "https://connect.composio.dev/link/lk_5" }, "list:figma": { status: "none" } };
    const routes = createComposioConnectRoutes({ servers: () => c.servers, signedIn: () => true, withToken: async (_name, server) => ({ type: "http", url: server.url } as never), refusal: () => null,
      manage: async (_spec, slug, _signal, action) => answers[`${action}:${slug}`] ?? { status: "none" }, noted: (slug, status) => c.connect.noted(slug, status) });
    for (const [method, slug] of [["GET", "gmail"], ["POST", "github"], ["GET", "figma"]] as const) {
      await routes({ method, path: `/api/connectors/composio-connect/apps/${slug}`, res: {}, json: () => {} } as never);
    }
    const source = { connectorAvailability: () => "unconfigured", connectedServicesInventory: async () => { throw new Error("no broker"); } } as never;
    expect(await dashboardApps({} as never, source, () => c.connect.apps())).toEqual({ available: true, complete: true,
      services: [{ slug: "gmail", connected: true, pending: false }, { slug: "github", connected: false, pending: true }] });
  });

  it("disconnects through the same Composio Connect, or says where to remove it when its tool cannot", async () => {
    const c = cloud({ "add:gmail": { status: "started", url: "https://connect.composio.dev/link/lk_4" }, "list:gmail": { status: "connected" } });
    c.state.signedIn = true;
    await c.connect.connect("gmail");
    expect(await c.connect.disconnect("gmail")).toEqual({ removed: 1 });
    expect(c.state.asked).toContain("remove:gmail");
    expect(await c.connect.apps()).toEqual([]);
    const stuck = cloud({ "list:gmail": { status: "connected" } }, false);
    stuck.state.signedIn = true;
    stuck.servers["composio-connect"] = { type: "http", url: COMPOSIO_CONNECT_URL, enabled: true };
    await expect(stuck.connect.disconnect("gmail")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("composio.dev") });
    expect(await cloud().connect.disconnect("gmail")).toEqual({ removed: 0 });
  });

  it("reads a remove action only from the live tool's own schema", () => {
    const schema = (actions: string[]) => ({ tools: [{ name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: { properties: { toolkits: { items: { properties: { action: { enum: actions } } } } } } }] });
    expect(removeActionOf(schema(["list", "add"]))).toBeNull();
    expect(removeActionOf(schema(["list", "add", "remove"]))).toBe("remove");
    expect(removeActionOf({})).toBeNull();
  });
});
