import assert from "node:assert/strict";
import test from "node:test";
import { accountFromWire, billingFromWire, cartFromQuote, cartFromSelection, catalogFromWire, cloudFromWire, providersFromWire, selectionFromCart, subscriptionFromWire } from "./live.ts";
import type { Selection } from "./contracts.ts";
import { CLOUD_STATUSES, SETUP_STEPS, SUBSCRIPTION_STATUSES, type AccountAnswer, type BillingOverview, type Catalog, type CloudDesktopView, type Quote, type SubscriptionView } from "./wire.ts";

const catalog: Catalog = {
  v: 1, currency: "USD", defaultRegion: "eu", yearlyDiscountPercent: 20, freeWorkUntil: 1_800_000_000_000, graceDays: 7,
  licenses: [
    { kind: "solo", label: "Solo", monthlyCents: 1200, includedMembers: 1, extraMemberCents: null, maxMembers: 1, priority: false },
    { kind: "team", label: "Team", monthlyCents: 3000, includedMembers: 3, extraMemberCents: 1500, maxMembers: 50, priority: true },
  ],
  desktops: [
    { kind: "shared_s", label: "Plus", monthlyCents: 1000, machine: { vcpu: 2, ramGb: 4, diskGb: 40 }, placement: "pool", botComputers: 2, priority: false },
    { kind: "shared_m", label: "Pro", monthlyCents: 4000, machine: { vcpu: 4, ramGb: 8, diskGb: 80 }, placement: "pool", botComputers: 5, priority: true },
    { kind: "dedicated", label: "Dedicated", monthlyCents: null, machine: { vcpu: 8, ramGb: 16, diskGb: 165 }, placement: "dedicated", botComputers: null, priority: true },
  ],
  dedicated: { baseCents: 600, perVcpuCents: 350, perGbRamCents: 125, per20GbDiskCents: 102, includedDiskGb: 100, vcpu: { min: 2, max: 32, step: 2 }, ramGb: { min: 4, max: 64, step: 4 }, diskGb: { min: 40, max: 1000, step: 20 }, sizes: [] },
  bundles: [
    { id: "free", label: "Free", monthlyCents: 0, yearlyMonthlyCents: 0, cart: { license: { kind: "none" }, desktop: { kind: "none" } }, highlights: ["Personal use"] },
    { id: "starter", label: "Starter", monthlyCents: 2000, yearlyMonthlyCents: 1600, cart: { license: { kind: "solo" }, desktop: { kind: "shared_s" } }, highlights: ["Always on"] },
    { id: "pro", label: "Pro", monthlyCents: 5000, yearlyMonthlyCents: 4000, cart: { license: { kind: "solo" }, desktop: { kind: "shared_m" } }, highlights: ["Priority"] },
    { id: "team", label: "Team", monthlyCents: 10000, yearlyMonthlyCents: 8000, cart: { license: { kind: "team" }, desktop: { kind: "dedicated" } }, highlights: ["Unlimited computers"] },
  ],
  regions: [{ id: "us", country: "United States", label: "Ashburn" }, { id: "eu", country: "Germany", label: "Falkenstein" }, { id: "ap", country: "Singapore", label: "Singapore" }],
};

test("catalog maps ids, prices, bundles, custom pricing and the default region", () => {
  const result = catalogFromWire(catalog);
  assert.deepEqual(result.licenses[0], { id: "personal", name: "personal", monthly: 0, includedMembers: 1, perExtraMember: 0, maxMembers: 1, work: false, blurb: "personal and non-commercial use" });
  assert.deepEqual(result.licenses.slice(1).map((license) => [license.id, license.name, license.monthly, license.perExtraMember, license.work, license.blurb]), [["starter", "solo", 12, 0, true, ""], ["team", "team", 30, 15, true, ""]]);
  assert.deepEqual(result.desktops.map((desktop) => [desktop.id, desktop.placement, desktop.monthly, desktop.sizable]), [["shared-s", "shared", 10, false], ["shared-m", "shared", 40, false], ["dedicated", "dedicated", 57.32, true]]);
  assert.equal(result.custom.includedDiskGb, 100);
  assert.equal(result.custom.base, 6);
  assert.equal(result.custom.perVcpu, 3.5);
  assert.equal(result.custom.perGbRam, 1.25);
  assert.equal(result.custom.per20GbDisk, 1.02);
  assert.deepEqual(result.custom.diskGb, catalog.dedicated.diskGb);
  assert.deepEqual(result.bundles.map((bundle) => [bundle.license, bundle.members, bundle.desktop, bundle.monthly, bundle.recommended]), [["personal", 1, "none", 0, false], ["starter", 1, "shared-s", 20, false], ["starter", 1, "shared-m", 50, true], ["team", 3, "dedicated", 100, false]]);
  assert.equal(result.bundles[0]!.blurb, "for personal use on your computer or your own vps");
  assert.equal(result.bundles[1]!.blurb, "dusk cloud, always available");
  assert.equal(result.bundles[2]!.blurb, "a bigger machine, priority wake and a work license");
  assert.equal(result.bundles[3]!.blurb, "a dedicated machine and a team license");
  assert.deepEqual(result.bundles[2]!.features, ["Priority"]);
  assert.deepEqual(result.regions, [{ id: "eu", name: "Germany", city: "Falkenstein" }, { id: "us", name: "United States", city: "Ashburn" }, { id: "ap", name: "Singapore", city: "Singapore" }]);
  assert.equal(result.yearlyDiscount, 0.2);
  assert.equal(result.workFreeUntil, catalog.freeWorkUntil);
  const smaller = structuredClone(catalog);
  smaller.desktops[2]!.machine.diskGb = 40;
  assert.equal(catalogFromWire(smaller).desktops[2]!.monthly, 54);
});

test("selection and cart round trip and omit fields irrelevant to the chosen parts", () => {
  const plans = catalogFromWire(catalog);
  for (const license of ["personal", "starter", "team"] as const) for (const desktop of ["none", "shared-s", "shared-m", "dedicated"] as const) for (const interval of ["month", "year"] as const) {
    const selection: Selection = { license, members: license === "team" ? 7 : 1, desktop, size: desktop === "dedicated" ? { vcpu: 8, ramGb: 16, diskGb: 160 } : null, region: desktop === "none" ? "eu" : "us", interval };
    const cart = cartFromSelection(selection);
    assert.deepEqual(selectionFromCart(cart, plans), selection);
    assert.equal("members" in cart.license, license === "team");
    assert.equal("region" in cart.desktop, desktop !== "none");
    assert.equal("spec" in cart.desktop, desktop === "dedicated");
  }
  assert.deepEqual(selectionFromCart({ interval: "month", license: { kind: "team" }, desktop: { kind: "dedicated" } }, plans), { license: "team", members: 3, desktop: "dedicated", size: null, region: "eu", interval: "month" });
  const irrelevant: Selection = { license: "starter", members: 99, desktop: "none", region: "ap", size: { vcpu: 4, ramGb: 8, diskGb: 80 }, interval: "month" };
  assert.deepEqual(cartFromSelection(irrelevant), { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } });
});

test("yearly team quote merges extra members and uses service totals without bundle savings", () => {
  const plans = catalogFromWire(catalog);
  const quote: Quote = {
    cart: { interval: "year", license: { kind: "team", members: 5 }, desktop: { kind: "shared_m", region: "eu" } },
    bundle: null,
    lines: [
      { kind: "license", label: "Team license, 3 members", amountCents: 48000 },
      { kind: "members", label: "2 extra members", amountCents: 36000 },
      { kind: "desktop", label: "dusk cloud pro", amountCents: 48000 },
      { kind: "discount", label: "Yearly discount (20%)", amountCents: -26400 },
    ],
    totalCents: 105600, monthlyEquivalentCents: 8800, machine: { vcpu: 4, ramGb: 8, diskGb: 80 }, botComputers: 5, members: 5,
  };
  assert.deepEqual(cartFromQuote(quote, plans), {
    lines: [
      { key: "license", label: "team license", detail: "5 members, 2 extra", monthly: 70 },
      { key: "desktop", label: "dusk cloud, pro", detail: "4 vcpu · 8 gb ram · 80 gb disk", monthly: 40 },
    ],
    subtotal: 110, bundle: null, bundleSaving: 0, discount: 22, perMonth: 88, dueNow: 1056, free: false,
  });
  const fractional = cartFromQuote({ ...quote, lines: [
    { kind: "license", label: "Team license", amountCents: 48012 },
    ...quote.lines.slice(1, 3),
    { kind: "discount", label: "Yearly discount (17%)", amountCents: -22442 },
  ], totalCents: 109570, monthlyEquivalentCents: 9131 }, plans);
  assert.equal(fractional.subtotal, 110.01);
  assert.equal(fractional.discount, 22442 / 1200);
  assert.equal(fractional.perMonth, 91.31);
  assert.equal(fractional.dueNow, 1095.7);
});

test("small dedicated quote keeps its service price below the default desktop price", () => {
  const plans = catalogFromWire(catalog);
  const quote: Quote = {
    cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "dedicated", region: "eu", spec: { vcpu: 2, ramGb: 4, diskGb: 40 } } },
    bundle: null, lines: [{ kind: "desktop", label: "dusk cloud dedicated, 2 vCPU, 4 GB, 40 GB", amountCents: 2400 }],
    totalCents: 2400, monthlyEquivalentCents: 2400, machine: { vcpu: 2, ramGb: 4, diskGb: 40 }, botComputers: null, members: 0,
  };
  assert.deepEqual(cartFromQuote(quote, plans), {
    lines: [{ key: "desktop", label: "dusk cloud, dedicated", detail: "2 vcpu · 4 gb ram · 40 gb disk", monthly: 24 }],
    subtotal: 24, bundle: null, bundleSaving: 0, discount: 0, perMonth: 24, dueNow: 24, free: false,
  });
  const free = cartFromQuote({ ...quote, cart: { interval: "year", license: { kind: "none" }, desktop: { kind: "none" } }, bundle: "free", lines: [{ kind: "discount", label: "Yearly discount", amountCents: 0 }], totalCents: 0, monthlyEquivalentCents: 0, machine: null }, plans);
  assert.equal(free.free, true);
  assert.equal(free.bundle, plans.bundles[0]);
  assert.equal(cartFromQuote({ ...quote, totalCents: 0, monthlyEquivalentCents: 0 }, plans).free, false);
  const selection: Selection = { license: "personal", members: 1, desktop: "dedicated", size: null, region: "eu", interval: "month" };
  assert.deepEqual(cartFromSelection(selection, plans).desktop.spec, { vcpu: 8, ramGb: 16, diskGb: 165 });
});

const cloud: CloudDesktopView = { id: "cloud", name: "My Cloud", color: null, kind: "shared_m", placement: "pool", status: "provisioning", setupStep: "reserving", region: "eu", machine: { vcpu: 4, ramGb: 8, diskGb: 80 }, botComputers: 5, origin: null, workspaceId: "workspace", lastReportAt: null, destroyAt: null, error: null, subscriptionId: "sub", createdAt: 123 };

test("cloud statuses, progress, errors and destroyed or unpaid desktops map to the view", () => {
  const expected = [null, "provisioning", "running", "sleeping", "stopped", "error", "error", "error", null, null];
  CLOUD_STATUSES.forEach((status, index) => {
    const result = cloudFromWire({ ...cloud, status });
    assert.equal(result?.status ?? null, expected[index]);
    if (result && result.status !== "provisioning") assert.equal(result.progress, null);
  });
  const labels = ["reserving your machine", "preparing its disk", "installing Metal", "waking your bots"];
  SETUP_STEPS.forEach((setupStep, index) => assert.deepEqual(cloudFromWire({ ...cloud, setupStep })!.progress, { step: labels[index], value: (index + 0.5) / 4 }));
  assert.equal(cloudFromWire({ ...cloud, setupStep: null })!.progress, null);
  assert.equal(cloudFromWire({ ...cloud, status: "payment_problem" })!.error, "the last payment did not go through. update your card to wake it.");
  assert.equal(cloudFromWire({ ...cloud, status: "suspended" })!.error, "it is paused. write to us at hello@dusk.bot to sort it out.");
  assert.equal(cloudFromWire({ ...cloud, status: "error", error: "Setup failed" })!.error, "Setup failed");
  assert.deepEqual(cloudFromWire({ ...cloud, status: "running" }), { id: "cloud", name: "My Cloud", status: "running", tier: "shared-m", placement: "shared", region: "eu", vcpu: 4, ramGb: 8, diskGb: 80, workspaceId: "workspace", createdAt: 123, progress: null, error: null, botComputers: { used: 0, limit: 5 }, uptimeSec: null });
  assert.equal(cloudFromWire({ ...cloud, kind: "dedicated", placement: "dedicated", botComputers: null })!.tier, "dedicated");
});

test("a sleeping managed cloud whose wake is under way reads as waking, never while it runs", () => {
  assert.equal(cloudFromWire({ ...cloud, status: "sleeping", provider: "managed", waking: true })!.status, "waking");
  assert.equal(cloudFromWire({ ...cloud, status: "sleeping", provider: "managed", waking: false })!.status, "sleeping");
  assert.equal(cloudFromWire({ ...cloud, status: "running", provider: "managed", waking: true })!.status, "running");
});

test("a managed cloud we put to sleep reads as live; the owner's pause, billing and an egress pause stay honest", () => {
  const slept = { ...cloud, status: "sleeping" as const, provider: "managed" as const };
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "idle" })!.status, "running");
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "idle" })!.resting, true);
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "idle", waking: true })!.status, "running");
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "user" })!.status, "sleeping");
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "user" })!.resting, undefined);
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "user", waking: true })!.status, "waking");
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "operator" })!.status, "sleeping");
  assert.equal(cloudFromWire({ ...slept, stoppedBy: "idle", egress: { bytes: 1, state: "paused", until: 2 } })!.status, "sleeping");
  assert.equal(cloudFromWire({ ...slept })!.status, "sleeping");
  assert.equal(cloudFromWire({ ...cloud, status: "suspended", stoppedBy: "idle" })!.status, "error");
});

const account: AccountAnswer = {
  account: { id: "account", email: "me@example.test", name: null, providers: ["google", "email", "apple"], createdAt: 1000 },
  identities: [
    { provider: "google", label: "My name", email: "google@example.test", addedAt: 2000 },
    { provider: "apple", label: null, email: null, addedAt: 4000 },
  ],
  sessions: ["web", "desktop", "mobile"].map((kind, index) => ({ id: String(index), kind: kind as "web" | "desktop" | "mobile", name: `Device ${index}`, platform: "Platform", appVersion: null, createdAt: 1000, lastSeenAt: 5000, expiresAt: 10000, current: index === 0 })),
  notifications: { cloudStatus: true, product: false },
  onboarded: false,
};

test("account prepends email, preserves OAuth identities, and maps devices, preferences and the onboarded mark", () => {
  const emptyStorage = { getItem: () => null };
  const result = accountFromWire(account, 5000, emptyStorage);
  assert.deepEqual(result.identities, [{ provider: "email", label: "me@example.test", linkedAt: 1000 }, { provider: "google", label: "My name", linkedAt: 2000 }, { provider: "apple", label: "", linkedAt: 4000 }]);
  assert.deepEqual(result.devices.map((device) => [device.kind, device.label, device.location, device.current]), [["browser", "Device 0", null, true], ["desktop", "Device 1", null, false], ["phone", "Device 2", null, false]]);
  assert.equal(result.profile.onboarded, false);
  assert.equal(result.profile.avatarUrl, null);
  assert.deepEqual(result.notifications, { cloudStatus: true, product: false });
  const saved = new Map([["dusk-dash-onboarded:account", "1"], ["dusk-dash-notify", JSON.stringify({ cloudStatus: false, product: true })]]);
  const local = accountFromWire(account, 5000, { getItem: (key) => saved.get(key) ?? null });
  assert.equal(local.profile.onboarded, true, "the local mark is a cache");
  assert.deepEqual(local.notifications, result.notifications, "notifications come from the account, never the browser");
  assert.equal(accountFromWire({ ...account, onboarded: true }, 5000, emptyStorage).profile.onboarded, true, "onboarded in another browser");
  assert.equal(accountFromWire(account, 86_401_001, emptyStorage).profile.onboarded, true);
  assert.deepEqual(accountFromWire({ ...account, account: { ...account.account, providers: ["google"] } }, 5000, emptyStorage).identities, result.identities.slice(1));
  assert.deepEqual(accountFromWire(account, 5000, { getItem: () => { throw new Error("unavailable"); } }).notifications, result.notifications);
});

test("billing selects the newest non-ended subscription and maps invoices", () => {
  const plans = catalogFromWire(catalog);
  const subscription: SubscriptionView = { id: "sub", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "shared_m", region: "eu" } }, bundle: "pro", lines: [], totalCents: 5000, status: "active", licenseId: null, cloudId: null, currentPeriodEnd: 9999, cancelAtPeriodEnd: true, createdAt: 1 };
  SUBSCRIPTION_STATUSES.forEach((status, index) => assert.equal(subscriptionFromWire({ ...subscription, status }, plans).status, ["pending", "active", "past_due", "canceled", "canceled"][index]));
  assert.equal(subscriptionFromWire({ ...subscription, currentPeriodEnd: null, cancelAtPeriodEnd: false }, plans).currentPeriodEnd, 0);
  const now = new Date(2026, 10, 8).getTime();
  const overview: BillingOverview = {
    v: 1, subscriptions: [subscription, { ...subscription, id: "new", createdAt: 2 }, { ...subscription, id: "ended", status: "ended", createdAt: 3 }], licenses: [], license: { v: 1, work: "unlicensed", license: null, freeWorkUntil: null, checkedAt: now }, clouds: [],
    invoices: { invoices: [{ id: "invoice", at: now, amountCents: 1250, currency: "USD", status: "failed", description: "Plan", downloadUrl: "/invoice" }], nextCursor: null },
  };
  const result = billingFromWire(overview, plans);
  assert.equal(result.subscription!.id, "new");
  assert.equal(result.subscription!.amountUsd, 50);
  assert.equal(result.subscription!.cancelAt, 9999);
  assert.equal(result.paymentMethod, null);
  assert.deepEqual(result.invoices, [{ id: "invoice", number: "invoice", date: now, amountUsd: 12.5, status: "open", description: "Plan", url: "/invoice" }]);
  assert.equal(billingFromWire({ ...overview, subscriptions: [{ ...subscription, status: "ended" }] }, plans).subscription, null);
  assert.equal(billingFromWire({ ...overview, subscriptions: [{ ...subscription, status: "pending", currentPeriodEnd: null }] }, plans).subscription, null, "unpaid is not a plan");
  assert.deepEqual(providersFromWire({ v: 1, signupOpen: true, providers: [{ id: "apple", enabled: false, comingSoon: true }] }), { providers: [{ id: "apple", enabled: false, comingSoon: true }] });
});
