import { useRef } from "react";
import { Lock } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import type { Clip as ClipModel } from "../types/project";
import { cn } from "@/lib/utils";

interface ClipProps {
  clip: ClipModel;
  zoomPxPerSec: number;
}

type DragKind = "move" | "resize-l" | "resize-r";

export function Clip({ clip, zoomPxPerSec }: ClipProps) {
  const select = useProjectStore((s) => s.select);
  const updateClip = useProjectStore((s) => s.updateClip);
  const selection = useProjectStore((s) => s.selection);
  const selected = selection.kind === "clip" && selection.id === clip.id;
  const dragRef = useRef<{ kind: DragKind; startX: number; startSec: number; endSec: number } | null>(null);

  const left = clip.startSec * zoomPxPerSec;
  const width = Math.max(8, (clip.endSec - clip.startSec) * zoomPxPerSec);

  function onPointerDown(e: React.PointerEvent, kind: DragKind) {
    if (clip.locked && kind !== "move") return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      startX: e.clientX,
      startSec: clip.startSec,
      endSec: clip.endSec,
    };
    select({ kind: "clip", id: clip.id });
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dxSec = (e.clientX - drag.startX) / zoomPxPerSec;
    if (drag.kind === "move") {
      const dur = drag.endSec - drag.startSec;
      const start = Math.max(0, drag.startSec + dxSec);
      updateClip(clip.id, { startSec: start, endSec: start + dur });
    } else if (drag.kind === "resize-l") {
      const start = Math.min(drag.endSec - 0.1, Math.max(0, drag.startSec + dxSec));
      updateClip(clip.id, { startSec: start });
    } else {
      const end = Math.max(drag.startSec + 0.1, drag.endSec + dxSec);
      updateClip(clip.id, { endSec: end });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  const preview = clip.text.trim() || "(empty)";

  return (
    <div
      className={cn(
        "absolute top-1.5 bottom-1.5 select-none overflow-hidden rounded-md border bg-gradient-to-b shadow-sm transition-colors",
        selected
          ? "border-primary/60 from-primary/30 to-primary/15 ring-1 ring-primary/40"
          : "border-border/70 from-primary/10 to-primary/5 hover:border-primary/40",
        clip.locked && "opacity-80",
      )}
      style={{ left, width }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={clip.text || "Empty clip"}
    >
      <div className="line-clamp-2 px-2 pt-1 text-[11px] leading-tight text-foreground">
        {preview}
      </div>
      <div className="absolute bottom-1 left-2 right-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {clip.locked && <Lock className="h-2.5 w-2.5" />}
          {clip.mode}
        </span>
        <span>{(clip.endSec - clip.startSec).toFixed(2)}s</span>
      </div>
      <div
        className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-primary/40"
        onPointerDown={(e) => onPointerDown(e, "resize-l")}
      />
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-primary/40"
        onPointerDown={(e) => onPointerDown(e, "resize-r")}
      />
    </div>
  );
}
