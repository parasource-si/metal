import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Monitor, Smartphone } from "@/icons";
import type { WorkspaceDetail, WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { cloudForWorkspace, useCloud } from "../data/cloud";
import type { CloudDesktop } from "../data/contracts";
import { useWorkspaceLoad } from "../data/detail";
import { NumbersPending } from "./numbers-pending";
import { useSession } from "../data/session";
import { api } from "../lib/api";
import { appLink, openApp } from "../lib/app-link";
import { ago, longDate } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { DOWNLOAD_URL } from "../lib/usage";
import { Field, Modal } from "../ui/controls";
import { Button, ButtonLink, Card, FreshnessTag, PageHeader, SectionTitle, Skeleton } from "../ui/kit";
import { RowMenu, Table, Td, Th, type MenuItem } from "../ui/table";
import { KIND_LABEL } from "../ui/Shell";
import { SkyEmpty } from "../ui/Sky";
import { CloudStatus, prewarm, regionName, tierName, workspaceIcon } from "./cloud-bits";
import { monthlyOf, Points, useQuickCheckout } from "./cloud-offer";
import { CommandButton, LoadError } from "./common";
import { MachineView } from "./Machine";
import { useNow } from "../lib/now";

const ICON = { size: 16, strokeWidth: 1.5 } as const;

function WorkspaceRow({ w, cloud }: { w: WorkspaceSummary; cloud: CloudDesktop | null }) {
  const { refresh, toast } = useSession();
  const now = useNow();
  const { clouds } = useCloud();
  const [name, setName] = useState(w.name);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name.trim();
    if (!next) { setError("enter a workspace name."); return; }
    if (next === w.name) { setEditing(false); return; }
    setBusy(true); setError(null);
    try { await api.rename(w.id, next); toast(`renamed to ${next}`); setEditing(false); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await api.forget(w.id); toast(`removed ${w.name}`); setRemoving(false); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const menu: MenuItem[] = [
    { label: "rename", onSelect: () => { setName(w.name); setError(null); setEditing(true); } },
    cloud ? { label: "manage dusk cloud", onSelect: () => navigate("/cloud") } : { label: "remove", danger: true, disabled: clouds === null, onSelect: () => { setError(null); setRemoving(true); } },
  ];
  const to = `/workspaces/${encodeURIComponent(w.id)}`;
  return (
    <tr className="hover-row relative">
      <Td>
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-ink-3" aria-hidden>{workspaceIcon(w, cloud, 16)}</span>
          <div className="min-w-0">
            <Link to={to} className="block truncate font-medium text-ink after:absolute after:inset-0 after:content-['']">{w.name}</Link>
            <div className="truncate text-13 text-ink-3 md:hidden">{KIND_LABEL(w.kind, cloud)}</div>
          </div>
        </div>
      </Td>
      <Td className="text-ink-2 max-md:hidden">{KIND_LABEL(w.kind, cloud)}</Td>
      <Td><FreshnessTag freshness={w.freshness} at={w.lastReportAt} now={now} cloud={cloud} className="!text-14" /></Td>
      <Td className="t-id text-ink-2 max-lg:hidden">{w.version}</Td>
      <Td className="num whitespace-nowrap text-ink-2 max-lg:hidden">{longDate(w.connectedAt)}</Td>
      <Td className="relative z-10 w-0 !pe-1 !ps-0">
        <RowMenu label={`more for ${w.name}`} items={menu} />
        <Modal open={editing} onClose={() => { if (!busy) setEditing(false); }} title={`rename ${w.name}`} footer={<><Button disabled={busy} onClick={() => setEditing(false)}>cancel</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? "saving" : "save"}</Button></>}>
          <form className="mt-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="workspace name" htmlFor={`workspace-name-${w.id}`} error={error}>
              <input id={`workspace-name-${w.id}`} className="field" value={name} maxLength={60} disabled={busy} aria-invalid={Boolean(error)} onChange={(e) => setName(e.target.value)} />
            </Field>
          </form>
        </Modal>
        <Modal open={removing} onClose={() => { if (!busy) setRemoving(false); }} title={`remove ${w.name}?`} footer={<><Button disabled={busy} onClick={() => setRemoving(false)}>cancel</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "removing" : "remove workspace"}</Button></>}>
          <p>it stops reporting until you connect it again from the app. your bots and files stay on the machine.</p>
          {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
        </Modal>
      </Td>
    </tr>
  );
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return <li className="flex min-w-0 gap-3"><span className="num grid size-8 shrink-0 place-items-center rounded-full bg-btn font-pixel text-13 text-ink-2" aria-hidden>{n}</span><div className="min-w-0 flex-1 pt-1"><div className="text-14 font-medium text-ink">{title}</div>{children && <div className="mt-1 text-13 leading-[1.55] text-ink-3">{children}</div>}</div></li>;
}

export function WorkspacesPage() {
  const { workspaces, workspacesError, refresh } = useSession();
  const { clouds } = useCloud();
  const rank = (w: WorkspaceSummary) => (cloudForWorkspace(clouds, w.id) ? 0 : w.kind === "vps" ? 2 : 1);
  const sorted = [...(workspaces ?? [])].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="min-w-0">
      <PageHeader title="workspaces" sub="where your bots run." />
      <div className="flex flex-col gap-4">
        <section className="enter min-w-0" aria-label="your workspaces">
          {workspacesError && workspaces === null ? <LoadError error={workspacesError} retry={refresh} /> : workspaces === null ? <div className="flex flex-col gap-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div> : workspaces.length ? (
            <Table label="workspaces" className="table-cards max-sm:[&_table]:table-fixed max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
              <thead><tr><Th>name</Th><Th className="max-md:hidden">type</Th><Th className="max-sm:w-[120px]">status</Th><Th className="max-lg:hidden">version</Th><Th className="max-lg:hidden">connected</Th><Th className="w-0 max-sm:w-11"><span className="sr-only">more</span></Th></tr></thead>
              <tbody>{sorted.map((w) => <WorkspaceRow key={w.id} w={w} cloud={cloudForWorkspace(clouds, w.id)} />)}</tbody>
            </Table>
          ) : <p className="py-2 text-14 text-ink-3">no workspaces yet. connect your mac or get dusk cloud below.</p>}
        </section>
        <section id="add" className="enter mt-6 scroll-mt-20" style={{ ["--i" as string]: 2 }}>
          <Card>
            <SectionTitle>add a workspace</SectionTitle>
            <div className="grid min-w-0 gap-6 md:grid-cols-2 md:gap-0">
              <div className="min-w-0 md:pr-6">
                <h3 className="mb-5 text-14 font-medium text-ink">your mac</h3>
                <ol className="flex flex-col gap-5">
                  <Step n={1} title="download Metal for mac"><ButtonLink to={DOWNLOAD_URL} external size="sm" className="mt-1.5">download</ButtonLink></Step>
                  <Step n={2} title="sign in with this account">it shows up here by itself a few seconds later.</Step>
                  <Step n={3} title="keep it awake">your bots run while the mac is on.</Step>
                </ol>
              </div>
              <CloudColumn hasCloud={Boolean(clouds?.length)} />
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
}

/** the second way to run bots: dusk cloud, so they keep working when the mac sleeps */
function CloudColumn({ hasCloud }: { hasCloud: boolean }) {
  const { catalog } = useCloud();
  const { busy, error, buy } = useQuickCheckout("dash_workspaces");
  const from = monthlyOf(catalog, "starter");
  return (
    <div className="min-w-0 max-md:pt-6 md:pl-6">
      <h3 className="mb-2 text-14 font-medium text-ink">dusk cloud</h3>
      <p className="mb-5 text-14 text-ink-3">your bots on a computer we run, so they keep going when your mac sleeps.{from ? ` from ${from} a month.` : ""}</p>
      <Points />
      {error && <p role="alert" className="mt-4 text-14 text-bad">{error}</p>}
      <div className="mt-6 flex flex-wrap gap-2">
        {hasCloud
          ? <ButtonLink to="/cloud" variant="primary">open dusk cloud</ButtonLink>
          : <Button variant="primary" onClick={() => void buy("starter")} disabled={busy || !catalog}>{busy ? "opening checkout" : "get dusk cloud"}</Button>}
        <ButtonLink to="/billing">compare plans</ButtonLink>
      </div>
    </div>
  );
}

/** a server of the person's own: one quiet offer, on its own page, to move it to dusk cloud. the Metal app that linked
 *  it runs the move (its bots, chats and memory go straight across), so the button opens the app there */
function ServerToCloud({ w }: { w: WorkspaceSummary }) {
  const { catalog } = useCloud();
  const from = monthlyOf(catalog, "starter");
  return <div className="surface flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card bg-card px-6 py-4">
    <div className="min-w-0 flex-1">
      <p className="text-14 text-ink">move {w.name} to dusk cloud</p>
      <p className="mt-1 text-13 text-ink-3">always on, with nothing to keep running. we handle updates and backups.{from ? ` from ${from} a month.` : ""}</p>
    </div>
    <Button size="sm" onClick={() => openApp(appLink.serverMove(w.id), "opening Metal. the move starts there.")}>move to dusk cloud</Button>
  </div>;
}

function WorkspaceDevices({ detail, now, ready }: { detail: WorkspaceDetail; now: number; ready: boolean }) {
  const devices = detail.report?.devices;
  return <Card>
    <SectionTitle>phones and signed-in apps</SectionTitle>
    {!devices ? <p className="text-13 text-ink-3">this workspace has not sent its devices yet.</p> : <>
      <h3 className="text-13 text-ink-3">phones</h3>
      {devices.phones.length ? <ul className="">{devices.phones.map((p) => <li key={p.id} className="flex items-center gap-3 py-3"><Smartphone {...ICON} className="shrink-0 text-ink-3" aria-hidden /><div className="min-w-0 flex-1"><div className="truncate text-14 text-ink">{p.label}</div><p className="truncate text-13 text-ink-3">{[p.platform, p.lastSeenAt ? `seen ${ago(p.lastSeenAt, now)}` : p.pairedAt ? `paired ${ago(p.pairedAt, now)}` : null].filter(Boolean).join(" · ")}</p></div><CommandButton kind="phone.revoke" target={p.id} label="revoke" doing="revoking" variant="danger" disabled={!ready} confirm={`revoke ${p.label}? it will need to pair again.`} /></li>)}</ul> : <p className="mt-2 text-13 text-ink-3">no phones paired. sign in to the iphone app with this email, or pair one in the app under settings, phone.</p>}
      <h3 className="mt-6 text-13 text-ink-3">signed-in apps and browsers</h3>
      {devices.sessions.length ? <ul className="">{devices.sessions.map((s) => <li key={s.id} className="flex items-center gap-3 py-3"><Monitor {...ICON} className="shrink-0 text-ink-3" aria-hidden /><div className="min-w-0 flex-1"><div className="truncate text-14 text-ink">{s.label}</div><p className="truncate text-13 text-ink-3">{[s.scopes.includes("admin") ? "owner" : "member", s.lastSeenAt ? `active ${ago(s.lastSeenAt, now)}` : s.createdAt ? `signed in ${ago(s.createdAt, now)}` : null].filter(Boolean).join(" · ")}</p></div><CommandButton kind="session.revoke" target={s.id} label="sign out" doing="signing out" variant="danger" disabled={!ready} confirm={`sign ${s.label} out of this workspace?`} /></li>)}</ul> : <p className="mt-2 text-13 text-ink-3">only the app on this computer. nothing else is signed in.</p>}
    </>}
  </Card>;
}

export function WorkspacePage({ id }: { id: string }) {
  const { workspaces, workspacesError, workspace: selected, pick, detailError, refresh } = useSession();
  const now = useNow();
  const { clouds, catalog } = useCloud();
  const w = workspaces?.find((item) => item.id === id);
  const { detail, error: loadError, retry } = useWorkspaceLoad(w ? id : null);
  const cloud = cloudForWorkspace(clouds, id);
  useEffect(() => { if (w) pick(id); }, [id, Boolean(w), pick]);
  // opening a cloud we put to sleep is using it: it wakes now, and its numbers follow in seconds
  useEffect(() => { if (cloud) prewarm(cloud); }, [cloud]);
  return <div className="min-w-0">
    <Link to="/workspaces" className="press-soft hover-ghost -ms-2 mb-6 inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-13 text-ink-2"><ArrowLeft size={15} strokeWidth={1.5} aria-hidden /> workspaces</Link>
    {workspacesError && workspaces === null ? <LoadError error={workspacesError} retry={refresh} /> : workspaces === null ? <Skeleton className="h-60 !rounded-card" /> : !w ? <SkyEmpty title="that workspace is not on your account">it may have been removed. choose a workspace from the list.</SkyEmpty> : <>
      <header className="mb-8 flex items-center gap-4"><span className="grid size-14 shrink-0 place-items-center rounded-[12px] bg-card-2 text-ink-2" aria-hidden>{workspaceIcon(w, cloud, 24)}</span><div className="min-w-0 flex-1"><h1 className="t-title truncate">{w.name}</h1><div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-ink-3"><span>{KIND_LABEL(w.kind, cloud)}</span><FreshnessTag freshness={w.freshness} at={w.lastReportAt} now={now} cloud={cloud} /></div></div></header>
      <div className="flex flex-col gap-4">
        {cloud && <div className="surface flex flex-wrap items-center justify-between gap-3 rounded-card bg-card px-6 py-4"><div className="min-w-0"><p className="text-14 text-ink">{tierName(catalog, cloud)} · {regionName(catalog, cloud.region)}</p><CloudStatus cloud={cloud} className="mt-1" /></div><ButtonLink to="/cloud" size="sm">open dusk cloud</ButtonLink></div>}
        {!detail || selected?.id !== id || cloud?.resting ? <NumbersPending cloud={cloud} error={loadError ?? (selected?.id === id ? detailError : null)} retry={retry} className="h-60 !rounded-card" /> : !detail.report ? <SkyEmpty title="waiting for its first report">keep Metal running there. its first report usually arrives in a few seconds.</SkyEmpty> : <><MachineView detail={detail} now={now} /><WorkspaceDevices detail={detail} now={now} ready={selected?.id === id} /></>}
        {w.kind === "vps" && !cloud && clouds !== null && <ServerToCloud w={w} />}
      </div>
    </>}
  </div>;
}
