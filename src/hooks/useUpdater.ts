import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle"
  | "available"
  | "downloading"
  | "error";

/** Checks GitHub releases once on mount and exposes a one-click installer.
 *
 * Errors are deliberately quiet (console only): an unreachable update
 * endpoint must never degrade the studio itself, and dev builds (`pnpm
 * tauri dev`) legitimately fail the check because they aren't bundled.
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  // Download progress in [0,1], or null before any size info arrives.
  const [progress, setProgress] = useState<number | null>(null);
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        updateRef.current = update;
        setVersion(update.version);
        setStatus("available");
      } catch (e) {
        console.warn("[updater] check failed (ignored):", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function install() {
    const update = updateRef.current;
    if (!update) return;
    setStatus("downloading");
    try {
      let received = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total) setProgress(Math.min(received / total, 1));
            break;
        }
      });
      // The new version is staged; this swaps to it.
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed:", e);
      setStatus("error");
    }
  }

  return { status, version, progress, install };
}
