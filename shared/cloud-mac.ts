/** "Cloud bots use this Mac": the person's own dusk cloud reaches their Mac through the Metal app on it. */

/** The Mac tools a dusk cloud's bots get. No screen tools: this never needs Screen Recording or Accessibility. */
export const CLOUD_MAC_TOOL_NAMES = ["mac_exec", "mac_read_file", "mac_write_file", "mac_list", "mac_open", "mac_download"] as const;
export type CloudMacToolName = (typeof CLOUD_MAC_TOOL_NAMES)[number];

/** Ordinary reads: they never ask unless they reach keys or secrets. */
export const CLOUD_MAC_READS: ReadonlyArray<CloudMacToolName> = ["mac_read_file", "mac_list"];

export const CLOUD_MAC_MODES = ["auto", "ask", "never"] as const;
export type CloudMacMode = (typeof CLOUD_MAC_MODES)[number];

/** One piece of work a cloud bot is doing on this Mac right now, for the indicator. */
export interface CloudMacWork {
  id: string;
  bot: string;
  tool: CloudMacToolName;
  /** The command, the link or the paths: never file contents. */
  summary: string;
  startedAt: number;
}

/** The desktop bridge's view (window.duskDesktop.cloudMac.state()). */
export interface CloudMacState {
  /** Settings > Your computer > "Let my cloud bots use this Mac". Off until the person turns it on on this Mac. When on,
   * cloud bots may do anything the person can, unless they opt into `ask` or `limitFolders`. */
  enabled: boolean;
  /** auto (default): only risky actions (electron/cloud-mac-risk.mjs) wait for Allow on a card; ask: every action but an
   * ordinary read does; never: nothing asks. */
  mode: CloudMacMode;
  /** "Only these folders": reads, writes, downloads and a command's folder stay inside `folders`. Default off. */
  limitFolders: boolean;
  /** The folder list "Only these folders" uses, in ~ form. */
  folders: string[];
  /** none: no dusk cloud; asleep: it sleeps; connecting; connected: it can reach this Mac; refused: it does not take this Mac yet. */
  cloud: "none" | "asleep" | "connecting" | "connected" | "refused";
  /** One sentence for the person when something is in the way, else null. */
  problem: string | null;
  busy: CloudMacWork[];
}

/** Sealed job from GET /api/mac/self/jobs on a dusk cloud: X25519 to the key the Mac sent, AES-256-GCM, and signed with
 * the cloud's own link key (Ed25519), whose public half the Mac gets from dusk.bot, never from the cloud's edge. */
export interface SealedMacJob {
  v: 1;
  /** The Mac's X25519 public key this was sealed to (base64url, 32 bytes). */
  mac: string;
  /** The cloud's one-job X25519 public key (base64url). */
  eph: string;
  iv: string;
  /** Ciphertext then the 16-byte tag, base64url. */
  data: string;
  /** Ed25519 over cloudMacSignedBytes(), base64url. */
  sig: string;
}

/** What the Mac posts back: the MacJobOutcome sealed with the same job key, bound to the job id. */
export interface SealedMacOutcome {
  v: 1;
  iv: string;
  data: string;
}

export const CLOUD_MAC_SEAL_INFO = "dusk cloud mac v1";

/** The bytes the cloud's link key signs: every part of the envelope but the signature. */
export function cloudMacSignedBytes(envelope: Pick<SealedMacJob, "mac" | "eph" | "iv" | "data">): string {
  return `dusk-mac-job-v1\n${envelope.mac}\n${envelope.eph}\n${envelope.iv}\n${envelope.data}`;
}

/** GCM additional data for a job and for its outcome. */
export const cloudMacJobAad = (mac: string, eph: string) => `job\n${mac}\n${eph}`;
export const cloudMacOutcomeAad = (jobId: string) => `outcome\n${jobId}`;
