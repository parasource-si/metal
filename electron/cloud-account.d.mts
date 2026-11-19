/** Remove from list's answer: done (`removed`), refused by the Admin now, the Cloud no longer theirs (`gone`), an Admin
 * without it (`unsupported`), or no answer (`failed`). */
export type CloudRemoveOutcome = "removed" | "refused" | "gone" | "unsupported" | "failed";
export interface CloudAccountState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
  enrollment?: { userCode: string; expiresAt: number };
  /** Signing in at this provider in the browser, which comes back to the app's own link (packaged app only). */
  browser?: import("./cloud-signin.mjs").CloudLinkProvider;
  /** the address a magic link went to; the app waits for it to be opened */
  magic?: string;
  /** `name`, `avatarUrl` (https): from an Admin that knows them */
  account?: { id: string; email: string; name?: string; avatarUrl?: string; avatar?: string };
  deviceId?: string;
  expiresAt?: number;
  /** Only a current server-verified session can include an entitlement
   * (verified within the last few minutes; a failed re-check keeps it).
   * `plan` "pro" means any paid plan; `tier` names it ("starter", "personal",
   * "pro", "max", or one newer than this app) when the Admin sends one. */
  entitlement?: { plan: "free" | "pro"; tier?: string; status: "active" | "inactive"; expiresAt: number | null; version: number };
  verifiedAt?: number;
  verifiedUntil?: number;
  /** Connected, but the last checks with dusk cloud failed; the snapshot is the last verified one. */
  checking?: true;
  /** Not connected (unavailable, or the sign-in ended): the paid plan last
   * verified for this account, for display only. It activates nothing. */
  lastPlan?: { tier?: string; active: boolean };
  /** The person's Cloud home machine, when their plan has one. */
  machine?: import("./cloud-home.mjs").CloudMachine;
  /** Connected: the teams this account is in, each with its Cloud; absent while it is in none. */
  teams?: import("./cloud-home.mjs").CloudTeam[];
  /** Connected to an Admin that lists every Cloud of the person's (contract v1 `clouds`): each of them, My Cloud first.
   * Absent from an older Admin, whose `machine` and `teams` say everything. */
  clouds?: import("./cloud-list.mjs").CloudListEntry[];
  /** With `clouds`: whether the Admin opens another Cloud's checkout now, and why not. */
  addCloud?: { canAdd: true } | { canAdd: false; blocked: CloudAddBlock };
  /** With `clouds`, for the account a Team plan with organizations is billed to: whether ＋ may add one to it now. */
  organizations?: import("./cloud-list.mjs").CloudOrganizations;
  /** The newest Metal release the Admin knows, while it follows releases (with `clouds`); absent otherwise. */
  latestVersion?: string;
  /** Another Cloud this app is buying (in the last 24 hours): its id, name, swatch and plan, when its checkout opened,
   * whether main keeps that page (`link`), and `done` once it was opened or announced. */
  /** `cloudId` null: a checkout the Admin said is still open, before the session lists its Cloud. */
  adding?: { cloudId: string | null; name: string; color: import("./cloud-list.mjs").CloudSwatch | null; tier: string | null; startedAt: number; link?: true; done?: true };
  /** A payment dusk cloud received and is still linking to this account. */
  purchase?: import("./cloud-home.mjs").CloudPurchase;
  /** Connected: "open" while the website takes this new account through its first steps (name, plan), which the app's
   * first run waits on; then where those steps put the bots, "free" (this computer) or "cloud" (a plan picked). Absent
   * for an account whose first steps ended before, and from an Admin older than it. */
  websiteSetup?: "open" | "free" | "cloud";
  /** Connected: the free trial on this account's Cloud, when the Admin says (display only). */
  trial?: import("./cloud-home.mjs").CloudTrial;
  /** Connected: what this account may buy now (the session's `offer`), for wording only. */
  offer?: import("./cloud-home.mjs").CloudOffer;
  /** Connected with an active plan: its allowances and this month's use of them, and the bigger plans the app can move to (display only). */
  usage?: import("./cloud-home.mjs").CloudUsage;
  /** Connected beside `usage`: the Cloud is short on room (display only; its plan moves through the usual upgrade). */
  room?: import("./cloud-home.mjs").CloudRoom;
  /** A checkout this app opened (or a sign-in it started on the way to
   * one: `signIn`) in the last 24 hours: the plan, and when (Reopen checkout
   * starts the 30-minute watch again). `link`: main keeps its page, so Reopen
   * and Copy link use that same page. `found`: not opened by this app run, only found
   * still open at the Admin after a restart (so `startedAt` is when it was found). */
  checkout?: { plan: string; startedAt: number; signIn?: true; link?: true; done?: true; found?: true };
  /** This app talks to the staging Admin (DUSK_CLOUD_STAGING=1): test payments, test Clouds. */
  staging?: true;
  /** Connected: opening My Cloud waits for it to wake. */
  waking?: true;
  /** Connected: the plan's renewal, only while this account pays for a plan that runs: what Cancel and Keep act on (display only). */
  renewal?: import("./cloud-list.mjs").CloudRenewal;
}
/** What holding the first run's AI sign-ins did: `held` for the Cloud being made, `nothing` to hold, `no-cloud` (none
 * being made for this account), or `failed`. */
export interface CloudHeldSignIns { outcome: "held" | "nothing" | "no-cloud" | "failed" }
/** The cancel sheet's reasons. */
export type CloudCancelAnswer = "feature" | "price" | "setup" | "broken" | "later" | "other";
/** The cancel sheet's survey: one reason (words without one are kept as `other`) and two optional boxes, at most 2,000 characters each. */
export interface CloudCancelSurvey { answer?: CloudCancelAnswer | null; expected?: string; improve?: string }
/** What Cancel or Keep my plan did: `cancelled` (with when it ends, from the Admin's answer, and whether the survey was kept),
 * `kept`, `browser` (this Admin can't do it from the app yet, so the Cloud page's billing opened instead), or `failed`
 * (nothing changed). */
export type CloudRenewalResult =
  | { outcome: "cancelled"; renewal: import("./cloud-list.mjs").CloudRenewal | null; surveyed: boolean; state: CloudAccountState }
  | { outcome: "kept"; state: CloudAccountState }
  | { outcome: "browser" }
  | { outcome: "failed"; state: CloudAccountState };
/** The email-code sign-in (cloud-signin.mjs). `sent`: the code is on its
 * way (`resendAt`: when another may be asked for). `browser`: this Cloud signs
 * in only in the browser (single sign-on there, or an older Admin). */
export type CloudSignInStart =
  | { outcome: "sent"; email: string; expiresAt: number; resendAt: number; /** False: new accounts are closed, so only an existing one gets a code. */ signupOpen: boolean }
  | { outcome: import("./cloud-signin.mjs").CloudSignInStartFailure };
/** `signed-in`: stored and read like the browser sign-in; `wrong-code` says
 * the tries left; `expired` needs a new code. */
export type CloudSignInVerify =
  | { outcome: "signed-in"; state: CloudAccountState }
  | { outcome: "wrong-code"; triesLeft: number }
  | { outcome: Exclude<import("./cloud-signin.mjs").CloudSignInVerifyFailure, "wrong-code"> };
/** How the Cloud is shown in this app's switcher and Settings → Servers. */
export interface CloudHomeLook { name: string; color: import("./cloud-buy.mjs").CloudColor }
/** Why the Admin opens no other Cloud's checkout now (contract v1 `addBlocked`). */
export type CloudAddBlock = "cap" | "checkout_open" | "rate" | "signups_closed";
export declare const ADD_BLOCKS: readonly CloudAddBlock[];
/** What buying another Cloud did: `opened` its checkout in the browser; `unsupported` (this Admin sells one Cloud per
 * account); `blocked` with the Admin's reason; or `failed` (nothing was opened). */
export type CloudAddResult =
  | { outcome: "opened"; state: CloudAccountState }
  | { outcome: "unsupported" | "failed" }
  | { outcome: "blocked"; blocked: CloudAddBlock };
/** What adding an organization did: `added` (its Cloud is being set up), `taken` (another of the plan's has that name),
 * `blocked` with the Admin's reason, `unsupported` (an Admin without organizations), or `failed` (nothing was added). */
export type OrganizationAddResult =
  | { outcome: "added"; cloudId?: string }
  | { outcome: "taken" | "unsupported" | "failed" }
  | { outcome: "blocked"; blocked: import("./cloud-list.mjs").OrganizationBlock };
/** What opening a checkout did: `opened` in the browser; `signing-in` (signed
 * out, the browser signs in first); `conflict` (the account changed, now read
 * again); `rate-limited`; or `failed` (nothing was opened). */
export type CloudCheckoutOutcome = "opened" | "signing-in" | "conflict" | "rate-limited" | "failed";
export interface CloudCheckoutResult { outcome: CloudCheckoutOutcome; state: CloudAccountState }
/** What moving up to a bigger plan would cost now, from Dodo's own preview (US cents): `price` a month before tax, `chargeNow`
 * today with its `tax` (0 for a free trial, whose first charge becomes `price` on `nextBillingAt`). The confirmation stays in main. */
export interface CloudUpgradePreview { plan: string; from?: string; trial: boolean; price: number; chargeNow: number; tax: number; nextBillingAt?: number; expiresAt: number }
/** The Admin's refusals the app words itself. */
export type CloudUpgradeRefusal = "payment_failed" | "not_subscribed" | "already_on_plan" | "plan_change_unavailable" | "confirmation_required" | "price_changed" | "rate_limited";
/** `preview`: show it and ask; `settled`: a change already going through, where it is now; `browser`: this Admin doesn't change
 * plans from the app, so the Cloud page opened instead; `refused` with its code; `failed`: nothing changed. */
export type CloudUpgradePreviewResult =
  | { outcome: "preview"; preview: CloudUpgradePreview }
  | { outcome: "settled"; status: "upgraded" | "pending"; tier: string }
  | { outcome: "browser" }
  | { outcome: "refused"; code: CloudUpgradeRefusal }
  | { outcome: "failed" };
/** `upgraded`: on the new plan; `pending`: Dodo is still taking the payment; `unconfirmed`: no answer, so the session will say. */
export type CloudUpgradeResult =
  | { outcome: "upgraded" | "pending"; tier: string }
  | { outcome: "unconfirmed" }
  | { outcome: "refused"; code: CloudUpgradeRefusal }
  | { outcome: "failed" };
export interface CloudAccountBridge {
  state(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** An account step in the browser for its context (shared/account-api.ts AccountIntent): `opened` already signed in,
   *  `browser` while the browser sign-in is under way (state().status "connecting"). Absent on an older app. */
  continueInBrowser?(intent: { kind: "signin" | "upgrade" | "billing"; plan?: "plus" | "pro"; source?: string; move?: string }): Promise<{ outcome: "opened" | "browser" | "failed"; state: CloudAccountState }>;
  /** A page of the account website in the browser, signed in as this account through a one-time link. */
  openPage?(page: Exclude<CloudHandoffPage, "plans">, workspaceId?: string): Promise<CloudWebHandoffResult>;
  /** What this person may buy now (cloud-account.mjs offer), or null. */
  offer?(): Promise<import("./cloud-home.mjs").CloudOffer | null>;
  /** Opens a checkout for a plan of the offer in the browser; `source` is one of CHECKOUT_SOURCES. */
  checkout?(plan: string, source: string): Promise<CloudCheckoutResult>;
  /** The email-code sign-in; the attempt and the token never reach the page. Absent on an older app. */
  signInStart?(email: string): Promise<CloudSignInStart>;
  signInVerify?(code: string): Promise<CloudSignInVerify>;
  signInCancel?(): Promise<void>;
  /** The checkout this app opened, again (never a new one while main keeps it); the plan and source only when none is kept. */
  reopenCheckout?(plan: string, source: string): Promise<CloudCheckoutResult>;
  /** Copies that checkout's page to the clipboard in main; false when none is kept. */
  copyCheckoutLink?(): Promise<boolean>;
  /** "Email me when I can add another". */
  interest?(): Promise<void>;
  /** Moving up to a bigger plan: what it costs now (changes nothing), then the change, only after this app's own preview of it. Absent on an older app. */
  upgradePreview?(plan: string, source: string): Promise<CloudUpgradePreviewResult>;
  upgrade?(plan: string, source: string): Promise<CloudUpgradeResult>;
  /** The Cloud's name and colour (chosen while it is set up), and saving them. */
  look?(): Promise<CloudHomeLook>;
  setLook?(name: string, color: string): Promise<CloudHomeLook>;
  /** The buying sheet is open on this page (main then opens the ready Cloud there rather than notifying). */
  sheet?(open: boolean): Promise<void>;
  /** The sheet showed the ready Cloud: the purchase is over. */
  readySeen?(): Promise<void>;
  /** Lists the Cloud machine under Servers and opens it in this window. */
  connectHome(): Promise<CloudAccountState>;
  /** The same, opening the Cloud's Settings on its phone pairing. */
  connectHomeForPhone(): Promise<CloudAccountState>;
  /** Opens a team's Cloud in this window, as the switcher does: one the verified session lists, by its id. Absent on an older app. */
  openTeam?(teamId: string): Promise<void>;
  /** Cancel trial / Cancel plan, after the survey when it says anything; Keep my plan. The Cloud is the verified session's own, never the page's. Absent on an older app. */
  cancelPlan?(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keepPlan?(): Promise<CloudRenewalResult>;
  /** The first run on dusk cloud: this computer's AI sign-ins, held for the account's own Cloud until it runs. */
  holdSignIns?(): Promise<CloudHeldSignIns>;
  /** The first run on dusk cloud: the AIs signed in here (instance ids) whose sign-in goes along to the account's own Cloud. Absent on an older app. */
  carriedAis?(): Promise<{ instanceIds: string[] }>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  files?: import("./cloud-sync.mjs").CloudFilesBridge;
}
/** Who is signed in on this device, as the You menu shows it. `signIn`: this account's sign-in has ended here. */
/** What the account card says of the plan: `free` (none), `active` (paid or a trial: `tier`, and when it renews or ends),
 * `inactive` (paid once, not now). Absent until a session read said. */
export interface AccountPlanLine { status: "free" | "active" | "inactive"; tier?: string; trial?: true; renewsAt?: number; endsAt?: number; cancelled?: true }
/** `avatar`: the person's choice (shared/user-avatar.ts), absent for the default. */
export interface AccountRow { id: string; email: string; signIn?: true; name?: string; avatarUrl?: string; avatar?: string; plan?: AccountPlanLine }
export interface AccountsView { active: AccountRow | null }
export interface AccountSwitchResult { outcome: "switched" | "signed-out" | "moving" | "sign-in" | "gone" | "failed"; email?: string; view: AccountsView }
/** What a click on a place of another account answers when it didn't switch: nothing moved. `sign-in`: that sign-in has ended. */
export interface RailOpenResult { outcome: "switched" | "moving" | "sign-in" | "gone" | "failed"; email?: string }
/** `added`: kept signed in, not switched to, while this computer's move finishes; `already`: that account is the one signed in. */
export type AccountAddResult =
  | { outcome: "switched" | "added" | "already"; email?: string; view: AccountsView }
  | { outcome: "wrong-code"; triesLeft: number }
  | { outcome: Exclude<import("./cloud-signin.mjs").CloudSignInVerifyFailure, "wrong-code"> };
/** This app's own pages only: main refuses any other page. Absent on an older app. */
export interface AccountsBridge {
  list(): Promise<AccountsView>;
  /** Removes that account from this device; the window goes to another signed in here, else the app is signed out. */
  signOut(id: string): Promise<AccountSwitchResult>;
  /** Keeps the avatar on the account: "photo", "g:<seed>", or null for the default. Absent on an older app. */
  setAvatar?(choice: string | null): Promise<{ outcome: "saved" | "failed"; view: AccountsView }>;
  /** Add another account: the active account goes on until this succeeds. The attempt and the token stay in main. */
  addStart(email: string): Promise<CloudSignInStart>;
  addVerify(code: string): Promise<AccountAddResult>;
  addBrowser(): Promise<{ outcome: "browser" | "failed"; code?: string }>;
  addReopen(): Promise<void>;
  /** How the browser's way ended, asked once the list changes: null until it has. */
  addResult(): Promise<{ outcome: "switched" | "added" | "already" | "failed"; email?: string } | null>;
  addCancel(): Promise<void>;
  sheetPending(): Promise<boolean>;
  sheetClosed(): Promise<void>;
  onChanged(callback: () => void): () => void;
  onOpenSheet(callback: () => void): () => void;
}
/** Any place's own page, from the person's click: the accounts sheet opens on the rail's page, and this page learns nothing of them. */
/** The account in use as a Cloud of the person's own shows it. `email` is absent from an older app. */
export type AccountFace = Omit<AccountRow, "email" | "signIn"> & { email?: string };
/** `face`: null on any page but a Cloud of the person's own, or while nobody is signed in. Absent on an older app. */
export interface AccountSheetBridge { offered(): Promise<boolean>; open(): Promise<void>; face?(): Promise<AccountFace | null> }
/** On the person's own Cloud, open in this app's window: the plan, read
 * only, Manage in the browser, and Sign in again. No account, credential or address. */
/** `signin`: this computer's sign-in ended; `tier` names the plan last verified, if any. */
export interface CloudPlanSnapshot {
  status: "paid" | "attention" | "checking" | "signin" | "none";
  tier?: string;
  /** Verified: the free trial on the Cloud. */
  trial?: import("./cloud-home.mjs").CloudTrial;
  /** The trial's popup due now, not yet shown today on either page. */
  notice?: import("./cloud-home.mjs").CloudTrialState;
  /** Verified: the plan sleeps when idle. */
  sleeps?: true;
  /** This window's home is this Cloud: the person's bots moved here (home-window.mjs). */
  home?: true;
  /** Verified, with an active plan: its allowances and their use this month (the usage meter). */
  usage?: import("./cloud-home.mjs").CloudUsage;
  /** Verified, beside `usage`: this Cloud is short on room, and the plan that fixes it or a tip (the room card). */
  room?: import("./cloud-home.mjs").CloudRoom;
  /** Verified, while this account pays for a plan that runs: what Cancel and Keep act on. */
  renewal?: import("./cloud-list.mjs").CloudRenewal;
  /** Verified: who runs My Cloud's machine, when the session's list says ("managed"). */
  provider?: string;
}
export type CloudPhoneSignIn = { outcome: "code"; code: string; expiresAt: number; email: string;
  /** the account service that made the code, which the phone must redeem it at; absent from an older app */
  service?: string }
  /** "unsupported": the account service makes no phone codes, so the phone logs in with its email instead */
  | { outcome: "signed-out" | "limited" | "unsupported" | "failed" | "canceled" };
export interface CloudPlanBridge {
  state(): Promise<CloudPlanSnapshot>;
  manage(): Promise<void>;
  /** A page of the account website, opened signed in (only from the person's click). Absent on an older app. */
  openPage?(page: Exclude<CloudHandoffPage, "plans">, workspaceId?: string): Promise<CloudWebHandoffResult>;
  /** This device's dusk cloud sign-in, again, once it has ended: only from the person's click. */
  signIn?(): Promise<void>;
  /** A code (and its QR) that logs a phone in to this account, after main's presence check; `renew` swaps the one on
   * screen without asking again for about an hour. Absent on an older app. */
  phoneSignIn?(renew?: boolean): Promise<CloudPhoneSignIn>;
  /** The trial's popup due now was shown: main shows it no more today. Absent on an older app. */
  noticeSeen?(): Promise<void>;
  /** The usage meter's Upgrade: the preview, then the change (only from the person's click). Absent on an older app. */
  upgradePreview?(plan: string, source: string): Promise<CloudUpgradePreviewResult>;
  upgrade?(plan: string, source: string): Promise<CloudUpgradeResult>;
  /** Cancel trial / Cancel plan and Keep my plan on the Cloud's own page (only from the person's click). Absent on an older app. */
  cancel?(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep?(): Promise<CloudRenewalResult>;
  /** The room card's Not now, and Restart now after its upgrade (only from the person's click). Absent on an older app. */
  roomNotNow?(id: string): Promise<boolean>;
  restartNow?(): Promise<"restarting" | "current" | "failed">;
}

export declare const CLOUD_ORIGIN: string;
export declare const STAGING_CLOUD_ORIGIN: string;
export declare function cloudTarget(env?: Record<string, string | undefined>): {
  origin: string; staging: boolean; custom: boolean;
  /** Under userData: the sign-in, saved servers, Files' folder, the Cloud's chosen name. */
  file: string; saved: string; places: string; environments: string; sync: string; look: string;
};
export declare const CHECKOUT_SOURCES: readonly string[];
export declare const UPGRADE_SOURCES: readonly string[];
export declare const CLOUD_CANCEL_ANSWERS: readonly CloudCancelAnswer[];
/** The survey as main sends it (trimmed; words without a reason as `other`), or null when it says nothing or isn't one. */
export declare function accountProfile(account: unknown): { name?: string; avatarUrl?: string; avatar?: string };
export declare function cancelSurvey(input: unknown): { answer: CloudCancelAnswer; expected?: string; improve?: string } | null;
/** Only this Admin's own /handoff (or /dashboard/handoff) page with a one-time `#t=` token; anything else is null. */
export declare function handoffDestination(value: unknown, origin: string): string | null;
export type CloudHandoffPage = "plans" | "home" | "workspace" | "cloud" | "billing" | "account" | "usage";
export declare const HANDOFF_PAGES: Readonly<Record<CloudHandoffPage, string>>;
export type CloudWebHandoffResult = { opened: true; fallback?: true } | { opened: false } | { signedOut: true };
export declare function checkoutDestination(value: unknown, options?: { fixture?: boolean; staging?: boolean; custom?: boolean }): string | null;
export declare function cloudOrigin(value?: string, fixture?: boolean, custom?: boolean): string;
export interface CloudAccountStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  /** Whether a sign-in can be saved now; asked before an emailed code is spent. */
  ready?(): Promise<boolean>;
}
export declare function createCloudAccountStore(options: {
  file: string;
  encryption: {
    available(): boolean | Promise<boolean>;
    encrypt(value: string): Buffer | Promise<Buffer>;
    /** A string, or Electron 43's { shouldReEncrypt, result } (safeStorage.decryptStringAsync). */
    decrypt(value: Buffer): string | { result: string } | Promise<string | { result: string }>;
  };
}): CloudAccountStore;
export interface CloudAccountClient {
  state(): CloudAccountState;
  start(): Promise<CloudAccountState>;
  begin(intent?: { plan: string; source: string } | null, options?: { provider?: string; account?: string | null; email?: string }): Promise<CloudAccountState>;
  enrollGrant(): Promise<{ enrollToken: string; dashboardUrl: string } | null>;
  /** Takes a workspace this account owns off its dashboard; true once gone, null when signed out or unanswered. */
  unlinkWorkspace(workspaceId: string): Promise<true | null>;
  setAvatar(choice: string | null): Promise<true | null>;
  /** A five-minute signed grant for the link service (apps/link-service/src/grant.mjs); null when signed out. */
  linkGrant(): Promise<string | null>;
  /** a ten-minute, single-use code that logs a phone in to this account (ACCOUNT_ROUTES.phoneSignIn) */
  phoneSignIn(): Promise<Exclude<CloudPhoneSignIn, { outcome: "canceled" }>>;
  /** Short-lived Cloudflare TURN servers for the direct screen path; null when signed out or TURN is off. */
  screenIce(): Promise<Array<{ urls: string[]; username?: string; credential?: string }> | null>;
  /** Only when the sign-in has ended: forget it and start a new one. */
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  /** Opens a website page signed in as this account (a one-time /handoff link); `fallback` when the Admin had none and the
   * plain page opened. `page` defaults to "plans", which alone takes `plan` ("plus" or "pro") and `source` (one of
   * CHECKOUT_SOURCES); "workspace" takes `workspaceId`. */
  webHandoff(input?: { page?: CloudHandoffPage; plan?: "plus" | "pro"; source?: string; workspaceId?: string }): Promise<CloudWebHandoffResult>;
  offer(): Promise<import("./cloud-home.mjs").CloudOffer | null>;
  checkout(plan: string, source: string): Promise<CloudCheckoutResult>;
  /** `recover`: "Can't sign in?": the mail also names the ways this address signs in. */
  emailStart(email: string, options?: { recover?: boolean }): Promise<CloudSignInStart>;
  emailVerify(code: string): Promise<CloudSignInVerify>;
  emailCancel(): void;
  /** duskbot://auth from the browser: redeems the code of the sign-in this app started; any other link is ignored. */
  finishLink(url: string): Promise<{ outcome: "signed-in" | "failed" | "ignored"; state: CloudAccountState }>;
  /** The provider buttons the account service says sign in, and whether it mails recovery; none when it doesn't say. */
  signInOptions(): Promise<{ providers: import("./cloud-signin.mjs").CloudLinkProvider[]; recovery: boolean }>;
  reopenCheckout(plan?: string, source?: string): Promise<CloudCheckoutResult>;
  /** Main only (the clipboard): the kept checkout page, or null. */
  checkoutLink(): string | null;
  /** The Cloud this checkout bought was opened, announced or shown ready. */
  checkoutDone(): void;
  /** Waiting on a checkout this app opened (the first 30 minutes). */
  checkoutPending(): boolean;
  interest(kind: "another_cloud"): Promise<void>;
  /** POST /api/cloud/desktop/upgrade/preview; keeps the confirmation in main. */
  upgradePreview(plan: string, source: string): Promise<CloudUpgradePreviewResult>;
  /** POST /api/cloud/desktop/upgrade with this app's own preview's confirmation, or nothing is asked. */
  upgrade(plan: string, source: string): Promise<CloudUpgradeResult>;
  /** POST /api/cloud/desktop/feedback when the survey says anything (never in the cancel's way), then POST
   * /api/cloud/desktop/clouds/<the session's own Cloud>/cancel. */
  cancelPlan(survey: unknown): Promise<CloudRenewalResult>;
  /** POST /api/cloud/desktop/clouds/<the session's own Cloud>/keep. */
  keepPlan(): Promise<CloudRenewalResult>;
  holdSignIns(items: Array<import("../shared/ai-signins.ts").AiSignIn>): Promise<CloudHeldSignIns>;
  /** POST /api/cloud/desktop/room: Not now on the room card for the session's own Cloud; false when it couldn't be said. */
  roomNotNow(id: string): Promise<boolean>;
  /** POST /api/cloud/desktop/resize-now: the bigger size after an upgrade goes at once. */
  restartNow(): Promise<"restarting" | "current" | "failed">;
  homeTarget(): { origin: string } | null;
  /** The Admin's last word on a Cloud whose plan sleeps; null for any other. */
  power(): import("./cloud-power.mjs").CloudPower | null;
  /** Asks the Admin to start a sleeping Cloud (POST /api/cloud/desktop/wake), then reads the session again. */
  wakeHome(intent: WakeIntent): Promise<"awake" | "waking" | "asleep" | null>;
  setWaking(on: boolean): void;
  /** My Cloud's one-time code, or (`cloudId`) another Cloud of the person's own that the verified session lists, its
   * grant for that Cloud's own address only. Rejects with `gone: true` once that Cloud is no longer theirs. */
  pairHome(cloudId?: string | null): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  /** `origin` is a Cloud the person owns (My Cloud or another of theirs), by the verified session only. */
  /** Main only: the account token while signed in, for its usage reports to the same origin. */
  eventToken(): string | null;
  isOwnCloud(origin: string | null | undefined): boolean;
  /** Buys another Cloud (POST /api/cloud/desktop/clouds): its checkout opens in the browser. */
  /** `source`: where the checkout started (CHECKOUT_SOURCES), for the Admin's funnel. */
  addCloud(input: { tier: string; interval?: "month" | "year"; name: string; color?: import("./cloud-list.mjs").CloudSwatch | null; source?: string | null }): Promise<CloudAddResult>;
  /** A new organization on the Team plan this account pays for (POST /api/cloud/desktop/organizations): no checkout. */
  addOrganization(input: { name: string; color?: import("./cloud-list.mjs").CloudSwatch | null }): Promise<OrganizationAddResult>;
  /** A Cloud's colour on the Admin (PATCH /api/cloud/desktop/clouds/:id), for its owner or its team's Super admin and Admins. */
  setCloudColor(cloudId: string, color: import("./cloud-list.mjs").CloudSwatch | null): Promise<{ outcome: "saved" | "refused" | "unsupported" | "failed" }>;
  /** Remove from list: one of the person's own Clouds the session says is `removable` leaves their list on the Admin. */
  hideCloud(cloudId: string): Promise<{ outcome: CloudRemoveOutcome }>;
  /** That checkout's page again (never a new one); false when none is kept. */
  reopenAdd(): Promise<boolean>;
  /** Main only (the clipboard): that checkout's page, or null. */
  addLink(): string | null;
  /** The Cloud being bought was opened or announced: that purchase is over. */
  addDone(): void;
  /** A one-time code for a team's Cloud, signed by the Admin with this person's membership (POST
   * /api/cloud/desktop/teams/<id>/pairing). Rejects with `gone: true` once they are no longer in the team. */
  pairTeam(teamId: string): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  /** A Cloud that ended and that the Admin still holds, started for its owner's export only. */
  exportHome(options?: { installation?: string }): Promise<{ starting: true } | { notHeld: true } | { deleted: true } | { grant: import("./cloud-home.mjs").CloudHomeGrant }>;
  /** Tells the Admin that this computer's move to My Cloud is done (POST /api/cloud/desktop/moved); false when it can't take it yet. */
  reportMove(options: { installation: string }): Promise<boolean>;
  /** This computer keeps its bots on itself again: it no longer counts as moved. False when the Admin can't take it yet. */
  reportKept(options: { installation: string }): Promise<boolean>;
  /** The Admin's word on this account's own Cloud at `origin` (POST /api/cloud/desktop/moved-to): deleted, ended (stopped and
   * kept only until it is deleted), live, or unknown (none of this account's). Null without a verified sign-in, or from an
   * Admin that doesn't say. */
  movedTo(origin: string): Promise<"deleted" | "ended" | "live" | "unknown" | null>;
  /** A backup of this account's own Cloud at `origin` now, once a move into it was checked (POST /api/cloud/desktop/backup). */
  requestBackup(origin: string): Promise<"started" | "not_managed" | null>;
  /** Tells the Admin where this computer's move to My Cloud stands (POST /api/cloud/desktop/move-status); false without a
   * sign-in or when the Admin doesn't take it yet. */
  reportMoveStatus(report: import("./move-status.mjs").MoveStatusReport): Promise<boolean>;
  growDisk(sizeGb: number): Promise<{ supported: false } | { supported: true; refused: true } | { supported: true; disk: { gb: number; maxGb: number } }>;
  /** This sign-in's own X research relay access while its plan is paid; null without one. */
  xResearchAccess(): Promise<{ url: string; token: string } | null>;
  pagesAccess(): Promise<{ url: string; token: string } | null>;
  /** Another account takes over: nothing more is asked or written for this sign-in. */
  quiesce(): void;
  /** Reads the sign-in saved in `store` afresh, keeping nothing of the one before. */
  reload(): Promise<CloudAccountState>;
  /** Ends a sign-in that waits on this device, at the Admin. */
  revokeSaved(record: unknown): Promise<void>;
  close(): void;
}
export declare function createCloudAccountClient(options: {
  store: CloudAccountStore;
  openBrowser(url: string): Promise<unknown>;
  platform: string;
  deviceName: string;
  appVersion?: string;
  origin?: string;
  /** Enables HTTP loopback only for isolated fixtures. Production main never sets it. */
  fixture?: boolean;
  custom?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (work: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onState?: (state: CloudAccountState) => void;
  /** Told once per plan name this app predates. Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Files or lending waits for a sleeping Cloud to wake: the session is read every 15 s. */
  awaitingWake?: () => boolean;
  /** This app owns duskbot:// (packaged): provider sign-in comes back through the link instead of a code to approve. */
  appLinks?: boolean;
}): CloudAccountClient;
export declare function cloudPlanSnapshot(state: CloudAccountState | null | undefined, extra?: { notice?: import("./cloud-home.mjs").CloudTrialState | null }): CloudPlanSnapshot;
/** My Cloud's line under its name in the server menus, or null for none. */
export declare function cloudMenuSublabel(state: CloudAccountState | null | undefined, date: (value: number) => string): string | null;

/** What a person did that may wake a sleeping Cloud (only `type`, `click` and `send` do). */
export type WakeIntent = "type" | "click" | "send" | "open" | "view";
export declare const WAKE_INTENTS: readonly WakeIntent[];
export declare const ACCOUNT_INTENT_KINDS: readonly ["signin", "upgrade", "billing"];
export declare function cleanAccountIntent(value: unknown): { kind: "signin" | "upgrade" | "billing"; plan?: "plus" | "pro"; source?: string; move?: string } | null;
