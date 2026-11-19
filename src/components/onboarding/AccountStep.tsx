// Signing in to a Dusk account, as one step of the first run: Google (and any other provider the account service
// offers) in the browser, or an emailed one-time code. The attempt and the token stay in main (funnel-account.ts).
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { phoneAppEnabled } from "@/lib/feature-flags";
import { Check, LoaderCircle } from "../../icons";
import { CodeBoxes, codeDigits } from "@/components/cloud-buy/CodeBoxes";
import { problemLine } from "@/components/cloud-buy/SignInScreen";
import type { CloudSignInProblem } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { t } from "@/lib/i18n";
import { accountSignIn, type AccountSignInMethod, type AccountSignInVia } from "@/lib/product-events";
import type { OAuthProvider } from "../../../shared/account-api";
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import type { FunnelAccount, FunnelAccountState } from "./funnel-account";
import { PRIMARY, QUIET, SECONDARY, StepArt, StepFrame, TILE } from "./FunnelSteps";

function GoogleMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

// the official marks, in the text colour: black on light, white on dark, as Apple's and X's guidelines ask
function AppleMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

const PROVIDER_MARK: Record<OAuthProvider, () => ReactElement> = { google: GoogleMark, apple: AppleMark };

const PROVIDER_LABEL: Record<OAuthProvider, Parameters<typeof t>[0]> = {
  google: "funnel.account.google", apple: "funnel.account.apple",
};

/** how often the account is read again while the website's first steps are open, beside main's own watch */
const WEBSITE_LOOK_MS = 4_000;

/** The shown sign-ins less any the service says it doesn't offer; the same array when nothing changes, so nothing redraws. */
export function refineProviders(shown: readonly OAuthProvider[], offered: readonly OAuthProvider[]): readonly OAuthProvider[] {
  const next = shown.filter((provider) => offered.includes(provider));
  return next.length === shown.length ? shown : next;
}

export function AccountStep({ account, known, onDone, onSkip }: {
  account: FunnelAccount;
  /** what main said last, kept by the flow so a signed-in person sees who they are */
  known: FunnelAccountState | null;
  onDone: () => void;
  /** continue without an account, where the app works without one */
  onSkip: (() => void) | null;
}) {
  const winCaption = useDesktopCapabilities().capabilities.windowChrome === "win-caption";
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  // every sign-in shows from the first frame; the service's own list only takes away one it doesn't offer
  const [providers, setProviders] = useState<readonly OAuthProvider[]>(account.initialProviders);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<Extract<CloudSignInStart, { outcome: "sent" }> | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<OAuthProvider | null>(null);
  const [magic, setMagic] = useState<string | null>(null);
  const [problem, setProblem] = useState<CloudSignInProblem | null>(null);
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const locked = useRef(false);
  // the funnel: the attempt under way (how), and whether this step already counted as shown or signed in
  const attempt = useRef<{ method: AccountSignInMethod; via: AccountSignInVia } | null>(null);
  const counted = useRef({ shown: false, returned: false });
  const begin = (method: AccountSignInMethod, via: AccountSignInVia) => { attempt.current = { method, via }; accountSignIn("method", attempt.current); };
  const fail = (next: CloudSignInProblem) => { setProblem(next); accountSignIn("error", { ...attempt.current, problem: next }); };
  const returned = () => {
    if (counted.current.returned) return;
    counted.current.returned = true;
    accountSignIn("returned", attempt.current ?? {});
  };
  const cancelled = () => { accountSignIn("cancelled", attempt.current ?? {}); attempt.current = null; };

  useEffect(() => {
    if (known?.signedIn || counted.current.shown) return;
    counted.current.shown = true;
    accountSignIn("shown");
  }, [known?.signedIn]);
  // a browser or magic-link sign-in comes back through main's state; only an attempt from this step counts
  useEffect(() => { if (known?.signedIn && attempt.current) returned(); });

  useEffect(() => {
    let alive = true;
    void account.providers().then((list) => {
      if (!alive) return;
      setProviders((shown) => (refineProviders(shown, list)));
    }, () => {});
    return () => { alive = false; };
  }, [account]);
  useEffect(() => { host.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus(); }, [sent]);
  // a new account takes the website's first steps (name, plan) before the app goes on: read again until they end
  const websiteOpen = known?.signedIn === true && known.website === "open";
  useEffect(() => {
    if (!websiteOpen || !account.refresh) return;
    const look = () => void account.refresh!().catch(() => {});
    const timer = setInterval(look, WEBSITE_LOOK_MS);
    window.addEventListener("focus", look);
    return () => { clearInterval(timer); window.removeEventListener("focus", look); };
  }, [websiteOpen, account]);
  useEffect(() => {
    if (!sent) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [sent]);

  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); } catch { fail("failed"); } finally { locked.current = false; setBusy(false); }
  };
  const send = () => run(async () => {
    if (!attempt.current || attempt.current.via !== "code") begin("email", "code");
    const result = await account.emailStart(email.trim());
    if (result.outcome === "sent") { setSent(result); setEmail(result.email); setCode(""); setNow(Date.now()); }
    else fail(result.outcome);
  });
  // a magic link: the website signs them in (or up), runs its first steps, and this app follows on its own
  const sendLink = () => run(async () => {
    const to = email.trim();
    begin("email", "link");
    await account.magicLink!(to);
    const now = await account.state();
    if (now.magic || now.browser) { setMagic(now.magic ?? to); accountSignIn("handoff", attempt.current!); } else fail("failed");
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sent && account.magicLink) { if (email.trim()) void sendLink(); return; }
    if (!sent) { if (email.trim()) void send(); return; }
    if (code.length !== 8) return;
    void run(async () => {
      const result = await account.emailVerify(code);
      if (result.outcome === "signed-in") { returned(); onDone(); }
      else { fail(result.outcome); setTriesLeft(result.outcome === "wrong-code" ? result.triesLeft : null); }
    });
  };

  if (websiteOpen) {
    return (
      <StepFrame art={<StepArt art="key" />} title={t("funnel.account.websiteTitle")} sub={t("funnel.account.website")}
        footer={<>
          <p role="status" data-funnel-account-website="" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
            <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />{t("funnel.account.waiting")}
          </p>
          {account.reopenWebsite && (
            <button type="button" data-funnel-account-website-again="" className={cn(SECONDARY, "mt-2")} disabled={busy}
              onClick={() => void run(async () => { await account.reopenWebsite!(); })}>{t("funnel.account.websiteAgain")}</button>
          )}
          {account.signOut && (
            <button type="button" data-funnel-account-switch="" className={cn(QUIET, "disabled:opacity-40")} disabled={busy}
              onClick={() => void run(async () => { await account.signOut!(); })}>{t("funnel.account.switch")}</button>
          )}
          {problem && <p role="alert" className="text-center text-[13px] leading-[18px] text-danger">{problemLine(problem, null)}</p>}
        </>} />
    );
  }

  if (known?.signedIn) {
    return (
      <StepFrame art={<span className="place-mark grid size-14 place-items-center rounded-full bg-success/10 text-success"><Check size={26} aria-hidden="true" /></span>}
        title={t("funnel.account.signedInTitle")}
        sub={known.email ? t("funnel.account.signedIn", { email: known.email }) : undefined}
        footer={<>
          <button type="button" data-primary="" autoFocus onClick={onDone} disabled={busy} className={PRIMARY}>{t("funnel.next")}</button>
          {account.signOut && (
            <button type="button" data-funnel-account-switch="" className={cn(QUIET, "mt-2 disabled:opacity-40")} disabled={busy}
              onClick={() => void run(async () => { await account.signOut!(); })}>{t("funnel.account.switch")}</button>
          )}
          {problem && <p role="alert" className="text-center text-[13px] leading-[18px] text-danger">{problemLine(problem, null)}</p>}
        </>} />
    );
  }

  // a browser sign-in still under way is left to finish, so it lands if they come back to it
  const skip = onSkip && (() => { accountSignIn("skipped", attempt.current ?? {}); onSkip(); });

  const waitingFor = magic ?? known?.magic ?? null;
  if (waitingFor && known?.signedIn !== true) {
    return (
      <StepFrame art={<StepArt art="key" />} title={t("funnel.account.magicTitle")} sub={t("funnel.account.magic", { email: waitingFor })}
        footer={<>
          <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
            <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />{t("funnel.account.magicWaiting")}
          </p>
          {skip && <button type="button" data-funnel-account-without="" onClick={skip} className={cn(SECONDARY, "mt-2")}>{t("funnel.account.without")}</button>}
          <button type="button" className={QUIET} onClick={() => { cancelled(); void account.cancelBrowser().catch(() => {}).finally(() => setMagic(null)); }}>{t("funnel.cancel")}</button>
        </>} />
    );
  }

  if (browser) {
    return (
      <StepFrame art={<StepArt art="key" />} title={t("funnel.account.browserTitle")} sub={t("funnel.account.browser")}
        footer={<>
          <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
            <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />{t("funnel.account.waiting")}
          </p>
          {skip && <button type="button" data-funnel-account-without="" onClick={skip} className={cn(SECONDARY, "mt-2")}>{t("funnel.account.without")}</button>}
          <button type="button" className={QUIET} onClick={() => { cancelled(); void account.cancelBrowser().catch(() => {}).finally(() => setBrowser(null)); }}>{t("funnel.cancel")}</button>
        </>} />
    );
  }

  return (
    // my-auto: centred in the step's pane like the steps that are a StepFrame alone
    <div ref={host} className="my-auto w-full pb-16">
      {/* top right, quiet: on Windows it stays left of the caption buttons */}
      {skip && (
        <button type="button" data-funnel-account-skip="" onClick={skip}
          className={cn("fixed top-0 z-20 flex h-14 items-center px-2 text-[13px] text-ink-tertiary/60 transition-colors hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none", winCaption ? "end-[148px]" : "end-4")}>
          {t("funnel.account.skip")}
        </button>
      )}
      <StepFrame art={<StepArt art="key" />} title={t("funnel.account.title", { app: "Dusk" })} sub={t(sent ? "funnel.account.codeSub" : phoneAppEnabled() ? "funnel.account.sub" : "funnel.account.subNoPhone", { email: sent?.email ?? "" })}
>
        <div className="flex w-full max-w-[320px] flex-col gap-3">
          {!sent && providers.length > 0 && (
            <>
              {providers.map((provider) => (
                <button key={provider} type="button" data-funnel-provider={provider} disabled={busy}
                  onClick={() => void run(async () => {
                    begin(provider, "browser");
                    setBrowser(provider);
                    try { await account.browser(provider); } catch (cause) { setBrowser(null); throw cause; }
                    accountSignIn("handoff", { method: provider, via: "browser" });
                  })}
                  className={cn(TILE, "flex min-h-11 w-full items-center justify-center gap-2.5 px-5 text-[14px] text-ink disabled:opacity-50")}>
                  {(() => { const Mark = PROVIDER_MARK[provider]; return <Mark />; })()}
                  {t(PROVIDER_LABEL[provider])}
                </button>
              ))}
              <p className="py-1 text-center text-[12px] leading-4 text-ink-tertiary">{t("funnel.account.or")}</p>
            </>
          )}
          <form onSubmit={submit} noValidate className="flex flex-col gap-3 text-start">
            {!sent ? (
              <>
                <label htmlFor={`${id}-email`} className="sr-only">{t("funnel.account.email")}</label>
                <input id={`${id}-email`} data-autofocus type="email" inputMode="email" autoComplete="email" spellCheck={false} disabled={busy}
                  value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("funnel.account.emailPlaceholder")}
                  aria-invalid={problem === "invalid-email" || undefined} aria-describedby={problem ? `${id}-problem` : undefined}
                  className="h-11 w-full rounded-xl bg-ink/[0.035] px-4 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 motion-reduce:transition-none" />
              </>
            ) : (
              <>
                <p id={`${id}-code`} className="sr-only">{t("funnel.account.codeLabel")}</p>
                <CodeBoxes code={code} onCode={(value) => setCode(codeDigits(value))} busy={busy} wrong={problem === "wrong-code"} labelId={`${id}-code`} problemId={problem ? `${id}-problem` : undefined} />
              </>
            )}
            <button type="submit" data-primary="" disabled={busy || (sent ? code.length !== 8 : !email.trim())} className={cn(PRIMARY, "w-full")}>
              {busy ? t("funnel.account.checking") : sent ? t("funnel.account.verify") : t(account.magicLink ? "funnel.account.sendLink" : "funnel.account.send")}
            </button>
            {sent && (
              <div className="flex items-center justify-center gap-1">
                <button type="button" className={QUIET} disabled={busy} onClick={() => void run(async () => { cancelled(); await account.emailCancel(); setSent(null); setCode(""); })}>{t("funnel.account.change")}</button>
                <button type="button" className={cn(QUIET, "disabled:opacity-40")} disabled={busy || (problem !== "expired" && now < sent.resendAt)} onClick={() => void send()}>{t("funnel.account.resend")}</button>
              </div>
            )}
            {problem && <p id={`${id}-problem`} role="alert" className="text-center text-[13px] leading-[18px] text-danger">{problemLine(problem, triesLeft)}</p>}
          </form>
        </div>
      </StepFrame>
    </div>
  );
}
