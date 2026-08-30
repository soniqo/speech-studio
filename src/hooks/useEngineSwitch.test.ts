import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../ipc/commands", () => ({
  initModel: vi.fn(),
  interruptModelLoad: vi.fn(),
  setTtsVariant: vi.fn(),
}));

import {
  initModel,
  interruptModelLoad,
  setTtsVariant,
  type TtsEngineInfo,
} from "../ipc/commands";
import { useProjectStore } from "../state/projectStore";
import { useEngineSwitch, useVariantSwitch } from "./useEngineSwitch";

function setModel(patch: Partial<ReturnType<typeof useProjectStore.getState>["model"]>) {
  useProjectStore.setState((s) => ({
    model: { ...s.model, ...patch },
  }));
}

beforeEach(() => {
  vi.mocked(initModel).mockReset().mockResolvedValue(undefined);
  vi.mocked(interruptModelLoad).mockReset().mockResolvedValue(undefined);
  useProjectStore.setState({ synthesisStatus: "idle" });
  setModel({ engine: "cosyvoice", status: "ready", error: undefined });
});

describe("useEngineSwitch", () => {
  it("initializes the next engine and settles on ready", async () => {
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("voxcpm2"));
    expect(initModel).toHaveBeenCalledWith("voxcpm2");
    const { model } = useProjectStore.getState();
    expect(model.engine).toBe("voxcpm2");
    expect(model.status).toBe("ready");
  });

  it("surfaces init failure as a model error for the new engine", async () => {
    vi.mocked(initModel).mockRejectedValue(new Error("download stalled"));
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("voxcpm2"));
    const { model } = useProjectStore.getState();
    expect(model.engine).toBe("voxcpm2");
    expect(model.status).toBe("error");
    expect(model.error).toContain("download stalled");
  });

  it("lets the user switch away from a failed engine", async () => {
    setModel({ engine: "indic-mio", status: "error", error: "no space left" });
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("cosyvoice"));
    expect(initModel).toHaveBeenCalledWith("cosyvoice");
    const { model } = useProjectStore.getState();
    expect(model.engine).toBe("cosyvoice");
    expect(model.status).toBe("ready");
    expect(model.error).toBeUndefined();
  });

  it("interrupts an in-flight load before switching", async () => {
    setModel({ status: "loading" });
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("voxcpm2"));
    expect(interruptModelLoad).toHaveBeenCalledTimes(1);
    expect(initModel).toHaveBeenCalledWith("voxcpm2");
  });

  it("is a no-op for the already-active engine", async () => {
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("cosyvoice"));
    expect(initModel).not.toHaveBeenCalled();
  });

  it("is a no-op while synthesis is running", async () => {
    useProjectStore.setState({ synthesisStatus: "running" });
    const { result } = renderHook(() => useEngineSwitch());
    await act(() => result.current("voxcpm2"));
    expect(initModel).not.toHaveBeenCalled();
    expect(useProjectStore.getState().model.engine).toBe("cosyvoice");
  });

  it("does not overwrite status when the user switched again mid-init", async () => {
    let resolveFirst: () => void = () => {};
    vi.mocked(initModel).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirst = resolve)),
    );
    const { result } = renderHook(() => useEngineSwitch());
    let firstSwitch: Promise<void> = Promise.resolve();
    act(() => {
      firstSwitch = result.current("voxcpm2");
    });
    // User picks a different engine while voxcpm2 is still initializing.
    setModel({ engine: "chatterbox", status: "loading" });
    resolveFirst();
    await act(() => firstSwitch);
    expect(useProjectStore.getState().model.status).toBe("loading");
  });
});

function variantEngine(selected: string): TtsEngineInfo {
  const variant = (id: string) => ({
    id,
    label: id,
    modelName: `voxcpm2-mlx-${id}`,
    modelId: `test/${id}`,
    precision: id,
  });
  return {
    id: "voxcpm2",
    displayName: "VoxCPM2",
    modelName: `voxcpm2-mlx-${selected}`,
    modelId: `test/${selected}`,
    modelSize: "1.7B",
    runtime: "MLX",
    precision: selected,
    languages: ["en"],
    voiceProfileModes: ["reference-clone"],
    requiresReferenceAudio: true,
    requiresReferenceTranscript: false,
    requiresLanguage: false,
    styleMode: "instruction",
    supportsInstruct: true,
    supportedMarkers: [],
    needsTrim: true,
    sampleRate: 48_000,
    usePolicy: "commercial-safe",
    readiness: "production",
    variants: [variant("bf16"), variant("int8")],
    selectedVariant: selected,
  };
}

describe("useVariantSwitch", () => {
  beforeEach(() => {
    vi.mocked(setTtsVariant)
      .mockReset()
      .mockImplementation(async (_engine, variant) => [variantEngine(variant)]);
    setModel({
      engine: "voxcpm2",
      engines: [variantEngine("bf16")],
      status: "ready",
      error: undefined,
    });
  });

  it("persists the choice, reloads the engine and settles on ready", async () => {
    const { result } = renderHook(() => useVariantSwitch());
    await act(() => result.current("int8"));
    expect(setTtsVariant).toHaveBeenCalledWith("voxcpm2", "int8");
    expect(initModel).toHaveBeenCalledWith("voxcpm2");
    const { model } = useProjectStore.getState();
    expect(model.engines[0].selectedVariant).toBe("int8");
    expect(model.engines[0].modelId).toBe("test/int8");
    expect(model.status).toBe("ready");
  });

  it("ignores the already selected variant and unknown ids", async () => {
    const { result } = renderHook(() => useVariantSwitch());
    await act(() => result.current("bf16"));
    await act(() => result.current("int4"));
    expect(setTtsVariant).not.toHaveBeenCalled();
    expect(initModel).not.toHaveBeenCalled();
    expect(useProjectStore.getState().model.status).toBe("ready");
  });

  it("keeps the persisted choice but reports a failed reload", async () => {
    vi.mocked(initModel).mockRejectedValue(new Error("no space left"));
    const { result } = renderHook(() => useVariantSwitch());
    await act(() => result.current("int8"));
    const { model } = useProjectStore.getState();
    expect(model.engines[0].selectedVariant).toBe("int8");
    expect(model.status).toBe("error");
    expect(model.error).toContain("no space left");
  });

  it("refuses to switch while synthesis is running", async () => {
    useProjectStore.setState({ synthesisStatus: "running" });
    const { result } = renderHook(() => useVariantSwitch());
    await act(() => result.current("int8"));
    expect(setTtsVariant).not.toHaveBeenCalled();
    expect(initModel).not.toHaveBeenCalled();
  });

  it("interrupts an in-flight load before reloading", async () => {
    setModel({ status: "loading" });
    const { result } = renderHook(() => useVariantSwitch());
    await act(() => result.current("int8"));
    expect(interruptModelLoad).toHaveBeenCalledTimes(1);
    expect(initModel).toHaveBeenCalledWith("voxcpm2");
    expect(useProjectStore.getState().model.status).toBe("ready");
  });
});
