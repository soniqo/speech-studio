import { invoke } from "@tauri-apps/api/core";
import type { Project, Voice } from "../types/project";

export interface PingResult {
  id: string;
  ok: boolean;
  result?: { pong: boolean; version: string };
  error?: string;
}

export function pingSidecar(): Promise<PingResult> {
  return invoke<PingResult>("ping_sidecar");
}

export type TtsEngineId =
  | "voxcpm2"
  | "cosyvoice"
  | "qwen3"
  | "chatterbox"
  | "omnivoice"
  | "indic-mio"
  | "fish-audio";

/** One selectable artifact of an engine — same architecture, different
 * weights (precision / size / memory footprint). */
export interface TtsModelVariant {
  id: string;
  label: string;
  modelName: string;
  modelId: string;
  precision: string;
  modelSize?: string;
  /** Approximate download size in GB. */
  diskGb?: number;
  /** Approximate resident memory while synthesizing, in GiB. */
  ramGib?: number;
}

export interface TtsEngineInfo {
  id: TtsEngineId;
  displayName: string;
  modelName: string;
  modelId: string;
  modelSize: string;
  runtime: "MLX" | "LiteRT" | string;
  precision: "bf16" | "fp16" | "int8" | "4bit" | string;
  languages: string[];
  benchmarkLanguages?: string[];
  voiceProfileModes: Array<"reference-clone" | "preset-voice" | "designed-voice">;
  requiresReferenceAudio: boolean;
  requiresReferenceTranscript: boolean;
  /** When true the engine needs a caller-chosen synthesis language. */
  requiresLanguage: boolean;
  /** How inline emotion markers are applied, so the editor can set honest
   * expectations:
   * - `instruction`: marker → a natural-language style instruction (real tone).
   * - `controlled-vocabulary`: marker → fixed model vocabulary (limited tone).
   * - `intensity`: marker → an expressiveness level only (not a specific emotion).
   * - `suffix-tag`: marker → an engine-specific suffix tag such as `<happy>`.
   * - `bracket-tag`: marker → an engine-specific suffix tag such as `[excited]`.
   * - `none`: markers are ignored. */
  styleMode:
    | "instruction"
    | "controlled-vocabulary"
    | "intensity"
    | "suffix-tag"
    | "bracket-tag"
    | "none";
  supportsInstruct: boolean;
  supportedMarkers: string[];
  needsTrim: boolean;
  sampleRate: number;
  usePolicy: "commercial-safe" | "research-only" | "needs-review" | string;
  readiness: "production" | "legacy-fallback" | "benchmark" | "experimental" | string;
  /** Alternative published artifacts (precision / memory trade-offs); empty
   * when the engine ships a single bundle. `modelId`/`precision` above already
   * reflect the selected one. */
  variants: TtsModelVariant[];
  /** Variant in effect — the saved choice or the registry default; null for
   * single-bundle engines. */
  selectedVariant: string | null;
}

export function availableTtsEngines(): Promise<TtsEngineInfo[]> {
  return invoke<TtsEngineInfo[]>("available_tts_engines");
}

/** Persist which artifact `engine` loads and get the refreshed engine list.
 * Follow with `initModel(engine)` so the sidecar swaps the weights. */
export function setTtsVariant(engine: TtsEngineId, variant: string): Promise<TtsEngineInfo[]> {
  return invoke<TtsEngineInfo[]>("set_tts_variant", { args: { engine, variant } });
}

export type AsrModelId = "parakeet-tdt-v3";

export interface AsrModelInfo {
  id: AsrModelId;
  displayName: string;
  modelName: string;
  modelId: string;
  modelSize: string;
  languages: string[];
  runtime: "coreml" | "litert" | string;
  sampleRate: number;
  maxSegmentSec: number;
  streaming: boolean;
  readiness: "production" | "experimental" | string;
}

export function availableAsrModels(): Promise<AsrModelInfo[]> {
  return invoke<AsrModelInfo[]>("available_asr_models");
}

export function initModel(engine: TtsEngineId): Promise<void> {
  return invoke<void>("init_model", { args: { engine } });
}

export function interruptModelLoad(): Promise<void> {
  return invoke<void>("interrupt_model_load");
}

export interface PickedVideo {
  path: string;
  durationSec: number;
}

export function pickVideo(): Promise<PickedVideo | null> {
  return invoke<PickedVideo | null>("pick_video");
}

export interface PickedAudio {
  path: string;
}

export function pickAudio(): Promise<PickedAudio | null> {
  return invoke<PickedAudio | null>("pick_audio");
}

export interface ImportedReferenceAudio {
  path: string;
}

export function importReferenceAudio(path: string): Promise<ImportedReferenceAudio> {
  return invoke<ImportedReferenceAudio>("import_reference_audio", { args: { path } });
}

export interface ReferenceProbe {
  sampleRate: number;
  durationSec: number;
  /** Full-clip RMS in [0,1]; < 0.005 = nearly silent, < 0.04 = quiet. */
  rms: number;
  peak: number;
}

/**
 * Decode a candidate reference clip in the sidecar and measure its level.
 * Resolves to null when the active sidecar has no probe support (callers
 * should then skip level validation).
 */
export function probeReference(path: string): Promise<ReferenceProbe | null> {
  return invoke<ReferenceProbe | null>("probe_reference", { args: { path } });
}

export interface CloneVoiceArgs {
  referencePath: string;
  name: string;
  referenceText: string;
  referenceDurationSec?: number;
  referenceSampleRate?: number;
  referenceRms?: number;
}

export function cloneVoice(args: CloneVoiceArgs): Promise<Voice> {
  return invoke<Voice>("clone_voice", { args });
}

export interface SynthesizeClipArgs {
  clipId: string;
  engine: TtsEngineId;
  text: string;
  voiceId: string;
  referenceAudioPath: string;
  referenceText: string;
  /** Synthesis language id for engines with requiresLanguage=true. */
  language?: string;
}

export interface SynthesizeClipResult {
  audioPath: string;
  /** Real rendered duration — clips auto-fit their timeline slot to this. */
  durationSec: number;
  /** Wall-clock seconds spent generating this clip. */
  elapsedSec: number;
}

export function synthesizeClip(args: SynthesizeClipArgs): Promise<SynthesizeClipResult> {
  return invoke<SynthesizeClipResult>("synthesize_clip", { args });
}

export interface SaveDictationAudioResult {
  audioPath: string;
  durationSec: number;
}

export function saveDictationAudio(wavBase64: string): Promise<SaveDictationAudioResult> {
  return invoke<SaveDictationAudioResult>("save_dictation_audio", { args: { wavBase64 } });
}

export interface TranscribeAudioArgs {
  audioPath: string;
  model?: AsrModelId;
  language?: string;
}

export interface TranscribeAudioResult {
  text: string;
  modelName: string;
  modelId: string;
  durationSec: number;
  elapsedSec: number;
  language?: string;
}

export function transcribeAudio(args: TranscribeAudioArgs): Promise<TranscribeAudioResult> {
  return invoke<TranscribeAudioResult>("transcribe_audio", { args });
}

export interface ExportClip {
  startSec: number;
  audioPath: string;
}

export interface ExportProjectArgs {
  outPath: string;
  durationSec: number;
  clips: ExportClip[];
}

export interface ExportProjectResult {
  outPath: string;
  sampleRate: number;
  durationSec: number;
  clipCount: number;
}

export function exportProject(args: ExportProjectArgs): Promise<ExportProjectResult> {
  return invoke<ExportProjectResult>("export_project", { args });
}

export interface ProjectMeta {
  id: string;
  name: string;
  savedAt: string;
}

export function listProjects(): Promise<ProjectMeta[]> {
  return invoke<ProjectMeta[]>("list_projects");
}

/** Persist a project. The store object is serialized verbatim; Rust wraps it
 * in a versioned envelope and writes <app-data>/projects/<id>.json. */
export function saveProject(project: Project): Promise<ProjectMeta> {
  return invoke<ProjectMeta>("save_project", { args: { projectJson: JSON.stringify(project) } });
}

/** Returns the saved Project as a JSON string (parse with JSON.parse). */
export function loadProject(id: string): Promise<string> {
  return invoke<string>("load_project", { args: { id } });
}

export function deleteProject(id: string): Promise<void> {
  return invoke<void>("delete_project", { args: { id } });
}

export interface DemoVoiceSeed {
  referenceAudioPath: string;
  referenceText: string;
}

export interface DemoClipSeed {
  speakerIndex: number;
  /** Path to a pre-rendered WAV if the line was already cached. */
  audioPath?: string;
  /** Duration of the cached WAV in seconds, if cached. */
  durationSec?: number;
  text: string;
}

export interface DemoSeed {
  voices: DemoVoiceSeed[];
  clips: DemoClipSeed[];
}

export function seedDemo(): Promise<DemoSeed> {
  return invoke<DemoSeed>("seed_demo");
}

export function seedHindiDemo(): Promise<DemoSeed> {
  return invoke<DemoSeed>("seed_hindi_demo");
}

// ── Activity log ─────────────────────────────────────────────────────────────

export type ActivityLogSource = "sidecar" | "studio";

/** One line of the shell's activity ring: sidecar stderr or a Studio note. */
export interface ActivityLine {
  seq: number;
  tsMs: number;
  source: ActivityLogSource;
  text: string;
}

/** Parsed from the sidecar's `[sidecar] mem …` snapshots after loads and
 * renders. `footprintMb` is the real process footprint (Activity Monitor's
 * "Memory"); `rssMb` under-reports Metal buffers. Older sidecars send neither. */
export interface SidecarMemoryEvent {
  label: string;
  activeMb?: number | null;
  cacheMb?: number | null;
  peakMb?: number | null;
  rssMb?: number | null;
  footprintMb?: number | null;
}

export function activityLogSnapshot(): Promise<ActivityLine[]> {
  return invoke<ActivityLine[]>("activity_log_snapshot");
}

export function activityLogInfo(): Promise<{ path: string | null }> {
  return invoke<{ path: string | null }>("activity_log_info");
}

export function revealActivityLog(): Promise<void> {
  return invoke<void>("reveal_activity_log");
}

export function clearActivityLog(): Promise<void> {
  return invoke<void>("clear_activity_log");
}

/** Record a WebView-side event (a clip that failed to render) next to the
 * sidecar lines, so the panel and the log file tell the whole story. */
export function noteActivity(text: string): Promise<void> {
  return invoke<void>("activity_log_note", { args: { text } });
}
