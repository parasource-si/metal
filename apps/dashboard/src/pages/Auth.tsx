import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, LoaderCircle } from "@/icons";
import type { AuthProviders, IdentityProvider } from "../data/contracts";
import { useSession } from "../data/session";
import { api, ApiError, FIXTURE, type Account } from "../lib/api";
import { appPath, Link, navigate, useLocation } from "../lib/router";
import { planIntent, planQuery, SITE_NAME, siteUrl } from "../lib/site";
import { ProviderMark, PROVIDER_NAME } from "../ui/BrandMarks";
import { APP_LANDING_PATH } from "../../../../shared/account-api.ts";
import { SplitFrame } from "../ui/Frame";
import { Button, cx } from "../ui/kit";
import { Mascot, useReducedMotion } from "../ui/Mascot";
import type { SceneHandle, SceneMood } from "../ui/Scene";

const REASON: Record<string, string> = {
  wrong_code: "that code doesn't match. check the newest email and try again.",
  expired: "that code expired. send a new one.",
  invalid_email: "that doesn't look like an email address.",
  sso: "your organization signs in through its own provider. sign in from the app instead.",
  two_factor: "this account uses two-step sign-in. sign in from the app instead.",
  signup_closed: "there's no account for this email, and new accounts aren't open yet.",
  device_limit: "this account is signed in on too many devices. sign out somewhere else and try again.",
  rate_limited: "too many tries. wait a minute, then try again.",
  offline: "can't reach Metal. check your connection and try again.",
};

const OAUTH: IdentityProvider[] = ["google", "apple"];
const SUPPORT = "hello@dusk.bot";
const LINK_ATTEMPT = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLOW_MS = 5000;
const PARTY_MS = 1100;

// ?error= after a provider sign-in that did not finish
const OAUTH_ERROR: Record<string, string> = {
  oauth_denied: "sign-in was cancelled at the provider. try again, or use your email.",
  oauth_failed: "the provider didn't finish signing you in. try again, or use your email.",
  oauth_expired: "that sign-in took too long. start again.",
  provider_unavailable: "that sign-in option isn't available right now. use your email instead.",
  signup_closed: "new accounts aren't open yet.",
  identity_taken: "that account is already linked to another Dusk Cloud account. sign in with it instead.",
};

type Mode = "signin" | "signup";
type Step = "start" | "code" | "recover" | "done";

const LINK = "text-link";
const QUIET = "text-link h-11 rounded-full px-2 text-14 disabled:opacity-50";

function Busy({ children }: { children: ReactNode }) {
  return <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />{children}</>;
}

/** the code as one box per digit over a single real input, so typing moves on by itself and a pasted or autofilled
 * code lands whole */
function CodeBoxes({ input, boxes, length, value, onChange, invalid, disabled, onFocus }: { input: RefObject<HTMLInputElement | null>; boxes: RefObject<HTMLDivElement | null>; length: number; value: string; onChange(v: string): void; invalid: boolean; disabled: boolean; onFocus(on: boolean): void }) {
  const [focused, setFocused] = useState(false);
  const at = Math.min(value.length, length - 1);
  const half = length >= 6 && length % 2 === 0 ? length / 2 : -1;
  return (
    <div className="relative">
      <div ref={boxes} className="flex gap-1.5" aria-hidden>
        {Array.from({ length }, (_, i) => (
          <span key={i} className={cx("num grid h-14 min-w-0 flex-1 place-items-center rounded-[14px] text-[22px] font-medium text-ink", invalid ? "bg-[color-mix(in_oklab,var(--bad)_9%,var(--btn))]" : "bg-btn", i === half && "ms-2.5", disabled && "opacity-60")}>
            {value[i] ?? (focused && i === at ? <i className="h-6 w-0.5 rounded-full bg-ink [animation:caret_1.1s_steps(1)_infinite]" /> : null)}
          </span>
        ))}
      </div>
      <input
        ref={input}
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        readOnly={disabled}
        value={value}
        onChange={(e) => { if (!disabled) onChange(e.target.value.replace(/\D/g, "").slice(0, length)); }}
        onFocus={() => { setFocused(true); onFocus(true); }}
        onBlur={() => { setFocused(false); onFocus(false); }}
        className="absolute inset-0 size-full cursor-text opacity-0"
        aria-invalid={invalid}
        aria-describedby={invalid ? "auth-error" : undefined}
      />
    </div>
  );
}

const CARD_ROWS: Array<[string, "blue" | "pink" | "orange", string, string]> = [
  ["kit", "blue", "see them work", "every bot, live, wherever it runs."],
  ["hearty", "pink", "keep them on", "dusk cloud runs your routines while you sleep."],
  ["boxo", "orange", "text them anywhere", "the same bots, from your phone."],
];

function SceneCard() {
  return (
    <>
      <p className="text-[30px] font-medium leading-[1.1] tracking-[-0.045em] text-ink">your bots, all in one place.</p>
      <ul className="mt-7 flex flex-col gap-5">
        {CARD_ROWS.map(([body, colour, title, line]) => (
          <li key={title} className="flex items-start gap-3.5">
            <Mascot body={body} color={colour} size={34} still />
            <span className="min-w-0"><b className="block text-15 font-[550] tracking-[-0.01em] text-ink">{title}</b><span className="block text-14 text-ink-2">{line}</span></span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** `forApp`: the desktop app sent the person here to sign in or make their account (its device sign-in), often someone new */
export function AuthScreen({ mode, note, forApp = false }: { mode: Mode; note?: ReactNode; forApp?: boolean }) {
  const { setAccount } = useSession();
  const { query } = useLocation();
  const reduced = useReducedMotion();
  const pending = query.get("pending");
  const next = query.get("next");
  const intent = planIntent(query);
  // signed out on a page like /cloud/desktop?code= or /claim: come back to it after signing in
  const here = ["/sign-in", "/signin", "/signup", "/welcome"].includes(appPath(window.location.pathname)) ? "/" : `${appPath(window.location.pathname)}${window.location.search}`;
  const home = intent ? `/welcome?${planQuery(intent)}` : next && next.startsWith("/") && !next.startsWith("//") ? next : here;
  // the one-time link of a "trouble signing in?" email: its code waits behind a click, so a mail scanner opening it signs nobody in
  const [linked] = useState(() => { const hash = new URLSearchParams(window.location.hash.slice(1)), a = hash.get("attempt") ?? query.get("attempt"), c = hash.get("code"); return a && LINK_ATTEMPT.test(a) && c && /^\d{8}$/.test(c) ? { attempt: a, code: c } : null; });
  const [step, setStep] = useState<Step>(linked ? "code" : "start");
  const [recovering, setRecovering] = useState(false);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState(linked?.code ?? "");
  const [length, setLength] = useState(linked ? linked.code.length : 6);
  const [attempt, setAttempt] = useState<string | null>(linked?.attempt ?? null);
  const [resendAt, setResendAt] = useState(0);
  const [busy, setBusy] = useState<IdentityProvider | null>(null);
  const [slow, setSlow] = useState(false);
  const [focused, setFocused] = useState(false);
  const [oops, setOops] = useState(0);
  const [error, setError] = useState<string | null>(() => OAUTH_ERROR[query.get("error") ?? ""] ?? null);
  const [providers, setProviders] = useState<AuthProviders["providers"] | null>(null);
  const [soon, setSoon] = useState<IdentityProvider | null>(null);
  const [, force] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const boxes = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const scene = useRef<SceneHandle>(null);
  const alive = useRef(true);
  const live = useRef({ step, attempt, recovering });
  live.current = { step, attempt, recovering };
  const signup = mode === "signup";
  const carry = intent ? `?${planQuery(intent)}` : "";

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { api.authProviders().then((r) => setProviders(r.providers), () => setProviders([])); }, []);
  useEffect(() => { if (linked) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`); }, [linked]);
  useEffect(() => { if (step === "code") codeRef.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== "code" || Date.now() >= resendAt) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [step, resendAt]);
  useEffect(() => {
    if (busy === null) { setSlow(false); return; }
    const id = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(id);
  }, [busy]);
  useEffect(() => {
    if (!oops) return;
    scene.current?.react("shake");
    if (!reduced) boxes.current?.animate?.([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], { duration: 360, easing: "ease-in-out" });
    const id = setTimeout(() => setOops(0), 1800);
    return () => clearTimeout(id);
  }, [oops, reduced]);
  // the browser's back button on the code step returns to the email, and forward goes back to the code
  useEffect(() => {
    const pop = () => {
      const marked = (window.history.state as { duskAuth?: string } | null)?.duskAuth === "code";
      const now = live.current;
      if (marked && now.attempt && now.step !== "done") setStep("code");
      else if (!marked && now.step === "code") { setStep(now.recovering ? "recover" : "start"); setError(null); }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const reason = (e: unknown) => (e instanceof ApiError && e.code && REASON[e.code]) || (e as Error).message || "sign-in didn't work. try again.";
  const fail = (e: unknown) => { setError(reason(e)); setOops((n) => n + 1); };
  const enabled = (p: IdentityProvider) => providers === null ? true : providers.some((x) => x.id === p && x.enabled);
  const toCode = () => {
    if ((window.history.state as { duskAuth?: string } | null)?.duskAuth !== "code") window.history.pushState({ ...(window.history.state as object | null), duskAuth: "code" }, "");
    setStep("code");
  };
  const leaveCode = () => {
    setStep(recovering ? "recover" : "start"); setError(null);
    if ((window.history.state as { duskAuth?: string } | null)?.duskAuth === "code") window.history.back();
  };

  const send = async (recover = recovering, again = false) => {
    const address = email.trim();
    if (!EMAIL.test(address)) { fail(new ApiError("", 400, "invalid_email")); (recover ? document.getElementById("recover-email") : emailRef.current)?.focus(); return; }
    // the same address again before a new code may go out: the one already sent still works
    if (!again && attempt && address === sentTo && Date.now() < resendAt && recover === recovering) { setError(null); toCode(); return; }
    setBusy("email"); setError(null);
    try {
      const r = await api.start(address, mode, recover ? undefined : pending ?? undefined, recover);
      if (!alive.current) return;
      setAttempt(r.attempt); setSentTo(address); setLength(r.codeLength || 6); setResendAt(Date.now() + r.resendAfter * 1000); setCode(""); toCode();
      if (again) codeRef.current?.focus();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const verify = async (value = code) => {
    if (!attempt) return;
    setBusy("email"); setError(null);
    try {
      const r = await api.verify(attempt, value.replace(/\D/g, ""));
      // a phone sign-in that needed an email goes back to the app with its one-time code
      if (r.redirect?.startsWith("duskbot://auth?")) { window.location.assign(r.redirect); return; }
      // the desktop app's sign-in that needed an email: the page that opens the app and says so
      if (r.redirect && new URL(r.redirect, window.location.origin).pathname.endsWith(APP_LANDING_PATH)) { window.location.assign(r.redirect); return; }
      // a brand-new account goes straight into onboarding, without the signed-in beat in between
      if (r.created) { navigate(home === "/" ? "/welcome" : home, { replace: true }); setAccount(r.account); return; }
      enter(r.account, home);
    }
    catch (e) { fail(e); setCode(""); codeRef.current?.focus(); if (e instanceof ApiError && e.code === "expired") setAttempt(null); }
    finally { setBusy(null); }
  };
  // a beat for the crew to celebrate, then in
  const enter = (account: Account, to: string) => {
    setStep("done");
    setTimeout(() => { if (!alive.current) return; navigate(to, { replace: true }); setAccount(account); }, reduced ? 200 : PARTY_MS);
  };
  const oauth = async (p: IdentityProvider) => {
    setError(null);
    // a provider without keys yet keeps its button and says so, instead of vanishing
    if (!enabled(p)) { setSoon(p); return; }
    setSoon(null);
    if (!FIXTURE) { window.location.assign(api.oauthUrl(p, mode, { next: home })); return; }
    // fixtures have no provider page to bounce through: sign the demo account in
    setBusy(p);
    try { const s = await api.start("sid@duskbot.test", mode); const r = await api.verify(s.attempt, "123456"); enter(r.account, intent ? home : "/"); }
    catch (e) { fail(e); } finally { setBusy(null); }
  };
  const wait = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  const mood: SceneMood = step === "done" ? "party" : oops ? "oops" : busy !== null ? "thinking" : step === "code" ? "waiting" : focused || (step === "recover" && email !== "") ? "typing" : "idle";
  const typed = (v: string) => { setEmail(v); setError(null); };
  const emailField = (id: string) => (
    <>
      <label htmlFor={id} className="mb-2 block text-14 text-ink-2">email</label>
      <input ref={id === "email" ? emailRef : undefined} id={id} type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required placeholder="you@example.com" value={email} onChange={(e) => typed(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} className="field !h-12" aria-invalid={Boolean(error)} aria-describedby={error ? "auth-error" : undefined} />
      {error && <p id="auth-error" role="alert" className="mt-2.5 text-14 text-bad">{error}</p>}
    </>
  );

  return (
    <SplitFrame
      mood={mood}
      scene={scene}
      card={<SceneCard />}
      aside={<a href={siteUrl()} className="text-link -me-2 inline-flex h-11 items-center gap-1.5 rounded-full px-2 text-14"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden />back to {SITE_NAME}</a>}
      foot={signup ? <>by continuing you agree to the <a href={siteUrl("/terms")} className={LINK}>terms</a> and <a href={siteUrl("/privacy")} className={LINK}>privacy policy</a>.</> : "your chats and files stay on your own computers."}
    >
      {step === "done" ? (
        <div key="done" className="step-in" role="status">
          <h1 className="t-title">you're signed in.</h1>
          <p className="mt-3 text-16 text-ink-2">taking you to your bots.</p>
        </div>
      ) : step === "start" ? (
        <div key="start" className="step-in">
          {intent && <p className="mb-4 flex items-center gap-2"><span className="tag !bg-lime !text-ink">{intent.plan === "starter" ? "plus" : "pro"} plan{intent.interval ? `, ${intent.interval}ly` : ""}</span><a href={siteUrl("/#pricing")} className={cx(LINK, "text-13")}>change</a></p>}
          <h1 className="t-title">{forApp ? "sign in or make your account." : signup ? "create your account." : "welcome back."}</h1>
          <p className="mt-3 text-16 text-ink-2">{forApp ? "new or returning, the same email works. the app signs in by itself when you're done." : intent ? "an account first, then checkout. your dusk cloud is ready in about a minute." : signup ? "free on your own computer. one account for the app, your phone and dusk cloud." : "sign in to see your bots, wherever they live."}</p>
          {note && <div className="mt-4 rounded-[16px] bg-lemon px-4 py-3 text-14 leading-[1.5] text-ink">{note}</div>}
          {pending && <div className="mt-4 rounded-[16px] bg-lemon px-4 py-3 text-14 leading-[1.5] text-ink">one more step: your provider didn't share an email, so enter the one you want to sign in with.</div>}
          <div className="mt-7 flex flex-col gap-2">
            {!pending && OAUTH.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void oauth(p)}
                disabled={busy !== null}
                aria-describedby={soon === p ? "auth-soon" : undefined}
                className="press hover-btn relative flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-btn text-15 font-medium text-ink disabled:opacity-45"
              >
                <span className="grid size-5 place-items-center text-ink"><ProviderMark provider={p} size={18} /></span>
                {busy === p ? "signing in" : `continue with ${PROVIDER_NAME[p].toLowerCase()}`}
              </button>
            ))}
            {soon && !pending && <p id="auth-soon" role="status" className="px-1 pt-1 text-14 text-ink-2">{PROVIDER_NAME[soon].toLowerCase()} sign-in is coming soon. use email{soon !== "google" && enabled("google") ? " or google" : ""} for now.</p>}
          </div>
          <div className={cx("t-meta my-5 flex items-center gap-3", pending && "hidden")} aria-hidden><span className="flex-1" />or<span className="flex-1" /></div>
          <form onSubmit={(e) => { e.preventDefault(); setRecovering(false); void send(false); }} noValidate>
            {emailField("email")}
            <Button type="submit" variant="primary" className="mt-3 w-full !h-12 !text-15" disabled={busy !== null || !email.trim()}>{busy === "email" ? <Busy>sending code</Busy> : "continue"}</Button>
          </form>
          {slow && <p role="status" className="mt-3 text-13 text-ink-3">still working. this connection is slow.</p>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 text-14 text-ink-3">
            <span>{signup ? <>already have an account? <Link to={`/signin${carry}`} className={LINK}>sign in</Link></> : <>don't have an account? <Link to={`/signup${carry}`} className={LINK}>sign up</Link></>}</span>
            {!signup && !pending && <button type="button" className={cx(QUIET, "-me-2")} onClick={() => { setStep("recover"); setError(null); }}>trouble signing in?</button>}
          </div>
        </div>
      ) : step === "recover" ? (
        <form key="recover" className="step-in" onSubmit={(e) => { e.preventDefault(); setRecovering(true); void send(true); }} noValidate>
          <h1 className="t-title">trouble signing in?</h1>
          <p className="mb-7 mt-3 text-16 text-ink-2">enter your email and we'll send you a sign-in link and a code.</p>
          {emailField("recover-email")}
          <Button type="submit" variant="primary" className="mt-3 w-full !h-12 !text-15" disabled={busy !== null || !email.trim()}>{busy === "email" ? <Busy>sending</Busy> : "send sign-in link"}</Button>
          <h2 className="mt-7 text-15 font-medium text-ink">can't access your email?</h2>
          <p className="mt-1 text-14 leading-[1.55] text-ink-3">if you signed up with google or apple, go back and continue with it. otherwise, email <a href={`mailto:${SUPPORT}`} className={LINK}>{SUPPORT}</a> with your receipt and we'll move your account to a new email.</p>
          <button type="button" className={cx(QUIET, "-ms-2 mt-3")} onClick={() => { setStep("start"); setError(null); }}>back to sign in</button>
        </form>
      ) : (
        <form key="code" className="step-in" noValidate onSubmit={(e) => { e.preventDefault(); if (attempt) void verify(); else void send(recovering, true); }}>
          <h1 className="t-title">{linked && !sentTo ? "your link is ready." : "check your email."}</h1>
          <p className="mt-3 text-16 text-ink-2">{linked && !sentTo ? "it signs you in once, and works for 10 minutes."
            : recovering ? <>if an account uses <span className="text-ink [overflow-wrap:anywhere]">{sentTo}</span>, we sent a link and {length === 8 ? "an" : "a"} {length}-digit code. it works for 10 minutes.</>
            : <>we sent {length === 8 ? "an" : "a"} {length}-digit code to <span className="text-ink [overflow-wrap:anywhere]">{sentTo}</span>. it works for 10 minutes.</>}</p>
          <label htmlFor="code" className="mb-2 mt-7 block text-14 text-ink-2">code</label>
          <CodeBoxes input={codeRef} boxes={boxes} length={length} value={code} invalid={Boolean(error)} disabled={busy !== null} onFocus={setFocused}
            onChange={(v) => {
              if (v.length > code.length) scene.current?.react("bounce", v.length - 1);
              setCode(v); setError(null);
              if (v.length === length && busy === null && attempt) void verify(v);
            }} />
          {error && <p id="auth-error" role="alert" className="mt-2.5 text-14 text-bad">{error}</p>}
          <Button type="submit" variant="primary" className="mt-3 w-full !h-12 !text-15" disabled={busy !== null || (attempt ? code.length !== length : !sentTo || wait > 0)}>{busy ? <Busy>{attempt ? "checking" : "sending"}</Busy> : !attempt ? <span className="num">{wait > 0 ? `resend code in ${wait} s` : "resend code"}</span> : signup ? "create account" : "sign in"}</Button>
          {slow && <p role="status" className="mt-3 text-13 text-ink-3">still working. this connection is slow.</p>}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button type="button" className={cx(QUIET, "-ms-2")} onClick={leaveCode}>use a different email</button>
            {attempt && <button type="button" className={cx(QUIET, "-me-2")} disabled={wait > 0 || busy !== null || !sentTo} onClick={() => void send(recovering, true)}><span className="num">{wait > 0 ? `resend code in ${wait} s` : "resend code"}</span></button>}
          </div>
        </form>
      )}
    </SplitFrame>
  );
}
