import type { ReactNode } from "react";
import type { CommandKind, WorkspaceDetail } from "../../../../shared/dashboard-protocol";
import { cloudForWorkspace, useClouds } from "../data/cloud";
import { awayLine, reachOf } from "../data/place";
import { useSession } from "../data/session";
import { Button, ButtonLink, Card, Skeleton } from "../ui/kit";
import { SkyEmpty } from "../ui/Sky";
import { wakeFirst } from "./cloud-bits";
import { DOWNLOAD_URL } from "../lib/usage";

export function LoadingPage() {
  return (
    <div aria-busy="true" aria-label="loading">
      <Skeleton className="h-9 w-72" />
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Skeleton className="h-[200px] !rounded-card" />
        <Skeleton className="h-[200px] !rounded-card" />
      </div>
      <Skeleton className="mt-4 h-[280px] !rounded-card" />
    </div>
  );
}

export function LoadError({ error, retry }: { error: string; retry(): void }) {
  return <section><p role="alert" className="text-13 text-bad">{error}</p><Button className="mt-4" size="sm" onClick={retry}>retry</Button></section>;
}

export function NoWorkspace() {
  return (
    <SkyEmpty
      title="connect your first workspace"
      action={<><ButtonLink to={DOWNLOAD_URL} external variant="primary">get the app</ButtonLink><ButtonLink to="/workspaces#add">how to connect</ButtonLink></>}
    >
      get the app and sign in with this account. your mac shows up here by itself, and so do the bots you make on it.
    </SkyEmpty>
  );
}

/** waits for the chosen workspace's newest report; says so when there is none yet */
export function WorkspaceGate({ children }: { children: (detail: WorkspaceDetail) => ReactNode }) {
  const { workspaces, workspacesError, workspace, detail, detailError, refresh } = useSession();
  if (workspacesError && workspaces === null) return <LoadError error={workspacesError} retry={refresh} />;
  if (workspaces === null) return <LoadingPage />;
  if (!workspace) return <NoWorkspace />;
  if (!detail) {
    return detailError ? (
      <Card><LoadError error={detailError} retry={refresh} /></Card>
    ) : <LoadingPage />;
  }
  if (!detail.report) {
    return (
      <SkyEmpty title={`waiting for ${workspace.name}`}>
        it is connected but has not reported yet. keep Metal running there; the first report usually lands within a few seconds.
      </SkyEmpty>
    );
  }
  return <>{children(detail)}</>;
}

/** a workspace action: sent as a command, picked up on the workspace's next report, then confirmed. a dusk cloud we put
 *  to sleep takes it too: it wakes first, and the command waits for it */
export function CommandButton({ kind, target, label, doing, variant = "outline", confirm, disabled }: { kind: CommandKind; target: string; label: string; doing: string; variant?: "outline" | "primary" | "danger" | "ghost"; confirm?: string; disabled?: boolean }) {
  const { command, pendingFor, workspace } = useSession();
  const cloud = cloudForWorkspace(useClouds(), workspace?.id);
  const last = pendingFor(kind, target);
  const busy = last?.status === "queued" || last?.status === "sent";
  const away = !workspace || reachOf(workspace.freshness, cloud) === "away";
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={busy || disabled || away}
      aria-busy={busy}
      title={away && workspace ? awayLine(workspace, cloud) : undefined}
      onClick={() => { if (!confirm || window.confirm(confirm)) { if (workspace) wakeFirst(cloud, workspace.name); void command(kind, target, label); } }}
    >
      {busy ? doing : label}
    </Button>
  );
}
