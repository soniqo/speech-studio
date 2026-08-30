import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ScriptEditor } from "./ScriptEditor";
import { EMOTION_TAGS } from "../types/project";
import { useProjectStore } from "../state/projectStore";
import type { TtsEngineInfo } from "../ipc/commands";
import { useDictationRecorder } from "../hooks/useDictationRecorder";

vi.mock("../hooks/useDictationRecorder", () => ({
  useDictationRecorder: vi.fn(),
}));

const defaultRecorder = {
  recording: false,
  busy: false,
  error: null,
  setError: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  stopAndTranscribe: vi.fn(),
};

function mockRecorder(patch: Partial<typeof defaultRecorder> = {}) {
  vi.mocked(useDictationRecorder).mockReturnValue({ ...defaultRecorder, ...patch });
}

function engineInfo(patch: Partial<TtsEngineInfo> & Pick<TtsEngineInfo, "id" | "displayName">): TtsEngineInfo {
  return {
    modelName: patch.id,
    modelId: `test/${patch.id}`,
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
    supportedMarkers: [...EMOTION_TAGS],
    needsTrim: true,
    sampleRate: 24_000,
    usePolicy: "commercial-safe",
    readiness: "production",
    variants: [],
    selectedVariant: null,
    ...patch,
  };
}

describe("ScriptEditor", () => {
  beforeEach(() => {
    mockRecorder();
    useProjectStore.setState({
      model: {
        engine: "voxcpm2",
        language: "en",
        engines: [],
        status: "idle",
      },
    });
  });

  it("prefixes the line with a parenthetical emotion tag when one is clicked", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="Hello world" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("(excited) Hello world");
  });

  it("replaces an existing parenthetical tag instead of stacking", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="(whispering) Just stay quiet." onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("(excited) Just stay quiet.");
  });

  it("removes the existing tag when its own button is clicked again", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="(whispering) Just stay quiet." onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "whispering" }));
    expect(onChange).toHaveBeenCalledWith("Just stay quiet.");
  });

  it("replaces legacy XML-style tags too", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="<whisper>Hush now.</whisper>" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "soft" }));
    expect(onChange).toHaveBeenCalledWith("(soft) Hush now.");
  });

  it("renders one button per emotion tag", () => {
    render(<ScriptEditor value="" onChange={() => {}} />);
    const palette = within(screen.getByTestId("emotion-markers"));
    expect(palette.getAllByRole("button")).toHaveLength(EMOTION_TAGS.length);
  });

  it("uses Indic-Mio suffix tags when the active engine asks for suffix markers", () => {
    useProjectStore.setState({
      model: {
        engine: "indic-mio",
        language: "hi",
        engines: [
          engineInfo({
            id: "indic-mio",
            displayName: "Indic-Mio",
            requiresReferenceTranscript: false,
            requiresLanguage: false,
            styleMode: "suffix-tag",
            supportsInstruct: false,
            supportedMarkers: ["happy", "sad", "angry"],
          }),
        ],
        status: "ready",
      },
    });
    const onChange = vi.fn();
    render(<ScriptEditor value="नमस्ते" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "angry" }));
    expect(onChange).toHaveBeenCalledWith("नमस्ते <angry>");
  });

  it("uses Fish Audio bracket tags when the active engine asks for bracket markers", () => {
    useProjectStore.setState({
      model: {
        engine: "fish-audio",
        language: "en",
        engines: [
          engineInfo({
            id: "fish-audio",
            displayName: "Fish Audio S2 Pro",
            requiresReferenceTranscript: true,
            requiresLanguage: false,
            styleMode: "bracket-tag",
            supportsInstruct: false,
            supportedMarkers: ["sad", "excited"],
          }),
        ],
        status: "ready",
      },
    });
    const onChange = vi.fn();
    render(<ScriptEditor value="[sad] नमस्ते" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("[excited] नमस्ते");
  });

  it("uses the engine-provided marker palette", () => {
    useProjectStore.setState({
      model: {
        engine: "fish-audio",
        language: "en",
        engines: [
          engineInfo({
            id: "fish-audio",
            displayName: "Fish Audio S2 Pro",
            styleMode: "bracket-tag",
            supportedMarkers: ["whisper", "excited"],
          }),
        ],
        status: "ready",
      },
    });
    render(<ScriptEditor value="" onChange={() => {}} />);
    const palette = within(screen.getByTestId("emotion-markers"));
    expect(palette.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "whisper",
      "excited",
    ]);
  });

  it("does not render marker buttons when the active engine ignores markers", () => {
    useProjectStore.setState({
      model: {
        engine: "qwen3",
        language: "en",
        engines: [
          engineInfo({
            id: "qwen3",
            displayName: "Qwen3-TTS",
            styleMode: "none",
            supportsInstruct: false,
            supportedMarkers: [],
          }),
        ],
        status: "ready",
      },
    });
    render(<ScriptEditor value="Hello" onChange={() => {}} />);
    const palette = within(screen.getByTestId("emotion-markers"));
    expect(palette.queryAllByRole("button")).toHaveLength(0);
  });

  it("starts recording when the mic is clicked on an idle editor", () => {
    const start = vi.fn();
    mockRecorder({ recording: false, start });
    render(<ScriptEditor value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dictate/i }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("appends the transcript to an existing line when recording stops", async () => {
    const onChange = vi.fn();
    const stopAndTranscribe = vi.fn().mockResolvedValue({
      audioPath: "/tmp/a.wav",
      durationSec: 1,
      elapsedSec: 0.5,
      text: "and then we leave.",
    });
    mockRecorder({ recording: true, stopAndTranscribe });
    render(<ScriptEditor value="(calm) Stay here" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("(calm) Stay here and then we leave."),
    );
  });

  it("fills an empty line with the transcript verbatim", async () => {
    const onChange = vi.fn();
    const stopAndTranscribe = vi.fn().mockResolvedValue({
      audioPath: "/tmp/a.wav",
      durationSec: 1,
      elapsedSec: 0.5,
      text: "Fresh dictated line.",
    });
    mockRecorder({ recording: true, stopAndTranscribe });
    render(<ScriptEditor value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("Fresh dictated line."),
    );
  });
});
