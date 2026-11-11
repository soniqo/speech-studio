import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn().mockReturnValue("asset://test"),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

// Per-test holders so subscribeSidecarMemory tests can push snapshots.
let memoryHandler: ((event: {
  label: string;
  peakMb?: number | null;
  footprintMb?: number | null;
  rssMb?: number | null;
}) => void) | null = null;

vi.mock("../hooks/subscribeSidecarMemory", () => ({
  subscribeSidecarMemory: vi.fn((handler: never) => {
    memoryHandler = handler;
    return Promise.resolve(() => undefined);
  }),
}));

vi.mock("../hooks/useDictationRecorder", () => ({
  useDictationRecorder: () => ({
    recording: false,
    busy: false,
    error: null,
    setError: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    stopAndTranscribe: vi.fn(),
  }),
}));

vi.mock("../ipc/commands", () => ({
  cloneVoice: vi.fn(),
  deleteTtsModel: vi.fn(),
  importReferenceAudio: vi.fn(),
  initModel: vi.fn().mockResolvedValue(undefined),
  pickAudio: vi.fn(),
  probeReference: vi.fn(),
  saveAudioAs: vi.fn().mockResolvedValue(null),
  setRuntimeMode: vi.fn(),
  setTtsVariant: vi.fn(),
  speechRuntimeHealth: vi.fn().mockResolvedValue({ connected: false, detail: "offline" }),
  speechRuntimeTranscribeReference: vi.fn(),
  speechRuntimeTtsCancel: vi.fn().mockResolvedValue(undefined),
  speechRuntimeTtsLoad: vi.fn().mockResolvedValue(undefined),
  speechRuntimeTtsModels: vi.fn().mockResolvedValue({ models: [] }),
  speechRuntimeTtsSynthesize: vi.fn(),
  speechRuntimeTtsUnload: vi.fn().mockResolvedValue(undefined),
  speechRuntimeTtsVoices: vi.fn().mockResolvedValue({ voices: [] }),
  speechRuntimeTtsRegisterVoice: vi.fn(),
  speechRuntimeTtsDeleteVoice: vi.fn().mockResolvedValue(undefined),
  synthesizeClip: vi.fn(),
  ttsModelArtifact: vi.fn(),
  importTtsBundle: vi.fn(),
  runtimeModeSettings: vi.fn().mockResolvedValue({ useSharedRuntime: false }),
}));

import { VoiceCompare } from "./VoiceCompare";
import {
  runtimeModeSettings,
  setRuntimeMode,
  speechRuntimeHealth,
  speechRuntimeTtsCancel,
  speechRuntimeTtsModels,
  speechRuntimeTtsSynthesize,
  synthesizeClip,
  ttsModelArtifact,
  type TtsEngineInfo,
} from "../ipc/commands";
import { useProjectStore } from "../state/projectStore";
import { useActivityStore } from "../state/activityStore";
import type { Voice } from "../types/project";

function engineInfo(id: "qwen3" | "voxcpm2" | "espeech"): TtsEngineInfo {
  return {
    id,
    displayName: id,
    modelName: id,
    modelId: `test/${id}`,
    modelSize: "test",
    runtime: "MLX",
    precision: "bf16",
    languages: ["ru"],
    voiceProfileModes: ["reference-clone"],
    requiresReferenceAudio: true,
    requiresReferenceTranscript: true,
    requiresLanguage: false,
    styleMode: "instruction",
    supportsInstruct: false,
    supportedMarkers: [],
    needsTrim: false,
    sampleRate: 24_000,
    usePolicy: "commercial-safe",
    readiness: "production",
    variants: [],
    selectedVariant: null,
  };
}

const voice: Voice = {
  id: "voice-1",
  name: "Voice",
  sourceKind: "library",
  referenceAudioPath: "/tmp/reference.wav",
  referenceText: "Reference text.",
  createdAt: new Date().toISOString(),
};

function seedEngines() {
  useProjectStore.setState((s) => ({
    ...s,
    project: { ...s.project, voices: [voice] },
    model: { ...s.model, engines: [engineInfo("qwen3"), engineInfo("voxcpm2"), engineInfo("espeech")] },
  }));
}

function emitMemory(label: string, peakMb?: number, footprintMb?: number) {
  act(() => {
    memoryHandler?.({ label, peakMb, footprintMb, rssMb: undefined });
  });
}

function resultCard(engine: string): HTMLElement {
  const heading = screen
    .getAllByText(engine, { exact: true })
    .find((node) => node.tagName === "H3");
  return heading!.closest("div.rounded-xl") as HTMLElement;
}

/** Engine participation checkboxes in card order: qwen3, voxcpm2, espeech. */
function engineCheckboxes(): HTMLElement[] {
  return screen.getAllByRole("checkbox").slice(1);
}


beforeEach(() => {
  vi.clearAllMocks();
  memoryHandler = null;
  useActivityStore.setState({ open: false, lines: [], memory: null, logPath: null });
  useProjectStore.setState((s) => ({
    ...s,
    project: { ...s.project, voices: [voice] },
    model: { ...s.model, engines: [engineInfo("qwen3"), engineInfo("voxcpm2"), engineInfo("espeech")], status: "idle" },
    synthesisStatus: "idle" as const,
  }));
  vi.mocked(speechRuntimeHealth).mockResolvedValue({ connected: false, detail: "offline" });
  vi.mocked(runtimeModeSettings).mockResolvedValue({ useSharedRuntime: false });
  vi.mocked(speechRuntimeTtsModels).mockResolvedValue({ models: [] });
  vi.mocked(initModelDefault).mockResolvedValue(undefined);
  vi.mocked(ttsModelArtifact).mockResolvedValue({
    engine: "qwen3",
    modelId: "test/qwen3",
    paths: [],
    exists: false,
    bytes: 0,
    loaded: false,
  });
});

// Import referenced after the vi.mock declarations so the mock applies.
import { initModel as initModelDefault } from "../ipc/commands";

describe("VoiceCompare", () => {
  it("keeps per-engine results independent with one shared text", async () => {
    seedEngines();
    vi.mocked(synthesizeClip)
      .mockResolvedValueOnce({ audioPath: "/tmp/qwen.wav", durationSec: 5, elapsedSec: 1 })
      .mockResolvedValueOnce({ audioPath: "/tmp/vox.wav", durationSec: 4, elapsedSec: 2 })
      .mockResolvedValueOnce({ audioPath: "/tmp/espeech.wav", durationSec: 3, elapsedSec: 1 });
    render(<VoiceCompare />);
    const textareas = screen.getAllByRole("textbox");
    fireEvent.change(textareas[1], { target: { value: "One shared sentence." } });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(synthesizeClip).toHaveBeenCalledTimes(3));
    expect(screen.getByTitle("/tmp/qwen.wav")).toBeInTheDocument();
    expect(screen.getByTitle("/tmp/vox.wav")).toBeInTheDocument();
    expect(screen.getByTitle("/tmp/espeech.wav")).toBeInTheDocument();
    const calls = vi.mocked(synthesizeClip).mock.calls;
    expect(calls[0][0]).toMatchObject({ text: "One shared sentence.", engine: "qwen3" });
    expect(calls[1][0]).toMatchObject({ text: "One shared sentence.", engine: "voxcpm2" });
    expect(calls[2][0]).toMatchObject({ text: "One shared sentence.", engine: "espeech" });
    // Each engine synthesized against the same reference sample.
    for (const call of calls) {
      expect(call[0].referenceAudioPath).toBe("/tmp/reference.wav");
    }
  });

  it("strips RUAccent stress markup for qwen3 and voxcpm2 but keeps it for espeech", async () => {
    seedEngines();
    vi.mocked(synthesizeClip).mockResolvedValue({
      audioPath: "/tmp/x.wav", durationSec: 1, elapsedSec: 1,
    });
    render(<VoiceCompare />);
    const textareas = screen.getAllByRole("textbox");
    fireEvent.change(textareas[1], { target: { value: "Стр+ашно" } });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(synthesizeClip).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(synthesizeClip).mock.calls;
    expect(calls.find((c) => c[0].engine === "qwen3")![0].text).toBe("Страшно");
    expect(calls.find((c) => c[0].engine === "voxcpm2")![0].text).toBe("Страшно");
    expect(calls.find((c) => c[0].engine === "espeech")![0].text).toBe("Стр+ашно");
  });

  it("attributes peak memory per run, not across engines", async () => {
    seedEngines();
    let resolveQwen: ((value: { audioPath: string; durationSec: number; elapsedSec: number }) => void) | undefined;
    vi.mocked(synthesizeClip)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveQwen = resolve; }))
      .mockResolvedValue({ audioPath: "/tmp/vox.wav", durationSec: 4, elapsedSec: 1 });
    const qwenResolve = () => resolveQwen?.({ audioPath: "/tmp/qwen.wav", durationSec: 5, elapsedSec: 1 });
    render(<VoiceCompare />);
    // Uncheck voxcpm2 and espeech so only qwen3 runs.
    const checkboxes = engineCheckboxes();
    fireEvent.click(checkboxes[1]); // voxcpm2 off
    fireEvent.click(checkboxes[2]); // espeech off
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(synthesizeClip).toHaveBeenCalledTimes(1));
    emitMemory("post-load-qwen", 3000);
    emitMemory("post-qwen-synth", 3200);
    await act(async () => { qwenResolve(); });
    await waitFor(() => expect(screen.getByTitle("/tmp/qwen.wav")).toBeInTheDocument());

    // A second engine's run must not inherit the first engine's peak.
    fireEvent.click(checkboxes[1]); // voxcpm2 back on
    fireEvent.click(checkboxes[0]); // qwen3 off
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(synthesizeClip).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle("/tmp/vox.wav")).toBeInTheDocument());

    const qwenCard = resultCard("Qwen3-TTS Base 1.7B");
    const voxCard = resultCard("VoxCPM2");
    expect(qwenCard!.textContent).toContain("3.13 GB");
    expect(voxCard!.textContent).toContain("—");
    expect(voxCard!.textContent).not.toContain("3.13 GB");
  });

  it("labels the first run cold and a regenerate run warm without relabeling", async () => {
    seedEngines();
    vi.mocked(synthesizeClip)
      .mockResolvedValueOnce({ audioPath: "/tmp/qwen1.wav", durationSec: 5, elapsedSec: 2 })
      .mockResolvedValueOnce({ audioPath: "/tmp/qwen2.wav", durationSec: 5, elapsedSec: 1 });
    render(<VoiceCompare />);
    const checkboxes = engineCheckboxes();
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(screen.getByTitle("/tmp/qwen1.wav")).toBeInTheDocument());
    const card = resultCard("Qwen3-TTS Base 1.7B");
    expect(card!.textContent).toMatch(/Cold synth\s*2\.00 s/);
    expect(card!.textContent).toMatch(/Warm synth\s*—/);

    fireEvent.click(screen.getByRole("button", { name: /Regenerate/ }));
    await waitFor(() => expect(screen.getByTitle("/tmp/qwen2.wav")).toBeInTheDocument());
    const cardAfter = resultCard("Qwen3-TTS Base 1.7B");
    // Cold keeps the first-run measurement; warm gains the rerun measurement.
    expect(cardAfter!.textContent).toMatch(/Cold synth\s*2\.00 s/);
    expect(cardAfter!.textContent).toMatch(/Warm synth\s*1\.00 s/);
  });

  it("cancels a runtime-mode synthesis via the cancel wrapper", async () => {
    seedEngines();
    vi.mocked(speechRuntimeHealth).mockResolvedValue({ connected: true, detail: "ok" });
    vi.mocked(runtimeModeSettings).mockResolvedValue({ useSharedRuntime: true });
    vi.mocked(setRuntimeMode).mockResolvedValue({ useSharedRuntime: true });
    vi.mocked(speechRuntimeTtsModels).mockResolvedValue({
      models: [
        { id: "qwen3", displayName: "qwen3", modelId: "test/qwen3", languages: ["ru"], loaded: false },
      ],
    });
    let rejectSynth: ((reason?: unknown) => void) | undefined;
    vi.mocked(speechRuntimeTtsSynthesize).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSynth = reject; }),
    );
    const rejectRuntime = () => rejectSynth?.(new Error("cancelled"));
    render(<VoiceCompare />);
    await waitFor(() => expect(screen.getByText(/Synthesize all/i)).toBeEnabled());
    const checkboxes = engineCheckboxes();
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    fireEvent.click(screen.getByRole("button", { name: "Synthesize all" }));
    await waitFor(() => expect(speechRuntimeTtsSynthesize).toHaveBeenCalledTimes(1));
    const requestId = vi.mocked(speechRuntimeTtsSynthesize).mock.calls[0][0].requestId;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(speechRuntimeTtsCancel).toHaveBeenCalledWith(requestId));
    await act(async () => { rejectRuntime(); });
    await waitFor(() => expect(screen.getByText(/Synthesis was cancelled/i)).toBeInTheDocument());
  });

  it("shows a guidance row when no engine info is available", async () => {
    useProjectStore.setState((s) => ({ ...s, model: { ...s.model, engines: [] } }));
    render(<VoiceCompare />);
    expect(
      screen.getByText(/No engine info available: the local registry is empty/i),
    ).toBeInTheDocument();
  });
});
