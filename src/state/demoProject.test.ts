import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHindiDemoProject } from "./demoProject";
import { seedHindiDemo, type DemoSeed } from "../ipc/commands";
import type { SpeakerTrack } from "../types/project";

vi.mock("../ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/commands")>();
  return {
    ...actual,
    seedHindiDemo: vi.fn(),
  };
});

// Mirrors what seed_hindi_demo returns since the second (female) FLEURS
// speaker landed: two reference voices, four lines alternating between them.
const twoVoiceSeed: DemoSeed = {
  voices: [
    { referenceAudioPath: "/tmp/ref-hindi-fleurs.wav", referenceText: "male ref" },
    { referenceAudioPath: "/tmp/ref-hindi-fleurs-female.wav", referenceText: "female ref" },
  ],
  clips: [
    { speakerIndex: 0, text: "(happy) line one" },
    { speakerIndex: 1, text: "(sad) line two" },
    { speakerIndex: 0, text: "(angry) line three" },
    { speakerIndex: 1, text: "(surprised) line four" },
  ],
};

describe("buildHindiDemoProject", () => {
  beforeEach(() => {
    vi.mocked(seedHindiDemo).mockResolvedValue(twoVoiceSeed);
  });

  it("builds two voices with their own speaker tracks", async () => {
    const project = await buildHindiDemoProject();

    expect(project.voices).toHaveLength(2);
    expect(project.voices[0].referenceAudioPath).toBe("/tmp/ref-hindi-fleurs.wav");
    expect(project.voices[1].referenceAudioPath).toBe("/tmp/ref-hindi-fleurs-female.wav");

    const speakers = project.tracks.filter(
      (t): t is SpeakerTrack => t.kind === "speaker",
    );
    expect(speakers).toHaveLength(2);
    expect(speakers[0].voiceId).toBe(project.voices[0].id);
    expect(speakers[1].voiceId).toBe(project.voices[1].id);
  });

  it("routes alternating lines to the matching speaker track", async () => {
    const project = await buildHindiDemoProject();
    const speakers = project.tracks.filter(
      (t): t is SpeakerTrack => t.kind === "speaker",
    );

    expect(speakers[0].clips.map((c) => c.text)).toEqual([
      "(happy) line one",
      "(angry) line three",
    ]);
    expect(speakers[1].clips.map((c) => c.text)).toEqual([
      "(sad) line two",
      "(surprised) line four",
    ]);
    for (const track of speakers) {
      for (const clip of track.clips) {
        expect(clip.trackId).toBe(track.id);
      }
    }
  });
});
