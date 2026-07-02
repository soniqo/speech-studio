import { Plus, Video, Mic, AudioWaveform, Trash2 } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import type { SpeakerTrack, Track } from "../types/project";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n/useI18n";
import type { Messages } from "../i18n/messages";

function TrackIcon({ track }: { track: Track }) {
  if (track.kind === "video") return <Video className="h-3.5 w-3.5 text-amber-300/80" />;
  if (track.kind === "speaker") return <Mic className="h-3.5 w-3.5 text-primary" />;
  return <AudioWaveform className="h-3.5 w-3.5 text-orange-300/70" />;
}

function metaForTrack(track: Track, messages: Messages, voiceName?: string): string {
  if (track.kind === "video") return messages.tracks.kindVideo;
  if (track.kind === "speaker")
    return voiceName ? messages.tracks.voiceMeta(voiceName) : messages.tracks.noVoice;
  return messages.tracks.kindAudio;
}

export function TrackList() {
  const { messages: m } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const select = useProjectStore((s) => s.select);
  const renameTrack = useProjectStore((s) => s.renameTrack);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const addTrack = useProjectStore((s) => s.addTrack);

  function addSpeaker() {
    const idx = project.tracks.filter((t) => t.kind === "speaker").length + 1;
    const track: SpeakerTrack = {
      kind: "speaker",
      id: crypto.randomUUID(),
      name: m.defaults.speakerTrack(idx),
      clips: [],
    };
    addTrack(track);
    select({ kind: "track", id: track.id });
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {m.tracks.title}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={addSpeaker}
          title={m.tracks.addSpeakerTitle}
          className="h-6 px-1.5 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          {m.tracks.addSpeaker}
        </Button>
      </div>
      {project.tracks.length === 0 && (
        <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-3 text-xs text-muted-foreground">
          {m.tracks.empty}
        </div>
      )}
      <div className="space-y-1">
        {project.tracks.map((trackItem) => {
          const voiceId = trackItem.kind === "speaker" ? trackItem.voiceId : undefined;
          const voiceName = project.voices.find((v) => v.id === voiceId)?.name;
          const selected = selection.kind === "track" && selection.id === trackItem.id;
          function selectTrack() {
            select({ kind: "track", id: trackItem.id });
          }

          return (
            <div
              key={trackItem.id}
              role="button"
              tabIndex={0}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors",
                selected
                  ? "border-primary/40 bg-primary/10"
                  : "hover:border-border hover:bg-accent/30",
              )}
              onClick={selectTrack}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                selectTrack();
              }}
            >
              <TrackIcon track={trackItem} />
              <div className="min-w-0 flex-1">
                <input
                  className="block w-full bg-transparent text-sm focus:outline-none"
                  value={trackItem.name}
                  onChange={(e) => renameTrack(trackItem.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="truncate text-[11px] text-muted-foreground">
                  {metaForTrack(trackItem, m, voiceName)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTrack(trackItem.id);
                }}
                title={m.tracks.deleteTitle}
                aria-label={m.tracks.deleteAria}
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              >
                  <Trash2 className="h-3 w-3" />
                </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
