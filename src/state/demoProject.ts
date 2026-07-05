import { seedDemo, seedHindiDemo, type DemoSeed } from "../ipc/commands";
import type { Clip, Project, SpeakerTrack, VideoTrack, Voice } from "../types/project";

// Demo clip start times (sec). Index matches the order returned by seed_demo,
// which alternates Anna (speakerIndex=0) and Marek (speakerIndex=1).
const CLIP_START_TIMES = [0.5, 4.0, 8.2, 12.0];
// Approximate per-clip length used for the empty (un-synthesized) slot. The
// user can resize a clip after Regenerating; once audio lands, the audio
// scheduler plays exactly the rendered duration regardless of slot length.
const DEFAULT_CLIP_DURATION = 4.0;

function makeClips(
  seed: DemoSeed,
  voiceIds: string[],
  trackIds: string[],
  clipStartTimes: number[],
  now: string,
): Clip[][] {
  const clipsBySpeaker = trackIds.map((): Clip[] => []);

  seed.clips.forEach((sc, idx) => {
    const startSec = clipStartTimes[idx] ?? idx * 4;
    const slotDuration =
      sc.durationSec && sc.durationSec > 0 ? sc.durationSec : DEFAULT_CLIP_DURATION;
    const endSec = startSec + slotDuration;
    const speakerIndex = Math.min(sc.speakerIndex, trackIds.length - 1);
    const trackId = trackIds[speakerIndex];
    const voiceId = voiceIds[speakerIndex];
    const history =
      sc.audioPath !== undefined
        ? [
            {
              id: crypto.randomUUID(),
              audioPath: sc.audioPath,
              text: sc.text,
              createdAt: now,
              settings: { voiceId },
            },
          ]
        : [];
    clipsBySpeaker[speakerIndex].push({
      id: crypto.randomUUID(),
      trackId,
      startSec,
      endSec,
      text: sc.text,
      locked: false,
      renderedAudioPath: sc.audioPath,
      history,
    });
  });

  return clipsBySpeaker;
}

export async function buildDemoProject(): Promise<Project> {
  // Lazy demo: seed_demo only generates the `say` reference clips (~1s) and
  // returns voice + clip metadata. Synthesis happens on-demand when the user
  // clicks Regenerate on a clip. Any clips already cached on disk come back
  // with an audioPath populated, so a second Load demo in the same session
  // surfaces previously-rendered audio immediately.
  const seed = await seedDemo();

  const now = new Date().toISOString();

  const voiceA: Voice = {
    id: crypto.randomUUID(),
    name: "Narrator (Anna)",
    sourceKind: "library",
    referenceAudioPath: seed.voices[0].referenceAudioPath,
    referenceText: seed.voices[0].referenceText,
    createdAt: now,
  };
  const voiceB: Voice = {
    id: crypto.randomUUID(),
    name: "Antagonist (Marek)",
    sourceKind: "library",
    referenceAudioPath: seed.voices[1].referenceAudioPath,
    referenceText: seed.voices[1].referenceText,
    createdAt: now,
  };

  const speakerAId = crypto.randomUUID();
  const speakerBId = crypto.randomUUID();
  const videoId = crypto.randomUUID();

  const [annaClips, marekClips] = makeClips(
    seed,
    [voiceA.id, voiceB.id],
    [speakerAId, speakerBId],
    CLIP_START_TIMES,
    now,
  );

  const speakerA: SpeakerTrack = {
    kind: "speaker",
    id: speakerAId,
    name: "Anna",
    voiceId: voiceA.id,
    clips: annaClips,
  };
  const speakerB: SpeakerTrack = {
    kind: "speaker",
    id: speakerBId,
    name: "Marek",
    voiceId: voiceB.id,
    clips: marekClips,
  };

  const video: VideoTrack = {
    kind: "video",
    id: videoId,
    name: "Scene 04 — final cut",
    sourcePath: "/demo/scene-04.mp4",
  };

  const durationSec = Math.max(
    18,
    ...annaClips.map((c) => c.endSec),
    ...marekClips.map((c) => c.endSec),
  );

  return {
    id: crypto.randomUUID(),
    name: "Demo — Scene 04",
    durationSec,
    voices: [voiceA, voiceB],
    tracks: [video, speakerA, speakerB],
  };
}

export async function buildHindiDemoProject(): Promise<Project> {
  const seed = await seedHindiDemo();

  const now = new Date().toISOString();
  const voiceA: Voice = {
    id: crypto.randomUUID(),
    name: "Hindi Reference Voice (Male)",
    sourceKind: "library",
    referenceAudioPath: seed.voices[0].referenceAudioPath,
    referenceText: seed.voices[0].referenceText,
    createdAt: now,
  };
  const voiceB: Voice = {
    id: crypto.randomUUID(),
    name: "Hindi Reference Voice (Female)",
    sourceKind: "library",
    referenceAudioPath: seed.voices[1].referenceAudioPath,
    referenceText: seed.voices[1].referenceText,
    createdAt: now,
  };

  const speakerAId = crypto.randomUUID();
  const speakerBId = crypto.randomUUID();
  const videoId = crypto.randomUUID();
  const [maleClips, femaleClips] = makeClips(
    seed,
    [voiceA.id, voiceB.id],
    [speakerAId, speakerBId],
    [0.5, 4.5, 8.8, 13.4],
    now,
  );

  const speakerA: SpeakerTrack = {
    kind: "speaker",
    id: speakerAId,
    name: "Hindi Narration",
    voiceId: voiceA.id,
    clips: maleClips,
  };
  const speakerB: SpeakerTrack = {
    kind: "speaker",
    id: speakerBId,
    name: "Hindi Narration 2",
    voiceId: voiceB.id,
    clips: femaleClips,
  };

  const video: VideoTrack = {
    kind: "video",
    id: videoId,
    name: "Hindi voice clone test",
    sourcePath: "/demo/hindi-voice-clone.mp4",
  };

  const durationSec = Math.max(
    18,
    ...maleClips.map((c) => c.endSec),
    ...femaleClips.map((c) => c.endSec),
  );

  return {
    id: crypto.randomUUID(),
    name: "Hindi Demo — Voice Clone",
    durationSec,
    voices: [voiceA, voiceB],
    tracks: [video, speakerA, speakerB],
  };
}
