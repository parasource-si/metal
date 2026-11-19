import { useEffect, useId, useRef, useState } from "react";

import { friendlyError } from "@/lib/plain-error";
import { ApiError } from "@/state/api";
import { cn } from "@/lib/cn";
import { closeFeedback, FEEDBACK_IMAGE_ACCEPT, FEEDBACK_MAX_IMAGES, feedbackImage, sendFeedback, useFeedbackOpen, type FeedbackImage } from "@/lib/feedback-sheet";
import { t } from "@/lib/i18n";
import type { BannerProblem } from "@/lib/place-banner";
import type { LocaleKey } from "@/locales";

import { ImagePlus, X } from "../icons";
import { fieldLabelCls, GrokDialog, mdPrimaryCls, mdSecondaryCls, smallButtonCls } from "./ui/GrokDialog";
import { Toast } from "./ui/Toast";

const PROBLEM: Readonly<Record<BannerProblem, LocaleKey>> = { format: "placeLook.imageFormat", read: "placeLook.imageRead", size: "placeLook.imageSize" };
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function Thumbs({ images, onRemove }: { images: readonly FeedbackImage[]; onRemove: (index: number) => void }) {
  return <>
    {images.map((image, i) => (
      <span key={image.url} data-feedback-image="" className="relative size-14 shrink-0">
        <img src={image.url} alt={t("giveFeedback.image", { n: i + 1 })} className="size-14 rounded-[10px] bg-ink/5 object-cover" />
        <button type="button" aria-label={t("giveFeedback.removeImage", { n: i + 1 })} onClick={() => onRemove(i)}
          className={cn("absolute -end-1.5 -top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-ink text-app hover:bg-[color-mix(in_srgb,var(--color-ink)_85%,var(--color-menu))]", FOCUS)}>
          <X size={12} strokeWidth={2.5} aria-hidden="true" />
        </button>
      </span>
    ))}
  </>;
}

export function FeedbackDialog({ onClose, onSent, send = sendFeedback }: { onClose: () => void; onSent: () => void; send?: typeof sendFeedback }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const kept = useRef(images);
  kept.current = images;
  const errorId = useId();
  useEffect(() => () => { for (const image of kept.current) URL.revokeObjectURL(image.url); }, []);

  const add = async (files: FileList | null) => {
    const chosen = [...(files ?? [])];
    if (picker.current) picker.current.value = "";
    const room = FEEDBACK_MAX_IMAGES - images.length;
    setError(chosen.length > room ? t("giveFeedback.tooManyImages", { n: FEEDBACK_MAX_IMAGES }) : null);
    for (const file of chosen.slice(0, room)) {
      const prepared = await feedbackImage(file);
      if (!prepared.ok) { setError(t(PROBLEM[prepared.problem])); continue; }
      setImages((now) => [...now, prepared.image]);
    }
  };
  const remove = (index: number) => {
    const image = images[index];
    if (image) URL.revokeObjectURL(image.url);
    setImages(images.filter((_, i) => i !== index));
    setError(null);
  };
  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true); setError(null);
    try {
      await send(text.trim(), images);
      onSent();
    } catch (failed) {
      if (failed instanceof ApiError && failed.status === 404) setError(t("giveFeedback.serverTooOld"));
      else setError(failed instanceof Error && failed.message ? friendlyError(failed) : t("giveFeedback.failed"));
      setSending(false);
    }
  };

  return (
    <GrokDialog
      title={t("giveFeedback.title")}
      onClose={onClose}
      data-panel-modal="feedback"
      footer={<>
        <span className="me-auto min-w-0 truncate text-[12px] leading-4 text-ink/56">{t("giveFeedback.goesTo", { app: "Dusk" })}</span>
        <button type="button" onClick={onClose} className={mdSecondaryCls}>{t("giveFeedback.cancel")}</button>
        <button type="button" data-feedback-send="" disabled={!text.trim() || sending} onClick={() => void submit()} className={mdPrimaryCls}>
          {sending ? t("giveFeedback.sending") : t("giveFeedback.send")}
        </button>
      </>}
    >
      <div className="flex flex-col gap-4 pb-2">
        <label className="flex flex-col gap-1">
          <span className={fieldLabelCls}>{t("giveFeedback.label")}</span>
          <textarea data-autofocus="" rows={5} value={text} maxLength={5_000} onChange={(event) => setText(event.target.value)} placeholder={t("giveFeedback.placeholder")}
            aria-describedby={error ? errorId : undefined}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }}
            className="block w-full resize-none rounded-[10px] bg-ink/[0.045] px-3 py-2.5 text-[14px] leading-5 text-ink outline-none transition-[background-color] duration-150 ease-[ease] placeholder:text-ink/40 focus:bg-ink/[0.07]" />
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <Thumbs images={images} onRemove={remove} />
          {images.length < FEEDBACK_MAX_IMAGES && (
            <button type="button" data-feedback-add-images="" onClick={() => picker.current?.click()}
              className={cn(smallButtonCls, "h-14 min-w-14 flex-col gap-0.5 rounded-[10px] px-3 text-[11px] text-ink-secondary")}>
              <ImagePlus size={16} strokeWidth={1.75} aria-hidden="true" />{t("giveFeedback.addImages")}
            </button>
          )}
          <input ref={picker} type="file" accept={FEEDBACK_IMAGE_ACCEPT} multiple hidden data-feedback-images-input="" onChange={(event) => void add(event.target.files)} />
        </div>
        {error && <p id={errorId} role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
      </div>
    </GrokDialog>
  );
}

/** Mounted once on the app's page: the Give feedback sheet, whoever opened it, and its thank-you once sent. */
export function FeedbackHost() {
  const open = useFeedbackOpen();
  const [sent, setSent] = useState(false);
  return <>
    {open && <FeedbackDialog onClose={closeFeedback} onSent={() => { closeFeedback(); setSent(true); }} />}
    {sent && <Toast data-notice-toast="feedback" text={t("giveFeedback.sent")} onDone={() => setSent(false)} />}
  </>;
}
