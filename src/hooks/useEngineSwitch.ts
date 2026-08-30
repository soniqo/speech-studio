import { useCallback } from "react";
import { useProjectStore } from "../state/projectStore";
import {
  initModel,
  interruptModelLoad,
  setTtsVariant,
  type TtsEngineId,
} from "../ipc/commands";

// Shared engine-switch flow: flip the store, (re)initialize the sidecar model,
// and settle status — used by the TopBar selector and by flows that switch
// engines programmatically (e.g. the Hindi demo). Interrupts an in-flight
// load so switching away from a stalled download always works. Status updates
// are guarded against the user switching again mid-init: only the request
// that still matches the active engine writes the outcome.
export function useEngineSwitch() {
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);
  const setModelStatus = useProjectStore((s) => s.setModelStatus);

  return useCallback(
    async (next: TtsEngineId) => {
      const state = useProjectStore.getState();
      if (next === state.model.engine || state.synthesisStatus === "running") {
        return;
      }
      const wasLoading = state.model.status === "loading";
      setTtsEngine(next);
      setModelStatus("loading");
      try {
        if (wasLoading) {
          await interruptModelLoad();
        }
        await initModel(next);
        if (useProjectStore.getState().model.engine === next) {
          setModelStatus("ready");
        }
      } catch (e) {
        if (useProjectStore.getState().model.engine === next) {
          setModelStatus("error", String(e));
        }
      }
    },
    [setTtsEngine, setModelStatus],
  );
}

// Weights switch for the active engine: persist the artifact choice on the
// Rust side, then reinitialize so the sidecar swaps the weights. Same status
// discipline as the engine switch — only the request that still matches the
// active engine writes the outcome, and an in-flight load is interrupted first.
export function useVariantSwitch() {
  const setAvailableTtsEngines = useProjectStore((s) => s.setAvailableTtsEngines);
  const setModelStatus = useProjectStore((s) => s.setModelStatus);

  return useCallback(
    async (variant: string) => {
      const state = useProjectStore.getState();
      const engine = state.model.engine;
      const info = state.model.engines.find((candidate) => candidate.id === engine);
      if (!info || state.synthesisStatus === "running") return;
      if (info.selectedVariant === variant) return;
      if (!info.variants.some((candidate) => candidate.id === variant)) return;
      const wasLoading = state.model.status === "loading";
      setModelStatus("loading");
      try {
        setAvailableTtsEngines(await setTtsVariant(engine, variant));
        if (wasLoading) {
          await interruptModelLoad();
        }
        await initModel(engine);
        if (useProjectStore.getState().model.engine === engine) {
          setModelStatus("ready");
        }
      } catch (e) {
        if (useProjectStore.getState().model.engine === engine) {
          setModelStatus("error", String(e));
        }
      }
    },
    [setAvailableTtsEngines, setModelStatus],
  );
}
