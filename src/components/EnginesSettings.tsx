import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "../icons";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineCard, EngineSections, RefreshEngines, engineReady } from "./EngineLibrary";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ApiKeyEngineManage, EngineSetup, EngineUpdateNotice, EngineWarningNotice, isApiKeyEngine } from "./EngineSetup";
import { AppCopyNotice } from "./EngineAppCopy";
import { forgetAppCopySwitches } from "@/state/engine-install";
import { AccountsCard, AddAccount, accountGroupOf, accountsReady, type AccountGroup } from "./EngineAccounts";
import { DEVICE_SIGN_IN_COPY, deviceSignInProvider } from "./DeviceSignIn";
import { AntigravityFreeSpace } from "./AntigravityFreeSpace";
import { CacheKeepWarmSettings } from "./CacheKeepWarmSettings";
import { ConfirmDialog } from "./ConfirmDialog";
import { PixelIcon } from "./ui/PixelIcon";
import { Select } from "./Select";
import { Card, FormDialog, FormField, ItemRow, NavRow, NoteRow, useSubPage } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { InstanceProviderMark } from "./ProviderIcons";
import { OtherOpenAiCompatServers } from "./OpenAiCompatServers";
import { friendlyError } from "@/lib/plain-error";

const RowsCard = Card;

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

function CustomPicker({ instance, cliDefault, onClose, onSaved }: {
  instance: InstanceInfo;
  cliDefault?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // Starts empty: a select whose value names a missing option shows the placeholder yet still holds that value.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving;

  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value;
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: committed }),
    })
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        if (result.ok) persist();
      })
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setProbing(false));
  };

  // a failed test can still be kept: the dialog's Save becomes Save anyway, and editing the path clears the verdict
  const failed = probe !== null && !probe.ok;
  return (
    <FormDialog
      data-panel-modal="engine-cli"
      title={t("engines.setCli")}
      description={t("settings.s2.engine.setCliNote")}
      width={460}
      saveLabel={failed ? t("engines.saveAnyway") : t("common.save")}
      canSave={Boolean(value) && dirty}
      busy={busy}
      error={error ?? (failed && probe?.message ? t("engines.testFailed", { message: probe.message }) : undefined)}
      onSave={failed ? persist : save}
      onClose={onClose}
    >
      {candidates !== null && candidates.length > 0 && (
        <FormField label={t("settings.s2.engine.detected")}>
          <Select
            className="w-full font-mono"
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={t("engines.detectedAria", { name: instance.displayName })}
            disabled={busy}
          >
            <option value="">{t("engines.selectBinary")}</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
        </FormField>
      )}
      <FormField label={t("settings.s2.engine.binaryPath")}>
        <input
          type="text"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder={candidates?.length ? t("engines.manualPath") : "/absolute/path/to/cli"}
          aria-label={t("engines.customAria", { name: instance.displayName })}
          spellCheck={false}
          disabled={busy}
          className={cn(textFieldCls, "font-mono text-[12px] placeholder:font-sans")}
        />
      </FormField>
      {probe?.ok && probe.version && <p role="status" className="m-0 text-[12px] leading-4 text-success">{t("engines.testPassed", { version: probe.version })}</p>}
    </FormDialog>
  );
}

/** The executable behind an engine: its path, Claude's self-update, and a reset to the default. */
function EngineAdvanced({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatedVersion, setUpdatedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const reset = () => {
    if (switching || updating) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setSwitching(false));
  };

  const updateClaude = () => {
    if (switching || updating) return;
    setUpdating(true);
    setUpdatedVersion(null);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(async ({ version }: { version: string }) => {
        setUpdatedVersion(version);
        await Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setUpdating(false));
  };

  const path = instance.cli ?? instance.cliDefault;
  return (
    <RowsCard label={t("engines.library.advanced")}>
      <ItemRow title={t("settings.s2.engine.program")} hint={[path, instance.snapshot.version].filter(Boolean).join(" · ") || t("settings.s2.engine.programDefault")}>
        {instance.driverKind === "claudeAgent" && (
          <button type="button" className="ui-button" onClick={updateClaude} disabled={switching || updating}>
            {updating ? t("engines.updating") : t("engines.updateClaude")}
          </button>
        )}
        {instance.cli && (
          <button type="button" className="ui-button" onClick={reset} disabled={switching || updating}>
            {switching ? t("engines.resetting") : t("engines.reset")}
          </button>
        )}
      </ItemRow>
      <NavRow data-settings-open="engine-cli" title={t("engines.setCli")} hint={t("settings.s2.engine.setCliHint")} disabled={updating} onClick={() => setOpen(true)} />
      {updatedVersion && <NoteRow>{t("engines.claudeUpdated", { version: updatedVersion })}</NoteRow>}
      {error && <NoteRow tone="danger">{error}</NoteRow>}
      {open && (
        <CustomPicker
          instance={instance}
          cliDefault={instance.cliDefault}
          onClose={() => setOpen(false)}
          onSaved={refreshInstances}
        />
      )}
    </RowsCard>
  );
}

/** Remove drops an added account; Sign out forgets a signed-in account's Google sign-in, the first one too. */
function AntigravityAccountAction({ instance, action }: { instance: InstanceInfo; action: "remove" | "signOut" }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = action === "remove";
  const usedBy = remove ? state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId).length : 0;
  const label = t(remove ? "accounts.remove" : "accounts.signOut");
  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setError(null);
    try {
      const path = `/api/instances/${encodeURIComponent(instance.instanceId)}${remove ? "" : "/auth/sign-out"}`;
      const { instances } = await api(path, { method: remove ? "DELETE" : "POST" });
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      else await refreshInstances();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setRunning(false);
    }
  };
  return <>
    <ItemRow title={instance.displayName}
      hint={usedBy > 0 ? t("accounts.inUse", { count: String(usedBy) }) : undefined}>
      <button type="button" className={remove ? "ui-button ui-button-danger" : "ui-button"} disabled={running || usedBy > 0} onClick={() => setConfirming(true)}>
        {running ? <Loader2 size={13} className="animate-spin" /> : label}
      </button>
    </ItemRow>
    {error && <NoteRow tone="danger">{error}</NoteRow>}
    <ConfirmDialog open={confirming} art={<PixelIcon name="key" size={28} />} title={t(remove ? "accounts.removeTitle" : "accounts.signOutTitle", { name: instance.displayName })}
      body={t(remove ? "confirm.accountRemove" : "confirm.signOut")}
      confirmLabel={label} tone="neutral" pending={running} onCancel={() => { if (!running) setConfirming(false); }} onConfirm={() => void run()} />
  </>;
}

/** A provider Metal found here by itself: it is offered, never used, until the person says so. */
export function FoundProvider({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!instance.found) return null;
  const use = () => {
    setBusy(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ chosen: true }) })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setBusy(false));
  };
  return (
    <RowsCard>
      <ItemRow title={t("engines.found.title")} hint={t("engines.found.hint", { name: instance.displayName })}>
        <button type="button" className="ui-button ui-button-primary" data-use-found={instance.instanceId} disabled={busy} onClick={use}>
          {busy ? t("engines.found.using") : t("engines.found.use")}
        </button>
      </ItemRow>
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </RowsCard>
  );
}

/** Out of every list and every automatic choice until Reconnect; bots on it move to another AI. Where Metal can sign
 * out of it, Disconnect does that too, so a signed-in app on this computer cannot bring it back; Keep sign-in only hides it. */
export function DisconnectProvider({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (instance.readOnly) return null;
  const path = `/api/instances/${encodeURIComponent(instance.instanceId)}`;
  const signsOut = instance.authentication?.signOut === true && instance.snapshot.authenticated === true;
  const disconnect = async (signOut: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (signOut) await api(`${path}/auth/sign-out`, { method: "POST" });
      await api(path, { method: "PATCH", body: JSON.stringify({ hidden: true }) });
      setConfirming(false);
      await Promise.resolve(refreshInstances()).catch(() => {});
    } catch (cause) {
      setConfirming(false);
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <RowsCard>
      <ItemRow title={t("engines.disconnect")} hint={t("engines.disconnectHint")}>
        <button type="button" className="ui-button" data-disconnect-engine={instance.instanceId} disabled={busy} onClick={() => setConfirming(true)}>
          {t("engines.disconnect")}
        </button>
      </ItemRow>
      {error && <NoteRow tone="danger">{error}</NoteRow>}
      <ConfirmDialog open={confirming} title={t("engines.disconnectTitle", { name: instance.displayName })}
        body={t(signsOut ? "engines.disconnectSignOutBody" : "engines.disconnectBody", { name: instance.displayName })}
        confirmLabel={t("engines.disconnect")} tone="neutral" pending={busy}
        alternative={signsOut ? { label: t("engines.disconnectKeepSignIn"), onClick: () => void disconnect(false) } : undefined}
        onCancel={() => { if (!busy) setConfirming(false); }} onConfirm={() => void disconnect(signsOut)} />
    </RowsCard>
  );
}

function EngineRow({ instance, bare = false }: { instance: InstanceInfo; bare?: boolean }) {
  const policy = instance.policy && <NoteRow><span className="text-ink">{t("policy.managedBy", { organization: instance.policy.organizationName })}</span> · {instance.policy.reason}</NoteRow>;
  if (instance.readOnly) return <EngineCard instance={instance} bare={bare}>
    <RowsCard>
      {policy}
      <NoteRow>{t("organization.managedEngine")}</NoteRow>
      {!engineReady(instance) && <NoteRow>{t("organization.engineUnavailable")}</NoteRow>}
    </RowsCard>
  </EngineCard>;

  const signedIn = engineReady(instance) && instance.snapshot.authenticated === true && (
    instance.authentication?.method === "device-code" ? t(DEVICE_SIGN_IN_COPY[deviceSignInProvider(instance.driverKind)].connectedAccount)
      : instance.authentication?.method === "paste-code" ? t("engineSetup.claude.connectedAccount") : null);
  return (
    <EngineCard instance={instance} bare={bare}>
      <FoundProvider instance={instance} />
      {policy && <RowsCard>{policy}</RowsCard>}
      {!engineReady(instance) && <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} unframed rows={bare} />}
      {engineReady(instance) && <ApiKeyEngineManage instance={instance} />}
      {/* The setup panel that first said so is gone once the engine is Ready. */}
      {engineReady(instance) && <AppCopyNotice instance={instance} />}
      {(signedIn || instance.snapshot.update || instance.snapshot.warning) && (
        <RowsCard>
          {signedIn && <ItemRow title={signedIn} value={<Check size={13} className="text-success" aria-label={t("onboarding.engines.ready")} />} />}
          {instance.snapshot.update && <EngineUpdateNotice update={instance.snapshot.update} instance={instance} quiet rows />}
          {instance.snapshot.warning && <EngineWarningNotice warning={instance.snapshot.warning} rows />}
        </RowsCard>
      )}
      {instance.freeUpSpace && <AntigravityFreeSpace instance={instance} />}
      {instance.driverKind === "antigravityAgent" && (
        <RowsCard>
          {instance.snapshot.authenticated && <ItemRow title={instance.snapshot.account?.email ?? t("engineSetup.antigravity.emailUnavailable")} />}
          <AddAccount label={t("engineSetup.antigravity.addAccount")} endpoint="/api/instances/antigravity-accounts" extra={{ sourceInstanceId: instance.instanceId }} onAdded={() => {}} />
          {instance.snapshot.authenticated === true && instance.authentication?.signOut === true && <AntigravityAccountAction instance={instance} action="signOut" />}
          {instance.instanceId.startsWith("antigravity-") && <AntigravityAccountAction instance={instance} action="remove" />}
        </RowsCard>
      )}
      <EngineAdvanced instance={instance} />
      <DisconnectProvider instance={instance} />
    </EngineCard>
  );
}

function simpleStatus(instance: InstanceInfo, ready: boolean): string {
  const email = instance.snapshot.authenticated === true ? instance.snapshot.account?.email : undefined;
  if (ready && instance.found) return t("engines.found.status");
  if (ready) return email ? t("settings.simple.ai.connectedAs", { email }) : t("settings.simple.ai.connected");
  return t("settings.simple.ai.connect");
}

const CUSTOM_PROVIDER_PAGE = "custom-provider";

function SimpleEngines({ rows, isReady, renderEngine, more }: {
  rows: InstanceInfo[];
  isReady: (instance: InstanceInfo) => boolean;
  renderEngine: (instance: InstanceInfo, bare?: boolean) => ReactNode;
  more: { id: string; open: boolean; onToggle: () => void };
}) {
  const { at, open } = useSubPage();
  const featured = rows.filter((instance) => isReady(instance) || instance.authentication !== undefined);
  const others = rows.filter((instance) => !featured.includes(instance));
  const shown = at?.startsWith("engine:") ? rows.find((instance) => `engine:${instance.instanceId}` === at) : undefined;
  if (shown) return <div data-simple-engine={shown.instanceId} className="flex flex-col gap-5">{renderEngine(shown, true)}</div>;
  if (at === CUSTOM_PROVIDER_PAGE) return <Card><div className="px-2 py-1.5"><OtherOpenAiCompatServers /></div></Card>;
  // the panel's row: the provider's mark and name, its status on the right, a chevron to its page
  const row = (instance: InstanceInfo) => (
    <NavRow
      key={instance.instanceId}
      data-panel-page={`engine:${instance.instanceId}`}
      title={<span className="flex min-w-0 items-center gap-2.5"><span aria-hidden="true" className="flex shrink-0"><InstanceProviderMark instance={instance} size={16} /></span><span className="truncate">{instance.displayName}</span></span>}
      value={simpleStatus(instance, isReady(instance))}
      onClick={() => open(`engine:${instance.instanceId}`, instance.displayName)}
    />
  );
  if (at === "more-engines") return <Card>{others.map(row)}</Card>;
  void more;
  return (
    <>
      <Card label={t("settings.simple.ai.yours")} action={<RefreshEngines />}>
        {featured.map(row)}
        {others.length > 0 && (
          <NavRow data-panel-page="more-engines" title={t("settings.simple.ai.more", { count: String(others.length) })}
            onClick={() => open("more-engines", t("settings.simple.ai.more", { count: String(others.length) }))} />
        )}
        <NavRow data-panel-page={CUSTOM_PROVIDER_PAGE} title={t("settings.simple.ai.custom")}
          onClick={() => open(CUSTOM_PROVIDER_PAGE, t("settings.simple.ai.custom"))} />
      </Card>
      <HiddenEngines />
    </>
  );
}

/** Providers someone disconnected: listed apart, each one click from coming back. */
export function HiddenEngines() {
  const { state, refreshInstances } = useStore();
  const [hidden, setHidden] = useState<Array<{ instanceId: string; displayName: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // An older server has no such route: nothing is hidden there.
    api<{ instances?: Array<{ instanceId: string; displayName: string }> } | undefined>("/api/instances/hidden")
      .then((result) => { if (alive) setHidden(Array.isArray(result?.instances) ? result.instances : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [state.instances]);
  if (hidden.length === 0) return null;
  const unhide = (instanceId: string) => {
    setBusy(instanceId);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", body: JSON.stringify({ hidden: false }) })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setBusy(null));
  };
  return (
    <div data-hidden-engines="" className="contents"><Card label={t("engines.disconnected.title", { count: String(hidden.length) })} footnote={t("engines.disconnected.hint")}>
      {hidden.map((entry) => (
        <ItemRow key={entry.instanceId} title={entry.displayName}>
          <button type="button" className="ui-button" data-unhide-engine={entry.instanceId} disabled={busy !== null} onClick={() => unhide(entry.instanceId)}>
            {busy === entry.instanceId ? t("engines.reconnecting") : t("engines.reconnect")}
          </button>
        </ItemRow>
      ))}
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </Card></div>
  );
}

export function EnginesSettings({ simple = false, more }: { simple?: boolean; more?: { id: string; open: boolean; onToggle: () => void } }) {
  const { state } = useStore();
  // Leaving Settings ends the "now uses the copy Metal installed" lines.
  useEffect(() => forgetAppCopySwitches, []);
  const listed = state.instances.filter((i) => i.readOnly || i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state === "unavailable" || isApiKeyEngine(i));
  // A provider's accounts share one card, which takes the place of its first account.
  const groups = new Map<AccountGroup, InstanceInfo[]>();
  for (const instance of listed) {
    const group = accountGroupOf(instance);
    if (group) groups.set(group, [...groups.get(group) ?? [], instance]);
  }
  const groupOf = (instance: InstanceInfo) => {
    const group = accountGroupOf(instance);
    return group && groups.get(group)?.[0] === instance ? group : null;
  };
  const rows = listed.filter((instance) => !accountGroupOf(instance) || groupOf(instance));
  const isReady = (instance: InstanceInfo) => { const group = groupOf(instance); return group ? accountsReady(groups.get(group)!) : engineReady(instance); };
  const renderEngine = (instance: InstanceInfo, bare = false) => {
    const group = groupOf(instance);
    return group
      ? <>
        {bare && <FoundProvider instance={instance} />}
        <AccountsCard group={group} accounts={groups.get(group)!} bare={bare}
          advanced={<>{!bare && <FoundProvider instance={instance} />}<EngineAdvanced instance={instance} /><DisconnectProvider instance={instance} /></>} />
      </>
      : <EngineRow instance={instance} bare={bare} />;
  };

  if (simple && more) return <SimpleEngines rows={rows} isReady={isReady} renderEngine={renderEngine} more={more} />;

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60 space-y-2 px-4">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("settings.engines.title")}</h1>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-ink-secondary">{t("engines.library.intro")}</p>
        </div>
        <RefreshEngines />
      </div>
      <EngineSections instances={rows} isReady={isReady} renderEngine={renderEngine} />
      <HiddenEngines />
      <CacheKeepWarmSettings />
    </div>
  );
}
