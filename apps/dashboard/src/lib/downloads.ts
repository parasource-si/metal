export type Platform = "macos" | "windows" | "linux" | "android" | "ios";
export const PLATFORMS: readonly Platform[] = ["macos", "windows", "linux", "android", "ios"];

export function detectOs(): Platform | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const ua = `${hinted} ${navigator.userAgent}`.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua) || (/mac/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/mac/.test(ua)) return "macos";
  if (/win/.test(ua)) return "windows";
  if (/linux|cros/.test(ua)) return "linux";
  return "unknown";
}
