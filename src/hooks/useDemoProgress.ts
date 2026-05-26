import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore, type DemoProgress } from "../state/projectStore";

export function useDemoProgress() {
  const setDemoProgress = useProjectStore((s) => s.setDemoProgress);

  useEffect(() => {
    const unlistenP = listen<DemoProgress>("demo_progress", (event) => {
      setDemoProgress(event.payload);
    });
    return () => {
      unlistenP.then((u) => u());
    };
  }, [setDemoProgress]);
}
