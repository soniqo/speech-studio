import { useEffect, useRef, useState } from "react";
import { saveDictationAudio, transcribeAudio, type AsrModelId } from "../ipc/commands";
import { arrayBufferToBase64, encodeWav, flattenChunks } from "../lib/audioRecording";
import { useI18n } from "../i18n/useI18n";

interface RecorderSession {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  sampleRate: number;
}

export interface DictationResult {
  audioPath: string;
  durationSec: number;
  text: string;
  elapsedSec: number;
}

/**
 * Microphone capture → save WAV → ASR transcript, as a headless hook so both
 * the dictation panel and the inline script-editor mic drive the exact same
 * pipeline. `stopAndTranscribe` resolves with the transcript (or null on
 * error / too-short); the caller decides what to do with the text.
 */
export function useDictationRecorder() {
  const { messages: t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);

  function teardown(): RecorderSession | null {
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

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => () => void teardown(), []);

  async function start(): Promise<void> {
    setError(null);
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
      const context = new window.AudioContext({ sampleRate: 16000 });
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
      };
      setRecording(true);
    } catch (e) {
      setError(t.dictation.micFailed(String(e)));
    }
  }

  function cancel(): void {
    teardown();
  }

  async function stopAndTranscribe(modelId?: AsrModelId): Promise<DictationResult | null> {
    const session = teardown();
    if (!session || busy) return null;
    const samples = flattenChunks(session.chunks);
    const durationSec = samples.length / session.sampleRate;
    if (durationSec < 0.2) {
      setError(t.dictation.tooShort);
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const wav = encodeWav(samples, session.sampleRate);
      const saved = await saveDictationAudio(arrayBufferToBase64(wav));
      const transcript = await transcribeAudio({ audioPath: saved.audioPath, model: modelId });
      return {
        audioPath: saved.audioPath,
        durationSec: transcript.durationSec || saved.durationSec || durationSec,
        text: transcript.text,
        elapsedSec: transcript.elapsedSec,
      };
    } catch (e) {
      setError(t.dictation.transcribeFailed(String(e)));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { recording, busy, error, setError, start, cancel, stopAndTranscribe };
}
