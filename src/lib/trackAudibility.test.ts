import { describe, expect, it } from "vitest";
import { audibleTrackIds } from "./trackAudibility";
import type { Project } from "../types/project";

const project: Project = {
  id: "p", name: "test", durationSec: 120, voices: [],
  tracks: [
    { kind: "speaker", id: "a", name: "A", clips: [
      { id: "c", trackId: "a", startSec: 0, endSec: 50, text: "Hi", locked: false, history: [] },
    ] },
    { kind: "speaker", id: "b", name: "B", clips: [] },
    { kind: "audio", id: "music", name: "Music", sourcePath: "/test.wav", gainDb: 0 },
  ],
};

describe("audibleTrackIds", () => {
  it("previews just the selected speaker and exports the full mix", () => {
    expect([...audibleTrackIds(project, { kind: "track", id: "a" }, "preview")]).toEqual(["a"]);
    expect([...audibleTrackIds(project, { kind: "clip", id: "c" }, "preview")]).toEqual(["a"]);
    expect([...audibleTrackIds(project, { kind: "track", id: "a" }, "export")]).toEqual(["a", "b", "music"]);
  });
  it("mute always wins and solo overrides selection", () => {
    const changed: Project = { ...project, tracks: project.tracks.map((t) =>
      t.id === "b" ? { ...t, solo: true } : t.id === "music" ? { ...t, muted: true } : t,
    ) };
    expect([...audibleTrackIds(changed, { kind: "track", id: "a" }, "preview")]).toEqual(["b"]);
    expect([...audibleTrackIds(changed, { kind: "none" }, "export")]).toEqual(["b"]);
  });
});
