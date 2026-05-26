import { useMemo, useRef } from "react";
import { useProjectStore, newClip } from "../state/projectStore";
import type { SpeakerTrack, Track } from "../types/project";
import { Clip } from "./Clip";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";

const TRACK_HEADER_W = 180;

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function rulerTicks(durationSec: number, zoom: number): number[] {
  const targetPxPerTick = 80;
  const stepSec = Math.max(1, Math.round(targetPxPerTick / zoom));
  const total = Math.max(durationSec, 5);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += stepSec) ticks.push(t);
  return ticks;
}

function laneTint(track: Track): string {
  if (track.kind === "video") return "bg-[#1f1a17]/40";
  if (track.kind === "speaker") return "bg-[#1a1715]/40";
  return "bg-[#1d1814]/40";
}

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const transport = useProjectStore((s) => s.transport);
  const setZoom = useProjectStore((s) => s.setZoom);
  const selection = useProjectStore((s) => s.selection);
  const select = useProjectStore((s) => s.select);
  const addClip = useProjectStore((s) => s.addClip);
  const seek = useProjectStore((s) => s.seek);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibleDuration = Math.max(project.durationSec, 5);
  const lanePxWidth = visibleDuration * transport.zoomPxPerSec;
  const ticks = useMemo(
    () => rulerTicks(visibleDuration, transport.zoomPxPerSec),
    [visibleDuration, transport.zoomPxPerSec],
  );

  function handleLaneDoubleClick(track: Track, e: React.MouseEvent<HTMLDivElement>) {
    if (track.kind !== "speaker") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const startSec = Math.max(0, x / transport.zoomPxPerSec);
    const endSec = startSec + 2;
    const clip = newClip({ trackId: track.id, startSec, endSec, text: "" });
    addClip(clip);
    select({ kind: "clip", id: clip.id });
  }

  function handleRulerClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seek(Math.max(0, x / transport.zoomPxPerSec));
  }

  const playheadLeft = TRACK_HEADER_W + transport.positionSec * transport.zoomPxPerSec;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs text-muted-foreground">
        <span>Zoom</span>
        <input
          type="range"
          min={20}
          max={400}
          step={1}
          value={transport.zoomPxPerSec}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-32 accent-primary"
        />
        <span className="font-mono tabular-nums">{transport.zoomPxPerSec} px/s</span>
        <span className="ml-auto">Duration {formatTime(visibleDuration)}</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        <div className="relative min-h-full">
          <div className="sticky top-0 z-10 flex h-7 border-b border-border bg-card/80 backdrop-blur">
            <div className="shrink-0 border-r border-border" style={{ width: TRACK_HEADER_W }} />
            <div
              className="relative cursor-pointer text-[11px] text-muted-foreground"
              style={{ width: lanePxWidth }}
              onClick={handleRulerClick}
              title="Click to seek"
            >
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-1 border-l border-border/60 pl-1 tabular-nums"
                  style={{ left: t * transport.zoomPxPerSec, height: "100%" }}
                >
                  {formatTime(t)}
                </div>
              ))}
            </div>
          </div>

          {project.tracks.length === 0 && <EmptyState />}

          {project.tracks.map((t) => {
            const selected = selection.kind === "track" && selection.id === t.id;
            return (
              <div key={t.id} className="flex border-b border-border/60">
                <button
                  type="button"
                  className={cn(
                    "shrink-0 border-r border-border px-3 py-2 text-left transition-colors",
                    selected ? "bg-primary/10" : "hover:bg-accent/30",
                  )}
                  style={{ width: TRACK_HEADER_W }}
                  onClick={() => select({ kind: "track", id: t.id })}
                >
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="text-[11px] text-muted-foreground">{t.kind}</div>
                </button>
                <div
                  className={cn("relative h-16", laneTint(t))}
                  style={{ width: lanePxWidth }}
                  onDoubleClick={(e) => handleLaneDoubleClick(t, e)}
                  title={t.kind === "speaker" ? "Double-click to add clip" : ""}
                >
                  {t.kind === "speaker" &&
                    (t as SpeakerTrack).clips.map((c) => (
                      <Clip key={c.id} clip={c} zoomPxPerSec={transport.zoomPxPerSec} />
                    ))}
                </div>
              </div>
            );
          })}

          {project.tracks.length > 0 && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary/80 shadow-[0_0_8px_var(--color-primary)]"
              style={{ left: playheadLeft }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
