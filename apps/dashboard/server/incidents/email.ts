import { render } from "../email/layout.ts";
import type { Block, EmailConfig, Rendered } from "../email/layout.ts";
import type { Incident } from "./store.ts";

export type IncidentMailKind = "new" | "daily" | "recovered";
const SHOWN = 8;

export const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} utc`;
const SOURCE_LABEL: Record<string, string> = {
  server: "account service", ops: "ops monitor", process: "account service crashed", log: "service log", database: "database", upstream: "site upstream", test: "test",
  web: "dashboard page", admin: "admin page", desktop: "desktop app page", "desktop-main": "desktop app",
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function incidentBlocks(incident: Incident): Block[] {
  const rows: Array<[string, string]> = [
    ["where", `${SOURCE_LABEL[incident.source] ?? incident.source}${incident.route ? ` · ${incident.route}` : ""}${incident.status ? ` · ${incident.status}` : ""}`],
    ["count", String(incident.count)],
    ["first seen", when(incident.firstSeen)],
    ["last seen", when(incident.lastSeen)],
  ];
  if (incident.requestId) rows.push(["request id", incident.requestId]);
  if (incident.path) rows.push(["page", incident.path]);
  if (incident.version || incident.os) rows.push(["app", [incident.version, incident.os].filter(Boolean).join(" · ")]);
  rows.push(["id", incident.id]);
  return [
    { t: "h2", text: `${incident.name}: ${incident.message || "(no message)"}`.slice(0, 200) },
    { t: "facts", rows },
    ...(incident.stack.length ? [{ t: "label" as const, text: "stack" }, { t: "log" as const, text: incident.stack.slice(0, 6).join("\n") }] : []),
  ];
}

/** the owner's "something's wrong" email: problems that just opened, or the daily email of ones the caps held back */
export function incidentEmail(cfg: EmailConfig, input: { kind: IncidentMailKind; env: string; incidents: Incident[]; panelUrl: string; test?: boolean; capped?: boolean; note?: string }): Rendered {
  const { kind, incidents } = input;
  const prefix = input.env === "production" ? "" : `[${input.env}] `;
  if (kind === "recovered") {
    const first = incidents[0]!;
    return render(cfg, {
      subject: `${prefix}back to normal: ${first.name}`, preheader: (input.note ?? first.name).slice(0, 120), tag: input.env === "production" ? "alert" : `alert · ${input.env}`, say: "phew, all good again", accent: "lime", status: ["recovered", "ok"],
      blocks: [
        { t: "h1", text: "back to normal" },
        { t: "p", text: input.note ?? `${first.name} is back to normal.` },
        { t: "facts", rows: [["started", when(first.firstSeen)], ["ended", when(first.lastSeen)], ["id", first.id]] },
        { t: "p", small: true, text: "this is the last email about this one." },
        { t: "button", label: "open admin ops", href: input.panelUrl.replace(/\/admin\/health$/, "/admin/ops") },
      ],
      reason: "you got this because your address is in DUSK_ALERT_EMAILS (or DUSK_ADMIN_EMAILS) for this Metal service.",
    });
  }
  const first = incidents[0]!;
  const subject = input.test ? `${prefix}test alert: this is what a problem looks like`
    : kind === "new" ? `${prefix}something's wrong: ${first.name}${first.route ? ` on ${first.route}` : ` (${SOURCE_LABEL[first.source] ?? first.source})`}${incidents.length > 1 ? ` and ${incidents.length - 1} more` : ""}`
    : `${prefix}${plural(incidents.length, "problem")} not emailed yet on Metal`;
  const heading = input.test ? "test alert" : kind === "new" ? "something's wrong" : "problems you haven't heard about";
  const intro = input.test ? `this is a test from the ${input.env} account service. a real one looks just like this.`
    : kind === "new" ? `${incidents.length === 1 ? "a new problem showed up" : `${incidents.length} new problems showed up`} on ${input.env}. you won't get another email about ${incidents.length === 1 ? "it" : "them"}: repeats only add to the count on the health page, until ${incidents.length === 1 ? "it stays" : "they stay"} quiet for 7 days.`
    : `these showed up on ${input.env} but were held back by the daily email limit.`;
  const shown = incidents.slice(0, SHOWN);
  return render(cfg, {
    subject, preheader: `${first.name}: ${first.message}`.slice(0, 120), tag: input.env === "production" ? "alert" : `alert · ${input.env}`,
    ...(input.test ? { say: "just a test", accent: "lav" as const, status: ["test", "off"] as [string, "off"] }
      : kind === "new" ? { say: "uh oh, something broke", accent: "pink" as const, status: ["open", "bad"] as [string, "bad"] }
      : { say: "a few you missed", accent: "lemon" as const, status: [`${incidents.length} held back`, "warn"] as [string, "warn"] }),
    blocks: [
      { t: "h1", text: heading },
      { t: "p", text: intro },
      ...shown.flatMap(incidentBlocks),
      ...(incidents.length > SHOWN ? [{ t: "p" as const, small: true, text: `and ${incidents.length - SHOWN} more on the health page.` }] : []),
      ...(input.capped ? [{ t: "p" as const, text: "more issues than the daily email limit came up. see the health page for all of them." }] : []),
      { t: "button", label: "open admin health", href: input.panelUrl },
      { t: "p", small: true, text: "to mute one problem, post {\"hours\": 24} to /v1/admin/incidents/<id>/mute while signed in as an admin. DUSK_ALERTS=off stops these emails." },
    ],
    reason: "you got this because your address is in DUSK_ALERT_EMAILS (or DUSK_ADMIN_EMAILS) for this Metal service.",
  });
}
