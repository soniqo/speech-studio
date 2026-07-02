import { create } from "zustand";
import {
  Clip,
  Project,
  Selection,
  SpeakerTrack,
  Track,
  Voice,
  emptyProject,
} from "../types/project";
import type { TtsEngineId, TtsEngineInfo } from "../ipc/commands";
import {
  detectInitialLocale,
  isDefaultProjectName,
  messages,
  storeLocale,
  type AppLocale,
} from "../i18n/messages";

interface TransportState {
  playing: boolean;
  positionSec: number;
  zoomPxPerSec: number;
}

export type ModelStatus = "idle" | "loading" | "ready" | "error";

export interface ModelLoadProgress {
  progress: number;
  percent: number;
  message: string;
  updatedAt: number;
}

interface ModelState {
  engine: TtsEngineId;
  /** Synthesis language id for engines that need one (Chatterbox `[lang]`). */
  language: string;
  engines: TtsEngineInfo[];
  status: ModelStatus;
  error?: string;
  loadingStartedAt?: number;
  lastLoadDurationSec?: number;
  progress?: ModelLoadProgress;
}

export interface DemoProgress {
  phase: "references" | "synthesis" | "done";
  current: number;
  total: number;
  message: string;
}

export interface SynthesisProgress {
  current: number;
  total: number;
  label: string;
  startedAt: number;
  lastElapsedSec?: number;
}

interface ProjectStore {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  project: Project;
  selection: Selection;
  transport: TransportState;
  model: ModelState;
  setModelStatus: (status: ModelStatus, error?: string) => void;
  setModelProgress: (progress: Omit<ModelLoadProgress, "updatedAt">) => void;
  setTtsEngine: (engine: TtsEngineId) => void;
  setTtsLanguage: (language: string) => void;
  setAvailableTtsEngines: (engines: TtsEngineInfo[]) => void;

  demoProgress: DemoProgress | null;
  setDemoProgress: (p: DemoProgress | null) => void;

  synthesisStatus: "idle" | "running";
  synthesisProgress: SynthesisProgress | null;
  setSynthesisStatus: (s: "idle" | "running") => void;
  setSynthesisProgress: (p: SynthesisProgress | null) => void;

  setProject: (project: Project) => void;
  renameProject: (name: string) => void;
  resetProject: (name?: string) => void;

  // JSON snapshot of the project at last save/load; null = never saved this
  // session. Components derive dirty as:
  //   savedSnapshot ? JSON.stringify(project) !== savedSnapshot
  //                 : project has any content
  savedSnapshot: string | null;
  markSaved: (snapshot: string) => void;

  addTrack: (track: Track) => void;
  removeTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;

  addClip: (clip: Clip) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  removeClip: (clipId: string) => void;

  addVoice: (voice: Voice) => void;
  removeVoice: (voiceId: string) => void;
  assignVoiceToTrack: (trackId: string, voiceId: string | undefined) => void;

  select: (selection: Selection) => void;

  setPlaying: (playing: boolean) => void;
  seek: (positionSec: number) => void;
  setZoom: (zoomPxPerSec: number) => void;
}

function findSpeakerTrack(project: Project, trackId: string): SpeakerTrack | undefined {
  const t = project.tracks.find((x) => x.id === trackId);
  return t && t.kind === "speaker" ? t : undefined;
}

function mapTracks(
  project: Project,
  trackId: string,
  fn: (track: Track) => Track,
): Track[] {
  return project.tracks.map((t) => (t.id === trackId ? fn(t) : t));
}

function mapSpeakerClips(
  project: Project,
  trackId: string,
  fn: (clips: Clip[]) => Clip[],
): Track[] {
  return project.tracks.map((t) =>
    t.kind === "speaker" && t.id === trackId ? { ...t, clips: fn(t.clips) } : t,
  );
}

function findClipTrack(project: Project, clipId: string): SpeakerTrack | undefined {
  for (const t of project.tracks) {
    if (t.kind === "speaker" && t.clips.some((c) => c.id === clipId)) return t;
  }
  return undefined;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  locale: detectInitialLocale(),
  setLocale: (locale) =>
    set((s) => {
      storeLocale(locale);
      const nextDefaultName = messages[locale].defaults.untitledProject;
      const project = isDefaultProjectName(s.project.name)
        ? { ...s.project, name: nextDefaultName }
        : s.project;
      const wasClean = s.savedSnapshot === JSON.stringify(s.project);
      const savedSnapshot =
        wasClean && project !== s.project ? JSON.stringify(project) : s.savedSnapshot;
      return { locale, project, savedSnapshot };
    }),
  project: emptyProject(messages[detectInitialLocale()].defaults.untitledProject),
  selection: { kind: "none" },
  transport: { playing: false, positionSec: 0, zoomPxPerSec: 100 },
  model: {
    engine: "cosyvoice",
    language: "en",
    engines: [],
    status: "idle",
  },
  setModelStatus: (status, error) =>
    set((s) => {
      const now = Date.now();
      const loadingStartedAt =
        status === "loading" ? now : s.model.loadingStartedAt;
      const lastLoadDurationSec =
        status === "ready" || status === "error"
          ? s.model.loadingStartedAt
            ? (now - s.model.loadingStartedAt) / 1000
            : s.model.lastLoadDurationSec
          : s.model.lastLoadDurationSec;
      return {
        model: {
          ...s.model,
          status,
          error,
          loadingStartedAt: status === "loading" ? loadingStartedAt : undefined,
          lastLoadDurationSec,
          progress:
            status === "loading"
              ? {
                  progress: 0,
                  percent: 0,
                  message: messages.en.model.preparingDownload,
                  updatedAt: now,
                }
              : undefined,
        },
      };
    }),
  setModelProgress: (progress) =>
    set((s) =>
      s.model.status === "loading"
        ? {
            model: {
              ...s.model,
              progress: { ...progress, updatedAt: Date.now() },
            },
          }
        : s,
    ),
  setTtsEngine: (engine) =>
    set((s) => ({
      model: {
        ...s.model,
        engine,
        language: engine === "indic-mio" ? "hi" : s.model.language,
        error: undefined,
      },
    })),
  setTtsLanguage: (language) =>
    set((s) => ({ model: { ...s.model, language, error: undefined } })),
  setAvailableTtsEngines: (engines) =>
    set((s) => ({ model: { ...s.model, engines } })),

  demoProgress: null,
  setDemoProgress: (p) => set(() => ({ demoProgress: p })),

  synthesisStatus: "idle",
  synthesisProgress: null,
  setSynthesisStatus: (synthesisStatus) => set(() => ({ synthesisStatus })),
  setSynthesisProgress: (synthesisProgress) => set(() => ({ synthesisProgress })),

  setProject: (project) => set({ project, selection: { kind: "none" } }),
  resetProject: (name) =>
    set((s) => {
      const project = emptyProject(name ?? messages[s.locale].defaults.untitledProject);
      return {
        project,
        selection: { kind: "none" } as Selection,
        // A fresh empty project is "clean" — never prompts to save.
        savedSnapshot: JSON.stringify(project),
      };
    }),

  savedSnapshot: null,
  markSaved: (snapshot) => set(() => ({ savedSnapshot: snapshot })),

  // Functional update: safe to call while synthesis is mutating clips —
  // a spread-from-render setProject({...project, name}) could clobber
  // concurrent clip updates with stale state.
  renameProject: (name) => set((s) => ({ project: { ...s.project, name } })),

  addTrack: (track) =>
    set((s) => ({ project: { ...s.project, tracks: [...s.project.tracks, track] } })),

  removeTrack: (trackId) =>
    set((s) => ({
      project: { ...s.project, tracks: s.project.tracks.filter((t) => t.id !== trackId) },
      selection:
        s.selection.kind === "track" && s.selection.id === trackId
          ? { kind: "none" }
          : s.selection,
    })),

  renameTrack: (trackId, name) =>
    set((s) => ({
      project: { ...s.project, tracks: mapTracks(s.project, trackId, (t) => ({ ...t, name })) },
    })),

  addClip: (clip) =>
    set((s) => {
      const track = findSpeakerTrack(s.project, clip.trackId);
      if (!track) return s;
      return {
        project: {
          ...s.project,
          tracks: mapSpeakerClips(s.project, clip.trackId, (clips) => [...clips, clip]),
          durationSec: Math.max(s.project.durationSec, clip.endSec),
        },
      };
    }),

  updateClip: (clipId, patch) =>
    set((s) => {
      const track = findClipTrack(s.project, clipId);
      if (!track) return s;
      return {
        project: {
          ...s.project,
          tracks: mapSpeakerClips(s.project, track.id, (clips) =>
            clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
          ),
        },
      };
    }),

  removeClip: (clipId) =>
    set((s) => {
      const track = findClipTrack(s.project, clipId);
      if (!track) return s;
      return {
        project: {
          ...s.project,
          tracks: mapSpeakerClips(s.project, track.id, (clips) =>
            clips.filter((c) => c.id !== clipId),
          ),
        },
        selection:
          s.selection.kind === "clip" && s.selection.id === clipId
            ? { kind: "none" }
            : s.selection,
      };
    }),

  addVoice: (voice) =>
    set((s) => ({ project: { ...s.project, voices: [...s.project.voices, voice] } })),

  // Removing a voice also unassigns it everywhere it's referenced (speaker
  // tracks and per-clip overrides) so nothing dangles; affected clips show
  // as voiceless and synthesis for them is disabled until reassigned.
  removeVoice: (voiceId) =>
    set((s) => ({
      project: {
        ...s.project,
        voices: s.project.voices.filter((v) => v.id !== voiceId),
        tracks: s.project.tracks.map((t) =>
          t.kind === "speaker"
            ? {
                ...t,
                voiceId: t.voiceId === voiceId ? undefined : t.voiceId,
                clips: t.clips.map((c) =>
                  c.voiceOverrideId === voiceId ? { ...c, voiceOverrideId: undefined } : c,
                ),
              }
            : t,
        ),
      },
      selection:
        s.selection.kind === "voice" && s.selection.id === voiceId
          ? { kind: "none" }
          : s.selection,
    })),

  assignVoiceToTrack: (trackId, voiceId) =>
    set((s) => ({
      project: {
        ...s.project,
        tracks: mapTracks(s.project, trackId, (t) =>
          t.kind === "speaker" ? { ...t, voiceId } : t,
        ),
      },
    })),

  select: (selection) => set({ selection }),

  setPlaying: (playing) => set((s) => ({ transport: { ...s.transport, playing } })),
  seek: (positionSec) => set((s) => ({ transport: { ...s.transport, positionSec } })),
  setZoom: (zoomPxPerSec) => set((s) => ({ transport: { ...s.transport, zoomPxPerSec } })),
}));

export function newClip(opts: {
  trackId: string;
  startSec: number;
  endSec: number;
  text?: string;

}): Clip {
  return {
    id: crypto.randomUUID(),
    trackId: opts.trackId,
    startSec: opts.startSec,
    endSec: opts.endSec,
    text: opts.text ?? "",

    locked: false,
    history: [],
  };
}
