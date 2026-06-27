import type { Clip } from "../types/project";

export function clipAudioPath(clip: Clip): string | undefined {
  return clip.renderedAudioPath ?? clip.history[0]?.audioPath;
}
