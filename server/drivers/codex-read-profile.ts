// Codex's approval parameters per named mode. Ask and Auto run in Metal's own permission profile: Codex's legacy
// workspace-write sandbox reads the whole disk (codex-cli 0.167).
import { isAbsolute } from "node:path";

import { under } from "../bot-box/plan.ts";
import { plainRecord } from "./codex-app-approval.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { CODEX_WORKSPACE_PROFILE, codexWorkspaceFilesystem, type EngineReadScope } from "./engine-read-scope.ts";

/** The profile keeps what config.toml's `[sandbox_workspace_write]` gives the legacy sandbox (codex-cli 0.167). */
export function workspaceProfile(scope: EngineReadScope, codexConfig: unknown): Record<string, unknown> {
  const workspace = plainRecord(plainRecord(codexConfig)?.sandbox_workspace_write) ?? {};
  const filesystem: Record<string, string> = codexWorkspaceFilesystem(scope);
  if (workspace.exclude_slash_tmp === true) delete filesystem[":slash_tmp"];
  if (workspace.exclude_tmpdir_env_var === true) delete filesystem[":tmpdir"];
  const extra = Array.isArray(workspace.writable_roots) ? workspace.writable_roots.filter((root): root is string => typeof root === "string" && isAbsolute(root)) : [];
  for (const root of extra) if (!scope.hidden.some((path) => under(root, path))) filesystem[root] = "write";
  return { filesystem, ...(workspace.network_access === true ? { network: { enabled: true } } : {}) };
}

/** Codex 0.167 echoes the profile it applied; an app-server that dropped the field must not have fallen back to a
 * wider default sandbox. */
export function assertProfileApplied(params: CodexApprovalParams, session: unknown): void {
  const id = params.config ? params.thread.permissions : undefined;
  if (typeof id !== "string") return;
  const active = plainRecord(plainRecord(session)?.activePermissionProfile);
  const sandbox = plainRecord(plainRecord(session)?.sandbox);
  const applied = active ? active.id === id : sandbox?.type === "workspaceWrite" || sandbox?.type === "readOnly";
  if (!applied || sandbox?.type === "dangerFullAccess") {
    throw new Error("Codex did not apply the requested sandbox mode; cannot safely start the turn.");
  }
}

export interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** The thread `config` layer the named profile is defined in, when Metal defines it. */
  config?: Record<string, unknown>;
  /** Legacy settings for an older app-server that rejects the named-profile field. */
  fallback?: Omit<CodexApprovalParams, "fallback">;
}

/** Codex persists these on its native thread, so they are explicit on start, resume and every turn.
 * Codex has no narrower "edits only" sandbox, so a stray Edits value asks. With a read scope, Ask and Auto run in
 * Metal's own permission profile, which also hides the scope's paths from reads; Codex's legacy
 * workspace-write sandbox reads the whole disk. */
export function namedApprovalParams(mode: Exclude<ApprovalMode, "custom">, scope?: EngineReadScope, codexConfig?: unknown): CodexApprovalParams {
  if (mode === "full") {
    return {
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  const approvalsReviewer = mode === "auto" ? "auto_review" : "user";
  const legacy: CodexApprovalParams = {
    thread: { approvalPolicy: "on-request", approvalsReviewer, sandbox: "workspace-write" },
    turn: { approvalPolicy: "on-request", approvalsReviewer, sandboxPolicy: { type: "workspaceWrite" } },
  };
  if (!scope) return legacy;
  const named = { permissions: CODEX_WORKSPACE_PROFILE, approvalPolicy: "on-request", approvalsReviewer };
  return {
    thread: named,
    turn: named,
    // codex-cli 0.167 accepts a profile defined only in the thread layer, then fails every model request with "failed
    // to load workspace requirements: invalid input parameter" unless default_permissions names it there too
    config: { default_permissions: CODEX_WORKSPACE_PROFILE, permissions: { [CODEX_WORKSPACE_PROFILE]: workspaceProfile(scope, codexConfig) } },
    fallback: legacy,
  };
}
