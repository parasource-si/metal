import { t } from "./i18n";
import type { LocaleKey } from "@/locales";
import { friendlyError } from "@/lib/plain-error";

/**
 * Computer status responses come from the server so they can also be useful
 * in logs and API clients. Translate the known user-facing status messages at
 * the UI boundary, including statuses that only occur in failure branches.
 */
export function localizeComputerProblem(problem: string | null | undefined): string | null {
  if (!problem) return problem ?? null;
  const exact: Record<string, Parameters<typeof t>[0]> = {
    "Create the Local VM": "computer.problem.createVm",
    "The Local VM is stopped; start it to continue": "computer.problem.vmStopped",
    "The Local VM started, but Cua Driver is not ready yet": "computer.problem.cuaNotReady",
    "The existing Local VM uses an older desktop or Cua Driver; recreate it": "computer.problem.oldImage",
    "The existing container was not created by dusk bot; recreate it": "computer.problem.unmanaged",
    "The existing container was not created by Metal; recreate it": "computer.problem.unmanaged",
    "The existing Local VM exposes its viewer publicly; recreate it": "computer.problem.publicViewer",
    "The existing Local VM is missing safety limits; recreate it": "computer.problem.missingLimits",
    "The existing Local VM is missing its durable folder; recreate it": "computer.problem.missingDurableFolder",
    "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port": "computer.problem.perBotRuntime",
  };
  const key = exact[problem];
  if (key) return t(key);
  const desktopFailure = /^The Local VM desktop failed to start: (.+)$/.exec(problem);
  if (desktopFailure) return looksRaw(desktopFailure[1]!) ? t("computer.err.screenUnavailable") : t("computer.problem.desktopFailed", { detail: desktopFailure[1]! });
  return looksRaw(problem) ? t("computer.err.screenUnavailable") : problem;
}

// a tool's own output (docker, a build, a registry, a log tail) never reaches the panel: the computer stays usable, and
// the full text is in the server log
const RAW_OUTPUT = /[\r\n]|error response from daemon|failed to solve|\bERROR:|manifest unknown|access to the resource is denied|sha256:|ghcr\.io|docker\.io|moby\/|buildkit|buildx|\bexit (?:status|code)\b|unexpected docker|stderr|traceback|\b(?:ECONN[A-Z]+|ENOENT|EACCES|EPIPE|ETIMEDOUT)\b|(?:^|\s)\/(?:usr|var|run|tmp|home|etc|opt)\//i;

export function looksRaw(text: string): boolean {
  return text.length > 280 || RAW_OUTPUT.test(text);
}

/** A Computer panel error worded by locale key, so it is translated when shown rather than when thrown. */
export class LocalizedPanelError extends Error {
  constructor(
    readonly key: LocaleKey,
    readonly problem?: string | null,
    readonly fallbackKey?: LocaleKey,
  ) {
    super(key);
  }
}

export function panelErrorText(error: Error | string | null): string | null {
  if (error instanceof LocalizedPanelError) {
    return t(error.key, error.fallbackKey ? { problem: localizeComputerProblem(error.problem) ?? t(error.fallbackKey) } : undefined);
  }
  const text = localizeComputerProblem(error instanceof Error ? error.message : error);
  return text ? friendlyError(text) : text;
}
