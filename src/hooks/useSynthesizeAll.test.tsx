import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSynthesizeAll } from "./useSynthesizeAll";
import { newClip, useProjectStore } from "../state/projectStore";
import { emptyProject, type SpeakerTrack, type Voice } from "../types/project";
import type { TtsEngineInfo } from "../ipc/commands";
import { synthesizeClip } from "../ipc/commands";

vi.mock("../ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/commands")>();
  return {
    ...actual,
    synthesizeClip: vi.fn(),
  };
});

function engineInfo(): TtsEngineInfo {
  return {
    id: "cosyvoice",
    displayName: "CosyVoice 3",
    modelName: "CosyVoice 3",
    modelId: "test/cosyvoice",
    modelSize: "test",
    runtime: "MLX",
    precision: "bf16",
    languages: ["en"],
    voiceProfileModes: ["reference-clone"],
    requiresReferenceAudio: true,
    requiresReferenceTranscript: true,
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
  };
}

beforeEach(() => {
  vi.mocked(synthesizeClip).mockReset();
  const voice: Voice = {
    id: "voice-1",
    name: "Voice",
    sourceKind: "library",
    referenceAudioPath: "/tmp/reference.wav",
    referenceText: "Reference text.",
    createdAt: new Date().toISOString(),
  };
  const clip = newClip({
    trackId: "track-1",
    startSec: 4,
    endSec: 6,
    text: "Render this line.",
  });
  const track: SpeakerTrack = {
    kind: "speaker",
    id: "track-1",
    name: "Speaker",
    voiceId: voice.id,
    clips: [clip],
  };
  useProjectStore.setState((s) => ({
    ...s,
    project: { ...emptyProject("Test"), tracks: [track], voices: [voice] },
    transport: { playing: true, positionSec: 18, zoomPxPerSec: 100 },
    synthesisStatus: "idle",
    synthesisProgress: null,
    model: {
      ...s.model,
      engine: "cosyvoice",
      engines: [engineInfo()],
      status: "ready",
    },
  }));
});

describe("useSynthesizeAll", () => {
  it("pauses and seeks to regenerated audio before replacing clip media", async () => {
    vi.mocked(synthesizeClip).mockResolvedValue({
      audioPath: "/tmp/rendered-new.wav",
      durationSec: 2.5,
      elapsedSec: 1.25,
    });

    const { result } = renderHook(() => useSynthesizeAll());
    let synthResult: Awaited<ReturnType<typeof result.current.run>> | undefined;

    await act(async () => {
      synthResult = await result.current.run("all");
    });

    expect(synthResult).toEqual({ total: 1, completed: 1, failed: 0 });
    const state = useProjectStore.getState();
    expect(state.transport.playing).toBe(false);
    expect(state.transport.positionSec).toBe(4);
    const updatedTrack = state.project.tracks[0] as SpeakerTrack;
    expect(updatedTrack.clips[0].renderedAudioPath).toBe("/tmp/rendered-new.wav");
  });
});
