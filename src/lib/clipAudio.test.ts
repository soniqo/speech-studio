import { describe, expect, it } from "vitest";
import { clipAudioPath, clipAudioVersion } from "./clipAudio";
import type { Clip } from "../types/project";

function clip(patch: Partial<Clip>): Clip {
  return {
    id: "clip-1",
    trackId: "track-1",
    startSec: 0,
    endSec: 1,
    text: "Hello",
    locked: false,
    history: [],
    ...patch,
  };
}

describe("clip audio helpers", () => {
  it("uses the current rendered path before previous takes", () => {
    const c = clip({
      renderedAudioPath: "/tmp/current.wav",
      history: [
        {
          id: "old-take",
          audioPath: "/tmp/old.wav",
          text: "Hello",
          createdAt: "2026-01-01T00:00:00.000Z",
          settings: { voiceId: "voice-1" },
        },
      ],
    });

    expect(clipAudioPath(c)).toBe("/tmp/current.wav");
  });

  it("versions media by take id even when the audio path is reused", () => {
    const first = clip({
      renderedAudioPath: "/tmp/reused.wav",
      history: [
        {
          id: "take-a",
          audioPath: "/tmp/reused.wav",
          text: "Hello",
          createdAt: "2026-01-01T00:00:00.000Z",
          settings: { voiceId: "voice-1" },
        },
      ],
    });
    const second = {
      ...first,
      history: [{ ...first.history[0], id: "take-b" }],
    };

    expect(clipAudioVersion(first)).toBe("take-a");
    expect(clipAudioVersion(second)).toBe("take-b");
  });
});
