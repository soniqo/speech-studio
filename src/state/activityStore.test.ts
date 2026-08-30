import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_RING_CAPACITY, useActivityStore } from "./activityStore";
import type { ActivityLine } from "../ipc/commands";

function line(seq: number, text = `line ${seq}`): ActivityLine {
  return { seq, tsMs: 1_700_000_000_000 + seq, source: seq % 2 ? "sidecar" : "studio", text };
}

beforeEach(() => {
  useActivityStore.setState({ open: false, lines: [], memory: null, logPath: null });
});

describe("activity store", () => {
  it("appends in order and drops lines already delivered", () => {
    const { append } = useActivityStore.getState();
    append(line(1));
    append(line(2));
    append(line(2));
    append(line(1));
    expect(useActivityStore.getState().lines.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("stays bounded at the ring capacity", () => {
    const { append } = useActivityStore.getState();
    for (let i = 1; i <= ACTIVITY_RING_CAPACITY + 5; i++) append(line(i));
    const lines = useActivityStore.getState().lines;
    expect(lines).toHaveLength(ACTIVITY_RING_CAPACITY);
    expect(lines[0].seq).toBe(6);
    expect(lines[lines.length - 1].seq).toBe(ACTIVITY_RING_CAPACITY + 5);
  });

  it("merges the backlog with lines that raced it, ordered by seq", () => {
    const { append, merge } = useActivityStore.getState();
    append(line(7));
    append(line(8));
    merge([line(3), line(4), line(7)]);
    expect(useActivityStore.getState().lines.map((l) => l.seq)).toEqual([3, 4, 7, 8]);
  });

  it("keeps the latest memory reading", () => {
    useActivityStore
      .getState()
      .setMemory({ label: "post-load-cosyvoice", activeMb: 1024, peakMb: 2048, footprintMb: 3072 });
    expect(useActivityStore.getState().memory?.footprintMb).toBe(3072);
    expect(useActivityStore.getState().memory?.label).toBe("post-load-cosyvoice");
  });
});
