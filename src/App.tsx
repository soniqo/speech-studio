import { useEffect, useRef } from "react";
import { AppShell } from "./components/AppShell";
import { initModel } from "./ipc/commands";
import { useProjectStore } from "./state/projectStore";
import "./index.css";

export default function App() {
  const setModelStatus = useProjectStore((s) => s.setModelStatus);
  const firedRef = useRef(false);

  useEffect(() => {
    // React 19 strict-mode runs effects twice in dev; guard so init_model
    // is only fired once per mount. Load happens in the background; the UI
    // is fully interactive while the model warms up.
    if (firedRef.current) return;
    firedRef.current = true;
    setModelStatus("loading");
    initModel()
      .then(() => setModelStatus("ready"))
      .catch((e) => setModelStatus("error", String(e)));
  }, [setModelStatus]);

  return <AppShell />;
}
