import type { AccountData } from "../lib/api.ts";
import type { AuthProviders, BillingOverview, CloudDesktop, DesktopId, LicenseId, NotificationPrefs, PlanCatalog, Selection, Subscription } from "./contracts.ts";
import { specLine, type Cart as PricedCart } from "./pricing.ts";
import { SETUP_STEPS, type AccountAnswer, type BillingOverview as WireBillingOverview, type Cart, type Catalog, type CloudDesktopView, type ProvidersAnswer, type Quote, type SubscriptionView } from "./wire.ts";

const licenseIds = { none: "personal", solo: "starter", team: "team" } as const;
const licenseKinds = { personal: "none", starter: "solo", team: "team" } as const;
const desktopIds = { none: "none", shared_s: "shared-s", shared_m: "shared-m", dedicated: "dedicated" } as const;
const desktopKinds = { none: "none", "shared-s": "shared_s", "shared-m": "shared_m", dedicated: "dedicated" } as const;
const bundleBlurbs = {
  free: "for personal use on your computer or your own vps",
  starter: "dusk cloud, always available",
  pro: "a bigger machine, priority wake and a work license",
  team: "a dedicated machine and a team license",
};

export function catalogFromWire(catalog: Catalog): PlanCatalog {
  const pricing = catalog.dedicated;
  const licenses: PlanCatalog["licenses"] = [
    { id: "personal", name: "personal", monthly: 0, includedMembers: 1, perExtraMember: 0, maxMembers: 1, work: false, blurb: "personal and non-commercial use" },
    ...catalog.licenses.map((license) => ({ id: licenseIds[license.kind], name: license.label.replace(/ license$/i, "").toLowerCase(), monthly: license.monthlyCents / 100, includedMembers: license.includedMembers, perExtraMember: (license.extraMemberCents ?? 0) / 100, maxMembers: license.maxMembers, work: true, blurb: "" })),
  ];
  return { ...(catalog.checkoutOpen === false ? { checkoutOpen: false } : {}),
    licenses,
    ...(catalog.wake ? { wake: Object.fromEntries(Object.entries(catalog.wake).map(([kind, stat]) => [desktopIds[kind as keyof typeof catalog.wake], stat])) } : {}),
    desktops: catalog.desktops.map((desktop) => {
      const machine = desktop.machine;
      const cents = desktop.monthlyCents ?? pricing.baseCents + machine.vcpu * pricing.perVcpuCents + machine.ramGb * pricing.perGbRamCents + Math.max(0, machine.diskGb - pricing.includedDiskGb) / 20 * pricing.per20GbDiskCents;
      return { id: desktopIds[desktop.kind], name: desktop.label.toLowerCase(), monthly: Math.round(cents) / 100, ...machine, placement: desktop.placement === "pool" ? "shared" : "dedicated", botComputers: desktop.botComputers, priority: desktop.priority, sizable: desktop.kind === "dedicated", blurb: "" };
    }),
    custom: { base: pricing.baseCents / 100, perVcpu: pricing.perVcpuCents / 100, perGbRam: pricing.perGbRamCents / 100, per20GbDisk: pricing.per20GbDiskCents / 100, includedDiskGb: pricing.includedDiskGb, vcpu: pricing.vcpu, ramGb: pricing.ramGb, diskGb: pricing.diskGb },
    bundles: catalog.bundles.map((bundle) => {
      const license = licenseIds[bundle.cart.license.kind];
      return { id: bundle.id, name: bundle.label.toLowerCase(), monthly: bundle.monthlyCents / 100, license, members: bundle.cart.license.members ?? licenses.find((item) => item.id === license)!.includedMembers, desktop: desktopIds[bundle.cart.desktop.kind], blurb: bundleBlurbs[bundle.id], features: bundle.highlights, recommended: bundle.id === "pro" };
    }),
    regions: [...catalog.regions.filter((region) => region.id === catalog.defaultRegion), ...catalog.regions.filter((region) => region.id !== catalog.defaultRegion)].map((region) => ({ id: region.id, name: region.country, city: region.label })),
    ...(catalog.poolRegions ? { poolRegions: catalog.poolRegions } : {}),
    yearlyDiscount: catalog.yearlyDiscountPercent / 100,
    workFreeUntil: catalog.freeWorkUntil,
    ...(catalog.trialDays ? { trialDays: catalog.trialDays } : {}),
  };
}

export function cartFromSelection(selection: Selection, catalog?: PlanCatalog): Cart {
  const desktop = catalog?.desktops.find((item) => item.id === selection.desktop);
  const spec = selection.size ?? (desktop ? { vcpu: desktop.vcpu, ramGb: desktop.ramGb, diskGb: desktop.diskGb } : null);
  return {
    interval: selection.interval,
    license: { kind: licenseKinds[selection.license], ...(selection.license === "team" ? { members: selection.members } : {}) },
    desktop: { kind: desktopKinds[selection.desktop], ...(selection.desktop !== "none" ? { region: selection.region } : {}), ...(selection.desktop === "dedicated" && spec !== null ? { spec } : {}) },
  };
}

export function cartFromQuote(quote: Quote, catalog: PlanCatalog): PricedCart {
  const divisor = (quote.cart.interval === "year" ? 12 : 1) * 100;
  const license = catalog.licenses.find((item) => item.id === licenseIds[quote.cart.license.kind]);
  const desktop = catalog.desktops.find((item) => item.id === desktopIds[quote.cart.desktop.kind]);
  const lines: PricedCart["lines"] = [];
  let subtotalCents = 0, discountCents = 0;
  for (const line of quote.lines) {
    if (line.kind === "discount") { discountCents -= line.amountCents; continue; }
    subtotalCents += line.amountCents;
    if (line.kind === "license" || line.kind === "members") {
      const existing = lines.find((item) => item.key === "license");
      if (existing) { existing.monthly += line.amountCents / divisor; continue; }
      const extra = Math.max(0, quote.members - (license?.includedMembers ?? quote.members));
      lines.push({ key: "license", label: license ? `${license.name} license` : line.label, detail: `${quote.members} ${quote.members === 1 ? "member" : "members"}${extra ? `, ${extra} extra` : ""}`, monthly: line.amountCents / divisor });
    } else {
      lines.push({ key: "desktop", label: desktop ? `dusk cloud, ${desktop.name}` : line.label, detail: quote.machine ? specLine(quote.machine) : "", monthly: line.amountCents / divisor });
    }
  }
  return { lines, subtotal: subtotalCents / divisor, bundle: catalog.bundles.find((item) => item.id === quote.bundle) ?? null, bundleSaving: 0, discount: discountCents / divisor, perMonth: quote.monthlyEquivalentCents / 100, dueNow: quote.totalCents / 100, free: quote.totalCents === 0 && lines.length === 0 };
}

export function selectionFromCart(cart: Cart, catalog: PlanCatalog): Selection {
  const license: LicenseId = licenseIds[cart.license.kind];
  const desktop: DesktopId = desktopIds[cart.desktop.kind];
  return {
    license,
    members: (cart.license.kind === "team" ? cart.license.members : undefined) ?? catalog.licenses.find((item) => item.id === license)!.includedMembers,
    desktop,
    size: desktop === "dedicated" ? cart.desktop.spec ?? null : null,
    region: (desktop !== "none" ? cart.desktop.region : undefined) ?? catalog.regions[0]?.id ?? "",
    interval: cart.interval,
  };
}

export function subscriptionFromWire(subscription: SubscriptionView, catalog: PlanCatalog): Subscription {
  const statuses = { pending: "pending", active: "active", payment_problem: "past_due", cancelled: "canceled", ended: "canceled" } as const;
  return { id: subscription.id, bundle: subscription.bundle, selection: selectionFromCart(subscription.cart, catalog), status: statuses[subscription.status], amountUsd: subscription.totalCents / 100, currentPeriodEnd: subscription.currentPeriodEnd ?? 0, cancelAt: subscription.cancelAtPeriodEnd ? subscription.currentPeriodEnd : null,
    ...(subscription.trialEndsAt ? { trialEndsAt: subscription.trialEndsAt } : {}),
    ...(subscription.scheduledChange ? { scheduled: { bundle: subscription.scheduledChange.bundle, selection: selectionFromCart(subscription.scheduledChange.cart, catalog), amountUsd: subscription.scheduledChange.totalCents / 100, at: subscription.scheduledChange.at } } : {}) };
}

// a pending subscription has no paid period yet: it is not a plan until it turns active
export function billingFromWire(overview: WireBillingOverview, catalog: PlanCatalog): BillingOverview {
  const subscription = overview.subscriptions.filter((item) => item.status !== "ended" && item.status !== "pending").reduce<SubscriptionView | null>((newest, item) => !newest || item.createdAt > newest.createdAt ? item : newest, null);
  return {
    team: overview.license?.license?.kind === "team" ? overview.license.license.role : null,
    subscription: subscription ? subscriptionFromWire(subscription, catalog) : null,
    paymentMethod: null,
    invoices: overview.invoices.invoices.map((invoice) => ({ id: invoice.id, number: invoice.id, date: invoice.at, description: invoice.description, amountUsd: invoice.amountCents / 100, status: invoice.status === "failed" ? "open" : invoice.status, url: invoice.downloadUrl })),
    retention: overview.retention ?? null,
  };
}

export const SETUP_LABELS = { reserving: "reserving your machine", storage: "preparing its disk", starting: "installing Metal", checking: "waking your bots" } as const;

export function cloudFromWire(cloud: CloudDesktopView): CloudDesktop | null {
  if (cloud.status === "checkout" || cloud.status === "destroying" || cloud.status === "destroyed") return null;
  const statuses = { checkout: "provisioning", provisioning: "provisioning", running: "running", sleeping: "sleeping", stopped: "stopped", payment_problem: "error", suspended: "error", error: "error" } as const;
  // asleep only because nobody used it (our cost saving, never the owner's pause): live to its owner, any use wakes it
  const resting = cloud.provider === "managed" && cloud.status === "sleeping" && (cloud.stoppedBy === "idle" || cloud.stoppedBy === null) && cloud.egress?.state !== "paused";
  const status = resting ? "running" : cloud.waking && cloud.status === "sleeping" ? "waking" : statuses[cloud.status];
  return {
    id: cloud.id, name: cloud.name, status, tier: desktopIds[cloud.kind], placement: cloud.placement === "pool" ? "shared" : "dedicated", region: cloud.region,
    ...cloud.machine, workspaceId: cloud.workspaceId, createdAt: cloud.createdAt,
    progress: status === "provisioning" && cloud.setupStep !== null ? { step: SETUP_LABELS[cloud.setupStep], value: (SETUP_STEPS.indexOf(cloud.setupStep) + 0.5) / 4 } : null,
    error: cloud.status === "payment_problem" ? "the last payment did not go through. update your card to wake it." : cloud.status === "suspended" ? "it is paused. write to us at hello@dusk.bot to sort it out." : cloud.error,
    botComputers: { used: 0, limit: cloud.botComputers }, uptimeSec: null,
    ...(resting ? { resting: true } : {}),
    ...(cloud.revivedAt ? { revivedAt: cloud.revivedAt } : {}),
    ...(cloud.egress && cloud.egress.state !== "ok" && cloud.egress.until !== null ? { egressLimit: { state: cloud.egress.state, until: cloud.egress.until } } : {}),
    ...(cloud.provider === "managed" ? { provider: "managed" as const, lastBackupAt: cloud.lastBackupAt ?? null, deleteScheduledAt: cloud.deleteScheduledAt ?? null, deleteAskedAt: cloud.deleteAskedAt ?? null } : {}),
  };
}

export function accountFromWire(answer: AccountAnswer, now = Date.now(), storage?: Pick<Storage, "getItem">): AccountData {
  const { account } = answer;
  const notifications: NotificationPrefs = { ...answer.notifications };
  let onboarded = answer.onboarded;
  try {
    storage ??= typeof localStorage === "undefined" ? undefined : localStorage;
    onboarded ||= storage?.getItem(`dusk-dash-onboarded:${account.id}`) === "1";
  } catch {}
  const kinds = { web: "browser", desktop: "desktop", mobile: "phone" } as const;
  return {
    profile: { id: account.id, email: account.email, name: account.name, avatarUrl: account.avatarUrl ?? null, ...(account.avatar ? { avatar: account.avatar } : {}), createdAt: account.createdAt, onboarded: onboarded || account.createdAt < now - 86_400_000 },
    identities: [
      ...(account.providers.includes("email") ? [{ provider: "email" as const, label: account.email, linkedAt: account.createdAt }] : []),
      ...answer.identities.map((identity) => ({ provider: identity.provider, label: identity.label ?? identity.email ?? "", linkedAt: identity.addedAt })),
    ],
    devices: answer.sessions.map((session) => ({ id: session.id, kind: kinds[session.kind], label: session.name, platform: session.platform, location: null, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, current: session.current })),
    notifications,
  };
}

export function providersFromWire(answer: ProvidersAnswer): AuthProviders {
  return { providers: answer.providers.map((provider) => ({ id: provider.id, enabled: provider.enabled, comingSoon: provider.comingSoon })) };
}
