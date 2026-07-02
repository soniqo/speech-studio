import { useEffect, useRef, useState } from "react";
import { Plus, Pause, Play, AudioLines, TriangleAlert, Trash2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useProjectStore } from "../state/projectStore";
import {
  cloneVoice,
  importReferenceAudio,
  pickAudio,
  probeReference,
  type ReferenceProbe,
} from "../ipc/commands";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n/useI18n";
import type { Messages } from "../i18n/messages";

// Reference-level thresholds, mirrored from speech-core's quiet-reference
// rescue: below QUIET_RMS (0.04) the engine auto-boosts the reference; below
// NEAR_SILENT_RMS the boosted result is still badly degraded (the field case
// was a -25 dB conversion at RMS 0.0019 producing inaudible clones).
const NEAR_SILENT_RMS = 0.005;
const QUIET_RMS = 0.04;

function levelDb(rms: number): string {
  if (rms <= 0) return "-inf dB";
  return `${Math.round(20 * Math.log10(rms))} dB`;
}

let currentRefAudio: HTMLAudioElement | null = null;

function sourceKindLabel(sourceKind: string, messages: Messages): string {
  if (sourceKind === "library") return messages.voices.sourceKind.library;
  if (sourceKind === "clip-clone") return messages.voices.sourceKind.clipClone;
  if (sourceKind === "track-clone") return messages.voices.sourceKind.trackClone;
  return sourceKind;
}

export function VoiceLibrary() {
  const { messages: t } = useI18n();
  const voices = useProjectStore((s) => s.project.voices);
  const selection = useProjectStore((s) => s.selection);
  const addVoice = useProjectStore((s) => s.addVoice);
  const removeVoice = useProjectStore((s) => s.removeVoice);
  const select = useProjectStore((s) => s.select);

  const [pendingQuietRef, setPendingQuietRef] = useState<{
    path: string;
    name: string;
    probe: ReferenceProbe;
  } | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  async function createVoice(path: string, name: string, probe: ReferenceProbe | null) {
    const voice = await cloneVoice({
      referencePath: path,
      name,
      referenceText: "",
      referenceDurationSec: probe?.durationSec,
      referenceSampleRate: probe?.sampleRate,
      referenceRms: probe?.rms,
    });
    addVoice(voice);
    select({ kind: "voice", id: voice.id });
  }

  async function addByReference() {
    setReferenceError(null);
    try {
      const picked = await pickAudio();
      if (!picked) return;
      const name = picked.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? t.voices.fallbackName;
      const imported = await importReferenceAudio(picked.path);

      // Measure the clip before accepting it as a voice. A nearly-silent
      // reference clones inaudibly (the engine tracks reference amplitude);
      // surface that NOW — the only moment the user can act — instead of
      // after a confusing broken synthesis. probe === null means the active
      // sidecar has no probe support; skip validation in that case.
      let probe: ReferenceProbe | null = null;
      try {
        probe = await probeReference(imported.path);
      } catch (e) {
        // Decode failure: the file can't work as a reference at all.
        console.error("probe_reference failed", e);
        setReferenceError(t.voices.decodeFailed(String(e)));
        return;
      }
      if (probe && probe.rms < NEAR_SILENT_RMS) {
        setPendingQuietRef({ path: imported.path, name, probe });
        return; // resolved by the confirm dialog below
      }
      await createVoice(imported.path, name, probe);
    } catch (e) {
      console.error("clone_voice failed", e);
      setReferenceError(String(e));
    }
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t.voices.title}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={addByReference}
          title={t.voices.addReferenceTitle}
          className="h-6 px-1.5 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t.voices.addReference}
        </Button>
      </div>
      {voices.length === 0 && (
        <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-3 text-xs text-muted-foreground">
          {t.voices.empty}
        </div>
      )}
      {referenceError && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {referenceError}
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
            referenceDurationSec={v.referenceDurationSec}
            referenceSampleRate={v.referenceSampleRate}
            referenceRms={v.referenceRms}
            selected={selection.kind === "voice" && selection.id === v.id}
            onSelect={() => select({ kind: "voice", id: v.id })}
            onDelete={() => removeVoice(v.id)}
            messages={t}
          />
        ))}
      </div>
      {pendingQuietRef && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <TriangleAlert className="h-4 w-4 text-amber-500" />
              {t.voices.nearlySilentTitle}
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              {t.voices.nearlySilentBody(
                pendingQuietRef.name,
                levelDb(pendingQuietRef.probe.rms),
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => {
                  const p = pendingQuietRef;
                  setPendingQuietRef(null);
                  void createVoice(p.path, p.name, p.probe).catch((e) => {
                    console.error("clone_voice failed", e);
                    setReferenceError(String(e));
                  });
                }}
              >
                {t.voices.useAnyway}
              </Button>
              <Button
                size="sm"
                className="text-xs"
                onClick={() => {
                  setPendingQuietRef(null);
                  void addByReference();
                }}
              >
                {t.voices.chooseAnother}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface VoiceCardProps {
  voiceId: string;
  name: string;
  sourceKind: string;
  referenceAudioPath?: string;
  referenceText: string;
  referenceDurationSec?: number;
  referenceSampleRate?: number;
  referenceRms?: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  messages: Messages;
}

function VoiceCard({
  voiceId,
  name,
  sourceKind,
  referenceAudioPath,
  referenceText,
  referenceDurationSec,
  referenceSampleRate,
  referenceRms,
  selected,
  onSelect,
  onDelete,
  messages: t,
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

  function onCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onSelect();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onCardKeyDown}
      data-voice-id={voiceId}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          {sourceKindLabel(sourceKind, t)}
          {referenceDurationSec != null && (
            <>
              {" "}&middot; {t.common.secondsShort(Math.round(referenceDurationSec))}
              {referenceSampleRate != null && <> &middot; {Math.round(referenceSampleRate / 1000)} kHz</>}
              {referenceRms != null && <> &middot; {levelDb(referenceRms)}</>}
            </>
          )}
        </div>
        {referenceRms != null && referenceRms < QUIET_RMS && (
          <div
            className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-500"
            title={t.voices.quietTitle}
          >
            <TriangleAlert className="h-3 w-3" />
            {referenceRms < NEAR_SILENT_RMS
              ? t.voices.nearlySilentReference
              : t.voices.quietReference}
          </div>
        )}
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
        title={!canPlay ? t.voices.noReferenceAudio : playing ? t.voices.stop : t.voices.playReference}
        aria-label={playing ? t.voices.stopReference : t.voices.playReference}
        className="h-7 w-7 shrink-0"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title={t.voices.deleteTitle}
        aria-label={t.voices.deleteAria}
        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
