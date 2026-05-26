import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: vi.fn(),
}));

import { Inspector } from "./Inspector";
import { newClip, useProjectStore } from "../state/projectStore";
import { emptyProject, type SpeakerTrack, type Voice } from "../types/project";

function freshStore() {
  useProjectStore.setState({
    project: emptyProject("Test"),
    selection: { kind: "none" },
    transport: { playing: false, positionSec: 0, zoomPxPerSec: 100 },
  });
}

beforeEach(() => {
  freshStore();
});

describe("Inspector dispatch by selection kind", () => {
  it("shows the empty pane when nothing is selected", () => {
    render(<Inspector />);
    expect(screen.getByText(/select a clip, track, or voice/i)).toBeInTheDocument();
  });

  it("shows the track pane for a speaker track selection", () => {
    const t: SpeakerTrack = {
      kind: "speaker",
      id: "t1",
      name: "Anna",
      clips: [],
    };
    useProjectStore.setState((s) => ({
      project: { ...s.project, tracks: [t] },
      selection: { kind: "track", id: t.id },
    }));
    render(<Inspector />);
    expect(screen.getByText(/^Track/)).toBeInTheDocument();
    expect(screen.getByText("Voice")).toBeInTheDocument();
  });

  it("shows the voice pane for a voice selection", () => {
    const v: Voice = {
      id: "v1",
      name: "Narrator",
      sourceKind: "library",
      referenceAudioPath: "/tmp/r.wav",
      referenceText: "Sample reference transcript.",
      createdAt: new Date().toISOString(),
    };
    useProjectStore.setState((s) => ({
      project: { ...s.project, voices: [v] },
      selection: { kind: "voice", id: v.id },
    }));
    render(<Inspector />);
    expect(screen.getByText(/^Voice/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Narrator")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Sample reference transcript.")).toBeInTheDocument();
  });

  it("shows the clip pane with mode label for a clip selection", () => {
    const track: SpeakerTrack = {
      kind: "speaker",
      id: "t1",
      name: "Anna",
      clips: [],
    };
    const clip = newClip({ trackId: track.id, startSec: 0, endSec: 2, text: "Hi" });
    track.clips.push(clip);
    useProjectStore.setState((s) => ({
      project: { ...s.project, tracks: [track] },
      selection: { kind: "clip", id: clip.id },
    }));
    render(<Inspector />);
    expect(screen.getByText(/^Clip/)).toBeInTheDocument();
    expect(screen.getByText(/fixed mode/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeDisabled();
  });
});
