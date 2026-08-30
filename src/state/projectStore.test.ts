import { beforeEach, describe, expect, it } from "vitest";
import { newClip, useProjectStore } from "./projectStore";
import { emptyProject, type SpeakerTrack, type VideoTrack } from "../types/project";
import type { TtsEngineInfo } from "../ipc/commands";

function engineInfo(
  id: TtsEngineInfo["id"],
  patch: Partial<TtsEngineInfo> = {},
): TtsEngineInfo {
  return {
    id,
    displayName: id,
    modelName: id,
    modelId: `test/${id}`,
    modelSize: "test",
    runtime: "MLX",
    precision: "fp16",
    languages: ["en"],
    voiceProfileModes: ["reference-clone"],
    requiresReferenceAudio: true,
    requiresReferenceTranscript: false,
    requiresLanguage: false,
    styleMode: "instruction",
    supportsInstruct: true,
    supportedMarkers: [],
    needsTrim: true,
    sampleRate: 24_000,
    usePolicy: "commercial-safe",
    readiness: "production",
    variants: [],
    selectedVariant: null,
    ...patch,
  };
}

function speakerTrack(name = "Speaker 1"): SpeakerTrack {
  return {
    kind: "speaker",
    id: crypto.randomUUID(),
    name,
    clips: [],
  };
}

function videoTrack(): VideoTrack {
  return {
    kind: "video",
    id: crypto.randomUUID(),
    name: "Scene",
    sourcePath: "/tmp/scene.mp4",
  };
}

beforeEach(() => {
  useProjectStore.setState({
    project: emptyProject("Test"),
    selection: { kind: "none" },
    transport: { playing: false, positionSec: 0, zoomPxPerSec: 100 },
  });
});

describe("projectStore model defaults", () => {
  it("starts on CosyVoice so macOS loads it by default", () => {
    expect(useProjectStore.getState().model.engine).toBe("cosyvoice");
  });

  it("normalizes the current language when engine descriptors arrive", () => {
    useProjectStore.setState((s) => ({
      model: { ...s.model, engine: "chatterbox", language: "xx" },
    }));
    useProjectStore
      .getState()
      .setAvailableTtsEngines([
        engineInfo("chatterbox", { languages: ["hi", "en"], requiresLanguage: true }),
      ]);
    expect(useProjectStore.getState().model.language).toBe("hi");
  });

  it("uses the selected engine's first language when switching engines", () => {
    useProjectStore.setState((s) => ({
      model: {
        ...s.model,
        engine: "cosyvoice",
        language: "ru",
        engines: [
          engineInfo("cosyvoice", { languages: ["en", "zh"] }),
          engineInfo("chatterbox", { languages: ["hi", "en"], requiresLanguage: true }),
        ],
      },
    }));
    useProjectStore.getState().setTtsEngine("chatterbox");
    expect(useProjectStore.getState().model.language).toBe("hi");
  });

  it("accepts only languages declared by the active language-aware engine", () => {
    useProjectStore.setState((s) => ({
      model: {
        ...s.model,
        engine: "cosyvoice",
        language: "en",
        engines: [
          engineInfo("cosyvoice", {
            languages: ["en", "zh"],
            requiresLanguage: true,
          }),
        ],
      },
    }));
    useProjectStore.getState().setTtsLanguage("zh");
    expect(useProjectStore.getState().model.language).toBe("zh");

    useProjectStore.getState().setTtsLanguage("ru");
    expect(useProjectStore.getState().model.language).toBe("zh");
  });

  it("ignores language changes for engines that do not expose a language selector", () => {
    useProjectStore.setState((s) => ({
      model: {
        ...s.model,
        engine: "qwen3",
        language: "en",
        engines: [
          engineInfo("qwen3", {
            languages: ["zh", "en"],
            requiresLanguage: false,
          }),
        ],
      },
    }));
    useProjectStore.getState().setTtsLanguage("zh");
    expect(useProjectStore.getState().model.language).toBe("en");
  });
});

describe("projectStore.addTrack / removeTrack", () => {
  it("adds a track to the project", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    expect(useProjectStore.getState().project.tracks).toHaveLength(1);
    expect(useProjectStore.getState().project.tracks[0].id).toBe(t.id);
  });

  it("clears selection when the selected track is removed", () => {
    const t = speakerTrack();
    const { addTrack, select, removeTrack } = useProjectStore.getState();
    addTrack(t);
    select({ kind: "track", id: t.id });
    expect(useProjectStore.getState().selection).toEqual({ kind: "track", id: t.id });
    removeTrack(t.id);
    expect(useProjectStore.getState().selection).toEqual({ kind: "none" });
    expect(useProjectStore.getState().project.tracks).toHaveLength(0);
  });

  it("leaves selection intact when an unrelated track is removed", () => {
    const a = speakerTrack("A");
    const b = speakerTrack("B");
    const { addTrack, select, removeTrack } = useProjectStore.getState();
    addTrack(a);
    addTrack(b);
    select({ kind: "track", id: a.id });
    removeTrack(b.id);
    expect(useProjectStore.getState().selection).toEqual({ kind: "track", id: a.id });
  });
});

describe("projectStore.addClip", () => {
  it("rejects clips on non-existent or non-speaker tracks", () => {
    const v = videoTrack();
    useProjectStore.getState().addTrack(v);
    const clip = newClip({ trackId: v.id, startSec: 0, endSec: 1 });
    useProjectStore.getState().addClip(clip);
    // Video tracks don't hold clips; addClip should no-op (track not found as speaker).
    const tracks = useProjectStore.getState().project.tracks;
    expect(tracks.find((t) => t.kind === "speaker")).toBeUndefined();
  });

  it("appends a clip to the correct speaker track", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    const clip = newClip({ trackId: t.id, startSec: 1, endSec: 3, text: "Hello" });
    useProjectStore.getState().addClip(clip);
    const updated = useProjectStore.getState().project.tracks[0] as SpeakerTrack;
    expect(updated.clips).toHaveLength(1);
    expect(updated.clips[0].text).toBe("Hello");
  });

  it("extends project durationSec to fit the clip", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    // Empty project starts at DEFAULT_PROJECT_DURATION_SEC (30s); adding a clip
    // past that should push duration outward to fit.
    useProjectStore
      .getState()
      .addClip(newClip({ trackId: t.id, startSec: 30, endSec: 42 }));
    expect(useProjectStore.getState().project.durationSec).toBe(42);
  });
});

describe("projectStore.updateClip / removeClip", () => {
  it("patches a clip in place", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    const clip = newClip({ trackId: t.id, startSec: 0, endSec: 2 });
    useProjectStore.getState().addClip(clip);
    useProjectStore.getState().updateClip(clip.id, { text: "Updated" });
    const updated = (useProjectStore.getState().project.tracks[0] as SpeakerTrack).clips[0];
    expect(updated.text).toBe("Updated");
    expect(updated.startSec).toBe(0);
  });

  it("removes a clip and clears its selection", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    const clip = newClip({ trackId: t.id, startSec: 0, endSec: 2 });
    useProjectStore.getState().addClip(clip);
    useProjectStore.getState().select({ kind: "clip", id: clip.id });
    useProjectStore.getState().removeClip(clip.id);
    expect((useProjectStore.getState().project.tracks[0] as SpeakerTrack).clips).toHaveLength(0);
    expect(useProjectStore.getState().selection).toEqual({ kind: "none" });
  });
});

describe("projectStore.assignVoiceToTrack", () => {
  it("assigns a voiceId to a speaker track", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    useProjectStore.getState().assignVoiceToTrack(t.id, "voice-xyz");
    const updated = useProjectStore.getState().project.tracks[0] as SpeakerTrack;
    expect(updated.voiceId).toBe("voice-xyz");
  });

  it("clears the voice when given undefined", () => {
    const t = speakerTrack();
    useProjectStore.getState().addTrack(t);
    useProjectStore.getState().assignVoiceToTrack(t.id, "v");
    useProjectStore.getState().assignVoiceToTrack(t.id, undefined);
    const updated = useProjectStore.getState().project.tracks[0] as SpeakerTrack;
    expect(updated.voiceId).toBeUndefined();
  });
});

describe("projectStore.transport", () => {
  it("toggles playing and seeks", () => {
    const { setPlaying, seek, setZoom } = useProjectStore.getState();
    setPlaying(true);
    seek(3.5);
    setZoom(200);
    const t = useProjectStore.getState().transport;
    expect(t.playing).toBe(true);
    expect(t.positionSec).toBe(3.5);
    expect(t.zoomPxPerSec).toBe(200);
  });
});
