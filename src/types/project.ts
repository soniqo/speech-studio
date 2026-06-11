// Tag names recognised by the sidecar's emotionInstructs map. Wrap a line
// with one of these (XML-style `<tag>…</tag>` or leading parenthetical
// `(tag) …`) and the sidecar passes the matching natural-language style
// instruction to VoxCPM2's `instruct` channel.
export const EMOTION_TAGS = [
  "soft",
  "warm",
  "whispering",
  "intense",
  "excited",
  "happy",
  "calm",
  "serious",
  "surprised",
  "sad",
  "angry",
  "dramatic",
  "laughs",
] as const;

export type EmotionTag = (typeof EMOTION_TAGS)[number];

export function wrapTag(text: string, tag: EmotionTag): string {
  return `<${tag}>${text}</${tag}>`;
}

export type VoiceSource = "clip-clone" | "track-clone" | "library";

export interface Voice {
  id: string;
  name: string;
  sourceKind: VoiceSource;
  referenceAudioPath?: string;
  // Qwen3-TTS ICL requires the reference clip's transcript at every synthesis
  // call. Voice is "incomplete" until this is non-empty.
  referenceText: string;
  createdAt: string;
  // Probe metadata measured at clone time (probe_reference). Absent on voices
  // created before probing existed or on sidecars without probe support.
  referenceDurationSec?: number;
  referenceSampleRate?: number;
  // Full-clip RMS in [0,1]. < 0.005 is nearly silent (clones inaudibly);
  // < 0.04 is quiet (speech-core auto-boosts it during synthesis).
  referenceRms?: number;
}

export interface ClipTake {
  id: string;
  audioPath: string;
  text: string;
  createdAt: string;
  settings: {
    voiceId: string;
  };
}

export interface Clip {
  id: string;
  trackId: string;
  startSec: number;
  endSec: number;
  text: string;
  voiceOverrideId?: string;
  locked: boolean;
  renderedAudioPath?: string;
  history: ClipTake[];
}

export interface VideoTrack {
  kind: "video";
  id: string;
  name: string;
  sourcePath: string;
}

export interface SpeakerTrack {
  kind: "speaker";
  id: string;
  name: string;
  voiceId?: string;
  referenceClipId?: string;
  clips: Clip[];
}

export interface AudioTrack {
  kind: "audio";
  id: string;
  name: string;
  sourcePath: string;
  gainDb: number;
}

export type Track = VideoTrack | SpeakerTrack | AudioTrack;

export interface Project {
  id: string;
  name: string;
  durationSec: number;
  tracks: Track[];
  voices: Voice[];
}

export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "track"; id: string }
  | { kind: "voice"; id: string }
  | { kind: "none" };

export const DEFAULT_PROJECT_DURATION_SEC = 30;

export function emptyProject(name = "Untitled"): Project {
  return {
    id: crypto.randomUUID(),
    name,
    durationSec: DEFAULT_PROJECT_DURATION_SEC,
    tracks: [],
    voices: [],
  };
}
