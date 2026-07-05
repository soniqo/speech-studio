import { useEffect, useState } from "react";
import { Clipboard, FilePlus2, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { availableAsrModels, type AsrModelInfo } from "../ipc/commands";
import { newClip, useProjectStore } from "../state/projectStore";
import type { SpeakerTrack } from "../types/project";
import { Button } from "./ui/button";
import { useI18n } from "../i18n/useI18n";
import { useDictationRecorder } from "../hooks/useDictationRecorder";

interface DictationCapture {
  id: string;
  audioPath: string;
  durationSec: number;
  text: string;
  elapsedSec: number;
  createdAt: string;
}

let currentDictationAudio: HTMLAudioElement | null = null;

function formatSec(value: number): string {
  return value.toFixed(value < 10 ? 1 : 0);
}

function estimateClipDurationSec(text: string, fallbackSec: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.0, fallbackSec || words * 0.35 || 1.0);
}

export function DictationPanel() {
  const { messages: t } = useI18n();
  const addTrack = useProjectStore((s) => s.addTrack);
  const addClip = useProjectStore((s) => s.addClip);
  const updateClip = useProjectStore((s) => s.updateClip);
  const select = useProjectStore((s) => s.select);
  const { recording, busy, error, setError, start, stopAndTranscribe } =
    useDictationRecorder();
  const [models, setModels] = useState<AsrModelInfo[]>([]);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [captures, setCaptures] = useState<DictationCapture[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const model = models[0];

  useEffect(() => {
    let cancelled = false;
    void availableAsrModels()
      .then((next) => {
        if (!cancelled) setModels(next);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      if (currentDictationAudio) {
        currentDictationAudio.pause();
        currentDictationAudio = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function record() {
    setFlowMessage(null);
    await start();
  }

  async function finishRecording() {
    setFlowMessage(null);
    const result = await stopAndTranscribe(model?.id);
    if (!result) return;
    setCaptures((prev) => [
      { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...result },
      ...prev,
    ]);
  }

  function insertCapture(capture: DictationCapture) {
    const text = capture.text.trim();
    if (!text) {
      setError(t.dictation.emptyTranscript);
      return;
    }
    const state = useProjectStore.getState();
    if (state.selection.kind === "clip") {
      updateClip(state.selection.id, {
        text,
        renderedAudioPath: undefined,
        locked: false,
      });
      setFlowMessage(t.dictation.insertedClip);
      return;
    }

    const selectedTrackId = state.selection.kind === "track" ? state.selection.id : undefined;
    const selectedTrack = selectedTrackId
      ? state.project.tracks.find(
          (track): track is SpeakerTrack =>
            track.kind === "speaker" && track.id === selectedTrackId,
        )
      : undefined;
    let targetTrack = selectedTrack ?? state.project.tracks.find(
      (track): track is SpeakerTrack => track.kind === "speaker",
    );
    if (!targetTrack) {
      targetTrack = {
        kind: "speaker",
        id: crypto.randomUUID(),
        name: t.defaults.speakerTrack(1),
        clips: [],
      };
      addTrack(targetTrack);
    }

    const startSec = Math.max(0, state.transport.positionSec);
    const endSec = startSec + estimateClipDurationSec(text, capture.durationSec);
    const clip = newClip({
      trackId: targetTrack.id,
      startSec,
      endSec,
      text,
    });
    addClip(clip);
    select({ kind: "clip", id: clip.id });
    setFlowMessage(t.dictation.insertedTimeline);
  }

  function togglePlayback(capture: DictationCapture) {
    if (playingId === capture.id) {
      currentDictationAudio?.pause();
      currentDictationAudio = null;
      setPlayingId(null);
      return;
    }
    currentDictationAudio?.pause();
    const audio = new Audio(convertFileSrc(capture.audioPath));
    currentDictationAudio = audio;
    audio.onended = () => {
      if (currentDictationAudio === audio) currentDictationAudio = null;
      setPlayingId(null);
    };
    audio.onerror = () => setPlayingId(null);
    audio.play().then(() => setPlayingId(capture.id)).catch(() => setPlayingId(null));
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t.dictation.title}
        </span>
        <span className="max-w-[120px] truncate text-[11px] text-muted-foreground">
          {model ? model.displayName : t.dictation.loadingModel}
        </span>
      </div>

      <div className="rounded-md border border-border/70 bg-background/50 p-2">
        <Button
          size="sm"
          variant={recording ? "destructive" : "default"}
          className="h-8 w-full text-xs"
          onClick={recording ? finishRecording : record}
          disabled={busy || !model}
          title={recording ? t.dictation.stopTitle : t.dictation.recordTitle}
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : recording ? (
            <Square className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Mic className="mr-1.5 h-3.5 w-3.5" />
          )}
          {busy ? t.dictation.transcribing : recording ? t.dictation.stop : t.dictation.record}
        </Button>
        <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
          {model ? t.dictation.modelMeta(model.runtime, model.modelSize) : t.dictation.modelPending}
        </div>
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {flowMessage && (
        <div className="mt-2 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-2 text-xs text-primary">
          {flowMessage}
        </div>
      )}

      <div className="mt-2 space-y-1.5">
        {captures.length === 0 && (
          <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-3 text-xs text-muted-foreground">
            {t.dictation.empty}
          </div>
        )}
        {captures.map((capture) => (
          <div
            key={capture.id}
            className="rounded-md border border-border/70 bg-background/50 px-2.5 py-2"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {t.dictation.captureMeta(
                  formatSec(capture.durationSec),
                  formatSec(capture.elapsedSec),
                )}
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => togglePlayback(capture)}
                  title={
                    playingId === capture.id ? t.dictation.stopPlayback : t.dictation.playCapture
                  }
                  aria-label={
                    playingId === capture.id ? t.dictation.stopPlayback : t.dictation.playCapture
                  }
                >
                  {playingId === capture.id ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => insertCapture(capture)}
                  title={t.dictation.insertIntoFlow}
                  aria-label={t.dictation.insertIntoFlow}
                >
                  <FilePlus2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => void navigator.clipboard?.writeText(capture.text)}
                  title={t.dictation.copyText}
                  aria-label={t.dictation.copyText}
                >
                  <Clipboard className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-xs leading-5 text-foreground">
              {capture.text || t.dictation.emptyTranscript}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
