import type { Project, Selection } from "../types/project";

/**
 * Preview: an explicitly selected speaker/clip is monitored alone, unless
 * any Solo buttons are on. Export: only explicit Solo/Mute controls apply.
 */
export function audibleTrackIds(
  project: Project,
  selection: Selection,
  mode: "preview" | "export",
): Set<string> {
  const audioTracks = project.tracks.filter((t) => t.kind !== "video");
  const solos = audioTracks.filter((t) => t.solo);
  if (solos.length > 0) return new Set(solos.filter((t) => !t.muted).map((t) => t.id));

  let selectedTrackId: string | undefined;
  if (mode === "preview") {
    if (selection.kind === "track") selectedTrackId = selection.id;
    if (selection.kind === "clip") {
      selectedTrackId = project.tracks.find((t) =>
        t.kind === "speaker" && t.clips.some((c) => c.id === selection.id),
      )?.id;
    }
  }
  return new Set(audioTracks
    .filter((t) => !t.muted && (!selectedTrackId || t.id === selectedTrackId))
    .map((t) => t.id));
}
