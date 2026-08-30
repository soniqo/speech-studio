import { Pause, Play } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import { useAnyClipRendered } from "../hooks/useSynthesizeAll";
import { Button } from "./ui/button";
import { ActivityToggle } from "./ActivityPanel";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n/useI18n";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export function Transport() {
  const { messages: t } = useI18n();
  const transport = useProjectStore((s) => s.transport);
  const project = useProjectStore((s) => s.project);
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const seek = useProjectStore((s) => s.seek);

  const duration = Math.max(project.durationSec, 5);
  const hasContent = project.tracks.length > 0;
  const anyRendered = useAnyClipRendered();
  const synthBusy = useProjectStore((s) => s.synthesisStatus === "running");
  const playable = hasContent && anyRendered && !synthBusy;
  const playTitle = !hasContent
    ? t.transport.loadProjectFirst
    : !anyRendered
      ? t.transport.synthesizeBeforePlaying
      : synthBusy
        ? t.transport.waitSynthesizing
        : transport.playing
          ? t.transport.pause
          : t.transport.play;

  const progressPct = (transport.positionSec / duration) * 100;

  return (
    <footer className="flex h-14 items-center gap-3 border-t border-border bg-card/60 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/40">
      <div className="font-mono text-xs tabular-nums text-muted-foreground min-w-[100px]">
        <span className="text-foreground">{formatTime(transport.positionSec)}</span>
        <span className="mx-1 text-muted-foreground/60">/</span>
        <span>{formatTime(duration)}</span>
      </div>
      <Button
        size="icon"
        variant={transport.playing ? "secondary" : "default"}
        onClick={() => setPlaying(!transport.playing)}
        disabled={!playable}
        title={playTitle}
        className="h-10 w-10 rounded-full"
      >
        {transport.playing ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="h-4 w-4 translate-x-[1px] fill-current" />
        )}
      </Button>
      <div className="relative flex-1">
        {/* Filled track behind the input */}
        <div
          className={cn(
            "pointer-events-none absolute inset-y-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-primary transition-[width]",
            !playable && "bg-muted",
          )}
          style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
        />
        <div className="pointer-events-none absolute inset-y-1/2 inset-x-0 -z-0 h-1 -translate-y-1/2 rounded-full bg-muted" />
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={transport.positionSec}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!playable}
          className={cn(
            "relative h-3 w-full cursor-pointer appearance-none bg-transparent",
            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>
      <ActivityToggle />
    </footer>
  );
}
