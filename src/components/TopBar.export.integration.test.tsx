import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../state/projectStore";
import { emptyProject } from "../types/project";
import { TopBar } from "./TopBar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn().mockResolvedValue("/mix.wav") }));
vi.mock("./ProjectsMenu", () => ({ ProjectsMenu: () => null }));
vi.mock("./DevPing", () => ({ DevPing: () => null }));
vi.mock("../hooks/useUpdater", () => ({ useUpdater: () => ({ status: "idle" }) }));

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useProjectStore.setState(s => ({ locale: "en", synthesisStatus: "idle", model: { ...s.model, status: "ready" } }));
  useProjectStore.getState().setProject({
    ...emptyProject("Mix"), tracks: [
      { kind: "audio", id: "music", name: "Music", sourcePath: "/music.wav", gainDb: -6, durationSec: 20 },
      { kind: "speaker", id: "speaker", name: "Speaker", clips: [{ id: "clip", trackId: "speaker", text: "Words", startSec: 1, endSec: 10, locked: false, history: [], renderedAudioPath: "/speech.wav" }] },
    ],
  });
});

describe("export selection and native payload", () => {
  it("exports the complete mix despite a single selected preview track", async () => {
    useProjectStore.getState().select({ kind: "track", id: "speaker" });
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_project", { args: {
      outPath: "/mix.wav", durationSec: 20, clips: [
        { startSec: 0, audioPath: "/music.wav", gainDb: -6 },
        { startSec: 1, audioPath: "/speech.wav" },
      ],
    } }));
  });

  it.each(["mute", "solo"])("keeps explicit %s in the exported mix", async (mode) => {
    const store = useProjectStore.getState();
    if (mode === "solo") store.toggleTrackSolo("speaker");
    else store.toggleTrackMuted("music");
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_project", { args: {
      outPath: "/mix.wav", durationSec: 20, clips: [{ startSec: 1, audioPath: "/speech.wav" }],
    } }));
  });
});
