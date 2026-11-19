// POST /api/feedback: what the person wrote in Give feedback, with up to FEEDBACK_LIMITS.images pictures, sent on to the
// Dusk team's bug reports (devs-report-send.ts) as source "feedback". A signed-in person's address goes with it;
// signed out, it goes without one.
import { z } from "zod";

import { contactAddress, CONTACT_FIELDS, redactReportText, type FeedbackPayload, type ReportImage } from "../devs-report.ts";
import { FEEDBACK_MAX_BYTES, type SendOutcome } from "../devs-report-send.ts";
import type { RequestAuth } from "../request-auth.ts";
import { BANNER_REFUSALS, checkBanner } from "../workspace-banner.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const FEEDBACK_PATH = "/api/feedback";
export const FEEDBACK_LIMITS = { text: 5_000, images: 3, body: FEEDBACK_MAX_BYTES - 16 * 1024 } as const;

export interface FeedbackRouteDeps {
  installId: string;
  appVersion: string;
  platform: string;
  send(payload: FeedbackPayload): Promise<SendOutcome>;
}

const bodySchema = z.object({
  text: z.string().trim().min(1).max(FEEDBACK_LIMITS.text),
  images: z.array(z.string().max(FEEDBACK_MAX_BYTES)).max(FEEDBACK_LIMITS.images).optional(),
  /** the desktop app's signed-in account: only this computer's own page may name it */
  email: z.string().max(320).optional(),
});

/** A session's own address; on this computer's own page, the account the app is signed in to. */
function senderAddress(auth: RequestAuth, given: string | undefined): string | undefined {
  if (auth.kind === "session") return contactAddress(auth.session.email);
  return auth.trust === "service" ? undefined : contactAddress(given);
}

export function createFeedbackRoutes(deps: FeedbackRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== FEEDBACK_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    let raw: unknown;
    try { raw = await readBody(req, FEEDBACK_LIMITS.body); } catch (error) {
      const status = (error as { status?: number }).status === 413 ? 413 : 400;
      return json(res, status, { error: status === 413 ? "That's too much to send at once. Try fewer or smaller pictures." : "Invalid feedback." });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "Write what happened, and add at most three pictures." });
    const images: ReportImage[] = [];
    for (const data of parsed.data.images ?? []) {
      const checked = checkBanner(Buffer.from(data, "base64"));
      if (!checked.ok) return json(res, 400, { error: BANNER_REFUSALS[checked.refusal], code: checked.refusal });
      images.push({ type: checked.mime, data: checked.bytes.toString("base64") });
    }
    const contact = senderAddress(auth, parsed.data.email);
    const outcome = await deps.send({
      installId: deps.installId, source: "feedback", description: redactReportText(parsed.data.text), appVersion: deps.appVersion,
      platform: deps.platform, diagnostics: "", ...(contact ? Object.fromEntries(CONTACT_FIELDS.map((name) => [name, contact])) : {}),
      ...(images.length ? { images } : {}),
    });
    if (outcome.ok) return json(res, 201, { id: outcome.id });
    if (outcome.why === "limited") return json(res, 429, { error: "You've sent a lot of feedback this hour. Try again later.", ...(outcome.retryAfterMs ? { retryAfter: Math.ceil(outcome.retryAfterMs / 1000) } : {}) });
    if (outcome.why === "refused") return json(res, 400, { error: outcome.detail });
    return json(res, 502, { error: "Couldn't reach Dusk’s feedback service. Check your connection and try again." });
  };
}
