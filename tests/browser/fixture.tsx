import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import App from "../../src/App";
import { useProjectStore } from "../../src/state/projectStore";
import type { Project } from "../../src/types/project";
import registry from "../../model-registry.json";

declare global {
  interface Window {
    studioTest: {
      store: typeof useProjectStore;
      calls: Array<{ command: string; args: unknown }>;
      failLoad: boolean;
      saved: Project[];
    };
  }
}

const engines = registry.ttsEngines.map(engine => ({ ...engine, variants: engine.variants ?? [], selectedVariant: engine.variants?.[0]?.id ?? null }));
let shared = new URLSearchParams(location.search).has("shared");
let legacy: Project = { id: "legacy", name: "Legacy custom canvas", durationSec: 60, voices: [], tracks: [{ kind: "speaker", id: "speaker", name: "Speaker", clips: [{ id: "clip", trackId: "speaker", startSec: 0, endSec: 10, text: "Words", locked: false, history: [] }] }] };
window.studioTest = { store: useProjectStore, calls: [], saved: [], failLoad: false };
mockWindows("main");
// Browser media uses a generated WAV served by the test, while all application
// components and IPC wrappers are the same modules used in the desktop build.
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => string } }).__TAURI_INTERNALS__.convertFileSrc = path => new URL(path, location.origin).href;
mockIPC((command, args: any) => {
  window.studioTest.calls.push({ command, args });
  if (command === "available_tts_engines") return engines;
  if (command === "available_asr_models") return registry.asrModels;
  if (command === "init_model" && window.studioTest.failLoad) throw new Error("Fixture model load failed");
  if (command === "runtime_mode_settings") return { useSharedRuntime: shared };
  if (command === "set_runtime_mode") { shared = args.args.settings.useSharedRuntime; return { useSharedRuntime: shared }; }
  if (command === "speech_runtime_health") return { connected: true, detail: "Fixture runtime" };
  if (command === "speech_runtime_tts_models") return { models: engines.map(engine => ({ ...engine, loaded: false })) };
  if (command === "activity_log_snapshot") return [];
  if (command === "activity_log_info") return { path: null };
  if (command === "list_projects") return [{ id: legacy.id, name: legacy.name, savedAt: "2026-01-01T00:00:00Z" }];
  if (command === "load_project") return JSON.stringify(legacy);
  if (command === "save_project") {
    const saved = JSON.parse(args.args.projectJson) as Project;
    window.studioTest.saved.push(saved);
    if (saved.id === legacy.id) legacy = saved;
    return { id: saved.id, name: saved.name, savedAt: "2026-01-01T00:00:00Z" };
  }
  if (command === "tts_model_artifact") return { engine: args.args.engine, paths: [], exists: false, bytes: 0, loaded: false };
  return null;
}, { shouldMockEvents: true });
createRoot(document.getElementById("root")!).render(<App />);
