import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import fixtures from "./fixtures/ttsCommands.json";
import * as commands from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

// Rust's dispatcher tests consume these same packets. Neither side can change
// its argument nesting without failing a contract test.
const calls: Record<string, () => Promise<unknown>> = {
  ttsModelArtifact: () => commands.ttsModelArtifact("voxcpm2"),
  deleteTtsModel: () => commands.deleteTtsModel("voxcpm2"),
  importTtsBundle: () => commands.importTtsBundle("voxcpm2"),
  setRuntimeMode: () => commands.setRuntimeMode({ useSharedRuntime: true }),
  initModel: () => commands.initModel("voxcpm2"),
  speechRuntimeTtsLoad: () => commands.speechRuntimeTtsLoad("qwen3", "bf16"),
  speechRuntimeTtsUnload: () => commands.speechRuntimeTtsUnload("qwen3"),
  speechRuntimeTtsDeleteVoice: () => commands.speechRuntimeTtsDeleteVoice("voice /?&"),
  speechRuntimeTtsCancel: () => commands.speechRuntimeTtsCancel("request-1"),
  speechRuntimeTtsSynthesize: () => commands.speechRuntimeTtsSynthesize({ requestId: "request-2", model: "qwen3", voiceId: "voice-1", text: "Hello world", language: "en", seed: 42 }),
};

describe("TTS native IPC contract", () => {
  it.each(fixtures)("serializes $name for the native dispatcher", async ({ name, command, payload }) => {
    vi.mocked(invoke).mockClear();
    await calls[name]();
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, JSON.parse(JSON.stringify(payload)));
  });
});
