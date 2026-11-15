import { beforeEach, describe, expect, it } from "vitest";
import { emptyProject } from "../types/project";
import { newClip, useProjectStore } from "./projectStore";

beforeEach(() => useProjectStore.getState().setProject(emptyProject("test")));

describe("speaker playback controls", () => {
  it("keeps Mute and Solo on saved track objects", () => {
    const store = useProjectStore.getState();
    store.addTrack({ kind: "speaker", id: "speaker-a", name: "A", clips: [] });
    useProjectStore.getState().toggleTrackMuted("speaker-a");
    useProjectStore.getState().toggleTrackSolo("speaker-a");
    const track = useProjectStore.getState().project.tracks[0];
    expect(track.kind).toBe("speaker");
    if (track.kind !== "speaker") throw Error("bad track type");
    expect(track.muted).toBe(true);
    expect(track.solo).toBe(true);
  });

  it("extends project duration to include a newly rendered long clip", () => {
    const store = useProjectStore.getState();
    store.addTrack({ kind: "speaker", id: "speaker-a", name: "A", clips: [] });
    const clip = newClip({ trackId: "speaker-a", startSec: 1, endSec: 3, text: "long text" });
    useProjectStore.getState().addClip(clip);
    useProjectStore.getState().updateClip(clip.id, { endSec: 74 });
    expect(useProjectStore.getState().project.durationSec).toBe(74);
  });
});
