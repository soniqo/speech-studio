import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { useProjectSave } from "../hooks/useProjectSave";
import { saveProject } from "../ipc/commands";
import { emptyProject, type Project } from "../types/project";

vi.mock("../ipc/commands", () => ({ saveProject: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.mocked(saveProject).mockClear());

describe("legacy canvas migration and persistence", () => {
  it.each([30, 60])("preserves an older %s second canvas through edit, save, and reload", async (durationSec) => {
    const legacy: Project = {
      id: "legacy", name: "Legacy", durationSec, voices: [], tracks: [{
        kind: "speaker", id: "track", name: "Track", clips: [{
          id: "clip", trackId: "track", startSec: 0, endSec: 10, text: "Words", locked: false, history: [],
        }],
      }],
    };
    useProjectStore.getState().setProject(JSON.parse(JSON.stringify(legacy)));
    useProjectStore.getState().markSaved(JSON.stringify(useProjectStore.getState().project));
    const { result } = renderHook(() => useProjectSave());
    expect(result.current.dirty).toBe(false);
    act(() => useProjectStore.getState().updateClip("clip", { text: "Edited" }));
    await act(async () => { await result.current.saveNow(); });
    const saved = vi.mocked(saveProject).mock.calls[0][0];
    expect(saved).toMatchObject({ durationSec, canvasSec: durationSec });
    act(() => useProjectStore.getState().setProject(JSON.parse(JSON.stringify(saved))));
    expect(useProjectStore.getState().project.durationSec).toBe(durationSec);
  });

  it("lets new projects shrink with their content and preserves imported media ends", () => {
    const store = useProjectStore.getState();
    store.setProject(emptyProject("New"));
    store.addTrack({ kind: "audio", id: "audio", name: "Audio", sourcePath: "/audio.wav", gainDb: 0, durationSec: 20 });
    store.addTrack({ kind: "video", id: "video", name: "Video", sourcePath: "/video.mp4", durationSec: 40 });
    expect(useProjectStore.getState().project.durationSec).toBe(40);
    store.removeTrack("video");
    expect(useProjectStore.getState().project.durationSec).toBe(20);
    store.removeTrack("audio");
    expect(useProjectStore.getState().project.durationSec).toBe(5);
  });
});
