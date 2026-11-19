import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Check, ListFilter, Search } from "@/icons";
import type { WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { flowKey, useAppCommands, type AppFlow } from "../data/app-connect";
import { CATEGORY_NAMES, composioSlug, connectedIn, connectedInAppOn, inCategory, presentCategories, searchApps, useConnectorRows, useDashApps, type Category, type ConnectorRow, type DashApp } from "../data/connectors";
import { cloudForWorkspace, useCloud } from "../data/cloud";
import { awayLine, reachOf } from "../data/place";
import { useSession } from "../data/session";
import { appLink, openApp } from "../lib/app-link";
import { navigate, useLocation } from "../lib/router";
import { CONNECT_CALLBACK_PATH } from "../../../../shared/dashboard-protocol";
import { toast } from "../lib/toast";
import { AppLogo } from "../ui/AppLogo";
import { Button, cx, PageHeader, Skeleton } from "../ui/kit";
import { Pill, usePill } from "../ui/motion";
import { NameDot, Nil, RowMenu, SectionHead, Table, Td, Th, type MenuItem } from "../ui/table";
import { ConnectPill } from "../ui/ConnectPill";

const PAGE = 8;
const BUSY: AppFlow["phase"][] = ["waiting", "redirecting", "finishing"];
const CATALOG_PAGE = 30;

// the app opens on this app's page in whichever place it has open, so the toast names the workspace it is meant for
const openConnect = (app: { id: string; label: string }, ws?: { name: string } | null) =>
  openApp(appLink.connect(app.id), `opening ${app.label} in Metal. connect it there${ws ? ` with ${ws.name} open` : ""}.`);

function ConnectAction({ app, flow, onConnect }: { app: DashApp; flow: AppFlow | undefined; onConnect(): void }) {
  if (flow?.phase === "waking") return <Button size="sm" disabled aria-label={`waking ${flow.workspaceName} to connect ${app.label}`}>waking</Button>;
  if (flow && BUSY.includes(flow.phase)) return <Button size="sm" disabled aria-label={`connecting ${app.label}`}>connecting</Button>;
  if (flow?.phase === "sign-in" && flow.url) return <a className="text-link shrink-0 px-2 text-13" href={flow.url} target="_blank" rel="noopener noreferrer">finish sign-in</a>;
  if (flow?.phase === "failed") return <Button size="sm" onClick={onConnect} aria-label={`try connecting ${app.label} again`} title={flow.message ?? undefined}>try again</Button>;
  return <Button size="sm" onClick={onConnect} aria-label={`connect ${app.label}`}>connect</Button>;
}

function Tile({ row }: { row: ConnectorRow }) {
  if (row.app) return <AppLogo app={row.app} size={32} />;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-card-2 text-13 text-ink-2" aria-hidden>
      {row.label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function WorkspacesCell({ list }: { list: ConnectorRow["workspaces"] }) {
  const names = list.map((w) => w.name);
  return <span className="block max-w-[160px] truncate text-ink-2" title={names.join(", ")}>{names.length > 2 ? `${names.length} workspaces` : names.join(", ")}</span>;
}

/** the pill on a row that needs sign-in: it follows the reconnect (waking, connecting, finish sign-in) */
function Reconnect({ row, where, flow, onAuth }: { row: ConnectorRow; where: string | null; flow: AppFlow | undefined; onAuth(): void }) {
  const on = where ? ` on ${where}` : "";
  if (flow?.phase === "waking") return <Button variant="outline" size="sm" disabled aria-label={`waking ${flow.workspaceName} to reconnect ${row.label}`}>waking</Button>;
  if (flow && BUSY.includes(flow.phase)) return <Button variant="outline" size="sm" disabled aria-label={`reconnecting ${row.label}${on}`}>connecting</Button>;
  if (flow?.phase === "sign-in" && flow.url) return <a className="text-link shrink-0 whitespace-nowrap px-2 text-13" href={flow.url} target="_blank" rel="noopener noreferrer">finish sign-in</a>;
  return <Button variant="outline" size="sm" onClick={onAuth} aria-label={`reconnect ${row.label}${on}`} title={flow?.phase === "failed" ? flow.message ?? undefined : undefined}>{flow?.phase === "failed" ? "try again" : "reconnect"}</Button>;
}

function Row({ row, flow, onAuth, menu }: { row: ConnectorRow; flow: AppFlow | undefined; onAuth(): void; menu: MenuItem[] }) {
  const needs = row.status === "needs-auth";
  // name the workspace only when the app is on more than one
  // the dot's label names where, the short line under the name stays short
  const many = row.needsAuth.length;
  const needLine = !needs || row.workspaces.length === 1 ? "needs sign-in" : many > 1 ? `needs sign-in on ${many} workspaces` : `needs sign-in on ${row.needsAuth[0]!.name}`;
  return (
    <tr className="hover-row">
      <Td>
        <div className="flex min-w-0 items-center gap-3">
          <Tile row={row} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{row.label}</span>
              <NameDot tone={needs ? "warn" : "good"} label={needs ? needLine : "ready"} />
            </div>
            {needs
              ? <div className="truncate text-13 text-ink-3" aria-hidden>needs sign-in</div>
              : <div className="truncate text-13 text-ink-3 xl:hidden" title={row.workspaces.map((w) => w.name).join(", ")}><span className="lowercase md:hidden">{row.type} · </span>{row.workspaces.length === 1 ? row.workspaces[0]!.name : `${row.workspaces.length} workspaces`}</div>}
          </div>
        </div>
      </Td>
      <Td className="lowercase text-ink-2 max-md:hidden">{row.type}</Td>
      <Td className="lowercase text-ink-2 max-lg:hidden">{row.category}</Td>
      {/* below 2xl the permissions column is hidden, so the tools cell carries it as a tooltip */}
      <Td className="num text-ink-2 max-lg:hidden" title={row.permissions ? `permissions: ${row.permissions.toLowerCase()}` : undefined}>
        {row.tools ?? <Nil />}{row.permissions && <span className="sr-only 2xl:hidden">, permissions {row.permissions.toLowerCase()}</span>}
      </Td>
      <Td className="lowercase text-ink-2 max-2xl:hidden">{row.permissions ?? <Nil />}</Td>
      <Td className="max-xl:hidden"><WorkspacesCell list={row.workspaces} /></Td>
      <Td className="w-0 !px-1 text-end">{needs && <Reconnect row={row} where={row.workspaces.length > 1 ? row.needsAuth[0]?.name ?? null : null} flow={flow} onAuth={onAuth} />}</Td>
      <Td className="w-0 !pe-1 !ps-0"><RowMenu label={`more for ${row.label}`} items={menu} /></Td>
    </tr>
  );
}

/** every app Metal can connect, searchable and by category */
function Catalog({ apps, connected, query, flowFor, onConnect }: { apps: DashApp[] | null; connected: string[]; query: string; onConnect(app: DashApp): void; flowFor(app: DashApp): AppFlow | undefined }) {
  const [category, setCategory] = useState<Category | null>(null);
  const pill = usePill();
  const [limit, setLimit] = useState(CATALOG_PAGE);
  const q = useDeferredValue(query.trim());
  const categories = useMemo(() => (apps ? presentCategories(apps) : []), [apps]);
  const list = useMemo(() => {
    if (!apps) return [];
    const pool = category ? inCategory(apps, category) : apps;
    return q ? searchApps(pool, q, 300) : pool;
  }, [apps, category, q]);
  const pick = (c: Category | null) => { setCategory(c); setLimit(CATALOG_PAGE); };
  return (
    <section className="mt-14" aria-labelledby="catalog-title">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="catalog-title" className="text-16 font-medium tracking-[-0.02em] text-ink">all apps</h2>
        <p className="num text-13 text-ink-3">{apps ? `${list.length.toLocaleString("en-US")} ${q || category ? "match" : "apps"}` : "loading"}</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="category">
        {[null, ...categories].map((c) => {
          const on = category === c;
          return (
            <button key={c ?? "all"} type="button" role="radio" aria-checked={on} onClick={() => pick(c)} className={cx("relative h-9 shrink-0 whitespace-nowrap rounded-full bg-card px-3.5 text-13 font-medium", on ? "text-primary-ink" : "hover-chip text-ink-2")}>
              {on && <Pill id={pill} className="bg-primary" />}
              <span className="relative">{c ? CATEGORY_NAMES[c].toLowerCase() : "all"}</span>
            </button>
          );
        })}
      </div>
      {apps === null ? (
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-[72px] !rounded-row" />)}</div>
      ) : list.length ? (
        <>
          <ul className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {list.slice(0, limit).map((app) => {
              const added = connectedIn(app, connected);
              return (
                <li key={app.id} className="surface flex min-h-[72px] min-w-0 items-center gap-3 rounded-row bg-card px-3.5 py-3">
                  <AppLogo app={app} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-14 font-medium text-ink">{app.label}</div>
                    <div className="truncate text-13 text-ink-3">{app.description}</div>
                  </div>
                  {added
                    ? <span className="inline-flex shrink-0 items-center gap-1 px-2 text-13 text-ink-3"><Check size={14} strokeWidth={2} className="text-good" aria-hidden />added</span>
                    : <ConnectAction app={app} flow={flowFor(app)} onConnect={() => onConnect(app)} />}
                </li>
              );
            })}
          </ul>
          {list.length > limit && <button type="button" onClick={() => setLimit((n) => n + CATALOG_PAGE * 2)} className="hover-ghost -ms-4 mt-3 h-11 rounded-full px-4 text-14 text-ink-3">show more</button>}
        </>
      ) : <p className="mt-4 text-14 text-ink-3">no apps match "{q}". try another name.</p>}
    </section>
  );
}

export function ConnectorsPage() {
  const { workspaces, workspace } = useSession();
  const { connections, clouds, appsAvailable, appsInApp } = useCloud();
  const { flows, connect, disconnect, finish, dismiss } = useAppCommands();
  const { apps } = useDashApps();
  const { rows, loading, error } = useConnectorRows();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [needsOnly, setNeedsOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const here = useMemo(() => (workspace ? connections?.[workspace.id] ?? [] : []), [connections, workspace]);
  const byId = useMemo(() => new Map((workspaces ?? []).map((w) => [w.id, w])), [workspaces]);
  // a dusk cloud we put to sleep takes the action and wakes first; only one its owner stopped, or a quiet mac, says why not
  const reach = (ws: WorkspaceSummary) => {
    const cloud = cloudForWorkspace(clouds, ws.id), state = reachOf(ws.freshness, cloud);
    return { away: state === "away" ? awayLine(ws, cloud) : null, wake: state === "wake" && cloud ? cloud : undefined };
  };
  const inApp = (ws: WorkspaceSummary, app: { id: string }, slug: string | null) => connectedInAppOn(appsInApp, ws.id, [app.id, slug]);
  const start = (ws: WorkspaceSummary | null | undefined, app: { id: string; label: string }, slug: string | null) => {
    if (!ws || !slug || inApp(ws, app, slug)) return openConnect(app, ws);
    // a computer with no Composio of its own connects apps in its own app; a dusk cloud signs in to Composio from here
    if (!cloudForWorkspace(clouds, ws.id) && appsAvailable[ws.id] === false) return openConnect(app, ws);
    const { away, wake } = reach(ws);
    if (away) return toast(away, "bad");
    connect(ws, slug, app.label, wake);
  };
  // back from a sign-in this page started: the app appended its word (status) to the callback; the state goes once
  const { query: params } = useLocation();
  const returning = params.get("connect");
  useEffect(() => {
    if (!returning || !workspaces || !apps) return;
    const status = params.get("status");
    navigate(CONNECT_CALLBACK_PATH, { replace: true });
    const appName = (slug: string) => apps.find((app) => composioSlug(app) === slug || app.id === slug)?.label ?? slug;
    void finish(returning, status, { workspace: (id) => byId.get(id)?.name ?? "your workspace", app: appName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returning, workspaces, apps]);
  const rowSlug = (row: ConnectorRow) => (row.app ? composioSlug(row.app) : row.type === "Connector" ? row.id.toLowerCase() : null);
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (!q || r.label.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)) && (!category || r.category === category) && (!needsOnly || r.status === "needs-auth"));
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const filtered = Boolean(category) || needsOnly;

  const busy = (w: WorkspaceSummary, slug: string | null) => Boolean(slug) && ["waking", ...BUSY].includes(flows[flowKey(w.id, slug!)]?.phase ?? "");
  // website actions first; "manage in the app" when there is nothing to do here, or the app was connected in the app
  const menuFor = (row: ConnectorRow): MenuItem[] => {
    const manage: MenuItem = { label: "manage in the app", onSelect: () => openApp(appLink.connect(row.id)) };
    const slug = rowSlug(row), one = row.workspaces.length === 1;
    const inAppHere = (listed: { id: string }) => { const w = byId.get(listed.id); return Boolean(w && inApp(w, row, slug)); };
    const items: MenuItem[] = [];
    for (const listed of row.needsAuth) {
      const w = byId.get(listed.id);
      if (w) items.push({ label: one ? "reconnect" : `reconnect on ${w.name}`, disabled: busy(w, slug), onSelect: () => start(w, row, slug) });
    }
    for (const w of workspaces ?? []) if (!row.workspaces.some((x) => x.id === w.id)) items.push({ label: `add to ${w.name}`, onSelect: () => start(w, row, slug) });
    if (slug) for (const listed of row.workspaces) {
      const w = byId.get(listed.id);
      if (w && !inAppHere(listed)) items.push({ label: `disconnect from ${w.name}`, danger: true, disabled: busy(w, slug), onSelect: () => { const { away, wake } = reach(w); if (away) toast(away, "bad"); else disconnect(w, slug, row.label, wake); } });
    }
    return items.length && !row.workspaces.some(inAppHere) ? items : [...items, manage];
  };
  // the pill reconnects where sign-in is missing, never on a workspace where the app already works
  const authTarget = (row: ConnectorRow) => byId.get(row.needsAuth[0]?.id ?? "") ?? null;

  return (
    <div className="min-w-0">
      <ConnectPill flows={flows} onDismiss={dismiss} />
      <PageHeader title="apps" sub={workspace ? `connect an app and your bots on ${workspace.name} can use it.` : "connect an app in the Metal app and your bots can use it."} />
      {workspace && reach(workspace).away && <p role="status" className="-mt-4 mb-6 text-14 text-ink-3">{reach(workspace).away}</p>}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
          <div className="relative min-w-0 flex-1 sm:w-[300px]">
            <label className="sr-only" htmlFor="connector-search">search apps</label>
            <Search size={16} strokeWidth={1.5} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
            <input id="connector-search" type="search" className="field !h-10 !rounded-full !pl-10" placeholder={apps ? `search ${apps.length.toLocaleString("en-US")} apps` : "search apps"} value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
          </div>
          {rows.length > 0 && (
            <RowMenu
              label={filtered ? "filter, on" : "filter"}
              active={filtered}
              icon={<ListFilter size={17} strokeWidth={1.5} aria-hidden />}
              items={[
                { label: "every category", checked: !category, onSelect: () => { setCategory(null); setLimit(PAGE); } },
                ...categories.map((c) => ({ label: c.toLowerCase(), checked: category === c, onSelect: () => { setCategory(c); setLimit(PAGE); } })),
                { label: needsOnly ? "show every status" : "needs sign-in only", onSelect: () => { setNeedsOnly((v) => !v); setLimit(PAGE); } },
              ]}
            />
          )}
        </div>
      </div>

      <section className="mt-10" aria-labelledby="installed-title">
        <SectionHead id="installed-title">connected</SectionHead>
        {error ? (
          <div className="flex flex-wrap items-center gap-3 py-5"><p role="alert" className="text-14 text-bad">{error}</p><Button size="sm" onClick={() => location.reload()}>retry</Button></div>
        ) : loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : shown.length ? (
          <>
            <Table label="connected apps" className="table-cards max-sm:[&_table]:table-fixed max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
              <thead>
                <tr>
                  <Th>name</Th>
                  <Th className="max-md:hidden">type</Th>
                  <Th className="max-lg:hidden">category</Th>
                  <Th className="max-lg:hidden">tools on</Th>
                  <Th className="max-2xl:hidden">permissions</Th>
                  <Th className="max-xl:hidden">workspaces</Th>
                  <Th className="w-0 max-sm:w-[104px]"><span className="sr-only">reconnect</span></Th>
                  <Th className="w-0 max-sm:w-12"><span className="sr-only">more</span></Th>
                </tr>
              </thead>
              <tbody>{shown.slice(0, limit).map((row) => { const target = authTarget(row), slug = rowSlug(row); return <Row key={row.id} row={row} menu={menuFor(row)} flow={target && slug ? flows[flowKey(target.id, slug)] : undefined} onAuth={() => start(target, row, slug)} />; })}</tbody>
            </Table>
            {shown.length > limit && <button type="button" onClick={() => setLimit((n) => n + PAGE * 2)} className="hover-ghost -ms-4 mt-2 h-11 rounded-full px-4 text-14 text-ink-3">show more</button>}
          </>
        ) : (
          <p className="py-6 text-15 text-ink-2">{q || filtered ? `nothing connected matches${q ? ` "${query.trim()}"` : " that filter"}.` : "nothing connected yet. pick an app below to connect it."}</p>
        )}
      </section>

      <Catalog apps={apps} connected={here} query={query} onConnect={(app) => start(workspace, app, composioSlug(app))}
        flowFor={(app) => { const slug = composioSlug(app); return workspace && slug ? flows[flowKey(workspace.id, slug)] : undefined; }} />
    </div>
  );
}
