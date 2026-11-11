import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Upload, Volume2 } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import {
  cloneVoice,
  importReferenceAudio,
  initModel,
  pickAudio,
  probeReference,
  speechRuntimeHealth,
  speechRuntimeTranscribeReference,
  synthesizeClip,
  type TtsEngineId,
  type SpeechRuntimeHealth,
} from "../ipc/commands";
import { mediaFileSrc } from "../lib/mediaSrc";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const COMPARE_ENGINES = ["qwen3", "voxcpm2"] as const;
type CompareEngine = (typeof COMPARE_ENGINES)[number];

interface CompareResult {
  engine: CompareEngine;
  audioPath?: string;
  elapsedSec?: number;
  durationSec?: number;
  error?: string;
}

const modelLabel: Record<CompareEngine, string> = {
  qwen3: "Qwen3-TTS Base",
  voxcpm2: "VoxCPM2",
};

/** Sequential engine A/B: one Swift/MLX model resident at a time. */
export function VoiceCompare() {
  const locale = useProjectStore((s) => s.locale);
  const ru = locale === "ru";
  const voices = useProjectStore((s) => s.project.voices);
  const engineInfo = useProjectStore((s) => s.model.engines);
  const modelStatus = useProjectStore((s) => s.model.status);
  const synthesisStatus = useProjectStore((s) => s.synthesisStatus);
  const [voiceId, setVoiceId] = useState("");
  const activeVoiceId = voices.some((v) => v.id === voiceId) ? voiceId : (voices[0]?.id ?? "");
  const voice = voices.find((v) => v.id === activeVoiceId);
  const [referenceText, setReferenceText] = useState("");
  const [targetText, setTargetText] = useState(
    "Проверьте произношение русских слов, ударения и интонацию. Kubernetes, Swift и DevOps.",
  );
  const [enabled, setEnabled] = useState<CompareEngine[]>(["qwen3", "voxcpm2"]);
  const [results, setResults] = useState<CompareResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<SpeechRuntimeHealth | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  useEffect(() => {
    setReferenceText(voice?.referenceText ?? "");
  }, [voice?.id, voice?.referenceText]);

  useEffect(() => {
    let cancelled = false;
    void speechRuntimeHealth()
      .then((status) => { if (!cancelled) setRuntime(status); })
      .catch((e) => { if (!cancelled) setRuntime({ connected: false, detail: String(e) }); });
    return () => { cancelled = true; };
  }, []);

  async function refreshRuntime() {
    try {
      setRuntime(await speechRuntimeHealth());
    } catch (e) {
      setRuntime({ connected: false, detail: String(e) });
    }
  }

  async function importVoice() {
    setError(null);
    try {
      const picked = await pickAudio();
      if (!picked) return;
      const imported = await importReferenceAudio(picked.path);
      const probe = await probeReference(imported.path);
      if (probe && probe.rms < 0.005) {
        throw new Error(ru ? "Образец почти беззвучный. Запишите другой." : "Reference is nearly silent. Choose another.");
      }
      const created = await cloneVoice({
        referencePath: imported.path,
        name: picked.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Voice",
        referenceText: "",
        referenceDurationSec: probe?.durationSec,
        referenceSampleRate: probe?.sampleRate,
        referenceRms: probe?.rms,
      });
      useProjectStore.getState().addVoice(created);
      setVoiceId(created.id);
      setResults([]);
    } catch (e) {
      setError(String(e));
    }
  }

  function saveReferenceText() {
    if (!voice) return;
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        voices: state.project.voices.map((v) =>
          v.id === voice.id ? { ...v, referenceText } : v,
        ),
      },
    }));
  }

  async function transcribeReference() {
    if (!voice?.referenceAudioPath) return;
    setTranscribing(true);
    setError(null);
    try {
      const transcript = await speechRuntimeTranscribeReference(voice.referenceAudioPath);
      setReferenceText(transcript); // review before explicitly saving to the project
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  function toggle(engine: CompareEngine, checked: boolean) {
    setEnabled((current) => checked ? [...current, engine] : current.filter((x) => x !== engine));
  }

  async function compare() {
    if (busy || synthesisStatus === "running") return;
    setError(null);
    setResults([]);
    if (!voice?.referenceAudioPath || !targetText.trim() || enabled.length === 0) {
      setError(ru ? "Выберите голос, текст и хотя бы одну модель." : "Choose voice, text, and at least one model.");
      return;
    }
    if (modelStatus === "loading") {
      setError(ru ? "Дождитесь загрузки текущей модели." : "Wait for the current model to load.");
      return;
    }
    const chosen = COMPARE_ENGINES.filter((engine) => enabled.includes(engine));
    const missing = chosen.filter((engine) => !engineInfo.some((info) => info.id === engine));
    if (missing.length > 0) {
      setError(`Unavailable engines: ${missing.join(", ")}`);
      return;
    }
    if (chosen.some((engine) => engineInfo.find((info) => info.id === engine)?.requiresReferenceTranscript) && !referenceText.trim()) {
      setError(ru ? "Для Qwen3-TTS нужна точная расшифровка образца." : "Qwen3-TTS requires an accurate reference transcript.");
      return;
    }

    setBusy(true);
    const state = useProjectStore.getState();
    state.setPlaying(false);
    state.setSynthesisStatus("running"); // Prevent TopBar switching mid-comparison.
    try {
      for (const engine of chosen) {
        const model = useProjectStore.getState().model;
        const details = model.engines.find((info) => info.id === engine);
        setStage(`${modelLabel[engine]}: ${ru ? "загрузка" : "loading"}`);
        try {
          if (model.engine !== engine || model.status !== "ready") {
            useProjectStore.getState().setTtsEngine(engine as TtsEngineId);
            useProjectStore.getState().setModelStatus("loading");
            await initModel(engine);
            useProjectStore.getState().setModelStatus("ready");
          }
        } catch (e) {
          useProjectStore.getState().setModelStatus("error", String(e));
          setResults((current) => [...current, { engine, error: String(e) }]);
          continue;
        }
        setStage(`${modelLabel[engine]}: ${ru ? "синтез" : "synthesizing"}`);
        try {
          const result = await synthesizeClip({
            clipId: crypto.randomUUID(), // Never overwrite a timeline clip or another comparison.
            engine,
            text: targetText,
            voiceId: voice.id,
            referenceAudioPath: voice.referenceAudioPath,
            referenceText,
            language: details?.requiresLanguage ? "ru" : undefined,
          });
          setResults((current) => [...current, {
            engine, audioPath: result.audioPath, elapsedSec: result.elapsedSec,
            durationSec: result.durationSec,
          }]);
        } catch (e) {
          // A failed render does not necessarily mean the loaded model is broken.
          setResults((current) => [...current, { engine, error: String(e) }]);
        }
      }
    } finally {
      setStage("");
      setBusy(false);
      useProjectStore.getState().setSynthesisStatus("idle");
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background p-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{ru ? "Сравнение клонирования голоса" : "Voice cloning comparison"}</h2>
          <p className="text-xs text-muted-foreground">
            {ru ? "Один образец и текст для всех моделей. Модели загружаются последовательно, не одновременно." : "Same voice and text across engines. Models load sequentially, not concurrently."}
          </p>
        </div>

        <section className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium" htmlFor="compare-voice">{ru ? "Образец голоса" : "Reference voice"}</label>
            <select id="compare-voice" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" disabled={busy} value={activeVoiceId} onChange={(e) => { setVoiceId(e.target.value); setResults([]); }}>
              {voices.length === 0 && <option value="">{ru ? "Нет образцов" : "No reference voices"}</option>}
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void importVoice()}>
              <Upload className="mr-1 h-3.5 w-3.5" />{ru ? "Добавить WAV/аудио" : "Import reference"}
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={runtime?.connected ? "text-emerald-500" : "text-muted-foreground"}>
              Speech Runtime: {runtime == null ? "…" : runtime.connected ? (ru ? "подключён" : "connected") : (ru ? "недоступен" : "offline")}
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={transcribing} onClick={() => void refreshRuntime()}>
              <RefreshCw className="h-3 w-3" />
            </Button>
            {runtime && !runtime.connected && <span className="truncate" title={runtime.detail}>{runtime.detail}</span>}
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="compare-ref-text">{ru ? "Расшифровка образца (для Qwen3-TTS)" : "Reference transcript (Qwen3-TTS)"}</label>
            <Textarea id="compare-ref-text" rows={2} value={referenceText} disabled={busy || transcribing} onChange={(e) => setReferenceText(e.target.value)} placeholder={ru ? "Точный текст эталонной записи" : "Exact words spoken in the reference"} />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!runtime?.connected || !voice?.referenceAudioPath || busy || transcribing} onClick={() => void transcribeReference()}>
                {transcribing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {ru ? "Распознать через Speech Runtime" : "Transcribe via Speech Runtime"}
              </Button>
              <Button variant="outline" size="sm" disabled={!voice || busy || referenceText === voice.referenceText} onClick={saveReferenceText}>
                {ru ? "Сохранить расшифровку" : "Save transcript"}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="compare-target">{ru ? "Текст синтеза" : "Text to synthesize"}</label>
            <Textarea id="compare-target" rows={3} value={targetText} disabled={busy} onChange={(e) => setTargetText(e.target.value)} />
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            {COMPARE_ENGINES.map((engine) => (
              <label key={engine} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={enabled.includes(engine)} disabled={busy} onChange={(e) => toggle(engine, e.target.checked)} />
                {modelLabel[engine]}
              </label>
            ))}
            <span className="text-xs text-muted-foreground" title="Requires a native F5-TTS conversion and Russian tokenizer">
              ESpeech-TTS-1 · {ru ? "ещё не подключена" : "not integrated yet"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={busy || synthesisStatus === "running"} onClick={() => void compare()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Volume2 className="mr-2 h-4 w-4" />}
              {ru ? "Синтезировать и сравнить" : "Synthesize and compare"}
            </Button>
            {stage && <span className="text-xs text-muted-foreground">{stage}</span>}
          </div>
          {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          {COMPARE_ENGINES.map((engine) => {
            const result = results.find((item) => item.engine === engine);
            return (
              <div key={engine} className="min-w-0 rounded-xl border border-border bg-card/40 p-4 space-y-2">
                <h3 className="text-sm font-medium">{modelLabel[engine]}</h3>
                {result?.audioPath ? (
                  <>
                    <audio key={result.audioPath} controls preload="none" className="w-full" src={mediaFileSrc(result.audioPath)} />
                    <div className="text-xs text-muted-foreground">
                      {ru ? "Синтез" : "Generation"}: {result.elapsedSec?.toFixed(2)}s · {ru ? "Аудио" : "Audio"}: {result.durationSec?.toFixed(2)}s
                      {result.elapsedSec && result.durationSec ? ` · RTF ${(result.elapsedSec / result.durationSec).toFixed(2)}` : ""}
                    </div>
                  </>
                ) : result?.error ? <p role="alert" className="text-xs text-destructive">{result.error}</p> : (
                  <p className="text-xs text-muted-foreground">{ru ? "Нет результата" : "No result yet"}</p>
                )}
              </div>
            );
          })}
        </section>
        <p className="text-xs text-muted-foreground">
          {ru ? "Для объективного сравнения прослушайте один и тот же текст. Загрузка модели не входит во время синтеза. RTF — время генерации / длительность аудио." : "Listen to the same text for both engines. Model loading is excluded from synthesis time. RTF = generation time / audio duration."}
        </p>
      </div>
    </main>
  );
}
