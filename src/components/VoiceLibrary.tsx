import { useEffect, useRef, useState } from "react";
import { Plus, Pause, Play, AudioLines } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProjectStore } from "../state/projectStore";
import { cloneVoice, pickAudio } from "../ipc/commands";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

let currentRefAudio: HTMLAudioElement | null = null;

export function VoiceLibrary() {
  const voices = useProjectStore((s) => s.project.voices);
  const selection = useProjectStore((s) => s.selection);
  const addVoice = useProjectStore((s) => s.addVoice);
  const select = useProjectStore((s) => s.select);

  async function addByReference() {
    try {
      const picked = await pickAudio();
      if (!picked) return;
      const name = picked.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Voice";
      const voice = await cloneVoice({ referencePath: picked.path, name, referenceText: "" });
      addVoice(voice);
      select({ kind: "voice", id: voice.id });
    } catch (e) {
      console.error("clone_voice failed", e);
    }
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Voices
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={addByReference}
          title="Clone from reference clip"
          className="h-6 px-1.5 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          Reference
        </Button>
      </div>
      {voices.length === 0 && (
        <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-3 text-xs text-muted-foreground">
          No cloned voices yet. Add a short reference clip to start.
        </div>
      )}
      <div className="space-y-1.5">
        {voices.map((v) => (
          <VoiceCard
            key={v.id}
            voiceId={v.id}
            name={v.name}
            sourceKind={v.sourceKind}
            referenceAudioPath={v.referenceAudioPath}
            referenceText={v.referenceText}
            selected={selection.kind === "voice" && selection.id === v.id}
            onSelect={() => select({ kind: "voice", id: v.id })}
          />
        ))}
      </div>
    </div>
  );
}

interface VoiceCardProps {
  voiceId: string;
  name: string;
  sourceKind: string;
  referenceAudioPath?: string;
  referenceText: string;
  selected: boolean;
  onSelect: () => void;
}

function VoiceCard({
  voiceId,
  name,
  sourceKind,
  referenceAudioPath,
  referenceText,
  selected,
  onSelect,
}: VoiceCardProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const canPlay = !!referenceAudioPath;

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (currentRefAudio === audioRef.current) currentRefAudio = null;
    },
    [],
  );

  function togglePlay(e: React.MouseEvent) {
    e.stopPropagation();
    if (!referenceAudioPath) return;
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    if (currentRefAudio && currentRefAudio !== audioRef.current) {
      currentRefAudio.pause();
    }
    const a = new Audio(convertFileSrc(referenceAudioPath));
    audioRef.current = a;
    currentRefAudio = a;
    a.onended = () => {
      setPlaying(false);
      if (currentRefAudio === a) currentRefAudio = null;
    };
    a.onerror = () => setPlaying(false);
    a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      data-voice-id={voiceId}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md border px-2 py-2 text-left transition-colors",
        selected
          ? "border-primary/40 bg-primary/10"
          : "border-border/60 bg-background/40 hover:border-border hover:bg-accent/30",
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <AudioLines className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {sourceKind}
        </div>
        {referenceText.trim().length > 0 && (
          <div className="mt-0.5 line-clamp-1 text-[11px] italic text-muted-foreground/80" title={referenceText}>
            {referenceText}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={togglePlay}
        disabled={!canPlay}
        title={!canPlay ? "No reference audio" : playing ? "Stop" : "Play reference"}
        aria-label={playing ? "Stop reference" : "Play reference"}
        className="h-7 w-7 shrink-0"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
    </button>
  );
}
