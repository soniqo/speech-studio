import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../ipc/commands", () => ({
  initModel: vi.fn(),
  interruptModelLoad: vi.fn(),
}));

import { initModel, interruptModelLoad } from "../ipc/commands";
import { useProjectStore } from "../state/projectStore";
import { useEngineSwitch } from "./useEngineSwitch";

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
