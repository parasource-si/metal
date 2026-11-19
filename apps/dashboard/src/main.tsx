import "../../../electron/legacy-names.mjs";
import { lazy, StrictMode, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CloudDataProvider, useCloud } from "./data/cloud";
import { SessionProvider, useSession } from "./data/session";
import { navigate, useLocation } from "./lib/router";
import { initTheme } from "./lib/theme";
import { planIntent, planQuery } from "./lib/site";
import { reportPageErrors } from "./lib/page-errors";
import { reloadForStaleChunk } from "./lib/stale-chunk";
import { trackPage } from "./lib/analytics";
import { Button, ButtonLink } from "./ui/kit";
import { Shell } from "./ui/Shell";
import { MotionRoot } from "./ui/motion";
import { SkyEmpty } from "./ui/Sky";
import { CrashBoundary } from "./ui/Crash";
import { LoadingPage } from "./pages/common";
import { PlansPageSkeleton, PlansSkeleton } from "./ui/plans-skeleton";
import { ClaimPage, hasClaim, stashClaim } from "./pages/Connect";
import { deletePageId, deleteSignInNote, deleteToken, stashDeleteToken } from "./data/delete-data";
import { HomePage } from "./pages/Home";
import { AuthScreen } from "./pages/Auth";
import { HANDOFF_PATH, handoffArrived, stashHandoff } from "./data/handoff";
import { appReturn, stashAppReturn } from "./data/app-return";
import { APP_LANDING_PATH } from "../../../shared/account-api.ts";
import { stashTeamInvite, TEAM_JOIN_PATH, teamInvite } from "./data/team";
import { PRELAUNCH, prelaunchAllowed } from "./lib/prelaunch";
import "./app.css";

type Page<P> = ComponentType<P> & { preload(): Promise<unknown> };

/** a page from its own chunk; once the chunk is in it renders straight away instead of suspending, which spares
 * later visits react's suspense reveal delay */
function page<M, P extends object>(rawLoad: () => Promise<M>, pick: (m: M) => ComponentType<P>): Page<P> {
  const load = () => rawLoad().catch((error: unknown) => reloadForStaleChunk(error) ? new Promise<M>(() => {}) : Promise.reject(error));
  let loaded: ComponentType<P> | null = null;
  const take = (m: M) => (loaded = pick(m));
  const Lazy = lazy(() => load().then((m) => ({ default: take(m) })));
  return Object.assign((props: P) => {
    const Current = (loaded ?? Lazy) as ComponentType<P>;
    return <Current {...props} />;
  }, { preload: () => load().then(take) });
}

const CloudDesktopPage = page(() => import("./pages/CloudDesktop"), (m) => m.CloudDesktopPage);
const WorkspacesPage = page(() => import("./pages/Workspaces"), (m) => m.WorkspacesPage);
const WorkspacePage = page(() => import("./pages/Workspaces"), (m) => m.WorkspacePage);
const BotsPage = page(() => import("./pages/Bots"), (m) => m.BotsPage);
const BotPage = page(() => import("./pages/Bots"), (m) => m.BotPage);
const ConnectorsPage = page(() => import("./pages/Connectors"), (m) => m.ConnectorsPage);
const UsagePage = page(() => import("./pages/Usage"), (m) => m.UsagePage);
const BillingPage = page(() => import("./pages/Billing"), (m) => m.BillingPage);
const AccountPage = page(() => import("./pages/Account"), (m) => m.AccountPage);
const TeamPage = page(() => import("./pages/Team"), (m) => m.TeamPage);
const TeamJoinPage = page(() => import("./pages/Team"), (m) => m.TeamJoinPage);
const DeviceApprovalPage = page(() => import("./pages/DeviceApproval"), (m) => m.DeviceApprovalPage);
const DeleteDataPage = page(() => import("./pages/DeleteData"), (m) => m.DeleteDataPage);
const Onboarding = page(() => import("./pages/Onboarding"), (m) => m.Onboarding);
const HandoffPage = page(() => import("./pages/Handoff"), (m) => m.HandoffPage);
const AppSignedInPage = page(() => import("./pages/AppSignedIn"), (m) => m.AppSignedInPage);
const AdminApp = page(() => import("./admin/AdminApp"), (m) => m.AdminApp);

// after the first page has painted, fetch the others in idle time so moving between them never waits;
// the app catalogue comes last, so the apps page opens with every app already there
function prefetchPages() {
  const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1));
  const timer = setTimeout(() => idle(() => {
    for (const p of [CloudDesktopPage, WorkspacesPage, WorkspacePage, BotsPage, BotPage, ConnectorsPage, UsagePage, BillingPage, AccountPage, DeviceApprovalPage, Onboarding]) void p.preload().catch(() => {});
    void import("./data/connectors").then((m) => m.preloadApps());
  }), 1500);
  return () => clearTimeout(timer);
}

// before anything else reads the address: the handoff token must never reach an error report or a page view
stashHandoff();
stashAppReturn();
initTheme();
reportPageErrors();
stashClaim();
stashDeleteToken();
stashTeamInvite();

const TITLES: Record<string, string> = {
  "/": "home", "/cloud": "dusk cloud", "/workspaces": "workspaces", "/bots": "bots", "/connectors": "apps",
  "/billing": "plans and billing", "/usage": "usage", "/account": "account", "/team": "team", [TEAM_JOIN_PATH]: "join a team", "/claim": "connect a workspace", "/welcome": "welcome",
  "/signin": "sign in", "/sign-in": "sign in", "/signup": "make your account", "/cloud/desktop": "approve sign-in",
};

const SIGN_IN_PATHS = ["/signin", "/sign-in", "/signup"];

// older links keep working
const MOVED: Record<string, string> = { "/settings": "/account", "/devices": "/account#devices", "/connect": "/workspaces#add", "/signin": "/", "/sign-in": "/", "/signup": "/" };

function route(path: string): ReactNode {
  if (path === "/") return <HomePage />;
  if (path === "/cloud") return <CloudDesktopPage />;
  if (path === "/workspaces") return <WorkspacesPage />;
  const ws = /^\/workspaces\/([^/]+)$/.exec(path);
  if (ws) return <WorkspacePage id={decodeURIComponent(ws[1]!)} />;
  if (path === "/bots") return <BotsPage />;
  const bot = /^\/bots\/([^/]+)$/.exec(path);
  if (bot) return <BotPage id={decodeURIComponent(bot[1]!)} />;
  if (path === "/connectors") return <ConnectorsPage />;
  if (path === "/billing") return <BillingPage />;
  if (path === "/usage") return <UsagePage />;
  if (path === "/account") return <AccountPage />;
  if (path === "/team") return <TeamPage />;
  if (path === TEAM_JOIN_PATH) return <TeamJoinPage />;
  if (path === "/claim") return <ClaimPage />;
  if (path === "/cloud/desktop") return <DeviceApprovalPage />;
  const deleting = deletePageId(path);
  if (deleting !== null) return <DeleteDataPage id={deleting} />;
  return <SkyEmpty art="cat" title="nothing lives here." action={<ButtonLink to="/" variant="primary">go home</ButtonLink>}>there's no page at {path}. just gary.</SkyEmpty>;
}

function SignedIn() {
  const { path, query } = useLocation();
  useEffect(prefetchPages, []);
  const { account, error } = useCloud();
  const next = query.get("next");
  const intent = planIntent(query);
  const welcome = path === "/welcome";
  const admin = path === "/admin" || path.startsWith("/admin/");
  const exempt = path === "/claim" || path === "/cloud/desktop" || path === TEAM_JOIN_PATH || deletePageId(path) !== null;
  // until onboarding is done every dashboard page leads back into it; the account page (sign out, delete) stays open
  const unfinished = account !== null && !account.profile.onboarded && !welcome && !exempt && !admin && path !== "/account";
  const search = query.toString();
  // a plan picked on the site: someone signed in already goes to the plan step, or straight to plans once onboarded
  const moved = MOVED[path]
    ? (intent && SIGN_IN_PATHS.includes(path) ? `/welcome?${planQuery(intent)}` : path === "/sign-in" && next?.startsWith("/") && !next.startsWith("//") ? next : MOVED[path])
    : welcome && intent && account?.profile.onboarded ? `/billing?${planQuery(intent)}`
    : unfinished ? `/welcome${search ? `?${search}` : ""}` : null;
  useEffect(() => { if (moved) navigate(moved, { replace: true }); }, [moved]);
  if (moved) return null;
  const blank = <div className="min-h-[100dvh] bg-bg" aria-busy="true" />;
  if (admin) return <Suspense fallback={blank}><AdminApp /></Suspense>;
  // home or onboarding is decided once the profile is in, so a new account never sees home first
  if (!welcome && !exempt && account === null && !error) return path === "/billing" ? <PlansPageSkeleton /> : blank;
  if (welcome && intent && account === null && !error) return blank;
  if (welcome) return <Suspense fallback={blank}><Onboarding /></Suspense>;
  // the desktop app's sign-in: its own clean page, not the dashboard around it
  if (path === "/cloud/desktop") return <main className="min-h-[100dvh] bg-bg px-6 py-10"><Suspense fallback={<LoadingPage />}>{route(path)}</Suspense></main>;
  return <Shell><Suspense fallback={path === "/billing" ? <PlansSkeleton /> : <LoadingPage />}>{route(path)}</Suspense></Shell>;
}

function App() {
  const { path, query } = useLocation();
  const search = query.toString();
  useEffect(() => trackPage(path), [path, search]);
  const { account, accountError, retryAccount } = useSession();
  useEffect(() => {
    // the admin panel names its own tabs
    if (account && (path === "/admin" || path.startsWith("/admin/"))) return;
    const page = path === HANDOFF_PATH ? "signing in" : path === APP_LANDING_PATH ? "signed in" : account === null ? (path === "/signup" ? "make your account" : "sign in")
      : TITLES[path] ?? (path.startsWith("/bots/") ? "bot" : path.startsWith("/workspaces/") ? "workspace" : deletePageId(path) !== null ? "delete cloud data" : "not found");
    document.title = `${page} / Metal`;
  }, [path, account]);
  // before launch only a real flow's pages show; any other move (a link, the sidebar, after signing in) goes to the waitlist
  const away = PRELAUNCH && !prelaunchAllowed(path, query, { handoff: handoffArrived(), appReturn: appReturn() !== null, claim: hasClaim(), deleting: (id) => deleteToken(id) !== null, teamInvite: teamInvite() !== null });
  useEffect(() => { if (away) location.replace("/"); }, [away]);
  const blank = <div className="min-h-[100dvh] bg-bg" aria-busy="true" />;
  if (away) return blank;
  // the app's links open the plans most of all, so the wait looks like them
  if (path === HANDOFF_PATH) return <Suspense fallback={<PlansPageSkeleton />}><HandoffPage /></Suspense>;
  if (path === APP_LANDING_PATH) return <Suspense fallback={blank}><AppSignedInPage /></Suspense>;
  if (accountError) return <main className="flex min-h-[100dvh] items-center justify-center bg-bg px-6"><SkyEmpty art="cat" title="can't reach your account right now." action={<Button variant="primary" onClick={retryAccount}>try again</Button>} className="w-full max-w-[520px]">check your connection. your bots are fine, they live on your own computers.</SkyEmpty></main>;
  if (account === undefined) return path === "/billing" ? <PlansPageSkeleton /> : <div className="min-h-[100dvh] bg-bg" aria-busy="true" />;
  if (account === null) return <AuthScreen mode={path === "/signup" ? "signup" : "signin"} forApp={path === "/cloud/desktop"} note={path === TEAM_JOIN_PATH ? "sign in with the email your invite was sent to, and you join the team." : path === "/claim" ? "this link connects a Metal workspace to your account, so its machine stats, bots and usage show here. chats and files stay on it. sign in to go on." : deleteSignInNote(path)} />;
  return <SignedIn />;
}

function Root() {
  const { account } = useSession();
  return <CloudDataProvider signedIn={Boolean(account)}><App /></CloudDataProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashBoundary>
      <MotionRoot>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </MotionRoot>
    </CrashBoundary>
  </StrictMode>,
);
