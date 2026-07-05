import type { Clip } from "../types/project";

export function clipAudioPath(clip: Clip): string | undefined {
  return clip.renderedAudioPath ?? clip.history[0]?.audioPath;
}

export function clipAudioVersion(clip: Clip): string | undefined {
  const path = clipAudioPath(clip);
  if (!path) return undefined;
  return clip.history.find((take) => take.audioPath === path)?.id ?? clip.history[0]?.id ?? path;
}
