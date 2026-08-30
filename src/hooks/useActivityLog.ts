import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  activityLogInfo,
  activityLogSnapshot,
  type ActivityLine,
  type SidecarMemoryEvent,
} from "../ipc/commands";
import { useActivityStore } from "../state/activityStore";

// Subscribe to the shell's activity stream for the lifetime of the app.
// Listeners attach before the backlog is fetched so nothing is lost in the
// gap; the store unions the two by seq.
export function useActivityLog() {
  const append = useActivityStore((s) => s.append);
  const merge = useActivityStore((s) => s.merge);
  const setMemory = useActivityStore((s) => s.setMemory);
  const setLogPath = useActivityStore((s) => s.setLogPath);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const stopLines = await listen<ActivityLine>("activity_log", (event) => {
          append(event.payload);
        });
        const stopMemory = await listen<SidecarMemoryEvent>("sidecar_memory", (event) => {
          setMemory(event.payload);
        });
        if (cancelled) {
          stopLines();
          stopMemory();
          return;
        }
        unlisteners.push(stopLines, stopMemory);
        merge(await activityLogSnapshot());
        setLogPath((await activityLogInfo()).path);
      } catch (e) {
        console.warn("[activity] log stream unavailable", e);
      }
    })();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [append, merge, setMemory, setLogPath]);
}
