import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioScheduler } from "./useAudioScheduler";
import { usePlayheadTick } from "./usePlayheadTick";
import { useProjectStore } from "../state/projectStore";
import { emptyProject } from "../types/project";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));

const audios: TestAudio[] = [];
class TestAudio {
  duration = Number.NaN;
  currentTime = 0;
  paused = true;
  volume = 1;
  preload = "";
  onloadedmetadata: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  load = vi.fn();
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  constructor(public src: string) { audios.push(this); }
  metadata(seconds: number) { this.duration = seconds; this.onloadedmetadata?.(); }
}

let nextFrame: FrameRequestCallback | undefined;
beforeEach(() => {
  audios.length = 0;
  nextFrame = undefined;
  vi.stubGlobal("Audio", TestAudio);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { nextFrame = undefined; });
  useProjectStore.setState({ project: emptyProject("Audio"), selection: { kind: "none" }, transport: { playing: false, positionSec: 0, zoomPxPerSec: 100 } });
});
afterEach(() => vi.unstubAllGlobals());

function mountPlayback() {
  return renderHook(() => { useAudioScheduler(); usePlayheadTick(); });
}

describe("media duration and transport integration", () => {
  it("plays an imported 20 second track past the former five second cutoff", () => {
    useProjectStore.getState().addTrack({ kind: "audio", id: "audio", name: "Audio", sourcePath: "/twenty.wav", gainDb: 0 });
    const playback = mountPlayback();
    act(() => audios[0].metadata(20));
    expect(useProjectStore.getState().project.durationSec).toBe(20);
    expect(useProjectStore.getState().project.tracks[0]).toMatchObject({ durationSec: 20 });
    act(() => { useProjectStore.getState().seek(4.9); useProjectStore.getState().setPlaying(true); });
    const start = performance.now();
    act(() => nextFrame?.(start + 200));
    expect(useProjectStore.getState().transport.playing).toBe(true);
    expect(useProjectStore.getState().transport.positionSec).toBeGreaterThan(5);
    expect(audios[0].paused).toBe(false);
    act(() => nextFrame?.(start + 21_000));
    expect(useProjectStore.getState().transport).toMatchObject({ playing: false, positionSec: 20 });
    playback.unmount();
    expect(audios[0].paused).toBe(true);
  });

  it("applies mute and solo while playing and restores all tracks after clearing selection", () => {
    const store = useProjectStore.getState();
    for (const id of ["a", "b"]) store.addTrack({ kind: "audio", id, name: id, sourcePath: `/${id}.wav`, gainDb: 0, durationSec: 20 });
    mountPlayback();
    act(() => { audios.forEach(audio => audio.metadata(20)); store.setPlaying(true); });
    expect(audios.every(audio => !audio.paused)).toBe(true);
    act(() => store.toggleTrackMuted("a"));
    expect(audios[0].paused).toBe(true);
    expect(audios[1].paused).toBe(false);
    act(() => { store.toggleTrackMuted("a"); store.toggleTrackSolo("a"); });
    expect(audios[0].paused).toBe(false);
    expect(audios[1].paused).toBe(true);
    act(() => { store.toggleTrackSolo("a"); store.select({ kind: "track", id: "b" }); });
    expect(audios[0].paused).toBe(true);
    expect(audios[1].paused).toBe(false);
    act(() => store.select({ kind: "none" }));
    expect(audios.every(audio => !audio.paused)).toBe(true);
  });

  it("ignores duration events from removed media", () => {
    const store = useProjectStore.getState();
    store.addTrack({ kind: "audio", id: "a", name: "A", sourcePath: "/a.wav", gainDb: 0 });
    mountPlayback();
    const stale = audios[0];
    act(() => store.removeTrack("a"));
    act(() => stale.metadata(99));
    expect(useProjectStore.getState().project.durationSec).toBe(5);
  });
});
