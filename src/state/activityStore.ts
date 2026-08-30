import { create } from "zustand";
import type { ActivityLine, SidecarMemoryEvent } from "../ipc/commands";

/** Mirrors the Rust ring so the panel never grows without bound. */
export const ACTIVITY_RING_CAPACITY = 2000;

export interface MemoryReading extends SidecarMemoryEvent {
  updatedAt: number;
}

interface ActivityStore {
  open: boolean;
  lines: ActivityLine[];
  memory: MemoryReading | null;
  logPath: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Live event; ignored when the snapshot already delivered that seq. */
  append: (line: ActivityLine) => void;
  /** Backlog fetched on mount, unioned by seq with lines that raced it. */
  merge: (snapshot: ActivityLine[]) => void;
  clear: () => void;
  setMemory: (memory: SidecarMemoryEvent) => void;
  setLogPath: (path: string | null) => void;
}

function bounded(lines: ActivityLine[]): ActivityLine[] {
  return lines.length > ACTIVITY_RING_CAPACITY
    ? lines.slice(lines.length - ACTIVITY_RING_CAPACITY)
    : lines;
}

export const useActivityStore = create<ActivityStore>((set) => ({
  open: false,
  lines: [],
  memory: null,
  logPath: null,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  append: (line) =>
    set((s) => {
      const last = s.lines[s.lines.length - 1];
      if (last && line.seq <= last.seq) return s;
      return { lines: bounded([...s.lines, line]) };
    }),
  merge: (snapshot) =>
    set((s) => {
      const bySeq = new Map<number, ActivityLine>();
      for (const line of snapshot) bySeq.set(line.seq, line);
      for (const line of s.lines) bySeq.set(line.seq, line);
      return { lines: bounded([...bySeq.values()].sort((a, b) => a.seq - b.seq)) };
    }),
  clear: () => set({ lines: [] }),
  setMemory: (memory) => set({ memory: { ...memory, updatedAt: Date.now() } }),
  setLogPath: (logPath) => set({ logPath }),
}));
