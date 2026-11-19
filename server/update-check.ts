import { createPublicKey, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/parasource-si/metal/releases/latest";

/** "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv")) return "docker";
  if (exists("/run/.containerenv")) return "podman";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (exists(join(input.serverRoot, "..", ".git"))) return "git";
  return "unknown";
}

export interface UpdateCheck {
  current: string;
  install: InstallKind;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

export const DESKTOP_DOWNLOAD_URL = "https://github.com/parasource-si/metal/releases/latest";

/** CI's release keys (apps/cloud-service/src/release-signing.ts pins the same ones; a test keeps them equal) */
export const DESKTOP_RELEASE_KEYS: readonly { kid: string; x: string }[] = [
  { kid: "rel-2026-11", x: "wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM" },
];

/** the version a manifest vouches for, or null when it is not a desktop release signed by a pinned key */
export function verifiedDesktopVersion(body: unknown, keys: readonly { kid: string; x: string }[] = DESKTOP_RELEASE_KEYS): string | null {
  const signature = body && typeof body === "object" ? (body as { signature?: unknown }).signature : undefined;
  if (typeof signature !== "string") return null;
  const parts = signature.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "r1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]!) || !/^[A-Za-z0-9_-]+$/.test(parts[3]!)) return null;
  const key = keys.find((item) => item.kid === parts[1]);
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), publicKey, Buffer.from(parts[3]!, "base64url"))) return null;
    const manifest = JSON.parse(Buffer.from(parts[2]!, "base64url").toString("utf8")) as { v?: unknown; kind?: unknown; version?: unknown };
    return manifest.v === 1 && manifest.kind === "desktop" && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version) ? manifest.version : null;
  } catch {
    return null;
  }
}

/** a > b for plain x.y.z versions; anything else is never newer */
export function newerVersion(a: string, b: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}

function publishedVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const release = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return null;
  return /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1] ?? null;
}

const DESKTOP_CHECK_TTL_MS = 60 * 60_000;

/**
 * The desktop app checks Metal releases and links to the release page. A configured signed feed is verified with
 * its pinned keys. Other installs are updated by whoever runs them.
 */
export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  fetch?: typeof fetch;
  now?: () => number;
  manifestUrl?: string;
  keys?: readonly { kid: string; x: string }[];
}) {
  const now = options.now ?? Date.now;
  let desktopCache: { at: number; latest: string | null } | null = null;
  return async function check(): Promise<UpdateCheck> {
    const base: UpdateCheck = { current: options.current, install: options.install, available: false };
    if (options.install !== "desktop") return base;
    if (!desktopCache || now() - desktopCache.at >= DESKTOP_CHECK_TTL_MS) {
      const response = await (options.fetch ?? fetch)(options.manifestUrl ?? LATEST_RELEASE_URL, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (response.status === 404) desktopCache = { at: now(), latest: null };
      else if (!response.ok) throw new Error(`the release check returned ${response.status}`);
      else {
        const body: unknown = await response.json().catch(() => null);
        const latest = options.manifestUrl ? verifiedDesktopVersion(body, options.keys) : publishedVersion(body);
        desktopCache = { at: now(), latest };
      }
    }
    const latest = desktopCache.latest;
    return latest && newerVersion(latest, options.current) ? { ...base, latest, available: true, releaseUrl: DESKTOP_DOWNLOAD_URL } : base;
  };
}
