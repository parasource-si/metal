// The funnel's Dusk account sign-in, over whichever bridge this window has: the account gate's (which knows the
// providers the account service offers) or the cloud account's. Both keep the attempt and the token in main.
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import { OAUTH_PROVIDERS, type OAuthProvider } from "../../../shared/account-api";
import type { SignInVerify } from "../account-gate/bridge";

export interface FunnelAccountState {
  signedIn: boolean;
  email?: string;
  /** the app can't be used without one (the packaged app's gate) */
  required: boolean;
  /** a browser sign-in is under way */
  browser: boolean;
  /** a magic link went to this address, and the app waits for it */
  magic?: string;
  /** the website's first steps for this account (CloudAccountState.websiteSetup): "open" while it takes them, then where
   * they put the bots */
  website?: "open" | "free" | "cloud";
}

export interface FunnelAccount {
  state(): Promise<FunnelAccountState>;
  /** the sign-ins shown from the first frame; providers() only narrows them where the service says so */
  initialProviders: readonly OAuthProvider[];
  providers(): Promise<OAuthProvider[]>;
  emailStart(email: string): Promise<CloudSignInStart>;
  emailVerify(code: string): Promise<SignInVerify>;
  emailCancel(): Promise<void>;
  browser(provider: OAuthProvider): Promise<void>;
  /** emails a magic link; absent where the bridge can't (the code is typed here instead) */
  magicLink?(email: string): Promise<void>;
  cancelBrowser(): Promise<void>;
  /** signs this app out of the Dusk account, so another can sign in; absent where the bridge can't */
  signOut?(): Promise<void>;
  /** reads the account again now (the website's first steps may have ended) */
  refresh?(): Promise<void>;
  /** opens the website signed in, where its first steps carry on */
  reopenWebsite?(): Promise<void>;
  onChange(callback: () => void): () => void;
}

const signedIn = (status: string | undefined) => status === "connected";

type CloudBridge = NonNullable<Window["duskDesktop"]>["cloudAccount"];
function websiteWays(cloud: CloudBridge): Pick<FunnelAccount, "refresh" | "reopenWebsite"> {
  if (!cloud) return {};
  return {
    refresh: async () => { await cloud.refresh(); },
    ...(cloud.openPage ? { reopenWebsite: async () => { await cloud.openPage!("home"); } } : {}),
  };
}

/** Null where this window can't sign in to an account (a browser, a remote page, the app in development). */
export function funnelAccount(desktop: Window["duskDesktop"] = window.duskDesktop): FunnelAccount | null {
  if (!desktop || desktop.remoteClient?.active === true) return null;
  const gate = desktop.accountGate;
  const cloud = desktop.cloudAccount;
  if (gate) {
    return {
      state: async () => {
        const [view, account] = await Promise.all([gate.state(), cloud?.state().catch(() => null) ?? Promise.resolve(null)]);
        const email = account?.account?.email, website = account?.status === "connected" ? account.websiteSetup : undefined;
        return { signedIn: signedIn(view.status) || (view.required && !view.blocked), ...(email ? { email } : {}), required: view.required,
          browser: view.status === "connecting" && Boolean(view.browser || view.enrollment), ...(view.status === "connecting" && view.magic ? { magic: view.magic } : {}),
          ...(website ? { website } : {}) };
      },
      initialProviders: OAUTH_PROVIDERS,
      providers: async () => {
        if (!gate.options) return [...OAUTH_PROVIDERS];
        const answer = await gate.options();
        return answer.providers.filter((provider) => OAUTH_PROVIDERS.includes(provider));
      },
      emailStart: (email) => gate.signInStart(email),
      emailVerify: (code) => gate.signInVerify(code),
      emailCancel: async () => { await gate.signInCancel(); },
      browser: async (provider) => { await gate.browser(provider); },
      ...(gate.magicLink ? { magicLink: async (email: string) => { await gate.magicLink!(email); } } : {}),
      cancelBrowser: async () => { await gate.cancel(); },
      ...(cloud?.signOut ? { signOut: async () => { await cloud.signOut(); } } : {}),
      ...websiteWays(cloud),
      onChange: (callback) => {
        const stopGate = gate.onChange(() => callback());
        const stopCloud = cloud?.onState(() => callback());
        return () => { stopGate(); stopCloud?.(); };
      },
    };
  }
  if (cloud?.signInStart && cloud.signInVerify) {
    const start = cloud.signInStart, verify = cloud.signInVerify;
    return {
      state: async () => {
        const account = await cloud.state();
        const website = account.status === "connected" ? account.websiteSetup : undefined;
        return { signedIn: Boolean(account.account) && signedIn(account.status), ...(account.account?.email ? { email: account.account.email } : {}),
          required: false, browser: account.status === "connecting", ...(website ? { website } : {}) };
      },
      // the browser sign-in opens the account page, which offers Google there
      initialProviders: ["google"],
      providers: async () => ["google"],
      emailStart: (email) => start(email),
      emailVerify: async (code) => {
        const result = await verify(code);
        return result.outcome === "signed-in" ? { outcome: "signed-in" } : result;
      },
      emailCancel: async () => { await cloud.signInCancel?.(); },
      browser: async () => { await cloud.begin(); },
      cancelBrowser: async () => { await cloud.cancel(); },
      ...(cloud.signOut ? { signOut: async () => { await cloud.signOut(); } } : {}),
      ...websiteWays(cloud),
      onChange: (callback) => cloud.onState(() => callback()),
    };
  }
  return null;
}
