import { describe, expect, it } from "vitest";
import { samples } from "./samples.ts";
import { EMAIL_ASSETS, cloudNoticeEmail, emailConfig, promoEmail } from "./templates.ts";

const cfg = emailConfig({}, { publicUrl: "https://preview.dusk.bot", pageBase: "/dashboard" });
const all = samples(cfg);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]!.replace(/&amp;/g, "&"));
const BILLING = new Set(["05-payment-failed"]);

describe("account emails", () => {
  it.each(all.map(sample => [sample.id, sample.email] as const))("%s renders whole, in html and text", (_id, email) => {
    expect(email.subject.length).toBeGreaterThan(3);
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toMatch(/undefined|\bnull\b|NaN|\[object |\$\{|\*\*|—/);
    }
    expect(email.text).not.toMatch(/<[a-z/]/i);
    expect(email.html).toMatch(/^<!doctype html>/);
    expect(email.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(email.html).toContain('class="kit"');
    expect(email.html).toContain(">Metal<");
    expect(email.html).toContain("prefers-color-scheme: dark");
    expect(email.html).toContain("max-width:560px");
    expect(email.text).toMatch(/\n--\n\ndusk bot\n/);
    for (const href of hrefs(email.html)) expect(href).toMatch(/^https:\/\/[a-z0-9.-]+\//);
    for (const tag of email.html.match(/<img [^>]*>/g) ?? []) {
      expect(tag).toMatch(/ alt="[^"]*"/);
      const src = /src="([^"]+)"/.exec(tag)![1]!;
      expect(src.startsWith(`${cfg.assets}/`)).toBe(true);
      expect(EMAIL_ASSETS).toContain(src.slice(cfg.assets.length + 1));
    }
    // every link in the html is also spelled out in the text
    for (const href of hrefs(email.html)) expect(email.text).toContain(href);
  });

  it("marks codes, receipts and cloud ready transactional: styled, untracked, small, a text part, and no footer links", () => {
    const transactional = new Set(["01-code", "01b-recovery", "01c-recovery-none", "03-cloud-ready", "04-receipt"]);
    for (const { id, email } of all) {
      expect(!!email.transactional, id).toBe(transactional.has(id));
      if (!transactional.has(id)) { expect(email.text, id).toContain("/privacy"); continue; }
      // the full design goes out (resend adds nothing to it), with a plain text part beside it
      expect(email.html, id).toContain('class="kit"');
      expect(email.text.length, id).toBeGreaterThan(40);
      // no pixel, no tracking or redirect links, no unsubscribe: gmail reads it as a person's email, not a campaign
      for (const tag of email.html.match(/<img [^>]*>/g) ?? []) expect(tag, id).not.toMatch(/width="1"|height="1"|display:\s*none/);
      expect(`${email.html}${email.text}`, id).not.toMatch(/utm_|[?&](?:mc_|_hs|trk)|\/track|\/click|\/open|sendibt|unsubscribe/i);
      expect(email.text, id).not.toMatch(/\/docs|x\.com|\/privacy/);
      expect(email.text.match(/https:\/\//g)?.length ?? 0, id).toBeLessThanOrEqual(2);
      // well under gmail's 102 kb clipping
      expect(Buffer.byteLength(email.html), id).toBeLessThan(40_000);
    }
  });

  it("never puts a plan action in an email: one plain billing page link where billing matters, and nothing into the payment provider", () => {
    for (const { id, email } of all) {
      const buttons = [...email.html.matchAll(/class="btn-a" href="([^"]*)"/g)].map(match => match[1]!);
      for (const href of buttons) expect(href).not.toMatch(/\/billing/);
      const plan = hrefs(email.html).filter(href => href.endsWith("/dashboard/billing"));
      expect(plan).toHaveLength(BILLING.has(id) ? 1 : 0);
      if (BILLING.has(id)) expect(email.html).toMatch(/>billing page<\/a>/);
      expect(email.html + email.text).not.toMatch(/manage (your )?(plan|billing)|update (your )?card|change (your )?plan|cancel (your )?plan|dodo/i);
      expect(email.html).not.toMatch(/>(cancel[^<]*)<\/a>/i);
    }
  });

  it("keeps what a receipt must say in plain sight", () => {
    const receipt = all.find(sample => sample.id === "04-receipt")!.email;
    for (const fact of ["$20.00", "dusk cloud plus", "next charge", "december 11, 2026", "inv_7Qm2xK9"]) { expect(receipt.text).toContain(fact); expect(receipt.html).toContain(fact); }
  });

  it("keeps the code one copyable string, and in the subject and preheader for notifications", () => {
    const code = all.find(sample => sample.id === "01-code")!.email;
    expect(code.subject).toBe("48213097 is your Metal code");
    expect(code.text).toContain("    48213097");
    const shown = /user-select:all">([\s\S]*?)<\/div>/.exec(code.html)![1]!;
    expect(shown.replace(/<[^>]+>/g, "")).toBe("48213097");
    expect(code.html).toContain("your Metal code is 48213097.");
    expect(all.find(sample => sample.id === "01b-recovery")!.email.subject).toBe("48213097 is your Metal code");
    const welcome = all.find(sample => sample.id === "02-welcome")!.email;
    expect(welcome.text).toContain("from $20/mo");
    expect(welcome.html).toContain("https://preview.dusk.bot/dashboard/cloud");
    const deleted = samples(cfg).find(sample => sample.id === "09-account-deleted")!;
    expect(deleted.email.html).not.toContain("<script");
    expect(deleted.email.text).toContain("kept 30 days, then deleted");
  });

  it("refuses a promo without an unsubscribe link", () => {
    expect(() => promoEmail(cfg, { subject: "x", preheader: "x", eyebrow: "new", title: "x", intro: "x", features: [], cta: { label: "x", href: "https://dusk.bot/" }, unsubscribe: "" })).toThrow();
  });

  it("folds the cloud notices into the emails that matter, and keeps quiet for the rest", () => {
    for (const kind of ["ended", "delete_cancelled", "resumed"] as const) expect(cloudNoticeEmail(cfg, { kind, name: "night shift", at: 0 })).toBeNull();
    expect(cloudNoticeEmail(cfg, { kind: "left_7", name: "night shift", at: Date.UTC(2026, 0, 8) })!.subject).toBe("night shift will be deleted in 7 days");
    expect(cloudNoticeEmail(cfg, { kind: "delete_requested", name: "night shift", at: null, link: "https://preview.dusk.bot/dashboard/clouds/c/delete#t" })!.html).toContain('href="https://preview.dusk.bot/dashboard/clouds/c/delete#t"');
    expect(cloudNoticeEmail(cfg, { kind: "deleted", name: "night shift", at: 0 })!.subject).toBe("night shift was deleted");
    expect(cloudNoticeEmail(cfg, { kind: "recovered", name: "night shift", at: null })!.subject).toBe("night shift is back");
  });

  it("reads its asset base and site from the environment", () => {
    expect(emailConfig({ DUSK_EMAIL_ASSET_BASE: "https://cdn.example.test/e/" }, { publicUrl: "https://app.example.test" })).toMatchObject({ assets: "https://cdn.example.test/e", site: "https://dusk.bot", app: "https://app.example.test" });
    expect(emailConfig({}, { publicUrl: "https://preview.dusk.bot/x", pageBase: "/dashboard" })).toMatchObject({ assets: "https://dusk.bot/email", site: "https://preview.dusk.bot", app: "https://preview.dusk.bot/dashboard" });
  });
});
