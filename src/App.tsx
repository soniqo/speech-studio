import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./components/AppShell";
import { availableTtsEngines, initModel, runtimeModeSettings, type TtsEngineId } from "./ipc/commands";
import { supportsSharedRuntime } from "./lib/runtimeEngines";
import { useProjectStore } from "./state/projectStore";
import "./index.css";

interface ModelProgressEvent {
  progress: number;
  percent: number;
  message: string;
}

export default function App() {
  const setModelStatus = useProjectStore((s) => s.setModelStatus);
  const setModelProgress = useProjectStore((s) => s.setModelProgress);
  const setAvailableTtsEngines = useProjectStore((s) => s.setAvailableTtsEngines);
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let requestedEngine: TtsEngineId = useProjectStore.getState().model.engine;
    void (async () => {
      try {
        const stopListening = await listen<ModelProgressEvent>("model_progress", (event) => {
          setModelProgress(event.payload);
        });
        if (cancelled) {
          stopListening();
          return;
        }
        unlisten = stopListening;

        // Register the progress listener before init_model so first-run
        // download events are not missed.
        setModelStatus("loading");
        const [engines, mode] = await Promise.all([availableTtsEngines(), runtimeModeSettings()]);
        setAvailableTtsEngines(engines);
        let engine = useProjectStore.getState().model.engine;
        const configuredEngine = import.meta.env.VITE_TTS_ENGINE as TtsEngineId | undefined;
        if (configuredEngine && engines.some((candidate) => candidate.id === configuredEngine)) {
          engine = configuredEngine;
          setTtsEngine(engine);
        } else if (!engines.some((candidate) => candidate.id === engine)) {
          engine = engines[0]?.id ?? "voxcpm2";
          setTtsEngine(engine);
        }
        if (mode.useSharedRuntime && !supportsSharedRuntime(engine)) {
          const sharedEngine = engines.find((candidate) => supportsSharedRuntime(candidate.id));
          if (!sharedEngine) throw new Error("No engine is available through Shared Speech Runtime");
          engine = sharedEngine.id;
          setTtsEngine(engine);
        }
        requestedEngine = engine;
        await initModel(engine);
        if (!cancelled && useProjectStore.getState().model.engine === engine) {
          setModelStatus("ready");
        }
      } catch (e) {
        if (!cancelled && useProjectStore.getState().model.engine === requestedEngine) {
          setModelStatus("error", String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setAvailableTtsEngines, setModelProgress, setModelStatus, setTtsEngine]);

  return <AppShell />;
}
