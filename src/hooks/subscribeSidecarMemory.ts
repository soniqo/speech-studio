import { listen } from "@tauri-apps/api/event";
import type { SidecarMemoryEvent } from "../ipc/commands";

export type SidecarMemoryListener = (event: SidecarMemoryEvent) => void;

/**
 * Subscribe to the shell's `sidecar_memory` events for the lifetime of the
 * returned unsubscribe fn. `useActivityLog` keeps the activity store's memory
 * readout current; this is for pages that need the raw stream (per-run peak
 * attribution).
 *
 * Resolves to a no-op unsubscribe when the event stream is unavailable (tests,
 * non-Tauri hosts) so callers never need to special-case it.
 */
export function subscribeSidecarMemory(handler: SidecarMemoryListener): Promise<() => void> {
  return listen<SidecarMemoryEvent>("sidecar_memory", (event) => handler(event.payload)).catch(
    () => () => undefined,
  );
}
