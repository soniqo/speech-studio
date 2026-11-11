import { useEffect, useRef } from "react";
import { useProjectStore } from "../state/projectStore";
import type { Project } from "../types/project";
import { clipAudioPath, clipAudioVersion } from "../lib/clipAudio";
import { mediaFileSrc } from "../lib/mediaSrc";
import { audibleTrackIds } from "../lib/trackAudibility";

// A jump in positionSec larger than this is treated as a seek (we re-sync
// the active clip's currentTime). Smaller jumps come from the playhead RAF
// tick (~16ms at 60fps) and don't need a re-sync.
const SEEK_THRESHOLD_SEC = 0.05;

interface PlaybackItem {
  id: string;
  trackId: string;
  startSec: number;
  endSec: number;
  audioPath: string;
  version?: string;
  gainDb: number;
}

function clipsWithAudio(project: Project): PlaybackItem[] {
  const out: PlaybackItem[] = [];
  for (const t of project.tracks) {
    if (t.kind === "audio") {
      if (t.sourcePath) out.push({
        id: `track:${t.id}`, trackId: t.id, startSec: 0,
        endSec: Infinity, audioPath: t.sourcePath, gainDb: t.gainDb,
      });
      continue;
    }
    if (t.kind === "speaker") {
      for (const c of t.clips) {
        const audioPath = clipAudioPath(c);
        if (audioPath) out.push({
          id: c.id, trackId: t.id, startSec: c.startSec,
          endSec: c.endSec, audioPath, version: clipAudioVersion(c), gainDb: 0,
        });
      }
    }
  }
  return out;
}

export function useAudioScheduler() {
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const playing = useProjectStore((s) => s.transport.playing);
  const audiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Sync the audio element pool to the current set of rendered clips.
  useEffect(() => {
    const map = audiosRef.current;
    const wanted = new Set<string>();

    for (const c of clipsWithAudio(project)) {
      wanted.add(c.id);
      const expectedSrc = mediaFileSrc(c.audioPath, c.version);
      const existing = map.get(c.id);
      if (!existing) {
        const a = new Audio(expectedSrc);
        a.preload = "auto";
        a.volume = Math.max(0, Math.min(1, Math.pow(10, c.gainDb / 20)));
        a.load();
        map.set(c.id, a);
      } else {
        existing.volume = Math.max(0, Math.min(1, Math.pow(10, c.gainDb / 20)));
        if (existing.src !== expectedSrc) {
          existing.pause();
          existing.src = expectedSrc;
          existing.load();
        }
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
      const state = useProjectStore.getState();
      const clips = clipsWithAudio(state.project);
      const audible = audibleTrackIds(state.project, state.selection, "preview");
      for (const c of clips) {
        const audio = map.get(c.id);
        if (!audio) continue;
        const knownLength = Number.isFinite(audio.duration) ? audio.duration : Infinity;
        const inRange = audible.has(c.trackId) && pos >= c.startSec &&
          pos < Math.min(c.endSec, c.startSec + knownLength);
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
  // Changing Mute/Solo or selecting a track updates playback immediately.
  }, [playing, project, selection]);
}
