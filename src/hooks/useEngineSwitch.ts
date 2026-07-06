import { useCallback } from "react";
import { useProjectStore } from "../state/projectStore";
import { initModel, interruptModelLoad, type TtsEngineId } from "../ipc/commands";

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
