import { useEffect, useRef } from "react";
import { useProjectStore } from "../state/projectStore";
import type { Clip, Project } from "../types/project";
import { clipAudioPath, clipAudioVersion } from "../lib/clipAudio";
import { mediaFileSrc } from "../lib/mediaSrc";

// A jump in positionSec larger than this is treated as a seek (we re-sync
// the active clip's currentTime). Smaller jumps come from the playhead RAF
// tick (~16ms at 60fps) and don't need a re-sync.
const SEEK_THRESHOLD_SEC = 0.05;

function clipsWithAudio(project: Project): Clip[] {
  const out: Clip[] = [];
  for (const t of project.tracks) {
    if (t.kind === "speaker") {
      for (const c of t.clips) {
        if (clipAudioPath(c)) out.push(c);
      }
    }
  }
  return out;
}

export function useAudioScheduler() {
  const project = useProjectStore((s) => s.project);
  const playing = useProjectStore((s) => s.transport.playing);
  const audiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Sync the audio element pool to the current set of rendered clips.
  useEffect(() => {
    const map = audiosRef.current;
    const wanted = new Set<string>();

    for (const c of clipsWithAudio(project)) {
      wanted.add(c.id);
      const path = clipAudioPath(c);
      if (!path) continue;
      const expectedSrc = mediaFileSrc(path, clipAudioVersion(c));
      const existing = map.get(c.id);
      if (!existing) {
        const a = new Audio(expectedSrc);
        a.preload = "auto";
        a.load();
        map.set(c.id, a);
      } else if (existing.src !== expectedSrc) {
        existing.pause();
        existing.src = expectedSrc;
        existing.load();
      }
    }

    for (const [id, a] of Array.from(map.entries())) {
      if (!wanted.has(id)) {
        a.pause();
        map.delete(id);
      }
    }
  }, [project]);

  // Drive play/pause/seek based on transport.playing + positionSec.
  useEffect(() => {
    const map = audiosRef.current;

    const pauseAll = () => {
      for (const a of map.values()) {
        if (!a.paused) a.pause();
      }
    };

    if (!playing) {
      pauseAll();
      return;
    }

    const syncAt = (pos: number, treatAsSeek: boolean) => {
      const clips = clipsWithAudio(useProjectStore.getState().project);
      for (const c of clips) {
        const audio = map.get(c.id);
        if (!audio) continue;
        const inRange = pos >= c.startSec && pos < c.endSec;
        if (inRange) {
          const offset = Math.max(0, pos - c.startSec);
          // The clip's timeline slot can be wider than the actual rendered
          // audio (e.g. a 4 s slot holding a 2.2 s line). If the playhead is
          // past the audio's natural end, do NOT restart it — that's what
          // produces the "plays twice" effect when the slot is generous.
          const knownDur = Number.isFinite(audio.duration) ? audio.duration : null;
          if (knownDur !== null && offset >= knownDur && !treatAsSeek) {
            continue;
          }
          if (audio.paused || treatAsSeek) {
            if (Math.abs(audio.currentTime - offset) > SEEK_THRESHOLD_SEC) {
              audio.currentTime = offset;
            }
            audio.play().catch(() => {
              // Browser may reject e.g. if file missing; silent fail is fine.
            });
          }
        } else if (!audio.paused) {
          audio.pause();
        }
      }
    };

    // Prime active clips at the moment Play was pressed.
    syncAt(useProjectStore.getState().transport.positionSec, true);

    let lastPos = useProjectStore.getState().transport.positionSec;
    const unsub = useProjectStore.subscribe((s) => {
      const pos = s.transport.positionSec;
      if (pos === lastPos) return;
      const seeked = Math.abs(pos - lastPos) > SEEK_THRESHOLD_SEC;
      lastPos = pos;
      syncAt(pos, seeked);
    });

    return () => {
      unsub();
      pauseAll();
    };
  }, [playing]);
}
