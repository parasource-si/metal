import { useEffect, useState, type FormEvent } from "react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { openExternalLink } from "@/lib/app-links";
import { copyText } from "@/lib/copy-text";
import { tokenApp, type TokenAppId, type TokenField } from "../../../shared/app-tokens";
import { KitActions, KitBody, KitButton, KitCard, KitRow, KitStatus, KitText } from "./detail-kit";
import { StepGuide, type GuideStep } from "./StepGuide";
import type { TokenApps } from "./use-token-apps";

const FIELD_LABEL: Record<TokenField["key"], LocaleKey> = {
  token: "tokenApps.field.token", key: "tokenApps.field.key", email: "tokenApps.field.email", site: "tokenApps.field.site", shop: "tokenApps.field.shop",
};

/** One app connected with the person's own token or a sign-in to Metal's own app: its accounts, then a guide.
 * `preferToken` picks the token steps over a ready sign-in; the page's other ways switch it. */
export function TokenCard({ app, tokens, replacing: startReplacing, preferToken = false }: { app: TokenAppId; tokens: TokenApps; replacing?: string; preferToken?: boolean }) {
  const spec = tokenApp(app)!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  // the refused account a new token takes over, so bots keep their access to it
  const [replacing, setReplacing] = useState<string | undefined>(startReplacing);
  const accounts = tokens.accounts(app);
  const nativeReady = spec.native === true && tokens.status?.native[app] === true;
  const flow = tokens.device?.app === app ? tokens.device : null;
  const replaced = replacing !== undefined && tokens.status !== null && !accounts.some((account) => account.id === replacing);
  useEffect(() => {
    if (!replaced) return;
    setReplacing(undefined);
    setJustConnected(true);
  }, [replaced]);
  // switching ways means connecting that way now: its steps show, even beside accounts already there
  const [shownWay, setShownWay] = useState(preferToken);
  if (shownWay !== preferToken) {
    setShownWay(preferToken);
    setError(null);
    if (accounts.length > 0) setAdding(true);
  }
  const guiding = accounts.length === 0 || adding || flow !== null || replacing !== undefined;
  const byToken = spec.fields.length > 0 && (!nativeReady || preferToken);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const problem = await tokens.connect(app, values, replacing);
    setBusy(false);
    if (problem) { setError(problem); return; }
    setValues({});
    setAdding(false);
    setReplacing(undefined);
    setOpened(false);
    setJustConnected(true);
  };
  const signIn = async (replaces = replacing) => {
    setError(null);
    setJustConnected(false);
    const problem = await tokens.startDevice(app, replaces);
    if (problem) setError(problem);
  };
  const reconnect = (id: string) => {
    setReplacing(id);
    setAdding(false);
    if (nativeReady && !preferToken) void signIn(id);
  };
  const filled = spec.fields.every((field) => values[field.key]?.trim());

  const tokenSteps: GuideStep[] = !spec.fields.length ? [] : [
    { key: "open", text: t("tokenApps.line.open", { name: spec.label }), done: opened || filled,
      action: <KitButton onClick={() => { setOpened(true); void openExternalLink(spec.settingsUrl); }}>{t("tokenApps.openApp", { name: spec.label })}</KitButton> },
    { key: "make", text: t(`tokenApps.how.${app}` as LocaleKey), done: filled },
    { key: "paste", text: t("tokenApps.line.paste"), done: false,
      action: (
        <form data-token-form="" className="ca-guide-action" onSubmit={(event) => void submit(event)}>
          {spec.fields.map((field) => (
            <input key={field.key} aria-label={t(FIELD_LABEL[field.key])} type={field.secret ? "password" : "text"} autoComplete="off" spellCheck={false} dir="ltr"
              placeholder={t(FIELD_LABEL[field.key])} value={values[field.key] ?? ""} aria-invalid={error ? true : undefined}
              onChange={(event) => { setValues((now) => ({ ...now, [field.key]: event.target.value })); setError(null); setOpened(true); }} />
          ))}
          <KitButton type="submit" disabled={busy || !filled} aria-busy={busy || undefined}>{busy ? t("tokenApps.checking") : t("connectors.action.connect")}</KitButton>
        </form>
      ) },
  ];
  const nativeSteps: GuideStep[] = [
    { key: "sign-in", text: t("tokenApps.line.signIn", { name: spec.label }), done: flow !== null,
      action: <KitButton disabled={!nativeReady} onClick={() => void signIn()}>{t("tokenApps.signIn", { name: spec.label })}</KitButton> },
    flow?.start.userCode
      ? { key: "code", text: t("tokenApps.line.code", { name: spec.label }), done: false,
        action: (
          <>
            <span className="ca-token-code" data-device-code="">{flow.start.userCode}</span>
            <KitButton onClick={() => void openExternalLink(flow.start.verificationUrl)}>{t("tokenApps.device.open", { name: spec.label })}</KitButton>
            <KitButton variant="secondary" onClick={() => void copyText(flow.start.userCode!)}>{t("tokenApps.device.copy")}</KitButton>
          </>
        ) }
      : { key: "finish", text: t("tokenApps.line.finish", { name: spec.label }), done: false,
        action: flow ? <KitButton variant="secondary" onClick={() => void openExternalLink(flow.start.verificationUrl)}>{t("tokenApps.device.openAgain")}</KitButton> : undefined },
  ];

  return (
    <KitBody data-token-app={app}>
      {accounts.length > 0 && (
        <div className="ca-kit-card">
          <KitCard label={t("connectApps.accounts")} count={accounts.length}>
            {accounts.map((account) => (
              <KitRow key={account.id} title={<>{account.label}{account.needsReconnect && <span className="ca-account-tag" data-needs-reconnect="">{t("connectApps.account.needsReconnect")}</span>}</>}
                detail={t(account.via === "device" ? "tokenApps.viaDevice" : "tokenApps.viaToken")}>
                {account.needsReconnect && replacing !== account.id && (
                  <button type="button" className="ca-pill" data-size="sm" aria-label={t("connectors.reconnectAria", { account: account.label, service: spec.label })} onClick={() => reconnect(account.id)}>
                    <span>{t("connectors.action.reconnect")}</span>
                  </button>
                )}
                <button type="button" className="ca-link" data-tone="danger" aria-label={t("tokenApps.disconnect", { name: account.label })} onClick={() => void tokens.remove(account.id)}>
                  {t("connectors.disconnect")}
                </button>
              </KitRow>
            ))}
          </KitCard>
        </div>
      )}
      {guiding && (
        <StepGuide label={t("tokenApps.guide", { name: spec.label })} steps={byToken ? tokenSteps : nativeSteps} />
      )}
      {error && <KitStatus tone="danger">{error}</KitStatus>}
      {flow && flow.state === "waiting" && <KitStatus>{t("tokenApps.device.waiting")}</KitStatus>}
      {flow && flow.state === "failed" && <KitStatus tone="danger">{flow.message ?? t("tokenApps.device.expired")}</KitStatus>}
      {(flow || replacing) && <KitActions><KitButton variant="secondary" onClick={() => { tokens.stopDevice(); setReplacing(undefined); }}>{t("common.cancel")}</KitButton></KitActions>}
      {spec.native && !nativeReady && !byToken && <KitStatus>{t("tokenApps.device.notReady")}</KitStatus>}
      {justConnected && accounts.length > 0 && !guiding && (
        <StepGuide label={t("tokenApps.guide", { name: spec.label })} steps={[]} finished={t("tokenApps.done", { name: spec.label })} />
      )}
      {accounts.length > 0 && !guiding && (
        <KitActions>
          <KitButton variant="secondary" onClick={() => { setAdding(true); setError(null); setJustConnected(false); }}>{t("tokenApps.addAnother")}</KitButton>
        </KitActions>
      )}
      <KitText>{t("tokenApps.free")}</KitText>
    </KitBody>
  );
}

/** Gmail without a review: the steps to a personal account's app password, on top; the built-in email form under them
 * takes it. Once connected the form's account list says so, and the steps step aside. */
export function GmailPasswordNote({ connected }: { connected?: boolean }) {
  const [opened, setOpened] = useState(false);
  if (connected) return null;
  return (
    <KitBody data-gmail-password="">
      <StepGuide label={t("tokenApps.guide", { name: "Gmail" })} steps={[
        { key: "open", text: t("tokenApps.gmail.step1"), done: opened,
          action: <KitButton onClick={() => { setOpened(true); void openExternalLink("https://myaccount.google.com/apppasswords"); }}>{t("tokenApps.gmail.make")}</KitButton> },
        { key: "copy", text: t("tokenApps.gmail.step2") },
        { key: "paste", text: t("tokenApps.gmail.step3") },
      ]} />
    </KitBody>
  );
}
