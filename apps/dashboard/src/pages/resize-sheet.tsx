import { useEffect, useRef, useState } from "react";
import { useCloud } from "../data/cloud";
import type { ChangeOffer, CloudDesktop, DesktopTier, PlanCatalog, Selection } from "../data/contracts";
import { dollars, priceCart, specLine } from "../data/pricing";
import { useSession } from "../data/session";
import { ApiError } from "../lib/api";
import { shortDate } from "../lib/format";
import { offerText } from "./plan-sheet";
import { Choice, Modal } from "../ui/controls";
import { Button } from "../ui/kit";

const UNDO_MS = 3000;
const money = (n: number) => dollars(n, !Number.isInteger(Math.round(n * 100) / 100));

type Quote = { state: "loading" } | { state: "ready"; offer: ChangeOffer } | { state: "error"; message: string };

function plainError(e: unknown): string {
  if (e instanceof ApiError && e.code === "price_changed") return "the price just changed. check the new amount and try again.";
  if (e instanceof ApiError && e.code === "offline") return "can't reach Metal. check your connection and try again.";
  return (e as Error).message || "that didn't go through. try again.";
}

export function ResizeDialog({ open, onClose, cloud, catalog, focus }: { open: boolean; onClose(): void; cloud: CloudDesktop; catalog: PlanCatalog; focus: DesktopTier["id"] | null }) {
  const { billing, changeCharge, changePlan } = useCloud();
  const { toast } = useSession();
  const sub = billing?.subscription ?? null;
  const [to, setTo] = useState<DesktopTier["id"]>(cloud.tier);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionFor = (id: DesktopTier["id"]): Selection | null => (sub ? { ...sub.selection, desktop: id, size: null } : null);

  const quote = (id: DesktopTier["id"]) => {
    const selection = selectionFor(id);
    if (!selection) return;
    setQuotes((q) => ({ ...q, [id]: { state: "loading" } }));
    changeCharge(selection).then(
      (offer) => setQuotes((q) => ({ ...q, [id]: { state: "ready", offer } })),
      (e) => setQuotes((q) => ({ ...q, [id]: { state: "error", message: plainError(e) } })),
    );
  };

  // every price is in before anyone picks, so the button can say exactly what it charges
  useEffect(() => {
    if (!open) return;
    setTo(focus ?? cloud.tier); setError(""); setPending(false);
    if (sub) for (const d of catalog.desktops) if (d.id !== cloud.tier) quote(d.id);
  }, [open, sub?.id, cloud.tier]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const cancelPending = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } setPending(false); };
  const pick = (id: DesktopTier["id"]) => { if (busy) return; cancelPending(); setError(""); setTo(id); };

  const target = catalog.desktops.find((d) => d.id === to) ?? null;
  const changed = to !== cloud.tier && target !== null;
  const q = changed ? quotes[to] : undefined;
  const shownError = error || (q?.state === "error" ? q.message : "");

  const apply = async (d: DesktopTier, offer: ChangeOffer) => {
    const selection = selectionFor(d.id);
    setPending(false);
    if (!selection) return;
    setBusy(true);
    try {
      await changePlan(selection, offer.todayUsd);
      toast(offer.timing === "scheduled" ? `${cloud.name} switches to ${d.name} on ${shortDate(offer.effectiveAt)}` : `switching ${cloud.name} to ${d.name}. it restarts once, in under a minute.`);
      onClose();
    } catch (e) {
      setError(plainError(e));
      if (e instanceof ApiError && e.code === "price_changed") quote(d.id);
    } finally { setBusy(false); }
  };
  const press = () => {
    if (!target || !changed) return;
    if (pending) { cancelPending(); return; }
    if (q?.state !== "ready") { setError(""); quote(target.id); return; }
    setError("");
    setPending(true);
    const offer = q.offer;
    timer.current = setTimeout(() => { timer.current = null; void apply(target, offer); }, UNDO_MS);
  };
  const close = () => { cancelPending(); onClose(); };

  const label = !target ? "" : busy ? "switching" : pending ? "undo" : shownError && q?.state !== "ready" ? "try again"
    : q?.state === "ready" ? `switch to ${target.name} · ${q.offer.timing === "scheduled" ? `on ${shortDate(q.offer.effectiveAt)}` : q.offer.todayUsd > 0 ? `${money(q.offer.todayUsd)} today` : "nothing today"}` : `switch to ${target.name}`;

  return (
    <Modal open={open} onClose={close} title={`resize ${cloud.name}`} wide
      footer={changed ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {shownError && !pending && <p role="alert" className="me-auto text-13 text-bad">{shownError}</p>}
          {pending && <p role="status" className="me-auto text-13 text-ink-2">switching to {target?.name} in a moment</p>}
          <Button variant={pending ? "outline" : "primary"} className="max-sm:w-full"
            disabled={!sub || busy || (q?.state === "loading" && !pending)}
            aria-busy={busy || q?.state === "loading"}
            onClick={press}>
            {label}
          </Button>
        </div>
      ) : undefined}>
      <p>it restarts once, usually in under a minute. bots, files and logins come along. a bigger size starts now and charges the difference for the rest of this period; a smaller one starts on your next billing date.</p>
      <fieldset className="mt-4 min-w-0">
        <legend className="sr-only">size</legend>
        <div className="flex flex-col gap-1">
          {catalog.desktops.map((d) => {
            const selection = selectionFor(d.id);
            const perMonth = selection ? priceCart(selection, catalog).perMonth : null;
            return (
              <Choice key={d.id} name="resize" value={d.id} checked={to === d.id} onChange={() => pick(d.id)}
                title={<>{d.name}{d.id === cloud.tier && <span className="ms-2 text-13 text-ink-3">current</span>}</>}
                detail={`${specLine(d)}${d.priority ? ", priority wake" : ""}`}
                aside={perMonth !== null ? <>{money(perMonth)}<span className="text-ink-3">/mo</span></> : null} />
            );
          })}
        </div>
      </fieldset>
      {q?.state === "ready" && target && sub ? <p role="status" className="num mt-3 text-13 text-ink-2">{offerText(q.offer, { from: catalog.desktops.find((d) => d.id === cloud.tier)?.name ?? "this size", to: target.name, fromInterval: sub.selection.interval, toInterval: sub.selection.interval })}</p>
        : sub && <p className="mt-3 text-13 text-ink-3">prices are your whole plan per month.</p>}
    </Modal>
  );
}
