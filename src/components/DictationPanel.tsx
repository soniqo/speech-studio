import { useEffect, useRef, useState } from "react";
import { Clipboard, FilePlus2, Loader2, Mic, Pause, Play, Square } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  availableAsrModels,
  saveDictationAudio,
  transcribeAudio,
  type AsrModelInfo,
  type TranscribeAudioResult,
} from "../ipc/commands";
import { newClip, useProjectStore } from "../state/projectStore";
import type { SpeakerTrack } from "../types/project";
import { Button } from "./ui/button";
import { useI18n } from "../i18n/useI18n";

interface RecorderSession {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  sampleRate: number;
  startedAt: number;
}

interface DictationCapture {
  id: string;
  audioPath: string;
  durationSec: number;
  text: string;
  elapsedSec: number;
  createdAt: string;
}

let currentDictationAudio: HTMLAudioElement | null = null;

function flattenChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += bytesPerSample;
  }
  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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
  const [models, setModels] = useState<AsrModelInfo[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [captures, setCaptures] = useState<DictationCapture[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);

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
      stopRecorderOnly();
      if (currentDictationAudio) {
        currentDictationAudio.pause();
        currentDictationAudio = null;
      }
    };
  }, []);

  function stopRecorderOnly(): RecorderSession | null {
    const session = recorderRef.current;
    recorderRef.current = null;
    if (!session) return null;
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    void session.context.close();
    setRecording(false);
    return session;
  }

  async function startRecording() {
    setError(null);
    setFlowMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t.dictation.unsupported);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const AudioContextCtor = window.AudioContext;
      const context = new AudioContextCtor({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        event.outputBuffer.getChannelData(0).fill(0);
      };
      source.connect(processor);
      processor.connect(context.destination);
      recorderRef.current = {
        stream,
        context,
        source,
        processor,
        chunks,
        sampleRate: context.sampleRate,
        startedAt: performance.now(),
      };
      setRecording(true);
    } catch (e) {
      setError(t.dictation.micFailed(String(e)));
    }
  }

  async function stopAndTranscribe() {
    const session = stopRecorderOnly();
    if (!session || busy) return;
    const samples = flattenChunks(session.chunks);
    const durationSec = samples.length / session.sampleRate;
    if (durationSec < 0.2) {
      setError(t.dictation.tooShort);
      return;
    }

    setBusy(true);
    setError(null);
    setFlowMessage(null);
    try {
      const wav = encodeWav(samples, session.sampleRate);
      const saved = await saveDictationAudio(arrayBufferToBase64(wav));
      const transcript: TranscribeAudioResult = await transcribeAudio({
        audioPath: saved.audioPath,
        model: model?.id,
      });
      setCaptures((prev) => [
        {
          id: crypto.randomUUID(),
          audioPath: saved.audioPath,
          durationSec: transcript.durationSec || saved.durationSec || durationSec,
          text: transcript.text,
          elapsedSec: transcript.elapsedSec,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
    } catch (e) {
      setError(t.dictation.transcribeFailed(String(e)));
    } finally {
      setBusy(false);
    }
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
          onClick={recording ? stopAndTranscribe : startRecording}
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
