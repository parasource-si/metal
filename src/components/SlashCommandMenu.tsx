import { useRef, type RefObject } from "react";
import { BookOpen, ChevronDown, Sparkles, Target, Wand2 } from "../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { ComposerSlashCommand } from "@/lib/composer-commands";
import type { MenuMotion } from "./MenuMotion";

/** The composer's / list: Metal's commands like /goal, the skills made in Metal, then a More row for the other
 * AI tools' skills. */
export function SlashCommandMenu({ listRef, motion, commands, highlight, onPick, onHighlight }: {
  listRef: RefObject<HTMLDivElement | null>;
  motion: MenuMotion;
  commands: ComposerSlashCommand[];
  highlight: number;
  onPick: (command: ComposerSlashCommand) => void;
  onHighlight: (index: number) => void;
}) {
  // the list scrolling under a resting pointer must not steal the keyboard's highlight: only a real move hovers
  const pointer = useRef<{ x: number; y: number } | null>(null);
  if (!motion.shown) return null;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("composer.commands.aria")}
      className={cn("popover-surface absolute bottom-full start-2 z-20 mb-2 max-h-80 w-80 max-w-[calc(100%-1rem)] origin-bottom-left overflow-x-hidden overflow-y-auto overscroll-contain rounded-[16px] border-[0.5px] border-transparent p-1.5", motion.className)} {...motion.exitProps}
    >
      <div className="px-2 pb-1 pt-0.5 text-[12px] font-medium tracking-[0.01em] text-ink-tertiary">
        {t("composer.commands.title")}
      </div>
      {commands.map((command, index) => (
        <button
          key={`${command.kind}:${command.id}`}
          data-command-index={index}
          type="button"
          role="option"
          aria-selected={index === highlight}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
          onPointerMove={(event) => {
            const last = pointer.current;
            pointer.current = { x: event.clientX, y: event.clientY };
            if (!last || (last.x === event.clientX && last.y === event.clientY)) return;
            if (index !== highlight) onHighlight(index);
          }}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-start",
            index === highlight && "bg-menu-hover",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary">
            {command.kind === "more" ? (
              <ChevronDown size={15} aria-hidden="true" />
            ) : command.kind === "skill" ? (
              <Sparkles size={15} aria-hidden="true" />
            ) : command.id === "goal" ? (
              <Target size={15} aria-hidden="true" />
            ) : command.id === "setup" ? (
              <Wand2 size={15} aria-hidden="true" />
            ) : (
              <BookOpen size={15} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] leading-5 tracking-[0.01em] text-ink">{command.label}</span>
              {command.kind === "skill" && (
                <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] font-medium leading-4 text-ink-secondary">{t("composer.command.skillTag")}</span>
              )}
            </span>
            <span className="block truncate text-[12px] leading-4 text-ink-tertiary">
              {command.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
