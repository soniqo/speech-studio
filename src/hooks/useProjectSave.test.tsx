import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSave, projectHasSaveableContent } from "./useProjectSave";
import { newClip, useProjectStore } from "../state/projectStore";
import { emptyProject, type SpeakerTrack } from "../types/project";
import { saveProject } from "../ipc/commands";

vi.mock("../ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/commands")>();
  return {
    ...actual,
    saveProject: vi.fn(),
  };
});

function projectWithContent() {
  const clip = newClip({ trackId: "track-1", startSec: 0, endSec: 2, text: "hi" });
  const track: SpeakerTrack = {
    kind: "speaker",
    id: "track-1",
    name: "Speaker",
    clips: [clip],
  };
  return { ...emptyProject("Test"), tracks: [track] };
}

beforeEach(() => {
  vi.mocked(saveProject).mockReset();
  vi.mocked(saveProject).mockResolvedValue({
    id: "test",
    name: "Test",
    savedAt: new Date().toISOString(),
  });
});

describe("projectHasSaveableContent", () => {
  it("is false for an untouched empty Untitled project", () => {
    expect(projectHasSaveableContent(emptyProject())).toBe(false);
  });

  it("is true once the project has a track", () => {
    expect(projectHasSaveableContent(projectWithContent())).toBe(true);
  });

  it("is true for a renamed but empty project", () => {
    expect(projectHasSaveableContent(emptyProject("My Project"))).toBe(true);
  });
});

describe("useProjectSave", () => {
  it("reports dirty when the project differs from the saved snapshot", () => {
    useProjectStore.setState((s) => ({
      ...s,
      project: projectWithContent(),
      savedSnapshot: null,
    }));
    const { result } = renderHook(() => useProjectSave());
    expect(result.current.dirty).toBe(true);
  });

  it("saveNow persists and marks clean, then reports not dirty", async () => {
    useProjectStore.setState((s) => ({
      ...s,
      project: projectWithContent(),
      savedSnapshot: null,
    }));
    const { result, rerender } = renderHook(() => useProjectSave());

    await act(async () => {
      await result.current.saveNow();
    });

    expect(saveProject).toHaveBeenCalledTimes(1);
    rerender();
    expect(result.current.dirty).toBe(false);
  });

  it("saveNow is a no-op when the project is already saved", async () => {
    const project = projectWithContent();
    useProjectStore.setState((s) => ({
      ...s,
      project,
      savedSnapshot: JSON.stringify(project),
    }));
    const { result } = renderHook(() => useProjectSave());
    expect(result.current.dirty).toBe(false);

    await act(async () => {
      await result.current.saveNow();
    });
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("saveNow does not write an untouched empty project", async () => {
    useProjectStore.setState((s) => ({
      ...s,
      project: emptyProject(),
      savedSnapshot: null,
    }));
    const { result } = renderHook(() => useProjectSave());

    await act(async () => {
      await result.current.saveNow();
    });
    expect(saveProject).not.toHaveBeenCalled();
  });
});
