// Settings > Transfer: where the bots live now, moving them back to this computer, taking Metal off the server, and
// the backups a move keeps
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { openPlaceSetup } from "@/lib/place-setup";
import { formatBytes, useVpsLink, type VpsBackup, type VpsMoveBack, type VpsWhere } from "@/lib/vps-link";
import { Card, CopyRow, ItemRow, NavRow, NoteRow } from "../ListRows";
import { askConfirm, type ConfirmRequest } from "../ConfirmDialog";
import { smallButtonCls } from "../ui/GrokDialog";
import { PlaceArt } from "../ui/PlaceArt";
import { PixelIcon } from "../ui/PixelIcon";
import { deviceWord, message } from "./parts";

function backupWhen(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function backupContents(backup: VpsBackup): string {
  const size = formatBytes(backup.bytes);
  if (!backup.summary) return size;
  return t("vpsLink.transfer.contents", { bots: backup.summary.bots, chats: backup.summary.chats, skills: backup.summary.skills, routines: backup.summary.routines, size });
}

/** Asking before the bots come back from a server: what is kept, and that routines arrive paused. */
export function moveBackAsk(name: string, device: string): ConfirmRequest {
  return { art: <PlaceArt name="direct" size={44} />, title: t("vpsLink.transfer.moveBackTitle", { name, device }), body: t("vpsLink.transfer.moveBackBody"),
    confirmLabel: t("vpsLink.transfer.moveBackAction"), tone: "neutral" };
}

/** Asking before bots come here from a saved server this computer never moved to. */
export function bringAsk(name: string, device: string): ConfirmRequest {
  return { art: <PlaceArt name="direct" size={44} />, title: t("vpsLink.transfer.bringTitle", { name, device }), body: t("vpsLink.transfer.bringBody", { name }),
    confirmLabel: t("vpsLink.transfer.moveBackAction"), tone: "neutral" };
}

const BACK_STEP_LINES = { check: "vpsLink.back.check", "backup-here": "vpsLink.back.backupHere", pause: "vpsLink.back.pause", copy: "vpsLink.back.copy", restore: "vpsLink.back.restore" } as const satisfies Record<VpsMoveBack["step"], string>;
const BLOCKED = { "own-bots": "vpsLink.transfer.bringBlockedOwnBots", moved: "vpsLink.transfer.bringBlockedMoved", moving: "vpsLink.transfer.bringBlockedMoving" } as const;

/** Where a move back is, in a line; null when none runs or it failed (its error shows instead). */
export function moveBackLine(back: VpsMoveBack | undefined, device: string, size: (bytes: number) => string = formatBytes): string | null {
  if (!back || back.status !== "running") return null;
  const name = back.name;
  if (!name) return t("vpsLink.back.starting");
  if (back.step === "copy" && back.bytes?.total) return t("vpsLink.back.copyBytes", { name, done: size(back.bytes.done), total: size(back.bytes.total) });
  const key = BACK_STEP_LINES[back.step];
  return t(key, { name, device });
}

/** A failed move back, said with what is still true: the server never loses its bots. */
export function moveBackFailure(back: VpsMoveBack): string {
  const error = back.error ?? t("vpsLink.back.failed");
  return back.name ? t("vpsLink.back.failedKept", { error, name: back.name }) : error;
}

export function TransferSettings() {
  const { bridge, view, ready } = useVpsLink();
  const [where, setWhere] = useState<VpsWhere | null>(null);
  const [backups, setBackups] = useState<VpsBackup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState(false);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const device = deviceWord();
  const { state, dispatch } = useStore();
  // dusk cloud is the way offered here; a server of one's own stays on the Connect from elsewhere page
  const cloud = Boolean(window.duskDesktop?.cloudAccount) && window.duskDesktop?.remoteClient?.active !== true && !state.config?.cloudHome;

  const load = useCallback(() => {
    if (!bridge) return;
    const sequence = ++loadSequence.current;
    void Promise.all([bridge.where(), bridge.backups()]).then(([place, list]) => {
      if (!alive.current || sequence !== loadSequence.current) return;
      setWhere(place); setBackups(list);
    }, (cause) => { if (alive.current && sequence === loadSequence.current) setError(message(cause)); });
  }, [bridge]);
  const refreshKey = JSON.stringify([view.stage, view.server?.id, view.move?.step, view.move?.status, view.move?.backupId]);
  useEffect(() => {
    alive.current = true;
    if (ready) load();
    return () => { alive.current = false; loadSequence.current++; };
  }, [load, ready, refreshKey]);

  if (!bridge) return <Card><NoteRow>{t("vpsLink.transfer.desktopOnly")}</NoteRow></Card>;
  const perform = async (ask: ConfirmRequest | null, work: () => Promise<unknown>, done?: string) => {
    if (busy || (ask && !await askConfirm(ask))) return;
    setBusy(true); setError(""); setNote("");
    try {
      await work();
      if (alive.current && done) setNote(done);
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally { if (alive.current) { setBusy(false); load(); } }
  };
  const server = where?.place === "vps" ? where.server : null;
  const blocked = where?.blocked && where.blocked !== "unknown" ? t(BLOCKED[where.blocked], { device }) : null;
  const backLine = moveBackLine(view.back, device);
  const backError = view.back?.status === "failed" ? moveBackFailure(view.back) : null;
  const retryPlace = where?.bring?.find((place) => place.name === view.back?.name)?.id;
  return (
    <>
      <Card label={t("vpsLink.transfer.whereTitle")} data-settings-block="transfer">
        {!where
          ? <NoteRow>{error || t("vpsLink.transfer.loading")}</NoteRow>
          : <ItemRow title={server ? server.name : t("vpsLink.transfer.thisDevice", { device })}
              hint={server ? t("vpsLink.transfer.onServer") : t("vpsLink.transfer.onDevice", { device })} />}
        {where && (server
          ? <>
              <NavRow title={t("vpsLink.transfer.moveBack", { device })} hint={t("vpsLink.transfer.moveBackHint", { name: server.name, device })} disabled={busy || Boolean(backLine)}
                onClick={() => void perform(moveBackAsk(server.name, device), () => bridge.moveBack(), t("vpsLink.transfer.moveBackStarted"))} />
              {where.uninstall && <>
                <NavRow title={t("vpsLink.transfer.remove")} hint={t("vpsLink.transfer.removeHint", { name: server.name })} drill={false}
                  aria-expanded={removing} onClick={() => setRemoving((open) => !open)} />
                {removing && <>
                  <CopyRow title={t("vpsLink.transfer.removePaste", { name: server.name })} text={where.uninstall} data-copy-row="uninstall" />
                  <NoteRow>{t("vpsLink.transfer.removeNote")}</NoteRow>
                </>}
              </>}
              <NavRow title={t("vpsLink.transfer.forget", { name: server.name })} hint={t("vpsLink.transfer.forgetHint")} danger drill={false} disabled={busy}
                onClick={() => void perform({ art: <PlaceArt name="server" size={33} />, title: t("vpsLink.transfer.forgetTitle", { name: server.name }), body: t("vpsLink.transfer.forgetBody"), confirmLabel: t("vpsLink.transfer.forgetAction"), tone: "neutral" }, () => bridge.forget())} />
            </>
          : cloud
            ? <NavRow data-settings-open="cloud-add" title={t("vpsLink.transfer.toCloud")} hint={t("vpsLink.transfer.toCloudHint", { device })}
                onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })} />
            : <NavRow title={t("vpsLink.add")} hint={t("vpsLink.addHint")} onClick={() => openPlaceSetup("server")} />)}
        {where && !server && where.bring?.map((place) => (
          <NavRow key={place.id} data-bring-from={place.id} title={t("vpsLink.transfer.bringFrom", { name: place.name })}
            hint={t("vpsLink.transfer.bringFromHint", { name: place.name, device })} disabled={busy || Boolean(blocked) || Boolean(backLine)}
            onClick={() => void perform(bringAsk(place.name, device), () => bridge.moveBack(place.id))} />
        ))}
        {where && !server && where.bring?.length && blocked ? <NoteRow>{blocked}</NoteRow> : null}
        {backLine && <NoteRow>{backLine}</NoteRow>}
        {backError && !busy && <NoteRow tone="danger">{backError}</NoteRow>}
        {backError && !busy && (server || retryPlace) && (
          <div className="flex justify-end px-3 pb-2">
            <button type="button" data-move-back-retry="" className={smallButtonCls}
              onClick={() => void perform(null, () => bridge.moveBack(server ? undefined : retryPlace))}>
              {t("vpsLink.back.retry")}
            </button>
          </div>
        )}
      </Card>
      <Card label={t("vpsLink.transfer.backupsTitle")} footnote={t("vpsLink.transfer.backupsNote", { device })}>
        {backups === null
          ? <NoteRow>{t("vpsLink.transfer.loading")}</NoteRow>
          : backups.length === 0
            ? <NoteRow>{t("vpsLink.transfer.noBackups")}</NoteRow>
            : backups.map((backup) => (
              <ItemRow key={backup.id} title={backupWhen(backup.at)} hint={`${t(`vpsLink.transfer.reason.${backup.reason}`)} · ${backupContents(backup)}`}>
                <button type="button" className={smallButtonCls} disabled={busy} aria-label={t("vpsLink.transfer.restoreAria", { when: backupWhen(backup.at) })}
                  onClick={() => void perform({ art: <PixelIcon name="clock" size={28} />, title: t("vpsLink.transfer.restoreTitle", { when: backupWhen(backup.at) }), body: t("vpsLink.transfer.restoreBody"), confirmLabel: t("vpsLink.transfer.restore"), tone: "neutral" }, () => bridge.restore(backup.id))}>
                  {t("vpsLink.transfer.restore")}
                </button>
              </ItemRow>
            ))}
        <NavRow title={t("vpsLink.transfer.backupNow")} hint={t("vpsLink.transfer.backupNowHint", { device })} drill={false} disabled={busy}
          onClick={() => void perform(null, () => bridge.backupNow(), t("vpsLink.transfer.backedUp"))} />
        {note && <NoteRow>{note}</NoteRow>}
        {error && where && <NoteRow tone="danger">{error}</NoteRow>}
      </Card>
    </>
  );
}
