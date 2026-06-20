import { useEffect, useRef } from "react";
import { AppShell } from "./components/AppShell";
import { availableTtsEngines, initModel } from "./ipc/commands";
import { useProjectStore } from "./state/projectStore";
import "./index.css";

export default function App() {
  const setModelStatus = useProjectStore((s) => s.setModelStatus);
  const setAvailableTtsEngines = useProjectStore((s) => s.setAvailableTtsEngines);
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);
  const firedRef = useRef(false);

  useEffect(() => {
    // React 19 strict-mode runs effects twice in dev; guard so init_model
    // is only fired once per mount. Load happens in the background; the UI
    // is fully interactive while the model warms up.
    if (firedRef.current) return;
    firedRef.current = true;
    setModelStatus("loading");
    void (async () => {
      try {
        const engines = await availableTtsEngines();
        setAvailableTtsEngines(engines);
        let engine = useProjectStore.getState().model.engine;
        if (!engines.some((candidate) => candidate.id === engine)) {
          engine = engines[0]?.id ?? "voxcpm2";
          setTtsEngine(engine);
        }
        await initModel(engine);
        setModelStatus("ready");
      } catch (e) {
        setModelStatus("error", String(e));
      }
    })();
  }, [setAvailableTtsEngines, setModelStatus, setTtsEngine]);

  return <AppShell />;
}
