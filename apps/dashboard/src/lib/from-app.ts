/** the person came from the desktop app's account step (the account context redirect): after paying, the page sends
 *  them back to the app. Kept for the browser tab's session. */
export const FROM_APP_KEY = "dusk.fromApp";
/** the app's link after a purchase: Metal opens its cloud sheet, which picks the new cloud up */
export const APP_CLOUD_LINK = "duskbot://cloud";
export function markFromApp(query: URLSearchParams) {
  if (query.get("from") === "app" || (query.get("src") ?? "").startsWith("app_")) { try { sessionStorage.setItem(FROM_APP_KEY, "1"); } catch {} }
}
export function fromApp(): boolean { try { return sessionStorage.getItem(FROM_APP_KEY) === "1"; } catch { return false; } }

