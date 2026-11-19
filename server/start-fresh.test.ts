import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SERVER_LEASE_NAME } from "../electron/legacy-names.mjs";
import type { RequestAuth } from "./request-auth.ts";
import { applyPendingStartFresh, createStartFreshRoutes, requestStartFresh, START_FRESH_MARKER } from "./start-fresh.ts";
import { PASS } from "./routes/table.ts";

const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "start-fresh-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seeded() {
  const dir = folder();
  for (const name of ["config.json", "bots.json", "messages.db", "routines.json", "sessions.json", "environment-id", SERVER_LEASE_NAME]) writeFileSync(join(dir, name), "x");
  for (const name of ["attachments", "workspaces", "providers", "memory-journal", "tools"]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "inside"), "x");
  }
  return dir;
}

const session = (scopes: string[]): RequestAuth => ({ kind: "session", scopes, session: { id: "s1", email: null } } as unknown as RequestAuth);
const owner: RequestAuth = { kind: "loopback", scopes: [] } as unknown as RequestAuth;
const service: RequestAuth = { kind: "loopback", scopes: [], trust: "service" } as unknown as RequestAuth;

async function ask(auth: RequestAuth, { method = "POST", isOwner = false, managed = false } = {}) {
  const dir = seeded();
  const restart = vi.fn();
  const answers: Array<{ status: number; body: unknown }> = [];
  const route = createStartFreshRoutes({ dataDir: dir, owner: () => isOwner, managed: () => managed, restart });
  const out = await route({ req: {} as never, res: {} as never, url: new URL("http://x/api/start-fresh"), path: "/api/start-fresh", method, auth,
    json: ((_res: unknown, status: number, body: unknown) => { answers.push({ status, body }); }) as never, readBody: (async () => ({})) as never });
  return { dir, restart, answer: answers[0], out };
}

describe("start fresh on a Metal server", () => {
  it("lets this computer's desktop app ask, marks the folder and restarts, deleting nothing while running", async () => {
    const { dir, restart, answer } = await ask(owner);
    expect(answer?.status).toBe(202);
    expect(restart).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, START_FRESH_MARKER))).toBe(true);
    expect(existsSync(join(dir, "bots.json"))).toBe(true);
  });

  it("lets the one owner of a server of their own ask", async () => {
    const { answer, restart } = await ask(session(["admin"]), { isOwner: true });
    expect(answer?.status).toBe(202);
    expect(restart).toHaveBeenCalledOnce();
  });

  it.each([
    ["a shared server's bot shell", service, {}],
    ["someone who isn't this server's owner", session(["admin"]), { isOwner: false }],
    ["a member", session(["member"]), { isOwner: false }],
    ["even the owner, on a managed Cloud", owner, { managed: true }],
  ])("refuses %s, and touches nothing", async (_who, auth, options) => {
    const { dir, restart, answer } = await ask(auth, options);
    expect(answer?.status).toBe(403);
    expect(restart).not.toHaveBeenCalled();
    expect(existsSync(join(dir, START_FRESH_MARKER))).toBe(false);
  });

  it("answers only POST and leaves every other path to the next route", async () => {
    expect((await ask(owner, { method: "GET" })).answer?.status).toBe(405);
    const route = createStartFreshRoutes({ dataDir: folder(), owner: () => true, managed: () => false, restart: vi.fn() });
    expect(await route({ path: "/api/bots", method: "POST", auth: owner } as never)).toBe(PASS);
  });

  it("empties the folder at the next start, keeping only the lease and tools, and does it once", () => {
    const dir = seeded();
    expect(applyPendingStartFresh(dir)).toBe(false);
    expect(readdirSync(dir)).toContain("bots.json");
    requestStartFresh(dir);
    expect(applyPendingStartFresh(dir)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([SERVER_LEASE_NAME, "tools"].sort());
    // a second start finds nothing pending
    expect(applyPendingStartFresh(dir)).toBe(false);
  });
});
