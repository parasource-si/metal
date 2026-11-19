import { useSyncExternalStore } from "react";

import { api, ApiError } from "@/state/api";
import { redactSecretsInText } from "../../shared/redact";
import { appVersion } from "./app-links";
import { prepareBanner, type BannerProblem } from "./place-banner";
import { randomUuid } from "./random-uuid";

/** POST /api/feedback (server/routes/feedback.ts) */
export const FEEDBACK_PATH = "/api/feedback";
export const FEEDBACK_MAX_IMAGES = 3;
export const FEEDBACK_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

let open = false;
const listeners = new Set<() => void>();
const tell = () => { for (const listener of listeners) listener(); };

export function openFeedback(): void { if (!open) { open = true; tell(); } }
export function closeFeedback(): void { if (open) { open = false; tell(); } }
export function useFeedbackOpen(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => open,
    () => false,
  );
}

export interface FeedbackImage { blob: Blob; url: string }

/** A chosen picture shrunk and drawn afresh as the banner is, so nothing but its pixels is sent. */
export async function feedbackImage(file: Blob): Promise<{ ok: true; image: FeedbackImage } | { ok: false; problem: BannerProblem }> {
  const prepared = await prepareBanner(file);
  return prepared.ok ? { ok: true, image: { blob: prepared.blob, url: URL.createObjectURL(prepared.blob) } } : prepared;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** The desktop app's signed-in dusk account, sent along on this computer's own page; a session's server knows its own. */
async function signedInEmail(): Promise<string | undefined> {
  const bridge = window.duskDesktop?.remoteClient?.active === true ? undefined : window.duskDesktop?.cloudAccount;
  const state = await bridge?.state().catch(() => null);
  return state?.account?.email || undefined;
}

/** The Metal team's own report endpoint (apps/dashboard bug-reports), which the server's route forwards to. */
async function reportEndpoint(): Promise<string> {
  const configured = import.meta.env.VITE_DUSK_ACCOUNT_ORIGIN;
  if (configured) return `${configured.replace(/\/+$/, "")}/api/bug-reports`;
  const state = await window.duskDesktop?.cloudAccount?.state().catch(() => null);
  return `${state?.staging ? "https://preview.dusk.bot" : "https://dusk.bot"}/api/bug-reports`;
}

const INSTALL_KEY = "dusk-feedback-install";
/** the endpoint counts its hourly limit per install: one id for this app, kept */
function installId(): string {
  try {
    const kept = localStorage.getItem(INSTALL_KEY);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
    const made = `app-${randomUuid().replaceAll("-", "")}`;
    localStorage.setItem(INSTALL_KEY, made);
    return made;
  } catch {
    return `app-${randomUuid().replaceAll("-", "")}`;
  }
}

function platformLine(): string {
  const desktop = window.duskDesktop?.platform;
  return `${desktop ?? (navigator.platform || "web")}, app direct`.slice(0, 40);
}

/** Straight to the team's endpoint, for a server without the feedback route or one that couldn't send it on. */
export async function sendFeedbackDirect(text: string, images: readonly string[], email: string | undefined, fetcher: typeof fetch = fetch): Promise<{ id: string }> {
  const response = await fetcher(await reportEndpoint(), {
    method: "POST", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ installId: installId(), source: "feedback", description: redactSecretsInText(text), appVersion: appVersion().slice(0, 40), platform: platformLine(),
      diagnostics: "", ...(email ? { contactEmail: email, contact: email } : {}), ...(images.length ? { images: images.map((data) => ({ data })) } : {}) }),
  });
  const body = await response.json().catch(() => ({})) as { id?: unknown; error?: unknown };
  if (response.status === 201 && typeof body.id === "string") return { id: body.id };
  throw new ApiError(typeof body.error === "string" ? body.error : `status ${response.status}`, response.status, body as Record<string, unknown>);
}

/** the server read the feedback and said no (too long, a bad picture, its hourly limit): its words stand */
const refusedByServer = (error: unknown) => error instanceof ApiError && [400, 413, 429].includes(error.status);

/** The connected server's route, else straight to the team; the server's error when both fail. */
export async function sendFeedback(text: string, images: readonly FeedbackImage[]): Promise<{ id: string }> {
  const [email, data] = await Promise.all([signedInEmail(), Promise.all(images.map((image) => base64(image.blob)))]);
  try {
    return await api<{ id: string }>(FEEDBACK_PATH, { method: "POST", timeoutMs: 30_000, body: JSON.stringify({ text, ...(data.length ? { images: data } : {}), ...(email ? { email } : {}) }) });
  } catch (failed) {
    if (refusedByServer(failed)) throw failed;
    try { return await sendFeedbackDirect(text, data, email); } catch { throw failed; }
  }
}
