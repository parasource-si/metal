// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), admin: true as boolean | null, config: null as { cloudHome?: boolean } | null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { bots: [{ id: "pepper", name: "Pepper" }, { id: "quill", name: "Quill" }], config: fixture.config }, dispatch: vi.fn() }),
}));
// every password, 2FA key and token leaves sealed (src/lib/sealed-send.ts has its own tests): the fake names what it sealed, never the value
vi.mock("@/lib/sealed-send", () => ({
  sendSealed: async (purpose: string, target: string[], values: Record<string, string>, send: (sealed: unknown) => Promise<unknown>) => {
    const names = Object.keys(values).filter((name) => values[name]).sort();
    return send(names.length ? { keyId: "k", encapsulatedKey: "E", ciphertext: `${purpose}|${target.join("|")}|${names.join(",")}` } : null);
  },
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
// the Vault's saved secrets load on their own (SavedSecretsSettings.tsx); these tests count the logins calls only
vi.mock("./SavedSecretsSettings", () => ({ useSavedSecrets: () => ({ secrets: [], error: null, remove: async () => {} }), SavedSecretDialog: () => null }));
const { LoginsSettings, VaultNewItem } = await import("./LoginsSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const CARD_LOGIN = { id: "l1", site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false, username: "alice@example.com", hasTotp: true, source: "card", bots: ["pepper"], createdAt: 1, lastUsedAt: Date.now() - 120_000 };
const SHARED_LOGIN = { id: "l2", site: "example.org", hosts: ["crm.example.org"], exactHost: false, username: "team", hasTotp: false, source: "settings", bots: "all", createdAt: 2 };
const TENANT_LOGIN = { id: "l3", site: "okta.com", hosts: ["acme.okta.com"], exactHost: true, username: "ops", hasTotp: false, source: "settings", bots: "all", createdAt: 3 };
const VAULT_LOGIN = { id: "1password:v1:i1:example.com", site: "example.com", hosts: ["vault.example.com"], exactHost: false, username: "vault-user", hasTotp: false, source: "1password", bots: "all", createdAt: 0 };
const OFF = { connected: false };

beforeEach(() => {
  fixture.api.mockReset();
  fixture.admin = true;
  fixture.config = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => root.render([createElement(VaultNewItem, { key: "new" }), createElement(LoginsSettings, { key: "list" })]));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function type(name: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openOnePassword() {
  await click("New item");
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.getAttribute("aria-label") === "1Password")!.click());
}
async function submit() {
  await act(async () => { document.body.querySelector<HTMLFormElement>("[data-login-form]")!.requestSubmit(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Settings → Logins", () => {
  it("lists each login by site, the sign-in hosts it also fills on, username, 2FA, source, who may use it and last use", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN, SHARED_LOGIN, TENANT_LOGIN], onePassword: OFF });
    await render();
    expect(fixture.api).toHaveBeenCalledWith("/api/logins");
    const rows = [...document.body.querySelectorAll("[data-login-row]")].map((row) => `${row.textContent} | ${row.getAttribute("data-login-detail")}`);
    expect(rows[0]).toContain("example.com");
    expect(rows[0]).toContain("alice@example.com");
    expect(rows[0]).toContain("Also signs in on login.microsoftonline.com");
    expect(rows[0]).toContain("2FA");
    expect(rows[0]).toContain("Saved from a chat · Pepper · Used 2 min ago");
    expect(rows[1]).toContain("Added here · All bots · Not used yet");
    expect(rows[1]).toContain("Also signs in on crm.example.org");
    expect(rows[2]).toContain("Only on acme.okta.com");
    expect(document.body.querySelector("[data-logins-list]")!.querySelectorAll("input")).toHaveLength(0);
  });

  it("adds a login for the bots chosen, and keeps nothing it was typed once saved", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockResolvedValueOnce({ login: SHARED_LOGIN }).mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(document.body.textContent).toContain("Nothing saved yet");
    await click("New item");
    await click("Add login");
    await type("site", "crm.example.org");
    await type("username", "team");
    await type("password", "fake-typed-pass");
    await act(async () => { [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click(); });
    await act(async () => { document.body.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins", { method: "POST", body: JSON.stringify({ site: "crm.example.org", username: "team", sealed: { keyId: "k", encapsulatedKey: "E", ciphertext: "login.create|crm.example.org|team|password" }, bots: ["pepper"] }) });
    expect(document.body.querySelector("[data-login-form]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("fake-typed-pass");
  });

  it("keeps a new login to its exact address when asked", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockResolvedValueOnce({ login: TENANT_LOGIN }).mockResolvedValueOnce({ logins: [TENANT_LOGIN], onePassword: OFF });
    await render();
    await click("New item");
    await click("Add login");
    await type("site", "acme.okta.com");
    await type("password", "fake-tenant-pass");
    const exact = document.body.querySelector<HTMLInputElement>('input[name="exactHost"]')!;
    expect(exact.checked).toBe(false);
    expect(exact.closest("label")!.textContent).toBe("Only on this exact address, not elsewhere on its site");
    await act(async () => { exact.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins", { method: "POST", body: JSON.stringify({ site: "acme.okta.com", username: "", sealed: { keyId: "k", encapsulatedKey: "E", ciphertext: "login.create|acme.okta.com||password" }, bots: "all", exactHost: true }) });
  });

  it("replaces a password, keeps the 2FA key unless asked, and changes who may use it", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ login: CARD_LOGIN }).mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF });
    await render();
    await click("Change the login for example.com");
    expect(document.body.querySelector<HTMLInputElement>('input[name="password"]')!.value).toBe("");
    await type("password", "fake-new-pass");
    await act(async () => { document.body.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "PATCH", body: JSON.stringify({ sealed: { keyId: "k", encapsulatedKey: "E", ciphertext: "login.update|l1|password" }, bots: "all" }) });
  });

  it("keeps a login to its sign-in hosts, or lets it fill on its whole site again", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ login: CARD_LOGIN }).mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF });
    await render();
    await click("Change the login for example.com");
    const exact = document.body.querySelector<HTMLInputElement>('input[name="exactHost"]')!;
    expect(exact.closest("label")!.textContent).toBe("Only on example.com, login.microsoftonline.com, not elsewhere on example.com");
    await act(async () => { exact.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "PATCH", body: JSON.stringify({ bots: ["pepper"], exactHost: true }) });
  });

  it("deletes only on a second click", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ logins: [], onePassword: OFF });
    await render();
    await click("Change the login for example.com");
    await click("Delete the login for example.com");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await click("Delete for good");
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "DELETE" });
  });

  it("connects 1Password with a masked token it then forgets, lists its logins read-only, and disconnects", async () => {
    const on = { connected: true, vaults: [{ id: "v1", title: "Shared with Metal", items: 1, bots: "all" }], items: 1 };
    fixture.api
      .mockResolvedValueOnce({ logins: [], onePassword: OFF })
      .mockResolvedValueOnce({ onePassword: on })
      .mockResolvedValueOnce({ logins: [VAULT_LOGIN], onePassword: on })
      .mockResolvedValueOnce({ onePassword: OFF })
      .mockResolvedValueOnce({ logins: [], onePassword: OFF });
    await render();
    // nothing about 1Password shows until it is connected: New item opens it
    expect(document.body.querySelector("[data-onepassword]")).toBeNull();
    await openOnePassword();
    expect(document.body.querySelector('[data-panel-modal="onepassword"]')!.textContent).toContain("service account that reads one vault");
    const field = document.body.querySelector<HTMLInputElement>('input[name="onePasswordToken"]')!;
    expect(field.type).toBe("password");
    await type("onePasswordToken", "ops_fake-typed-token");
    await click("Connect 1Password");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/1password", { method: "POST", body: JSON.stringify({ sealed: { keyId: "k", encapsulatedKey: "E", ciphertext: "onepassword.connect||token" } }) });
    expect(document.body.querySelector("[data-onepassword]")!.textContent).toContain("Connected to Shared with Metal · 1 logins with a website");
    expect(document.body.innerHTML).not.toContain("ops_fake-typed-token");
    const row = document.body.querySelector('[data-login-row="example.com"]')!;
    expect(row.getAttribute("data-login-detail")).toContain("From 1Password · All bots");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    await click("Disconnect");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(4, "/api/logins/1password", { method: "DELETE" });
    await openOnePassword();
    expect(document.body.querySelector<HTMLInputElement>('input[name="onePasswordToken"]')!.value).toBe("");
  });

  it("keeps a 1Password vault to the bots chosen for it, on the same screen", async () => {
    const vault = { id: "v1", title: "Shared with Metal", items: 2, bots: "all" };
    const on = { connected: true, vaults: [vault], items: 2 };
    const narrowed = { ...on, vaults: [{ ...vault, bots: ["quill"] }] };
    fixture.api
      .mockResolvedValueOnce({ logins: [VAULT_LOGIN], onePassword: on })
      .mockResolvedValueOnce({ onePassword: narrowed })
      .mockResolvedValueOnce({ logins: [{ ...VAULT_LOGIN, bots: ["quill"] }], onePassword: narrowed });
    await render();
    const row = () => document.body.querySelector('[data-vault="Shared with Metal"]')!;
    expect(row().textContent).toContain("2 logins · All bots");
    await click("Change who can use Shared with Metal");
    await act(async () => { [...row().querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click(); });
    await act(async () => { [...row().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!.click(); });
    await click("Save changes");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/1password/vaults/v1", { method: "PATCH", body: JSON.stringify({ bots: ["quill"] }) });
    expect(row().textContent).toContain("2 logins · Quill");
    expect(document.body.querySelector('[data-login-row="example.com"]')!.getAttribute("data-login-detail")).toContain("From 1Password · Quill");
  });

  it("says why 1Password refused a token", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockRejectedValueOnce(new Error("1Password did not accept the token."));
    await render();
    await openOnePassword();
    await type("onePasswordToken", "ops_fake-wrong");
    await click("Connect 1Password");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.body.querySelector('[data-panel-modal="onepassword"] [role=alert]')!.textContent).toBe("1Password did not accept the token.");
  });

  it("is for admins only", async () => {
    fixture.admin = false;
    await render();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Only an admin of this installation can see and change saved logins.");
  });
});

describe("Settings → Logins with My Cloud", () => {
  afterEach(() => { delete (window as { duskDesktop?: unknown }).duskDesktop; });
  const where = (site: string) => document.body.querySelector(`[data-login-row="${site}"] [data-login-where]`)?.textContent;

  it("without My Cloud says nothing of sides; on My Cloud itself shows no line about logins and sends nothing", async () => {
    (window as { duskDesktop?: unknown }).duskDesktop = { cloudLogins: { state: vi.fn().mockResolvedValue({ cloud: null }), send: vi.fn() } };
    fixture.api.mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(document.body.querySelector("[data-logins-sides]")).toBeNull();
    expect(document.body.querySelector("[data-also-cloud]")).toBeNull();
    expect(where("example.org")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    delete (window as { duskDesktop?: unknown }).duskDesktop;
    fixture.config = { cloudHome: true };
    fixture.api.mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(document.body.textContent).not.toContain("come along when you move your bots here");
    expect(document.body.querySelector("[data-also-cloud]")).toBeNull();
  });
});
