import type { TtsEngineId } from "../ipc/commands";

export const SHARED_TTS_ENGINES = ["qwen3", "voxcpm2", "espeech"] as const;

export function supportsSharedRuntime(engine: TtsEngineId): boolean {
  return SHARED_TTS_ENGINES.some((candidate) => candidate === engine);
}
