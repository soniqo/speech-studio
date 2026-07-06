import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../ipc/commands", () => ({
  exportProject: vi.fn(),
  initModel: vi.fn().mockResolvedValue(undefined),
  interruptModelLoad: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./ProjectsMenu", () => ({ ProjectsMenu: () => null }));
vi.mock("./DevPing", () => ({ DevPing: () => null }));
vi.mock("../hooks/useSynthesizeAll", () => ({
  useSynthesizeAll: () => ({ run: vi.fn() }),
  useUnsynthesizedCount: () => 0,
}));
vi.mock("../hooks/useProjectSave", () => ({
  useProjectSave: () => ({ dirty: false, saving: false, saveNow: vi.fn() }),
}));
vi.mock("../hooks/useUpdater", () => ({
  useUpdater: () => ({ status: "idle", version: "", progress: null, install: vi.fn() }),
}));

import { TopBar } from "./TopBar";
import { initModel } from "../ipc/commands";
import { useProjectStore, type ModelStatus } from "../state/projectStore";
import type { TtsEngineInfo } from "../ipc/commands";

// Radix Select content relies on DOM APIs jsdom doesn't implement.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

function engineInfo(id: string, displayName: string): TtsEngineInfo {
  return {
    id: id as TtsEngineInfo["id"],
    displayName,
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
  };
}

function seedModel(status: ModelStatus, error?: string) {
  useProjectStore.setState((s) => ({
    synthesisStatus: "idle",
    model: {
      ...s.model,
      engine: "indic-mio",
      language: "en",
      engines: [
        engineInfo("indic-mio", "Indic-Mio"),
        engineInfo("cosyvoice", "CosyVoice 3"),
        engineInfo("voxcpm2", "VoxCPM2"),
      ],
      status,
      error,
    },
  }));
}

describe("TopBar model-error recovery", () => {
  beforeEach(() => {
    vi.mocked(initModel).mockClear();
  });

  it("offers picking another model when the load failed", () => {
    seedModel("error", "download stalled");
    render(<TopBar />);
    const button = screen.getByRole("button", { name: "Pick another model" });
    fireEvent.click(button);
    // The engine dropdown opens with the alternatives listed.
    expect(screen.getByRole("option", { name: "CosyVoice 3" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "VoxCPM2" })).toBeInTheDocument();
  });

  it("initializes the newly picked engine from the error state", () => {
    seedModel("error", "download stalled");
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Pick another model" }));
    fireEvent.click(screen.getByRole("option", { name: "CosyVoice 3" }));
    expect(initModel).toHaveBeenCalledWith("cosyvoice");
    expect(useProjectStore.getState().model.engine).toBe("cosyvoice");
  });

  it("does not show the recovery button while the model is healthy", () => {
    seedModel("ready");
    render(<TopBar />);
    expect(
      screen.queryByRole("button", { name: "Pick another model" }),
    ).not.toBeInTheDocument();
  });
});
