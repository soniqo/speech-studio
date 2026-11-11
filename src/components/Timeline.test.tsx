import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: vi.fn(),
}));

import { Timeline } from "./Timeline";
import { newClip, useProjectStore } from "../state/projectStore";
import { emptyProject, type SpeakerTrack } from "../types/project";

function speakerTrack(): SpeakerTrack {
  return { kind: "speaker", id: "sp1", name: "Anna", clips: [] };
}

beforeEach(() => {
  useProjectStore.setState({
    project: emptyProject("Test"),
    selection: { kind: "none" },
    transport: { playing: false, positionSec: 0, zoomPxPerSec: 100 },
  });
});

describe("Timeline canvas", () => {
  // Regression: a 10 s recording on a stale 30 s canvas produced a 30 s track
  // with audio only in its first 10 s.
  it("draws the lane at the recorded length, not at the old canvas", () => {
    const track = speakerTrack();
    const clip = newClip({ trackId: track.id, startSec: 0, endSec: 10, text: "запись" });
    useProjectStore.getState().setProject({
      ...emptyProject("Legacy"),
      durationSec: 30,
      tracks: [{ ...track, clips: [clip] }],
    });

    const { container } = render(<Timeline />);
    const lane = container.querySelector<HTMLElement>('[title^="Double-click"], .relative.h-16');
    expect(lane).not.toBeNull();
    // 10 s at 100 px/s, not 30 s at 100 px/s.
    expect(lane!.style.width).toBe("1000px");
  });
});
