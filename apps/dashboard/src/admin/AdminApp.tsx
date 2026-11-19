import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Bug, ChartNoAxesColumn, ChartNoAxesCombined, ChevronDown, Cloud, CreditCard, Gauge, Globe as GlobeIcon, History, Inbox, LayoutDashboard, Menu, MessageSquare, Moon, Repeat, Server, Sun, Table2, Users, X } from "@/icons";
import { setTheme, useTheme } from "../lib/theme";
import { ButtonLink, cx } from "../ui/kit";
import { Modal } from "../ui/controls";
import { SkyEmpty } from "../ui/Sky";
import { Link, navigate, useLocation } from "../lib/router";
import { useToasts } from "../lib/toast";
import mark from "../../favicon.svg";
import { AdminRoleContext, useAdmin, type AdminRole } from "./api";
import { DataSwitch, MoneySwitch, StagingTag, TestSwitch } from "./DataSwitch";
import { OverviewPage } from "./Overview";
import { DetailsPage } from "./Details";
import { RetentionPage } from "./Retention";
import { PeoplePage, PersonSheetHost } from "./People";
import { LivePage } from "./Live";
import { ProductPage } from "./Product";
import { RevenuePage } from "./RevenuePage";
import { UserPage, UsersPage } from "./Users";
import { CloudsPage } from "./Clouds";
import { WaitlistPage } from "./Waitlist";
import { EventsPage } from "./Events";
import { AuditPage, HealthPage } from "./Health";
import { OpsPage } from "./Ops";
import { AccountsUsagePage } from "./OpsAccounts";
import { FeedbackPage } from "./Feedback";
import { ExperiencePage } from "./Experience";
import { BugReportsPage } from "./BugReports";
import { Loading, Tabs } from "./ui";
import { CustomerSheetHost } from "./CustomerSheet";
import { AnimatePresence, EASE_OUT, GLIDE, m, PageIn, ToastStack } from "../ui/motion";

const ICON = { size: 17, strokeWidth: 1.75 } as const;
interface NavItem { to: string; key: string; label: string; icon?: ReactNode; also?: string[] }
const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: "analytics", items: [
    { to: "/admin", key: "o", label: "overview", icon: <LayoutDashboard {...ICON} />, also: ["/admin/analytics"] },
    { to: "/admin/live", key: "l", label: "live", icon: <GlobeIcon {...ICON} /> },
    { to: "/admin/people", key: "p", label: "people", icon: <Users {...ICON} />, also: ["/admin/users"] },
    { to: "/admin/waitlist", key: "w", label: "waitlist", icon: <Inbox {...ICON} /> },
    { to: "/admin/revenue", key: "m", label: "revenue", icon: <CreditCard {...ICON} /> },
  ] },
  { label: "product", items: [
    { to: "/admin/product", key: "i", label: "product", icon: <ChartNoAxesCombined {...ICON} /> },
    { to: "/admin/experience", key: "b", label: "experience", icon: <AlertTriangle {...ICON} /> },
    { to: "/admin/feedback", key: "f", label: "feedback", icon: <MessageSquare {...ICON} /> },
    { to: "/admin/bug-reports", key: "d", label: "bug reports", icon: <Bug {...ICON} /> },
    { to: "/admin/retention", key: "r", label: "retention", icon: <Repeat {...ICON} /> },
  ] },
  { label: "operations", items: [
    { to: "/admin/ops", key: "x", label: "ops", icon: <Server {...ICON} /> },
    { to: "/admin/ops/accounts", key: "u", label: "accounts usage", icon: <Table2 {...ICON} /> },
    { to: "/admin/clouds", key: "c", label: "clouds", icon: <Cloud {...ICON} /> },
  ] },
];
const NAV = GROUPS.flatMap((group) => group.items);
const SMALL = { size: 15, strokeWidth: 1.75 } as const;
/** on the overview as a tile each; their full pages stay one click away */
const MORE: NavItem[] = [
  { to: "/admin/events", key: "e", label: "events", icon: <ChartNoAxesColumn {...SMALL} /> },
  { to: "/admin/health", key: "h", label: "health", icon: <Gauge {...SMALL} /> },
  { to: "/admin/audit", key: "a", label: "audit log", icon: <History {...SMALL} /> },
];
const ALL = [...NAV, ...MORE];
/** the pages a growth admin sees; the server refuses every other read for that role too */
const GROWTH_PAGES = new Set(["/admin", "/admin/live", "/admin/waitlist", "/admin/revenue", "/admin/retention"]);
const opens = (role: AdminRole, path: string) => role === "owner" || GROWTH_PAGES.has(path) || /^\/admin\/analytics\/[a-z]+$/.test(path);
const groupsFor = (role: AdminRole) => role === "owner" ? GROUPS : GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => GROWTH_PAGES.has(item.to)) })).filter((group) => group.items.length);
const PEOPLE_TABS = [{ to: "/admin/people", label: "accounts" }, { to: "/admin/people/visitors", label: "visitors and journeys" }];
const MOVED: Record<string, string> = { "/admin/funnel": "/admin#funnel", "/admin/users": "/admin/people", "/admin/people/waitlist": "/admin/waitlist", "/admin/app": "/admin/product/apps", "/admin/product/retention": "/admin/retention" };
const prefixes = (item: NavItem) => [item.to, ...(item.also ?? [])];
const covers = (path: string, to: string) => to === "/admin" ? path === "/admin" : path === to || path.startsWith(`${to}/`);
/** the one nav item a path belongs to: the longest match, so /admin/ops/accounts is accounts usage, not ops */
export function currentItem(path: string): NavItem | null {
  let best: NavItem | null = null, length = -1;
  for (const item of ALL) for (const to of prefixes(item)) if (covers(path, to) && to.length > length) { best = item; length = to.length; }
  return best;
}

function page(path: string, role: AdminRole): ReactNode {
  if (!opens(role, path)) return <SkyEmpty art="cat" title="not part of your admin view." action={<ButtonLink to="/admin" variant="primary">overview</ButtonLink>}>your role covers growth and revenue.</SkyEmpty>;
  if (path === "/admin") return <OverviewPage />;
  const details = /^\/admin\/analytics\/([a-z]+)$/.exec(path);
  if (details) return <DetailsPage dimension={details[1]!} />;
  if (path === "/admin/people/visitors") return <PeoplePage tabs={<Tabs label="people views" items={PEOPLE_TABS} />} />;
  if (path === "/admin/people") return <UsersPage tabs={<Tabs label="people views" items={PEOPLE_TABS} />} />;
  const user = /^\/admin\/users\/([^/]+)$/.exec(path);
  if (user) return <UserPage id={decodeURIComponent(user[1]!)} />;
  if (path === "/admin/product" || path.startsWith("/admin/product/")) return <ProductPage path={path} />;
  if (path === "/admin/revenue") return <RevenuePage />;
  if (path === "/admin/ops") return <OpsPage />;
  if (path === "/admin/ops/accounts") return <AccountsUsagePage />;
  if (path === "/admin/retention") return <RetentionPage />;
  if (path === "/admin/feedback") return <FeedbackPage />;
  if (path === "/admin/experience") return <ExperiencePage />;
  if (path === "/admin/bug-reports") return <BugReportsPage />;
  if (path === "/admin/waitlist") return <WaitlistPage />;
  if (path === "/admin/clouds") return <CloudsPage />;
  if (path === "/admin/live") return <LivePage />;
  if (path === "/admin/events") return <EventsPage />;
  if (path === "/admin/health") return <HealthPage />;
  if (path === "/admin/audit") return <AuditPage />;
  return <SkyEmpty art="cat" title="no admin page here." action={<ButtonLink to="/admin" variant="primary">overview</ButtonLink>}>there's nothing at {path}.</SkyEmpty>;
}

/** g then a letter moves between pages, / finds, ? lists the keys; none of it fires while typing */
function useShortcuts(openHelp: () => void, role: AdminRole) {
  const pending = useRef<number>(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "/") { const box = document.querySelector<HTMLInputElement>("[data-admin-search]"); if (box) { e.preventDefault(); box.focus(); } return; }
      if (e.key === "?") { e.preventDefault(); openHelp(); return; }
      if (e.key === "g") { pending.current = Date.now(); return; }
      if (Date.now() - pending.current < 1200) {
        const item = ALL.find((nav) => nav.key === e.key && opens(role, nav.to));
        pending.current = 0;
        if (item) { e.preventDefault(); navigate(item.to); }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [openHelp, role]);
}


function Toasts() {
  const toasts = useToasts();
  return <ToastStack items={toasts.map((t) => ({ id: t.id, className: "max-w-[440px] rounded-[22px] bg-primary px-4.5 py-3 text-14 text-primary-ink", content: t.text }))} />;
}

export function AdminApp() {
  const { path } = useLocation();
  const me = useAdmin<{ admin: true; role?: AdminRole; email: string; environment: string; version: string | null; live?: string | null }>("/me");
  const role: AdminRole = me.data?.role ?? "owner";
  const [help, setHelp] = useState(false);
  useShortcuts(() => setHelp(true), role);
  const current = currentItem(path);
  const inMore = !!current && MORE.includes(current);
  const theme = useTheme();
  const dark = theme === "dark" || (theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  const [moreOpen, setMoreOpen] = useState(inMore);
  // landing on a "more" page opens the list once; after that the toggle is the person's
  useEffect(() => { if (inMore) setMoreOpen(true); }, [inMore]);
  // below lg the sidebar is a drawer from the left edge, like the account dashboard's
  const [drawer, setDrawer] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => setDrawer(false), [path]);
  // focus goes back to the menu button when the drawer shuts
  useEffect(() => { if (wasOpen.current && !drawer) menuButton.current?.focus({ preventScroll: true }); wasOpen.current = drawer; }, [drawer]);
  // a short window scrolls the sidebar, never past the page you're on
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLElement>("nav[aria-label=admin] [aria-current=page]")) if (el.offsetParent) el.scrollIntoView({ block: "nearest" });
  }, [path, drawer, moreOpen]);
  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [drawer]);
  useEffect(() => { document.title = `${current?.label ?? "admin"} / Metal admin`; }, [current]);
  useEffect(() => { const to = MOVED[path]; if (to) navigate(to, { replace: true }); }, [path]);
  const side = (close?: () => void) => (
    <>
        <div className="flex items-center justify-between">
          <Link to="/admin" className="flex items-center gap-2 rounded-full px-2.5 py-1" aria-label="Metal admin, overview">
            <img src={mark} alt="" width={24} height={24} className="size-6" />
            <span className="text-[16px] font-[550] tracking-[-0.02em] text-ink">Metal</span>
            <span className="tag !h-[22px] !px-2">admin</span>
          </Link>
          {close && <button type="button" autoFocus onClick={close} aria-label="close menu" className="press hover-ghost -me-1 grid size-11 place-items-center rounded-full text-ink-2"><X size={18} strokeWidth={1.75} /></button>}
        </div>
        <nav aria-label="admin" className="flex flex-col gap-4">
          {groupsFor(role).map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="t-meta px-3 pb-1 !text-[11.5px]">{group.label}</span>
              {group.items.map((item) => {
                const active = current === item;
                return (
                  <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined} className={cx("relative flex h-9 items-center gap-3 rounded-full px-3 text-14 transition-colors duration-200 ease-out max-lg:h-11", active ? "bg-pop text-ink" : "hover-side text-ink-2")}>
                    <span className={cx("relative", active ? "text-ink" : "text-ink-3")} aria-hidden>{item.icon}</span>
                    <span className="relative flex-1">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          {role === "owner" && <div className="flex flex-col gap-0.5">
            <button type="button" aria-expanded={moreOpen} aria-controls={close ? "admin-more-drawer" : "admin-more"} onClick={() => setMoreOpen((v) => !v)}
              className="hover-side flex h-8 items-center gap-2 rounded-full px-3 text-13 text-ink-3 max-lg:h-11">
              more <m.span aria-hidden className="inline-flex" initial={false} animate={{ rotate: moreOpen ? 180 : 0 }}><ChevronDown size={14} strokeWidth={1.75} /></m.span>
            </button>
            <AnimatePresence initial={false}>
            {moreOpen && (
              <m.ul key="more" id={close ? "admin-more-drawer" : "admin-more"} className="flex flex-col gap-0.5 overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", visualDuration: 0.24, bounce: 0 }}>
                {MORE.map((item) => {
                  const active = current === item;
                  return (
                    <li key={item.to}>
                      <Link to={item.to} aria-current={active ? "page" : undefined} className={cx("relative flex h-8 items-center gap-3 rounded-full px-3 text-13 transition-colors duration-150 max-lg:h-11", active ? "bg-pop font-medium text-ink" : "hover-side text-ink-3")}>
                            <span aria-hidden className="relative text-ink-4">{item.icon}</span><span className="relative flex-1">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </m.ul>
            )}
            </AnimatePresence>
          </div>}
        </nav>
        <div className="mt-auto flex flex-col gap-1 px-1">
          {me.data?.live && <DataSwitch live={me.data.live} />}
          {me.data && <span className="truncate px-2 text-12 text-ink-3" title={me.data.email}>{me.data.email}</span>}
          {me.data && <span className="t-meta px-2 !text-[11.5px]">{me.data.environment} · {me.data.version ?? "dev"}</span>}
          {me.data && <MoneySwitch />}
          {me.data && <TestSwitch />}
          <button type="button" onClick={() => setTheme(dark ? "light" : "dark")} className="hover-ghost flex h-9 items-center gap-2 rounded-full px-2 text-13 text-ink-3 max-lg:h-11">{dark ? <Sun size={15} strokeWidth={1.75} aria-hidden /> : <Moon size={15} strokeWidth={1.75} aria-hidden />}{dark ? "light mode" : "dark mode"}</button>
          <Link to="/" className="hover-ghost flex h-9 items-center gap-2 rounded-full px-2 text-13 text-ink-3 max-lg:h-11"><ArrowUpRight size={15} strokeWidth={1.75} aria-hidden /> app</Link>
        </div>
    </>
  );
  if (me.error) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-bg px-6">
        <SkyEmpty art="cat" title={me.error.status === 403 ? "this page is for the owner." : "can't open the admin panel."} action={<ButtonLink to="/" variant="primary">back to your account</ButtonLink>}>
          {me.error.status === 403 ? "your account isn't on the admin list." : me.error.message}
        </SkyEmpty>
      </main>
    );
  }
  return (
    <div className="min-h-[100dvh] bg-bg">
      <a href="#admin-main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink">skip to content</a>
      <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col gap-6 overflow-y-auto overscroll-contain bg-side px-3 pb-4 pt-5 max-lg:hidden">{side()}</aside>
      <header className="sticky top-0 z-20 box-content flex h-14 items-center gap-1 bg-bg/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur lg:hidden">
        <button ref={menuButton} type="button" onClick={() => setDrawer(true)} aria-label="open menu" aria-expanded={drawer} className="press hover-ghost grid size-11 place-items-center rounded-full text-ink-2"><Menu size={20} strokeWidth={1.75} /></button>
        <Link to="/admin" className="flex min-w-0 items-center gap-2" aria-label="Metal admin, overview"><img src={mark} alt="" width={22} height={22} className="size-[22px]" /><span className="text-[15px] font-[550] tracking-[-0.02em]">Metal</span><span className="tag !h-[22px] !px-2">admin</span></Link>
        <span className="min-w-0 flex-1 truncate text-end text-14 text-ink-3">{current?.label}</span>
        <span className="w-2 shrink-0" aria-hidden />
      </header>
      <AnimatePresence>
        {drawer && (
          <div key="drawer" className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="admin menu">
            <m.div className="absolute inset-0" style={{ background: "var(--scrim)" }} onClick={() => setDrawer(false)} aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }} />
            <m.div className="absolute inset-y-0 left-0 flex w-[min(280px,86vw)] flex-col gap-6 overflow-y-auto overscroll-contain rounded-e-[28px] bg-side px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]" initial={{ x: "-100%", opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "-100%", opacity: 0, transition: { type: "spring", visualDuration: 0.22, bounce: 0 } }} transition={GLIDE}>{side(() => setDrawer(false))}</m.div>
          </div>
        )}
      </AnimatePresence>
      <main id="admin-main" className="lg:ps-[232px]">
        <PageIn key={path} id={path} className="mx-auto w-full max-w-[1320px] px-10 pb-24 pt-10 max-lg:px-5 max-lg:pt-6 max-sm:px-4">
          {me.data && <StagingTag environment={me.data.environment} live={me.data.live} />}
          {me.data ? <AdminRoleContext.Provider value={role}>{page(path, role)}</AdminRoleContext.Provider> : <Loading rows={8} />}
        </PageIn>
      </main>
      <Modal open={help} onClose={() => setHelp(false)} title="keyboard shortcuts">
        <ul className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-14">
          {ALL.filter((item) => opens(role, item.to)).map((item) => <li key={item.key} className="contents"><kbd className="font-mono text-ink">g {item.key}</kbd><span>{item.label}</span></li>)}
          <li className="contents"><kbd className="font-mono text-ink">/</kbd><span>search this page</span></li>
          <li className="contents"><kbd className="font-mono text-ink">?</kbd><span>this list</span></li>
        </ul>
      </Modal>
      {me.data && role === "owner" && <CustomerSheetHost />}
      {me.data && role === "owner" && <PersonSheetHost />}
      <Toasts />
    </div>
  );
}
