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

export function initModel(): Promise<void> {
  return invoke<void>("init_model");
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
  text: string;
  voiceId: string;
  referenceAudioPath: string;
  referenceText: string;
}

export interface SynthesizeClipResult {
  audioPath: string;
  /** Real rendered duration — clips auto-fit their timeline slot to this. */
  durationSec: number;
}

export function synthesizeClip(args: SynthesizeClipArgs): Promise<SynthesizeClipResult> {
  return invoke<SynthesizeClipResult>("synthesize_clip", { args });
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
