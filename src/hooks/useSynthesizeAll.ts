import { useCallback } from "react";
import { synthesizeClip } from "../ipc/commands";
import { useProjectStore } from "../state/projectStore";
import type { Clip, SpeakerTrack, Voice } from "../types/project";
import { clipAudioPath } from "../lib/clipAudio";

interface PlannedJob {
  clip: Clip;
  track: SpeakerTrack;
  voice: Voice;
}

function collectJobs(state: ReturnType<typeof useProjectStore.getState>, mode: "missing" | "all"): PlannedJob[] {
  const out: PlannedJob[] = [];
  for (const track of state.project.tracks) {
    if (track.kind !== "speaker") continue;
    for (const clip of track.clips) {
      // Locked clips are user-protected — never overwrite them, even on
      // "resynthesize all". Once locked, they stay as they are.
      if (clip.locked) continue;
      if (!clip.text.trim()) continue;

      const voiceId = clip.voiceOverrideId ?? track.voiceId;
      if (!voiceId) continue;
      const voice = state.project.voices.find((v) => v.id === voiceId);
      // referenceText is NOT required: VoxCPM2 clones from audio alone (the
      // sidecar ignores reference transcripts). Requiring it silently skipped
      // every voice created via the "+ Reference" flow.
      if (!voice || !voice.referenceAudioPath) continue;

      const needs = mode === "all" ? true : !clip.renderedAudioPath;
      if (!needs) continue;

      out.push({ clip, track, voice });
    }
  }
  return out;
}

export interface SynthesizeAllResult {
  total: number;
  completed: number;
  failed: number;
}

export function useSynthesizeAll() {
  const updateClip = useProjectStore((s) => s.updateClip);
  const setSynthesisStatus = useProjectStore((s) => s.setSynthesisStatus);
  const setSynthesisProgress = useProjectStore((s) => s.setSynthesisProgress);

  const run = useCallback(
    async (mode: "missing" | "all"): Promise<SynthesizeAllResult> => {
      const initialState = useProjectStore.getState();
      const jobs = collectJobs(initialState, mode);
      const engine = initialState.model.engine;
      const engineInfo = initialState.model.engines.find((candidate) => candidate.id === engine);
      const engineName = engineInfo?.displayName ?? engine;
      const language = initialState.model.language;
      const fallbackRequiresReferenceTranscript =
        engine === "cosyvoice" || engine === "qwen3" || engine === "fish-audio";
      if (
        (engineInfo?.requiresReferenceTranscript ?? fallbackRequiresReferenceTranscript) &&
        jobs.some((job) => !job.voice.referenceText.trim())
      ) {
        throw new Error(
          `${engineName} needs an accurate reference transcript for every voice being synthesized`,
        );
      }
      if (jobs.length === 0) {
        return { total: 0, completed: 0, failed: 0 };
      }

      let completed = 0;
      let failed = 0;

      setSynthesisStatus("running");
      try {
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          const preview = job.clip.text.length > 28 ? `${job.clip.text.slice(0, 28)}…` : job.clip.text;
          setSynthesisProgress({
            current: i + 1,
            total: jobs.length,
            label: `${job.track.name}: ${preview}`,
          });
          try {
            const out = await synthesizeClip({
              clipId: job.clip.id,
              engine,
              text: job.clip.text,
              voiceId: job.voice.id,
              referenceAudioPath: job.voice.referenceAudioPath!,
              referenceText: job.voice.referenceText,
              language,
            });
            const take = {
              id: crypto.randomUUID(),
              audioPath: out.audioPath,
              text: job.clip.text,
              createdAt: new Date().toISOString(),
              settings: { voiceId: job.voice.id },
            };
            updateClip(job.clip.id, {
              renderedAudioPath: out.audioPath,
              history: [take, ...job.clip.history],
              // Generation is dynamic: the timeline slot follows the audio.
              ...(out.durationSec > 0
                ? { endSec: job.clip.startSec + out.durationSec }
                : {}),
            });
            completed++;
          } catch (e) {
            console.error(`synthesize ${job.clip.id} failed`, e);
            failed++;
          }
        }

        return { total: jobs.length, completed, failed };
      } finally {
        setSynthesisProgress(null);
        setSynthesisStatus("idle");
      }
    },
    [updateClip, setSynthesisStatus, setSynthesisProgress],
  );

  return { run };
}

/** Convenience: number of un-synthesized non-locked clips the user could synthesize right now. */
export function useUnsynthesizedCount(): number {
  return useProjectStore((s) => {
    let n = 0;
    for (const t of s.project.tracks) {
      if (t.kind !== "speaker") continue;
      for (const c of t.clips) {
        if (c.locked) continue;
        if (c.renderedAudioPath) continue;
        if (!c.text.trim()) continue;
        const voiceId = c.voiceOverrideId ?? t.voiceId;
        if (!voiceId) continue;
        const v = s.project.voices.find((x) => x.id === voiceId);
        if (!v || !v.referenceAudioPath || !v.referenceText.trim()) continue;
        n++;
      }
    }
    return n;
  });
}

/** Does any clip currently have rendered audio? Used to gate Play. */
export function useAnyClipRendered(): boolean {
  return useProjectStore((s) => {
    for (const t of s.project.tracks) {
      if (t.kind !== "speaker") continue;
      for (const c of t.clips) {
        if (clipAudioPath(c)) return true;
      }
    }
    return false;
  });
}
