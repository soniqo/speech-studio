import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FolderInput,
  Loader2,
  Mic,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import { subscribeSidecarMemory } from "../hooks/subscribeSidecarMemory";
import { useActivityStore } from "../state/activityStore";
import { useDictationRecorder } from "../hooks/useDictationRecorder";
import {
  cloneVoice,
  deleteTtsModel,
  importReferenceAudio,
  initModel,
  pickAudio,
  probeReference,
  saveAudioAs,
  setRuntimeMode,
  setTtsVariant,
  speechRuntimeHealth,
  speechRuntimeTtsCancel,
  speechRuntimeTranscribeReference,
  speechRuntimeTtsLoad,
  speechRuntimeTtsModels,
  speechRuntimeTtsSynthesize,
  synthesizeClip,
  ttsModelArtifact,
  importTtsBundle,
  runtimeModeSettings,
  type RuntimeSynthesizeResult,
  type RuntimeTtsModel,
  type SpeechRuntimeHealth,
  type TtsArtifactInfo,
  type TtsEngineId,
  type TtsEngineInfo,
} from "../ipc/commands";
import { mediaFileSrc } from "../lib/mediaSrc";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const COMPARE_ENGINES = ["qwen3", "voxcpm2", "espeech"] as const;
type CompareEngine = (typeof COMPARE_ENGINES)[number];

const ENGINE_LABELS: Record<CompareEngine, string> = {
  qwen3: "Qwen3-TTS Base 1.7B",
  voxcpm2: "VoxCPM2",
  espeech: "ESpeech-TTS-1 RL-V2",
};

interface EngineChoice {
  variant: string;
  language: string;
}

interface CompareResult {
  audioPath?: string;
  error?: string;
  /** Time from run start to model ready. */
  loadSec?: number;
  /** First synth after a load by this run — undefined for warm reruns. */
  firstSynthSec?: number;
  /** Repeat synth with the already-resident model. */
  warmSynthSec?: number;
  durationSec?: number;
  rtf?: number;
  peakFootprintMb?: number;
  /** True when a runtime-mode run was cancelled via the Cancel button. */
  cancelled?: boolean;
  ranAt?: number;
}

function defaultLanguage(info: TtsEngineInfo | undefined): string {
  if (!info?.languages.length) return "ru";
  return info.languages.includes("ru") ? "ru" : info.languages[0];
}

function formatMb(mb: number | null | undefined): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

function formatGb(bytes: number | undefined): string {
  if (!bytes) return "0 GB";
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** The daemon reports memory as { rssMb?, footprintMb?, peakMb? } per model. */
interface RuntimeTtsMemory {
  rssMb?: number;
  footprintMb?: number;
  peakMb?: number;
}

type RuntimeTtsModelWithMemory = RuntimeTtsModel & { memory?: RuntimeTtsMemory };

/**
 * Peak memory of a runtime-mode model: the daemon's own report (max of its
 * peak/footprint figures), or undefined when the daemon sent none.
 */
function runtimePeakMemoryMb(model: RuntimeTtsModelWithMemory | undefined): number | undefined {
  if (!model?.memory) return undefined;
  const peak = Math.max(model.memory.peakMb ?? 0, model.memory.footprintMb ?? 0);
  return peak > 0 ? peak : undefined;
}

export function VoiceCompare() {
  const locale = useProjectStore((s) => s.locale);
  const ru = locale === "ru";
  const voices = useProjectStore((s) => s.project.voices);
  const engines = useProjectStore((s) => s.model.engines);
  const memory = useActivityStore((s) => s.memory);
  const addVoice = useProjectStore((s) => s.addVoice);

  const [voiceId, setVoiceId] = useState("");
  const activeVoiceId = voices.some((voice) => voice.id === voiceId)
    ? voiceId
    : (voices[0]?.id ?? "");
  const voice = voices.find((candidate) => candidate.id === activeVoiceId);

  const [referenceText, setReferenceText] = useState("");
  const [targetText, setTargetText] = useState(
    "Проверьте произношение русских слов, ударения и интонацию. Kubernetes, Swift и DevOps.",
  );
  const [enabled, setEnabled] = useState<CompareEngine[]>([...COMPARE_ENGINES]);
  const [choices, setChoices] = useState<Record<CompareEngine, EngineChoice>>({
    qwen3: { variant: "", language: "ru" },
    voxcpm2: { variant: "", language: "ru" },
    espeech: { variant: "", language: "ru" },
  });
  const [results, setResults] = useState<Record<string, CompareResult>>({});
  const [artifacts, setArtifacts] = useState<Record<string, TtsArtifactInfo | undefined>>({});
  const [busyEngine, setBusyEngine] = useState<CompareEngine | null>(null);
  const [managingEngine, setManagingEngine] = useState<CompareEngine | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [runtime, setRuntime] = useState<SpeechRuntimeHealth | null>(null);
  const [runtimeModels, setRuntimeModels] = useState<RuntimeTtsModelWithMemory[]>([]);
  const [sharedRuntime, setSharedRuntime] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  /**
   * Peak sidecar memory observed inside the current run's time window.
   * Ref (not state) so the `sidecar_memory` listener can fold every snapshot
   * into the run that is actually in flight, never a later engine's numbers.
   */
  const runMemory = useRef<{ engine: CompareEngine; startedAt: number; peakMb: number } | null>(null);
  /** requestId of the in-flight runtime-mode synthesis, for cancellation. */
  const activeRequestId = useRef<string | null>(null);
  /** Set when the user pressed Cancel on the current runtime-mode synth. */
  const cancelRequested = useRef(false);
  const [cancellable, setCancellable] = useState(false);

  const recorder = useDictationRecorder();
  const busy = busyEngine !== null || recorder.busy;

  const engineInfo = useMemo(() => {
    const map = new Map<TtsEngineId, TtsEngineInfo>();
    for (const info of engines) map.set(info.id, info);
    return map;
  }, [engines]);

  // Fold sidecar memory snapshots into the run that is actually in flight.
  // Outside a run window every event is ignored, so one engine's peak can
  // never leak into another engine's result.
  useEffect(() => {
    let active = true;
    let stop: () => void = () => undefined;
    void subscribeSidecarMemory((event) => {
      const run = runMemory.current;
      if (!run) return;
      const candidate = Math.max(event.peakMb ?? 0, event.footprintMb ?? 0);
      if (candidate > run.peakMb) run.peakMb = candidate;
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop();
    };
  }, []);

  useEffect(() => {
    setReferenceText(voice?.referenceText ?? "");
  }, [voice?.id, voice?.referenceText]);

  useEffect(() => {
    let cancelled = false;
    void speechRuntimeHealth()
      .then((status) => {
        if (cancelled) return;
        setRuntime(status);
        if (!status.connected) return;
        return speechRuntimeTtsModels().then((catalog) => {
          if (!cancelled) setRuntimeModels(catalog.models);
        });
      })
      .catch((e) => {
        if (!cancelled) setRuntime({ connected: false, detail: String(e) });
      });
    void runtimeModeSettings()
      .then((mode) => {
        if (!cancelled) setSharedRuntime(mode.useSharedRuntime);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Default each engine to its registry variant, without overwriting a user pick.
    setChoices((current) => {
      let changed = false;
      const next = { ...current };
      for (const engine of COMPARE_ENGINES) {
        const info = engineInfo.get(engine);
        if (!info) continue;
        const variant = current[engine].variant || info.selectedVariant || info.variants[0]?.id || "";
        const language = info.languages.includes(current[engine].language)
          ? current[engine].language
          : defaultLanguage(info);
        if (variant !== current[engine].variant || language !== current[engine].language) {
          next[engine] = { variant, language };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [engineInfo]);

  async function refreshRuntime() {
    try {
      const status = await speechRuntimeHealth();
      setRuntime(status);
      if (status.connected) {
        const catalog = await speechRuntimeTtsModels();
        setRuntimeModels(catalog.models);
      }
    } catch (e) {
      setRuntime({ connected: false, detail: String(e) });
    }
  }

  async function toggleSharedRuntime(next: boolean) {
    setError(null);
    try {
      const saved = await setRuntimeMode({ useSharedRuntime: next });
      setSharedRuntime(saved.useSharedRuntime);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshArtifact(engine: CompareEngine) {
    try {
      const info = await ttsModelArtifact(engine);
      setArtifacts((current) => ({ ...current, [engine]: info }));
      return info;
    } catch {
      return undefined;
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
        throw new Error(ru ? "Образец почти беззвучный. Запишите другой." : "Reference is nearly silent.");
      }
      const created = await cloneVoice({
        referencePath: imported.path,
        name: picked.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Voice",
        referenceText: "",
        referenceDurationSec: probe?.durationSec,
        referenceSampleRate: probe?.sampleRate,
        referenceRms: probe?.rms,
      });
      addVoice(created);
      setVoiceId(created.id);
      setResults({});
    } catch (e) {
      setError(String(e));
    }
  }

  async function recordVoice() {
    if (recorder.recording) {
      const result = await recorder.stopAndTranscribe();
      if (!result) return;
      const probe = await probeReference(result.audioPath).catch(() => undefined);
      const created = await cloneVoice({
        referencePath: result.audioPath,
        name: ru ? `Запись ${new Date().toLocaleTimeString()}` : `Recording ${new Date().toLocaleTimeString()}`,
        referenceText: result.text,
        referenceDurationSec: probe?.durationSec ?? result.durationSec,
        referenceSampleRate: probe?.sampleRate,
        referenceRms: probe?.rms,
      });
      addVoice(created);
      setVoiceId(created.id);
      setResults({});
      return;
    }
    await recorder.start();
  }

  async function transcribeReference() {
    if (!voice?.referenceAudioPath) return;
    setTranscribing(true);
    setError(null);
    try {
      const transcript = await speechRuntimeTranscribeReference(voice.referenceAudioPath);
      setReferenceText(transcript);
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  function saveVoiceProfile() {
    if (!voice) return;
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        voices: state.project.voices.map((candidate) =>
          candidate.id === voice.id ? { ...candidate, referenceText } : candidate,
        ),
      },
    }));
  }

  function toggleEngine(engine: CompareEngine, checked: boolean) {
    setEnabled((current) =>
      checked ? [...new Set([...current, engine])] : current.filter((x) => x !== engine),
    );
  }

  async function loadEngine(engine: CompareEngine): Promise<number> {
    const info = engineInfo.get(engine);
    const choice = choices[engine];
    if (!info) throw new Error(`Engine ${engine} is not available on this platform.`);
    const store = useProjectStore.getState();
    if (store.model.engine !== engine) store.setTtsEngine(engine);
    store.setTtsLanguage(choice.language);
    if (choice.variant && info.variants.some((variant) => variant.id === choice.variant)
      && info.selectedVariant !== choice.variant) {
      store.setAvailableTtsEngines(await setTtsVariant(engine, choice.variant));
    }
    store.setModelStatus("loading");
    const started = performance.now();
    try {
      await initModel(engine);
      return performance.now() - started;
    } finally {
      if (useProjectStore.getState().model.engine === engine) {
        useProjectStore.getState().setModelStatus("ready");
      }
    }
  }

  /**
   * One synthesis run for one engine. `warm` marks a rerun with a model that
   * this page already loaded (or that the daemon already held resident), so
   * "cold" is only ever shown for a load performed by this run.
   */

/**
 * ESpeech reads RUAccent stress markup (`молок+о`); Qwen3 and VoxCPM2 speak
 * the `+` out loud, so it is stripped from their text only.
 */
function textForEngine(engine: CompareEngine, text: string): string {
  if (engine === "espeech") return text;
  return text.split("+").join("");
}

  async function runEngine(engine: CompareEngine, warm = false) {
    if (busy || !voice?.referenceAudioPath || !targetText.trim()) return;
    setError(null);
    setBusyEngine(engine);
    setStage(`${ENGINE_LABELS[engine]}: ${ru ? "запуск" : "starting"}`);
    const startedAt = Date.now();
    runMemory.current = { engine, startedAt, peakMb: 0 };
    try {
      let result: CompareResult;
      let synthElapsedSec: number | undefined;
      if (sharedRuntime) {
        // The daemon owns the model; never initialize a second local copy.
        const loadStarted = performance.now();
        const modelInfo = runtimeModels.find((candidate) => candidate.id === engine);
        // In runtime mode the sidecar never loads weights: the daemon is the
        // memory owner, so the peak comes from its reported per-model memory.
        const runtimePeakMb = runtimePeakMemoryMb(modelInfo);
        await speechRuntimeTtsLoad(engine, choices[engine].variant || undefined);
        const loadSec = (performance.now() - loadStarted) / 1000;
        setStage(`${ENGINE_LABELS[engine]}: ${ru ? "синтез через Speech Runtime" : "synthesizing via Speech Runtime"}`);
        const synthStarted = performance.now();
        const requestId = crypto.randomUUID();
        activeRequestId.current = requestId;
        setCancellable(true);
        let synth: RuntimeSynthesizeResult;
        try {
          synth = await speechRuntimeTtsSynthesize({
            requestId,
            model: engine,
            referenceAudioPath: voice.referenceAudioPath,
            referenceText,
            text: textForEngine(engine, targetText),
            language: choices[engine].language,
          });
        } catch (e) {
          if (cancelRequested.current) {
            setResults((current) => ({
              ...current,
              [engine]: { cancelled: true, ranAt: Date.now() },
            }));
            return;
          }
          throw e;
        } finally {
          activeRequestId.current = null;
          setCancellable(false);
          cancelRequested.current = false;
        }
        // Runtime mode measures the daemon round trip; the daemon has no
        // per-request synthesis-time field.
        synthElapsedSec = (performance.now() - synthStarted) / 1000;
        result = {
          audioPath: synth.audioPath,
          durationSec: synth.durationSec,
          loadSec,
          peakFootprintMb: runtimePeakMb,
        };
        // The daemon's memory report lags the synth (it parses the sidecar's
        // stderr); refetch the catalog so the peak reflects this run.
        try {
          const catalog = await speechRuntimeTtsModels();
          setRuntimeModels(catalog.models);
          result.peakFootprintMb = runtimePeakMemoryMb(
            catalog.models.find((candidate) => candidate.id === engine),
          ) ?? runtimePeakMb;
        } catch {
          result.peakFootprintMb = runtimePeakMb;
        }
      } else {
        const loadSec = (await loadEngine(engine)) / 1000;
        setStage(`${ENGINE_LABELS[engine]}: ${ru ? "синтез" : "synthesizing"}`);
        const synthStarted = performance.now();
        const synth = await synthesizeClip({
          clipId: crypto.randomUUID(),
          engine,
          text: textForEngine(engine, targetText),
          voiceId: voice.id,
          referenceAudioPath: voice.referenceAudioPath,
          referenceText,
          language: engineInfo.get(engine)?.requiresLanguage ? choices[engine].language : undefined,
        });
        // The backend reports the model's own synthesis time; the JS wall clock
        // here would also include IPC and audio-file decoding.
        synthElapsedSec = synth.elapsedSec ?? (performance.now() - synthStarted) / 1000;
        result = {
          audioPath: synth.audioPath,
          durationSec: synth.durationSec,
          loadSec,
        };
        await refreshArtifact(engine);
        const peakMb = runMemory.current?.peakMb ?? 0;
        result.peakFootprintMb = peakMb > 0 ? peakMb : undefined;
      }
      if (warm) {
        result.warmSynthSec = synthElapsedSec;
      } else {
        result.firstSynthSec = synthElapsedSec;
      }
      if (synthElapsedSec != null && result.durationSec) {
        result.rtf = synthElapsedSec / result.durationSec;
      }
      result.ranAt = Date.now();
      setResults((current) => ({ ...current, [engine]: result }));
    } catch (e) {
      setResults((current) => ({ ...current, [engine]: { error: String(e), ranAt: Date.now() } }));
    } finally {
      runMemory.current = null;
      setBusyEngine(null);
      setStage("");

    }
  }

  async function runCompare() {
    if (busy) return;
    setError(null);
    const chosen = COMPARE_ENGINES.filter((engine) => enabled.includes(engine));
    if (!voice?.referenceAudioPath || !targetText.trim() || chosen.length === 0) {
      setError(ru ? "Выберите голос, текст и хотя бы одну модель." : "Choose voice, text, and at least one model.");
      return;
    }
    const needsTranscript = chosen.some((engine) => engineInfo.get(engine)?.requiresReferenceTranscript);
    if (needsTranscript && !referenceText.trim()) {
      setError(ru ? "Для клонирования нужна точная расшифровка образца." : "Cloning requires an accurate reference transcript.");
      return;
    }
    const store = useProjectStore.getState();
    store.setPlaying(false);
    store.setSynthesisStatus("running");
    try {
      for (const engine of chosen) {
        await runEngine(engine);
      }
    } finally {
      store.setSynthesisStatus("idle");
    }
  }

  /**
   * Rerun with the resident model. All four metrics are replaced by the new
   * run: load time is re-measured (in runtime mode a load may not even be
   * needed), the fresh synth lands in `warmSynthSec`, and the previous cold
   * number — if the first run actually loaded the model — is kept.
   */
  async function regenerate(engine: CompareEngine) {
    const hadCold = results[engine]?.firstSynthSec != null;
    const previousCold = results[engine]?.firstSynthSec;
    const previousLoad = results[engine]?.loadSec;
    await runEngine(engine, true);
    if (hadCold && previousCold != null) {
      // The first run performed a real load; preserve its cold measurement
      // while the rerun reports itself as warm.
      setResults((current) => {
        const result = current[engine];
        if (!result?.audioPath) return current;
        return {
          ...current,
          [engine]: {
            ...result,
            firstSynthSec: previousCold,
            loadSec: previousLoad ?? result.loadSec,
          },
        };
      });
    }
  }

  async function cancelSynth() {
    const requestId = activeRequestId.current;
    if (!requestId) return;
    cancelRequested.current = true;
    try {
      await speechRuntimeTtsCancel(requestId);
    } catch (e) {
      cancelRequested.current = false;
      setError(String(e));
    }
  }

  async function importBundle(engine: CompareEngine) {
    setManagingEngine(engine);
    setError(null);
    try {
      const info = await importTtsBundle(engine);
      setArtifacts((current) => ({ ...current, [engine]: info }));
      await loadEngine(engine);
    } catch (e) {
      setError(String(e));
    } finally {
      setManagingEngine(null);
    }
  }

  async function download(engine: CompareEngine) {
    setManagingEngine(engine);
    setError(null);
    try {
      await loadEngine(engine);
      await refreshArtifact(engine);
    } catch (e) {
      setError(String(e));
    } finally {
      setManagingEngine(null);
    }
  }

  async function remove(engine: CompareEngine) {
    if (busy || managingEngine) return;
    if (!window.confirm(ru ? `Удалить веса ${ENGINE_LABELS[engine]}?` : `Delete ${ENGINE_LABELS[engine]} weights?`)) {
      return;
    }
    setManagingEngine(engine);
    setError(null);
    try {
      const info = await deleteTtsModel(engine);
      setArtifacts((current) => ({ ...current, [engine]: info }));
      setResults((current) => ({ ...current, [engine]: {} }));
    } catch (e) {
      setError(String(e));
    } finally {
      setManagingEngine(null);
    }
  }

  async function saveWav(engine: CompareEngine, audioPath: string) {
    try {
      await saveAudioAs(audioPath, `compare-${engine}-${Date.now()}.wav`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background p-5">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{ru ? "Сравнение клонирования голоса" : "Voice cloning comparison"}</h2>
            <p className="text-xs text-muted-foreground">
              {ru
                ? "Один образец и один текст для трёх движков. Локально модели загружаются последовательно; в общем Speech Runtime — по одной резидентной."
                : "One reference and one text across three engines. Locally models load sequentially; through the shared Speech Runtime one stays resident."}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={runtime?.connected ? "text-emerald-500" : "text-muted-foreground"}>
              Speech Runtime: {runtime == null ? "…" : runtime.connected ? (ru ? "подключён" : "connected") : (ru ? "недоступен" : "offline")}
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={transcribing} onClick={() => void refreshRuntime()}>
              <RefreshCw className="h-3 w-3" />
            </Button>
            <label className="ml-2 flex items-center gap-1.5" title={ru ? "Синтез выполняет общий демон, второй экземпляр модели не запускается" : "The daemon owns the model; no second copy is loaded"}>
              <input
                type="checkbox"
                checked={sharedRuntime}
                disabled={busy || !runtime?.connected}
                onChange={(e) => void toggleSharedRuntime(e.target.checked)}
              />
              {ru ? "Общий Speech Runtime" : "Shared Speech Runtime"}
            </label>
          </div>
        </div>

        {runtime && !runtime.connected && (
          <p className="truncate text-xs text-muted-foreground" title={runtime.detail}>{runtime.detail}</p>
        )}

        <section className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium" htmlFor="compare-voice">{ru ? "Голосовой профиль" : "Voice profile"}</label>
            <select
              id="compare-voice"
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
              disabled={busy}
              value={activeVoiceId}
              onChange={(e) => {
                setVoiceId(e.target.value);
                setResults({});
              }}
            >
              {voices.length === 0 && <option value="">{ru ? "Нет профилей" : "No voice profiles"}</option>}
              {voices.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void importVoice()}>
              <Upload className="mr-1 h-3.5 w-3.5" />{ru ? "Импорт аудио" : "Import audio"}
            </Button>
            <Button variant={recorder.recording ? "destructive" : "outline"} size="sm" disabled={busy && !recorder.recording} onClick={() => void recordVoice()}>
              {recorder.recording ? <Square className="mr-1 h-3.5 w-3.5" /> : recorder.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Mic className="mr-1 h-3.5 w-3.5" />}
              {recorder.recording ? (ru ? "Остановить и сохранить" : "Stop and save") : (ru ? "Записать с микрофона" : "Record from mic")}
            </Button>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="compare-ref-text">
              {ru ? "Расшифровка образца (обязательна для F5/ESpeech и Qwen3-ICL)" : "Reference transcript (required for F5/ESpeech and Qwen3-ICL)"}
            </label>
            <Textarea
              id="compare-ref-text"
              rows={2}
              value={referenceText}
              disabled={busy || transcribing}
              onChange={(e) => setReferenceText(e.target.value)}
              placeholder={ru ? "Точный текст эталонной записи" : "Exact words spoken in the reference"}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!runtime?.connected || !voice?.referenceAudioPath || busy || transcribing} onClick={() => void transcribeReference()}>
                {transcribing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {ru ? "Распознать (Parakeet Ultra)" : "Transcribe (Parakeet Ultra)"}
              </Button>
              <Button variant="outline" size="sm" disabled={!voice || busy || referenceText === voice.referenceText} onClick={saveVoiceProfile}>
                <Save className="mr-1 h-3 w-3" />{ru ? "Сохранить профиль" : "Save profile"}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="compare-target">{ru ? "Текст синтеза" : "Text to synthesize"}</label>
            <Textarea id="compare-target" rows={3} value={targetText} disabled={busy} onChange={(e) => setTargetText(e.target.value)} />
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
          <div className="grid gap-2 md:grid-cols-3">
            {COMPARE_ENGINES.map((engine) => {
              const info = engineInfo.get(engine);
              const artifact = artifacts[engine];
              const runtimeModel = runtimeModels.find((candidate) => candidate.id === engine);
              const selected = enabled.includes(engine);
              return (
                <div key={engine} className={`min-w-0 space-y-2 rounded-lg border p-3 ${selected ? "border-border" : "border-border/50 opacity-60"}`}>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={selected} disabled={busy} onChange={(e) => toggleEngine(engine, e.target.checked)} />
                    {ENGINE_LABELS[engine]}
                  </label>
                  <div className="text-[11px] text-muted-foreground">
                    {info ? `${info.runtime} · ${info.modelSize} · ${info.readiness}` : ru ? "недоступен на этой платформе" : "not available on this platform"}
                    {artifact ? ` · ${formatGb(artifact.bytes)}` : ""}
                    {engine === "espeech" ? ` · ${ru ? "локальный бандл" : "local bundle"}` : ""}
                    {sharedRuntime && runtimeModel ? ` · runtime: ${runtimeModel.loaded ? (ru ? "загружена" : "loaded") : (ru ? "выгружена" : "not loaded")}` : ""}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {info && info.variants.length > 0 && (
                      <select
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                        disabled={busy}
                        value={choices[engine].variant}
                        onChange={(e) => setChoices((current) => ({ ...current, [engine]: { ...current[engine], variant: e.target.value } }))}
                      >
                        {info.variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.label} {variant.diskGb ? `· ${variant.diskGb} GB` : ""} {variant.ramGib ? `· ~${variant.ramGib} GiB RAM` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    {info?.requiresLanguage && (
                      <select
                        className="rounded border border-border bg-background px-2 py-1 text-xs"
                        disabled={busy}
                        value={choices[engine].language}
                        onChange={(e) => setChoices((current) => ({ ...current, [engine]: { ...current[engine], language: e.target.value } }))}
                      >
                        {info.languages.map((language) => <option key={language} value={language}>{language}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {engine === "espeech" ? (
                      <>
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || managingEngine !== null || !info} onClick={() => void importBundle(engine)}>
                          {managingEngine === engine ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <FolderInput className="mr-1 h-3 w-3" />}
                          {artifact?.exists
                            ? (ru ? "Обновить бандл" : "Refresh bundle")
                            : (ru ? "Импортировать бандл" : "Import bundle")}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={busy || managingEngine !== null || !info} onClick={() => void refreshArtifact(engine)}>
                          {managingEngine === engine ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                          {ru ? "Проверить" : "Check"}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy || managingEngine !== null || !info} onClick={() => void download(engine)}>
                        {managingEngine === engine ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}
                        {artifact?.exists ? (ru ? "Загрузить в память" : "Load") : (ru ? "Скачать веса" : "Download weights")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-destructive" disabled={busy || managingEngine !== null || !artifact?.exists} onClick={() => void remove(engine)}>
                      {managingEngine === engine ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Trash2 className="mr-1 h-3 w-3" />}
                      {ru ? "Удалить" : "Delete"}
                    </Button>
                  </div>
                  {engine === "espeech" && (
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      {ru
                        ? "Не скачивается с хаба. Положите сконвертированный бандл в ~/Library/Caches/qwen3-speech/models/local/ESpeech-TTS-1-RL-V2-MLX-fp16 и импортируйте."
                        : "Not hub-downloadable. Place the converted bundle at ~/Library/Caches/qwen3-speech/models/local/ESpeech-TTS-1-RL-V2-MLX-fp16 and import it."}
                    </p>
                  )}
                  {artifact?.paths.length ? (
                    <p className="truncate text-[10px] text-muted-foreground" title={artifact.paths.join("\n")}>{artifact.paths[0]}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {COMPARE_ENGINES.every((engine) => !engineInfo.get(engine)) && (
            <p className="text-xs text-muted-foreground">
              {ru
                ? "Каталог движков пуст: локальный реестр недоступен и Speech Runtime не прислал модели. Проверьте подключение демона и обновите страницу."
                : "No engine info available: the local registry is empty and the Speech Runtime catalog returned no models. Check the daemon connection and refresh."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || enabled.length === 0} onClick={() => void runCompare()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Volume2 className="mr-2 h-4 w-4" />}
              {ru ? "Синтезировать все" : "Synthesize all"}
            </Button>
            {stage && <span className="text-xs text-muted-foreground">{stage}</span>}
            {cancellable ? (
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void cancelSynth()}>
                <Square className="mr-1 h-3 w-3" />{ru ? "Отменить" : "Cancel"}
              </Button>
            ) : busyEngine !== null && !sharedRuntime ? (
              <span className="text-[10px] text-muted-foreground">
                {ru
                  ? "отмена недоступна для локального синтеза — нажмите «Повторить» после завершения"
                  : "cancel is not available for local synthesis — Regenerate when it finishes"}
              </span>
            ) : null}
            {memory && (
              <span className="ml-auto text-xs text-muted-foreground">
                {ru ? "Память sidecar" : "Sidecar memory"}: {formatMb(memory.footprintMb)} ({memory.label})
              </span>
            )}
          </div>
          {(error || recorder.error) && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error ?? recorder.error}
            </div>
          )}
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          {COMPARE_ENGINES.map((engine) => {
            const result = results[engine] ?? {};
            const info = engineInfo.get(engine);
            return (
              <div key={engine} className="min-w-0 space-y-2 rounded-xl border border-border bg-card/40 p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">{ENGINE_LABELS[engine]}</h3>
                  <span className="text-[10px] text-muted-foreground">{info?.precision ?? ""}</span>
                </div>
                {result.cancelled ? (
                  <p className="text-xs text-muted-foreground">
                    {ru ? "Синтез отменён." : "Synthesis was cancelled."}
                  </p>
                ) : result.audioPath ? (
                  <>
                    <audio key={result.audioPath} title={result.audioPath} controls preload="none" className="w-full" src={mediaFileSrc(result.audioPath)} />
                    <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <dt>{ru ? "Загрузка" : "Load"}</dt><dd>{result.loadSec == null ? "—" : `${result.loadSec.toFixed(2)} s`}</dd>
                      <dt>{ru ? "Холодный синтез" : "Cold synth"}</dt><dd>{result.firstSynthSec == null ? "—" : `${result.firstSynthSec.toFixed(2)} s`}</dd>
                      <dt>{ru ? "Прогретый синтез" : "Warm synth"}</dt><dd>{result.warmSynthSec == null ? "—" : `${result.warmSynthSec.toFixed(2)} s`}</dd>
                      <dt>{ru ? "Аудио" : "Audio"}</dt><dd>{result.durationSec == null ? "—" : `${result.durationSec.toFixed(2)} s`}</dd>
                      <dt>RTF</dt><dd>{result.rtf == null ? "—" : result.rtf.toFixed(2)}</dd>
                      <dt>{ru ? "Пик памяти" : "Peak memory"}</dt><dd>{formatMb(result.peakFootprintMb ?? null)}</dd>
                    </dl>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void regenerate(engine)}>
                        <RefreshCw className="mr-1 h-3 w-3" />{ru ? "Повторить" : "Regenerate"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void saveWav(engine, result.audioPath!)}>
                        <Save className="mr-1 h-3 w-3" />WAV
                      </Button>
                    </div>
                  </>
                ) : result.error ? (
                  <p role="alert" className="break-words text-xs text-destructive">{result.error}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{ru ? "Нет результата" : "No result yet"}</p>
                )}
              </div>
            );
          })}
        </section>
        <p className="text-xs text-muted-foreground">
          {ru
            ? "RTF = время синтеза / длительность аудио. «Холодный» — первый запуск модели, загруженной этим запуском; «прогретый» — повторный запуск через «Повторить». Пик памяти — максимум из снимков sidecar за время запуска; в общем Speech Runtime — из отчёта демона."
            : "RTF = synthesis time / audio duration. Cold is the first run of a model loaded by that run; warm is a Regenerate run. Peak memory is the max sidecar snapshot within the run window; via the shared Speech Runtime it is the daemon's report."}
        </p>
      </div>
    </main>
  );
}
