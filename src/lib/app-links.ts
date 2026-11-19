export { PRODUCT_NAME as APP_NAME } from "./brand";
export const SITE_URL = "https://github.com/parasource-si/metal";
export const DOCS_URL = `${SITE_URL}/tree/main/docs`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${SITE_URL}/blob/main/docs/approval-levels.md`;
export const PASSKEY_HELP_URL = "https://dusk.bot/docs/troubleshooting";
export const FEEDBACK_URL = `${SITE_URL}/issues`;
export const RELEASES_URL = `${SITE_URL}/blob/main/CHANGELOG.md`;
export const CLOUD_PLAN_URL = "https://dusk.bot/dashboard/cloud";
export const LICENSE_URL = `https://dusk.bot/license`;
export const THIRD_PARTY_NOTICES_URL = "/third-party-notices.txt";

export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

/** How an app that is not the desktop window shows a web page and puts it away: the phone's in-app browser. */
export interface ExternalPages {
  open(url: string): Promise<void>;
  close?(): void;
}

let hostPages: ExternalPages | null = null;

export function setExternalPages(pages: ExternalPages | null): void {
  hostPages = pages;
}

/** The app's own way to show a page outside this one; null in a plain browser tab, where a new tab is the way. */
export function externalOpener(): ((url: string) => Promise<unknown>) | null {
  return window.duskDesktop?.openExternal ?? hostPages?.open ?? null;
}

/** Puts away the page an app showed for a sign-in once it has done its job, so the person is back in the app. */
export function closeExternalPage(): void {
  hostPages?.close?.();
}

export async function openExternalLink(url: string): Promise<void> {
  const open = externalOpener();
  if (open) {
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
