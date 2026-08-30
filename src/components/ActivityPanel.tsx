import { useEffect, useRef, useState } from "react";
import { Check, Copy, FolderOpen, ScrollText, Trash2, X } from "lucide-react";
import { clearActivityLog, revealActivityLog, type ActivityLine } from "../ipc/commands";
import { useActivityStore, type MemoryReading } from "../state/activityStore";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n/useI18n";

/** MiB → "4.3" (GiB with one decimal), the unit the memory readout shows. */
export function formatGb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

function formatClock(tsMs: number): string {
  const d = new Date(tsMs);
  const two = (n: number) => n.toString().padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function formatLine(line: ActivityLine): string {
  return `${formatClock(line.tsMs)} ${line.source === "sidecar" ? "sidecar" : "studio "} ${line.text}`;
}

/** The figure to check against RAM: the real footprint when the sidecar
 * reports it, else resident size, else nothing. */
export function processMemoryMb(memory: MemoryReading | null): number | null {
  return memory?.footprintMb ?? memory?.rssMb ?? null;
}

/** Live readout in the footer; opens the panel. */
export function ActivityToggle() {
  const { messages: t } = useI18n();
  const open = useActivityStore((s) => s.open);
  const toggle = useActivityStore((s) => s.toggle);
  const memory = useActivityStore((s) => s.memory);
  const process = processMemoryMb(memory);
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="sm"
      onClick={toggle}
      aria-pressed={open}
      title={t.activity.toggleTitle}
      className="shrink-0"
    >
      <ScrollText className="mr-1.5 h-3.5 w-3.5" />
      {t.activity.title}
      {process != null && (
        <span className="ml-1.5 tabular-nums text-muted-foreground">
          {t.activity.processShort(formatGb(process))}
        </span>
      )}
    </Button>
  );
}

export function ActivityPanel() {
  const { messages: t } = useI18n();
  const open = useActivityStore((s) => s.open);
  const lines = useActivityStore((s) => s.lines);
  const memory = useActivityStore((s) => s.memory);
  const logPath = useActivityStore((s) => s.logPath);
  const setOpen = useActivityStore((s) => s.setOpen);
  const clear = useActivityStore((s) => s.clear);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the tail unless the user scrolled up to read something.
  const followRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, open]);

  if (!open) return null;

  const process = processMemoryMb(memory);
  const memorySummary =
    memory?.activeMb != null && memory.peakMb != null
      ? t.activity.memory(
          formatGb(memory.activeMb),
          formatGb(memory.peakMb),
          process == null ? null : formatGb(process),
        )
      : t.activity.noMemoryYet;

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
  }

  async function onCopy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(lines.map(formatLine).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onReveal() {
    setError(null);
    try {
      await revealActivityLog();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClear() {
    clear();
    try {
      await clearActivityLog();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section
      aria-label={t.activity.title}
      className="flex h-[220px] shrink-0 flex-col border-t border-border bg-card/60"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium">{t.activity.title}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={memory?.label}>
          {memorySummary}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {error && <span className="max-w-[240px] truncate text-destructive">{error}</span>}
          <Button variant="ghost" size="sm" onClick={onCopy} title={t.activity.copyTitle}>
            {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
            {copied ? t.activity.copied : t.activity.copy}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReveal}
            disabled={!logPath}
            title={logPath ?? t.activity.noLogFile}
          >
            <FolderOpen className="mr-1 h-3.5 w-3.5" />
            {t.activity.reveal}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear} title={t.activity.clearTitle}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t.activity.clear}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(false)}
            title={t.activity.close}
            aria-label={t.activity.close}
            className="h-7 w-7"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[11px] leading-[1.6]"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground">{t.activity.empty}</div>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {formatClock(line.tsMs)}
              </span>
              <span
                className={cn(
                  "w-12 shrink-0",
                  line.source === "sidecar" ? "text-sky-300/80" : "text-muted-foreground",
                )}
              >
                {line.source}
              </span>
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
