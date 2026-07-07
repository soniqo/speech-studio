use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    LazyLock, Mutex,
};
use std::time::Instant;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ---------- sidecar process management ----------

// Sidecar binary name (Tauri's externalBin bundler strips the target-triple
// suffix, so this is also the bundled name). macOS runs the Swift/MLX sidecar;
// Windows/Linux run the speech-core LiteRT C++ sidecar.
#[cfg(target_os = "macos")]
const SIDECAR_BIN: &str = "soniqo-tts-sidecar";
#[cfg(all(not(target_os = "macos"), target_os = "windows"))]
const SIDECAR_BIN: &str = "speech-core-tts-sidecar.exe";
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const SIDECAR_BIN: &str = "speech-core-tts-sidecar";

fn sidecar_path() -> PathBuf {
    // In a Tauri release bundle the sidecar lives next to the main binary
    // (e.g. `<App>.app/Contents/MacOS/` on macOS, alongside the .exe on
    // Windows). In dev we read from the sidecar's build dir so `pnpm tauri dev`
    // and `cargo run` both find the freshly-built binary.
    if !cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let bundled = parent.join(SIDECAR_BIN);
                if bundled.exists() {
                    return bundled;
                }
            }
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    #[cfg(target_os = "macos")]
    {
        manifest
            .join("..")
            .join("swift-sidecar")
            .join(".build")
            .join("debug")
            .join(SIDECAR_BIN)
    }
    // Windows: CMake's Visual Studio generator nests the binary under a
    // per-config subdir (Release). Single-config generators (Ninja, Unix
    // Makefiles on Linux) put it directly in the build dir.
    #[cfg(all(not(target_os = "macos"), target_os = "windows"))]
    {
        manifest
            .join("..")
            .join("core-sidecar")
            .join("build")
            .join("Release")
            .join(SIDECAR_BIN)
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        manifest
            .join("..")
            .join("core-sidecar")
            .join("build")
            .join(SIDECAR_BIN)
    }
}

// MLX-Swift looks for `mlx.metallib` via `dladdr` on its own code — which in
// our bundle resolves to the sidecar binary's directory (`Contents/MacOS/`).
// Tauri's `resources` config places the file at `Contents/Resources/`, one
// level up, so MLX never finds it and `init_model` aborts with
// "Failed to load the default metallib". Until the metallib moves to
// `externalBin` (next to the sidecar at bundle time), colocate it on demand:
// symlink the bundled copy into the sidecar's directory the first time the
// process starts. Idempotent — does nothing if the file is already present
// or unreachable.
//
// macOS-only: the metallib + `std::os::unix::fs::symlink` are Apple/Unix
// specifics. The Windows/Linux speech-core sidecar has no equivalent (LiteRT
// ships its compute as `libLiteRt`, colocated by the sidecar's CMake build).
#[cfg(target_os = "macos")]
fn colocate_metallib(sidecar_dir: &std::path::Path) {
    let dest = sidecar_dir.join("mlx.metallib");
    if dest.exists() {
        return;
    }
    let Some(macos_parent) = sidecar_dir.parent() else {
        return;
    };
    let src = macos_parent.join("Resources").join("mlx.metallib");
    if !src.exists() {
        return;
    }
    if let Err(e) = std::os::unix::fs::symlink(&src, &dest) {
        // Symlink failed (e.g. read-only Contents/MacOS on a quarantined
        // bundle). Fall back to a copy so a fresh install still works after
        // the first Gatekeeper bypass. If both fail, swallow — the sidecar
        // will spawn and surface a clear MLX error to the frontend.
        if let Err(e2) = std::fs::copy(&src, &dest) {
            eprintln!("[speech-studio] failed to colocate mlx.metallib: symlink={e}, copy={e2}");
        }
    }
}

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct SidecarManager {
    inner: Mutex<Option<SidecarProcess>>,
    child_pid: AtomicU32,
    // Bundled resource dir (Tauri ships libLiteRt here on Windows/Linux). Added
    // to the spawned sidecar's library search path so it can load libLiteRt in
    // an installed bundle, where the runtime lives apart from the binary.
    resource_dir: Option<PathBuf>,
    app: tauri::AppHandle,
}

impl SidecarManager {
    fn new(resource_dir: Option<PathBuf>, app: tauri::AppHandle) -> Self {
        Self {
            inner: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            resource_dir,
            app,
        }
    }
}

#[derive(Serialize, Clone)]
struct ModelProgressEvent {
    progress: f64,
    percent: f64,
    message: String,
}

fn parse_sidecar_progress(line: &str) -> Option<ModelProgressEvent> {
    let rest = line.split_once("[sidecar]")?.1.trim();
    let percent_idx = rest.find('%')?;
    let before_percent = &rest[..percent_idx];
    let number_start = before_percent
        .char_indices()
        .rev()
        .find(|(_, ch)| !(ch.is_ascii_digit() || *ch == '.'))
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(0);
    let percent_text = before_percent[number_start..].trim();
    if percent_text.is_empty() {
        return None;
    }
    let percent: f64 = percent_text.parse().ok()?;
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
        return None;
    }
    let stage = before_percent[..number_start].trim();
    let detail = rest[percent_idx + 1..].trim();
    let message = match (stage.is_empty(), detail.is_empty()) {
        (true, true) => "Loading model".to_string(),
        (true, false) => detail.to_string(),
        (false, true) => stage.to_string(),
        (false, false) => format!("{stage}: {detail}"),
    };
    Some(ModelProgressEvent {
        progress: percent / 100.0,
        percent,
        message,
    })
}

// Directories the spawned sidecar must be able to load libLiteRt from: its own
// directory (dev — CMake colocates the runtime there) and the bundled resource
// dir (release — Tauri ships it there). These build the child's library search
// path: PATH on Windows, LD_LIBRARY_PATH on Linux. Not needed on macOS (the
// Swift sidecar's MLX libs are linked / the metallib is handled separately).
#[cfg(not(target_os = "macos"))]
fn sidecar_lib_dirs(
    sidecar: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = sidecar.parent() {
        dirs.push(d.to_path_buf());
    }
    if let Some(d) = resource_dir {
        dirs.push(d.to_path_buf());
    }
    dirs
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        // When the Tauri app exits, kill the sidecar child so it doesn't
        // linger as an orphan holding GPU/Metal resources. The default
        // std::process::Child Drop only detaches; we want an explicit kill.
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut proc) = guard.take() {
                let _ = proc.child.kill();
                let _ = proc.child.wait();
            }
        }
        self.child_pid.store(0, Ordering::SeqCst);
    }
}

impl SidecarManager {
    fn interrupt(&self) -> Result<(), String> {
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        if pid == 0 {
            return Ok(());
        }
        kill_process(pid)
    }

    fn spawn(
        resource_dir: Option<&std::path::Path>,
        app: &tauri::AppHandle,
    ) -> Result<SidecarProcess, String> {
        let path = sidecar_path();
        #[cfg(target_os = "macos")]
        {
            let _ = resource_dir;
            if let Some(dir) = path.parent() {
                colocate_metallib(dir);
            }
        }
        let mut command = Command::new(&path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The sidecar is a console-subsystem binary. Spawning it from a GUI
        // (windows-subsystem) app would otherwise flash a console window on
        // every launch. CREATE_NO_WINDOW suppresses it; stdio is still piped,
        // so IPC is unaffected.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        // Make libLiteRt loadable from the sidecar's dir and the bundled
        // resource dir by prepending them to the child's dynamic-loader search
        // path. Child-only (via .env), so the parent process is untouched.
        #[cfg(not(target_os = "macos"))]
        {
            let dirs = sidecar_lib_dirs(&path, resource_dir);
            if !dirs.is_empty() {
                #[cfg(target_os = "windows")]
                let var = "PATH";
                #[cfg(not(target_os = "windows"))]
                let var = "LD_LIBRARY_PATH";
                let mut paths = dirs;
                if let Some(existing) = std::env::var_os(var) {
                    paths.extend(std::env::split_paths(&existing));
                }
                if let Ok(joined) = std::env::join_paths(&paths) {
                    command.env(var, joined);
                }
            }
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("spawn {} failed: {}", path.display(), e))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
        if let Some(stderr) = child.stderr.take() {
            let app = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("{line}");
                    if let Some(event) = parse_sidecar_progress(&line) {
                        let _ = app.emit("model_progress", event);
                    }
                }
            });
        }
        Ok(SidecarProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn request(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;

        // Lazily spawn or respawn if the previous one died.
        let needs_spawn = match guard.as_mut() {
            None => true,
            Some(p) => matches!(p.child.try_wait(), Ok(Some(_)) | Err(_)),
        };
        if needs_spawn {
            if let Some(mut stale) = guard.take() {
                let _ = stale.child.kill();
                let _ = stale.child.wait();
            }
            let proc = Self::spawn(self.resource_dir.as_deref(), &self.app)?;
            self.child_pid.store(proc.child.id(), Ordering::SeqCst);
            *guard = Some(proc);
        }

        let line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        let mut response = String::new();
        let read_result = {
            let proc = guard.as_mut().expect("just spawned");
            writeln!(proc.stdin, "{}", line).map_err(|e| e.to_string())?;
            proc.stdin.flush().map_err(|e| e.to_string())?;
            proc.stdout.read_line(&mut response)
        };
        if let Err(e) = read_result {
            self.child_pid.store(0, Ordering::SeqCst);
            if let Some(mut proc) = guard.take() {
                let _ = proc.child.wait();
            }
            return Err(e.to_string());
        }
        if response.trim().is_empty() {
            self.child_pid.store(0, Ordering::SeqCst);
            if let Some(mut proc) = guard.take() {
                let _ = proc.child.wait();
            }
            return Err("sidecar closed connection".into());
        }
        serde_json::from_str(&response)
            .map_err(|e| format!("parse sidecar response: {} (raw: {})", e, response.trim()))
    }
}

fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("failed to interrupt sidecar process {pid}: {e}"))?;

    #[cfg(not(windows))]
    let status = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .map_err(|e| format!("failed to interrupt sidecar process {pid}: {e}"))?;

    if !status.success() {
        eprintln!("[speech-studio] sidecar process {pid} was already gone or could not be killed");
    }
    Ok(())
}

// ---------- sidecar response envelope ----------

#[derive(Deserialize, Serialize)]
struct SidecarResponse {
    id: String,
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------- commands ----------

/// TTS backends exposed by the Studio. CosyVoice is currently available only
/// through the macOS Swift/MLX sidecar; Windows and Linux continue to expose
/// VoxCPM2 through speech-core.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TtsEngine {
    VoxCPM2,
    CosyVoice,
    Qwen3,
    Chatterbox,
    OmniVoice,
    #[serde(rename = "indic-mio")]
    IndicMio,
    #[serde(rename = "fish-audio")]
    FishAudio,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TtsEngineInfo {
    id: TtsEngine,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "modelSize")]
    model_size: String,
    runtime: String,
    precision: String,
    languages: Vec<String>,
    #[serde(
        rename = "benchmarkLanguages",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    benchmark_languages: Vec<String>,
    #[serde(rename = "voiceProfileModes")]
    voice_profile_modes: Vec<String>,
    #[serde(rename = "requiresReferenceAudio")]
    requires_reference_audio: bool,
    #[serde(rename = "requiresReferenceTranscript")]
    requires_reference_transcript: bool,
    #[serde(rename = "requiresLanguage")]
    requires_language: bool,
    #[serde(rename = "styleMode")]
    style_mode: String,
    #[serde(rename = "supportsInstruct")]
    supports_instruct: bool,
    #[serde(rename = "supportedMarkers")]
    supported_markers: Vec<String>,
    #[serde(rename = "needsTrim")]
    needs_trim: bool,
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    #[serde(rename = "usePolicy")]
    use_policy: String,
    readiness: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TtsEngineRegistryEntry {
    #[serde(flatten)]
    info: TtsEngineInfo,
    sidecar_command: String,
    macos_only: bool,
    #[serde(default)]
    platform_overrides: HashMap<String, ModelPlatformOverride>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AsrModel {
    ParakeetTdtV3,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AsrModelInfo {
    id: AsrModel,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "modelSize")]
    model_size: String,
    languages: Vec<String>,
    runtime: String,
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    #[serde(rename = "maxSegmentSec")]
    max_segment_sec: u32,
    streaming: bool,
    readiness: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrModelRegistryEntry {
    #[serde(flatten)]
    info: AsrModelInfo,
    sidecar_command: String,
    #[serde(default)]
    platform_overrides: HashMap<String, ModelPlatformOverride>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPlatformOverride {
    model_name: Option<String>,
    model_id: Option<String>,
    runtime: Option<String>,
    precision: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRegistry {
    version: u32,
    tts_engines: Vec<TtsEngineRegistryEntry>,
    asr_models: Vec<AsrModelRegistryEntry>,
}

impl TtsEngineInfo {
    fn apply_platform_override(&mut self, item: &ModelPlatformOverride) {
        if let Some(value) = &item.model_name {
            self.model_name = value.clone();
        }
        if let Some(value) = &item.model_id {
            self.model_id = value.clone();
        }
        if let Some(value) = &item.runtime {
            self.runtime = value.clone();
        }
        if let Some(value) = &item.precision {
            self.precision = value.clone();
        }
    }
}

impl AsrModelInfo {
    fn apply_platform_override(&mut self, item: &ModelPlatformOverride) {
        if let Some(value) = &item.model_name {
            self.model_name = value.clone();
        }
        if let Some(value) = &item.model_id {
            self.model_id = value.clone();
        }
        if let Some(value) = &item.runtime {
            self.runtime = value.clone();
        }
    }
}

fn platform_registry_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

static MODEL_REGISTRY: LazyLock<ModelRegistry> = LazyLock::new(|| {
    let mut registry: ModelRegistry =
        serde_json::from_str(include_str!("../../model-registry.json"))
            .expect("model-registry.json must be valid");
    assert_eq!(registry.version, 1, "unsupported model registry version");

    let platform = platform_registry_key();
    for entry in &mut registry.tts_engines {
        if let Some(item) = entry.platform_overrides.get(platform) {
            entry.info.apply_platform_override(item);
        }
    }
    for entry in &mut registry.asr_models {
        if let Some(item) = entry.platform_overrides.get(platform) {
            entry.info.apply_platform_override(item);
        }
    }
    registry
});

impl AsrModel {
    fn registry_entry(self) -> &'static AsrModelRegistryEntry {
        MODEL_REGISTRY
            .asr_models
            .iter()
            .find(|entry| entry.info.id == self)
            .expect("AsrModel missing from ASR_MODEL_REGISTRY")
    }

    fn sidecar_command(self) -> &'static str {
        self.registry_entry().sidecar_command.as_str()
    }
}

impl TtsEngine {
    fn registry_entry(self) -> &'static TtsEngineRegistryEntry {
        MODEL_REGISTRY
            .tts_engines
            .iter()
            .find(|entry| entry.info.id == self)
            .expect("TtsEngine missing from TTS_ENGINE_REGISTRY")
    }

    fn sidecar_command(self) -> &'static str {
        self.registry_entry().sidecar_command.as_str()
    }

    fn display_name(self) -> &'static str {
        self.registry_entry().info.display_name.as_str()
    }

    fn requires_reference_transcript(self) -> bool {
        self.registry_entry().info.requires_reference_transcript
    }

    /// Whether synthesis needs a caller-chosen language. The Studio shows a
    /// language picker only for engines that declare this in the registry.
    fn requires_language(self) -> bool {
        self.registry_entry().info.requires_language
    }

    /// How the engine applies inline emotion markers — drives the editor hint:
    /// - `instruction`: marker → an engine-specific style instruction.
    /// - `controlled-vocabulary`: marker → fixed engine vocabulary only.
    /// - `intensity`: marker → an expressiveness level only (Chatterbox; not a
    ///   specific emotion).
    /// - `suffix-tag`: marker is appended as an engine-specific suffix tag.
    /// - `bracket-tag`: marker is appended as an engine-specific bracket tag.
    /// - `none`: markers are stripped and ignored.
    fn style_mode(self) -> &'static str {
        self.registry_entry().info.style_mode.as_str()
    }
}

fn normalize_sidecar_language(engine: TtsEngine, language: Option<&str>) -> Option<String> {
    let trimmed = language.map(str::trim).filter(|value| !value.is_empty());
    match engine {
        TtsEngine::CosyVoice => trimmed.map(|value| match value.to_ascii_lowercase().as_str() {
            "zh" | "zho" | "cmn" | "chinese" => "chinese".to_string(),
            "en" | "eng" | "english" => "english".to_string(),
            "ja" | "jpn" | "japanese" => "japanese".to_string(),
            "ko" | "kor" | "korean" => "korean".to_string(),
            "de" | "deu" | "ger" | "german" => "german".to_string(),
            "es" | "spa" | "spanish" => "spanish".to_string(),
            "fr" | "fra" | "fre" | "french" => "french".to_string(),
            "it" | "ita" | "italian" => "italian".to_string(),
            "ru" | "rus" | "russian" => "russian".to_string(),
            _ => value.to_string(),
        }),
        // The UI keeps BCP-47-ish ids because Chatterbox expects `[hi]`, but
        // OmniVoice gives cleaner Hindi output with the spelled language item.
        TtsEngine::OmniVoice | TtsEngine::IndicMio => {
            trimmed.map(|value| match value.to_ascii_lowercase().as_str() {
                "hi" | "hin" => "hindi".to_string(),
                _ => value.to_string(),
            })
        }
        _ => trimmed.map(str::to_string),
    }
}

fn engine_is_supported(engine: TtsEngine) -> bool {
    let entry = engine.registry_entry();
    !entry.macos_only || cfg!(target_os = "macos")
}

fn ensure_engine_supported(engine: TtsEngine) -> Result<(), String> {
    if engine_is_supported(engine) {
        return Ok(());
    }
    Err(format!(
        "{} is currently available only on macOS (Apple Silicon)",
        engine.display_name()
    ))
}

fn humanize_sidecar_error(engine: TtsEngine, error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("failedtodownload")
        || lower.contains("failed to download")
        || lower.contains("invalid username or password")
        || lower.contains("file not found: main")
    {
        let access_hint = if lower.contains("invalid username or password")
            || lower.contains("file not found: main")
        {
            " The Hugging Face repo may be private, gated, or unavailable to this app without credentials."
        } else {
            ""
        };
        return format!(
            "Could not download {} model.{} Original error: {}",
            engine.display_name(),
            access_hint,
            error
        );
    }
    error
}

fn tts_engine_info(engine: TtsEngine) -> TtsEngineInfo {
    engine.registry_entry().info.clone()
}

fn asr_model_info(model: AsrModel) -> AsrModelInfo {
    model.registry_entry().info.clone()
}

#[tauri::command]
async fn available_tts_engines() -> Vec<TtsEngineInfo> {
    MODEL_REGISTRY
        .tts_engines
        .iter()
        .filter(|entry| engine_is_supported(entry.info.id))
        .map(|entry| entry.info.clone())
        .collect()
}

#[tauri::command]
async fn available_asr_models() -> Vec<AsrModelInfo> {
    MODEL_REGISTRY
        .asr_models
        .iter()
        .map(|entry| entry.info.clone())
        .collect()
}

#[tauri::command]
async fn ping_sidecar(manager: State<'_, SidecarManager>) -> Result<SidecarResponse, String> {
    let payload = serde_json::json!({
        "id": format!("ping-{}", uuid::Uuid::new_v4()),
        "command": "ping",
    });
    let raw = manager.request(&payload)?;
    serde_json::from_value(raw).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct InitModelArgs {
    engine: TtsEngine,
}

#[tauri::command]
async fn init_model(manager: State<'_, SidecarManager>, args: InitModelArgs) -> Result<(), String> {
    ensure_engine_supported(args.engine)?;
    let info = tts_engine_info(args.engine);
    let payload = serde_json::json!({
        "id": format!("init-{}", uuid::Uuid::new_v4()),
        "command": "init_model",
        "engine": args.engine,
        "modelId": info.model_id,
    });
    let raw = manager.request(&payload)?;
    let env: SidecarResponse = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if !env.ok {
        let error = env.error.unwrap_or_else(|| "init_model failed".into());
        return Err(humanize_sidecar_error(args.engine, error));
    }
    Ok(())
}

#[tauri::command]
async fn interrupt_model_load(manager: State<'_, SidecarManager>) -> Result<(), String> {
    manager.interrupt()
}

#[derive(Serialize)]
struct PickedVideo {
    path: String,
    #[serde(rename = "durationSec")]
    duration_sec: f64,
}

#[tauri::command]
async fn pick_video(app: tauri::AppHandle) -> Result<Option<PickedVideo>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Video", &["mp4", "mov", "m4v", "mkv", "webm"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked.map(|p| PickedVideo {
        // Duration unknown until we probe with ffmpeg/AVFoundation. Frontend
        // can refine via the HTMLMediaElement once the file is opened.
        path: p.to_string(),
        duration_sec: 0.0,
    }))
}

#[derive(Serialize)]
struct PickedAudio {
    path: String,
}

#[tauri::command]
async fn pick_audio(app: tauri::AppHandle) -> Result<Option<PickedAudio>, String> {
    // Offer only formats the active sidecar can actually decode. The C++
    // sidecar (Windows/Linux) handles WAV/MP3/FLAC via dr_libs; offering
    // m4a/aac/ogg there surfaced as a hard "could not decode" error long
    // after the pick. The Swift sidecar decodes via AVFoundation and keeps
    // the wider list.
    #[cfg(target_os = "macos")]
    const AUDIO_EXTS: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "ogg"];
    #[cfg(not(target_os = "macos"))]
    const AUDIO_EXTS: &[&str] = &["wav", "mp3", "flac"];

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Audio", AUDIO_EXTS)
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked.map(|p| PickedAudio {
        path: p.to_string(),
    }))
}

fn reference_cache_dir() -> PathBuf {
    let dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("audio.soniqo.studio")
        .join("references");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn sanitize_filename_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(80));
    for ch in input.chars().take(80) {
        if ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "reference".to_string()
    } else {
        trimmed.to_string()
    }
}

fn reference_access_error(action: &str, path: &Path, err: &std::io::Error) -> String {
    let hint = match err.kind() {
        std::io::ErrorKind::PermissionDenied => {
            "Speech Studio does not have permission to read this file. Copy or export it to a normal local folder, then add it again."
        }
        std::io::ErrorKind::NotFound => {
            "The file is no longer at that path. Re-add the reference from its current location."
        }
        _ => "Copy or export the reference audio to a normal local folder, then add it again.",
    };
    format!(
        "Cannot {action} reference audio \"{}\": {err}. {hint}",
        path.display()
    )
}

fn ensure_readable_reference(path: &Path) -> Result<(), String> {
    let f = std::fs::File::open(path).map_err(|e| reference_access_error("read", path, &e))?;
    let meta = f
        .metadata()
        .map_err(|e| reference_access_error("inspect", path, &e))?;
    if !meta.is_file() {
        return Err(format!(
            "Reference audio \"{}\" is not a file",
            path.display()
        ));
    }
    if meta.len() == 0 {
        return Err(format!("Reference audio \"{}\" is empty", path.display()));
    }
    Ok(())
}

fn import_reference_audio_path(source: &str) -> Result<PathBuf, String> {
    let source_path = PathBuf::from(source);
    if source_path.as_os_str().is_empty() {
        return Err("reference audio path is empty".into());
    }

    let cache_dir = reference_cache_dir();
    if source_path.starts_with(&cache_dir) {
        ensure_readable_reference(&source_path)?;
        return Ok(source_path);
    }

    let mut input = std::fs::File::open(&source_path)
        .map_err(|e| reference_access_error("read", &source_path, &e))?;
    let meta = input
        .metadata()
        .map_err(|e| reference_access_error("inspect", &source_path, &e))?;
    if !meta.is_file() {
        return Err(format!(
            "Reference audio \"{}\" is not a file",
            source_path.display()
        ));
    }
    if meta.len() == 0 {
        return Err(format!(
            "Reference audio \"{}\" is empty",
            source_path.display()
        ));
    }

    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("create reference cache {}: {e}", cache_dir.display()))?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(sanitize_filename_component)
        .unwrap_or_else(|| "reference".to_string());
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .map(sanitize_filename_component)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "audio".to_string());
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stable_key = format!(
        "{}:{}:{}",
        source_path.to_string_lossy(),
        meta.len(),
        modified
    );
    let dest = cache_dir.join(format!("{}-{:08x}.{}", stem, short_hash(&stable_key), ext));
    if dest.exists() {
        ensure_readable_reference(&dest)?;
        return Ok(dest);
    }
    let mut output = std::fs::File::create(&dest)
        .map_err(|e| format!("create imported reference {}: {e}", dest.display()))?;
    std::io::copy(&mut input, &mut output).map_err(|e| {
        format!(
            "copy reference audio \"{}\" to \"{}\": {e}",
            source_path.display(),
            dest.display()
        )
    })?;
    Ok(dest)
}

#[derive(Deserialize)]
struct ImportReferenceAudioArgs {
    path: String,
}

#[derive(Serialize)]
struct ImportedReferenceAudio {
    path: String,
}

#[tauri::command]
async fn import_reference_audio(
    args: ImportReferenceAudioArgs,
) -> Result<ImportedReferenceAudio, String> {
    let imported = import_reference_audio_path(&args.path)?;
    Ok(ImportedReferenceAudio {
        path: imported.to_string_lossy().into_owned(),
    })
}

#[derive(Deserialize)]
struct ProbeReferenceArgs {
    path: String,
}

#[derive(Serialize)]
struct ReferenceProbe {
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    #[serde(rename = "durationSec")]
    duration_sec: f64,
    rms: f64,
    peak: f64,
}

/// Decode a candidate reference clip in the sidecar and report level stats,
/// so the frontend can reject/warn on nearly-silent references at clone time
/// (a -25 dB reference silently produced inaudible clones in the field —
/// VoxCPM2 output tracks reference amplitude). Returns Ok(None) when the
/// active sidecar predates the probe command (e.g. the Swift sidecar until
/// it ships parity) — callers then skip validation rather than fail.
#[tauri::command]
async fn probe_reference(
    manager: State<'_, SidecarManager>,
    args: ProbeReferenceArgs,
) -> Result<Option<ReferenceProbe>, String> {
    ensure_readable_reference(Path::new(&args.path))?;
    let payload = serde_json::json!({
        "id": format!("probe-{}", uuid::Uuid::new_v4().simple()),
        "command": "probe_reference",
        "referenceAudioPath": args.path,
    });
    let raw = manager.request(&payload)?;
    if raw.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = raw
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("probe_reference failed");
        if err.contains("unknown command") {
            return Ok(None); // sidecar without probe support — skip validation
        }
        return Err(err.to_string());
    }
    let result = raw.get("result").ok_or("probe_reference: missing result")?;
    let f = |k: &str| result.get(k).and_then(|v| v.as_f64());
    Ok(Some(ReferenceProbe {
        sample_rate: f("sampleRate").unwrap_or(0.0) as u32,
        duration_sec: f("durationSec").unwrap_or(0.0),
        rms: f("rms").unwrap_or(0.0),
        peak: f("peak").unwrap_or(0.0),
    }))
}

#[derive(Deserialize)]
struct CloneVoiceArgs {
    #[serde(rename = "referencePath")]
    reference_path: String,
    name: String,
    #[serde(rename = "referenceText", default)]
    reference_text: String,
    // Probe metadata measured by probe_reference at pick time; persisted on
    // the Voice so the card can show duration/rate/level and flag quiet refs.
    #[serde(rename = "referenceDurationSec", default)]
    reference_duration_sec: Option<f64>,
    #[serde(rename = "referenceSampleRate", default)]
    reference_sample_rate: Option<u32>,
    #[serde(rename = "referenceRms", default)]
    reference_rms: Option<f64>,
}

#[derive(Serialize)]
struct Voice {
    id: String,
    name: String,
    #[serde(rename = "sourceKind")]
    source_kind: &'static str,
    #[serde(rename = "referenceAudioPath")]
    reference_audio_path: String,
    #[serde(rename = "referenceText")]
    reference_text: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(
        rename = "referenceDurationSec",
        skip_serializing_if = "Option::is_none"
    )]
    reference_duration_sec: Option<f64>,
    #[serde(
        rename = "referenceSampleRate",
        skip_serializing_if = "Option::is_none"
    )]
    reference_sample_rate: Option<u32>,
    #[serde(rename = "referenceRms", skip_serializing_if = "Option::is_none")]
    reference_rms: Option<f64>,
}

#[tauri::command]
async fn clone_voice(args: CloneVoiceArgs) -> Result<Voice, String> {
    let reference_path = import_reference_audio_path(&args.reference_path)?;
    // Qwen3-TTS is pure ICL: there's no separate "clone" step. A Voice is
    // metadata pointing at a reference clip + transcript that synthesis pulls
    // in at every call. No sidecar round-trip needed here.
    Ok(Voice {
        id: uuid::Uuid::new_v4().to_string(),
        name: args.name,
        source_kind: "library",
        reference_audio_path: reference_path.to_string_lossy().into_owned(),
        reference_text: args.reference_text,
        created_at: chrono::Utc::now().to_rfc3339(),
        reference_duration_sec: args.reference_duration_sec,
        reference_sample_rate: args.reference_sample_rate,
        reference_rms: args.reference_rms,
    })
}

#[derive(Deserialize)]
struct SynthesizeArgs {
    #[serde(rename = "clipId")]
    clip_id: String,
    engine: TtsEngine,
    text: String,
    #[serde(rename = "voiceId")]
    voice_id: String,
    #[serde(rename = "referenceAudioPath")]
    reference_audio_path: String,
    #[serde(rename = "referenceText")]
    reference_text: String,
    /// Synthesis language id for engines with `requiresLanguage=true`.
    /// Optional; engines that infer or default language do not receive it.
    #[serde(default)]
    language: Option<String>,
}

#[derive(Serialize)]
struct SynthesizeResult {
    #[serde(rename = "audioPath")]
    audio_path: String,
    /// Real rendered duration from the sidecar — the frontend fits the
    /// clip's timeline slot to this (generation is always "dynamic").
    #[serde(rename = "durationSec")]
    duration_sec: f64,
    /// Wall-clock time spent in synthesis, including model warmup/download if
    /// the selected engine was not loaded yet.
    #[serde(rename = "elapsedSec")]
    elapsed_sec: f64,
}

/// Split text into sentences on terminal punctuation, including the
/// Devanagari danda/double-danda. The terminator stays attached to its
/// sentence so the model gets a clean stop cue per chunk.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\u{0964}' | '\u{0965}' | '\n') {
            let t = cur.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
            cur.clear();
        }
    }
    let t = cur.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
    out
}

/// Split a sentence at clause punctuation (comma/semicolon/colon, plus the
/// Arabic comma/semicolon), keeping the separator attached. Used to break
/// over-long sentences at natural pause points before resorting to raw
/// word-count cuts.
fn split_clauses(sent: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in sent.chars() {
        cur.push(ch);
        if matches!(ch, ',' | ';' | ':' | '\u{060C}' | '\u{061B}') {
            let t = cur.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
            cur.clear();
        }
    }
    let t = cur.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
    out
}

/// Greedily pack sentences into chunks of at most `max_words` words. A
/// sentence longer than the cap is broken down first — at clause punctuation
/// where possible, then into balanced word groups — so no chunk ever exceeds
/// the cap. An over-cap chunk pushes the stop-step floor past the natural end
/// of the audio, and the AR fills the gap with babble (the >12 s degradation
/// on undelimited Hindi paragraphs). Word counting mirrors canon_tokens
/// (Unicode-aware), so Devanagari counts correctly.
fn chunk_text_for_synthesis(text: &str, max_words: usize) -> Vec<String> {
    let mut units: Vec<String> = Vec::new();
    for sent in split_sentences(text) {
        if canon_tokens(&sent).len() <= max_words {
            units.push(sent);
            continue;
        }
        for clause in split_clauses(&sent) {
            if canon_tokens(&clause).len() <= max_words {
                units.push(clause);
                continue;
            }
            // Balanced groups read better than a full chunk plus a stub.
            let words: Vec<&str> = clause.split_whitespace().collect();
            let groups = words.len().div_ceil(max_words);
            let per = words.len().div_ceil(groups.max(1)).max(1);
            for group in words.chunks(per) {
                units.push(group.join(" "));
            }
        }
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_words = 0usize;
    for sent in units {
        let w = canon_tokens(&sent).len();
        if cur_words > 0 && cur_words + w > max_words {
            chunks.push(cur.trim().to_string());
            cur = String::new();
            cur_words = 0;
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(&sent);
        cur_words += w;
    }
    if !cur.trim().is_empty() {
        chunks.push(cur.trim().to_string());
    }
    if chunks.is_empty() {
        chunks.push(text.trim().to_string());
    }
    chunks
}

fn synth_max_tokens(engine: TtsEngine, target_word_count: usize) -> usize {
    if engine == TtsEngine::Qwen3 {
        // Qwen3 frames are ~80 ms each. The generic cap lets short lines run
        // to 96 frames (~7.7 s of audio, ~12 s wall time) whenever EOS fails.
        // Keep enough headroom for slow speech, but prevent minute-long retry
        // ladders for one short utterance.
        (target_word_count.saturating_mul(4) + 20).clamp(40, 96)
    } else {
        (target_word_count.saturating_mul(12) + 40).clamp(60, 320)
    }
}

/// One synthesis pass (seed/cfg retry ladder + optional ASR grading) for a
/// single piece of text. Returns (audio_path, duration_sec) of the accepted
/// take. Extracted from synthesize_clip so long-form chunking can call it
/// once per sentence group.
#[allow(clippy::too_many_arguments)]
fn synth_one_line(
    manager: &SidecarManager,
    engine: TtsEngine,
    clip_id: &str,
    voice_id: &str,
    reference_audio_path: &str,
    reference_text: &str,
    text: &str,
    language: Option<&str>,
    invocation_salt: &str,
    part_idx: usize,
) -> Result<(String, f64), String> {
    // Token budget: ~12 steps/word + headroom (each step ≈ 50 ms of audio).
    let target_word_count = canon_tokens(&strip_style_markers_for_grading(text)).len();
    let max_tokens = synth_max_tokens(engine, target_word_count);
    // Floor under the model's stop signal: VoxCPM2 fires its stop token
    // prematurely on long non-Latin-script lines (a 19-word Hindi sentence
    // stops at ~40 steps ≈ 6 s, cutting the sentence). The model speaks
    // ~2-3 steps (×160 ms) per word, so ×3 ≈ a slow full read — forces past
    // the false stop without pinning renders to the floor (×8 produced a
    // 42 s render for a 33-word line: exactly the floor, babble tail).
    // ×2.5 steps/word: above the false-stop rate (~2.1/word measured on the
    // truncating 19-word Hindi line) but below a natural full read (~2.5-3),
    // so short chunks can still end naturally. A flat floor of 32 forced a
    // 6-word chunk (natural ≈ 15 steps) to ramble to 74 steps / 11.8 s.
    let min_stop_steps = (target_word_count.saturating_mul(5) / 2).clamp(8, max_tokens - 16);
    let sidecar_language = normalize_sidecar_language(engine, language);
    let model_id = engine.registry_entry().info.model_id.as_str();

    // Single-shot for every engine. The 16-bit (fp16/bf16) models produce
    // intelligible speech in one pass, so there is no seed/cfg retry ladder and
    // no ASR grading gate — only a non-empty/non-silent audio guard. The old
    // ladder graded takes with Parakeet on macOS, which cannot read non-Latin
    // scripts: it scored good Hindi/CJK audio near 0% and burned every seed for
    // nothing, and for Indic-Mio it re-ran the heavy WavLM speaker encoder on
    // each attempt. cfgValue and minStopSteps are read only by the engines that
    // use them (VoxCPM2, CosyVoice, …); the others ignore them.
    //
    // Seed varies per synthesis (derived from the per-call invocation_salt), so
    // every Regenerate rolls a fresh take. That is the manual escape hatch for
    // an unlucky single-shot render (e.g. a doubled onset word on one seed):
    // the user re-rolls instead of an ASR gate auto-retrying. Matches how
    // Voicebox handles it (regenerate → new random seed, no grading). A cached
    // take keeps its salt, so it stays put until explicitly regenerated.
    let seed = short_hash(invocation_salt) as u64;
    let payload = serde_json::json!({
        "id": format!("synth-{}-p{}-s{}-{}", clip_id, part_idx, seed, invocation_salt),
        "command": engine.sidecar_command(),
        "engine": engine,
        "modelId": model_id,
        "text": text,
        "voiceId": voice_id,
        "referenceAudioPath": reference_audio_path,
        "referenceText": reference_text,
        "language": sidecar_language.as_deref(),
        "seed": seed,
        "cfgValue": 2.0,
        "maxTokens": max_tokens,
        "minStopSteps": min_stop_steps,
    });
    let raw = manager.request(&payload)?;
    let env: SidecarResponse = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if !env.ok {
        return Err(humanize_sidecar_error(
            engine,
            env.error.unwrap_or_else(|| "sidecar error".into()),
        ));
    }
    let result = env.result.unwrap_or_default();
    let audio_path = result
        .get("audioPath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing audioPath in sidecar response".to_string())?
        .to_string();
    let duration = result
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    validate_synth_audio(&audio_path)?;
    eprintln!(
        "[synth] clip {} part {} synthesized via {} single-shot (seed={}, {:.2}s)",
        clip_id,
        part_idx,
        engine.sidecar_command(),
        seed,
        duration
    );
    Ok((audio_path, duration))
}

/// Words per synthesis chunk. Most AR engines stay clean around ~14 words
/// (≈4-7 s of speech). Indic-Mio's current LiteRT prefill graph has a
/// 64-token prompt bucket including the chat template, and dense Devanagari
/// can spend several BPE tokens per word, so use a smaller word cap until the
/// bundle moves to a wider prefill export.
const DEFAULT_MAX_CHUNK_WORDS: usize = 14;
const INDIC_MIO_MAX_CHUNK_WORDS: usize = 6;

fn max_chunk_words(engine: TtsEngine) -> usize {
    match engine {
        TtsEngine::IndicMio => INDIC_MIO_MAX_CHUNK_WORDS,
        _ => DEFAULT_MAX_CHUNK_WORDS,
    }
}

/// Silence inserted between concatenated chunks (sentence gap).
const CHUNK_GAP_SEC: f64 = 0.28;

fn trim_long_form_chunk_edges(engine: TtsEngine) -> bool {
    engine.registry_entry().info.needs_trim
}

/// Trim leading/trailing low-energy tails from a rendered chunk. The model
/// often pads renders with silence (and the forced stop floor can leave a
/// quiet tail); trimming keeps concatenated long-form output tight. Keeps a
/// short natural pad on both ends. Energy gate is RMS over 50 ms windows.
fn trim_silence_edges(samples: &[f32], rate: u32) -> &[f32] {
    let win = (rate as usize / 20).max(1); // 50 ms
    let pad = (rate as usize) * 15 / 100; // 150 ms
    let rms = |w: &[f32]| {
        (w.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / w.len() as f64).sqrt()
    };
    let gate = 0.004f64;
    // Segment-based edge trim. VoxCPM2 takes can end with seconds of dead
    // air containing a click and a short non-verbal burst (measured: speech
    // ends 10.2 s, click at 11.4 s, 0.25 s grunt at 12.1 s). ASR grading
    // can't catch those (non-verbal), and any loudness/run-length anchor is
    // defeated by the burst being genuinely loud — so the rule is structural:
    // an edge segment that is short AND far from the speech body is junk.
    let voiced: Vec<bool> = samples
        .chunks(win)
        .map(|w| w.len() == win && rms(w) >= gate)
        .collect();
    // Voiced runs → segments [start, end) in window units.
    let mut segs: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<usize> = None;
    for (i, &v) in voiced.iter().enumerate() {
        match (v, open) {
            (true, None) => open = Some(i),
            (false, Some(s)) => {
                segs.push((s, i));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(s) = open {
        segs.push((s, voiced.len()));
    }
    // Bridge intra-phrase pauses (≤ 200 ms) so words merge into one segment.
    const BRIDGE: usize = 4;
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for seg in segs {
        if let Some(prev) = merged.last_mut() {
            if seg.0 - prev.1 <= BRIDGE {
                prev.1 = seg.1;
                continue;
            }
        }
        merged.push(seg);
    }
    // Shed edge junk: < 0.5 s of audio sitting > 0.6 s away from the rest.
    const MIN_DUR: usize = 10; // 0.5 s
    const FAR: usize = 12; // 0.6 s
    while merged.len() > 1 {
        let last = merged[merged.len() - 1];
        let gap = last.0 - merged[merged.len() - 2].1;
        if last.1 - last.0 < MIN_DUR && gap > FAR {
            merged.pop();
        } else {
            break;
        }
    }
    while merged.len() > 1 {
        let first = merged[0];
        let gap = merged[1].0 - first.1;
        if first.1 - first.0 < MIN_DUR && gap > FAR {
            merged.remove(0);
        } else {
            break;
        }
    }
    let Some(&(f, _)) = merged.first() else {
        return samples; // all-quiet chunk: leave untouched
    };
    let l = merged.last().unwrap().1;
    let s0 = (f * win).saturating_sub(pad);
    let e0 = (l * win + pad).min(samples.len());
    &samples[s0..e0]
}

/// RMS over only the voiced part of a chunk (50 ms windows above the same
/// energy gate as trim_silence_edges), so inter-word silence doesn't skew
/// the loudness estimate.
fn voiced_rms(samples: &[f32], rate: u32) -> f64 {
    let win = (rate as usize / 20).max(1);
    let gate = 0.004f64;
    let mut acc = 0f64;
    let mut n = 0usize;
    for w in samples.chunks(win) {
        let e = w.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / w.len() as f64;
        if e.sqrt() >= gate {
            acc += e * w.len() as f64;
            n += w.len();
        }
    }
    if n == 0 {
        return 0.0;
    }
    (acc / n as f64).sqrt()
}

fn audio_rms_peak(samples: &[f32]) -> (f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut energy = 0.0f64;
    let mut peak = 0.0f64;
    for sample in samples {
        let s = *sample as f64;
        energy += s * s;
        peak = peak.max(s.abs());
    }
    ((energy / samples.len() as f64).sqrt(), peak)
}

fn validate_synth_audio(path: &str) -> Result<(), String> {
    let (_rate, _channels, samples) = read_wav_pcm_mono(std::path::Path::new(path))?;
    let (rms, peak) = audio_rms_peak(&samples);
    if samples.is_empty() || rms < 0.0005 || peak < 0.006 {
        return Err(format!(
            "rendered audio is effectively silent (rms={:.6}, peak={:.6})",
            rms, peak
        ));
    }
    Ok(())
}

/// Scale each rendered chunk to the median voiced RMS of the set. VoxCPM2's
/// output level wanders between independent AR runs — measured ~8 dB sag from
/// the first to the last chunk of a 3-chunk Hindi render, heard as "quality
/// degrading toward the end". Gain is clamped (0.5×–2.5×) and peak-capped at
/// 0.95 so a quiet noisy chunk can't be blown up into audible hiss.
fn equalize_chunk_loudness(rendered: &mut [Vec<f32>], rate: u32) {
    if rendered.len() < 2 {
        return;
    }
    let rms_vals: Vec<f64> = rendered.iter().map(|c| voiced_rms(c, rate)).collect();
    let mut sorted: Vec<f64> = rms_vals.iter().copied().filter(|r| *r > 1e-5).collect();
    if sorted.is_empty() {
        return;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let target = sorted[sorted.len() / 2];
    for (chunk, rms) in rendered.iter_mut().zip(rms_vals) {
        if rms <= 1e-5 {
            continue;
        }
        let mut gain = (target / rms).clamp(0.5, 2.5);
        let peak = chunk.iter().fold(0f32, |m, s| m.max(s.abs())) as f64;
        if peak * gain > 0.95 {
            gain = 0.95 / peak;
        }
        if (gain - 1.0).abs() < 0.05 {
            continue;
        }
        for s in chunk.iter_mut() {
            *s = (*s as f64 * gain) as f32;
        }
    }
}

#[tauri::command]
async fn synthesize_clip(
    manager: State<'_, SidecarManager>,
    args: SynthesizeArgs,
) -> Result<SynthesizeResult, String> {
    let synth_started = std::time::Instant::now();
    ensure_engine_supported(args.engine)?;
    if args.text.trim().is_empty() {
        return Err("clip text is empty".into());
    }
    if args.reference_audio_path.trim().is_empty() {
        return Err("reference audio path is required".into());
    }
    if args.engine.requires_reference_transcript() && args.reference_text.trim().is_empty() {
        return Err(format!(
            "{} needs an accurate transcript for the reference audio",
            args.engine.display_name()
        ));
    }
    let reference_audio_path = import_reference_audio_path(&args.reference_audio_path)?
        .to_string_lossy()
        .into_owned();

    // Period→comma preprocessing was a CosyVoice-specific workaround for its
    // EOS attractor on inline periods. VoxCPM2 doesn't share that quirk, but
    // keeping the preprocess is harmless and stays useful if we fall back.
    let processed_text = preprocess_target(&args.text);
    if processed_text != args.text {
        eprintln!(
            "[synth] clip {} preprocessed text: {:?} -> {:?}",
            args.clip_id, args.text, processed_text
        );
    }

    // Per-invocation salt so each regenerate writes to a fresh audio file —
    // the frontend's `<audio key={path}>` doesn't remount on an identical
    // path string (the WebView serves the cached response).
    let invocation_salt = uuid::Uuid::new_v4().simple().to_string();

    // Long form: split into sentence groups and synthesize each with fresh
    // AR state, concatenating with a natural gap. A single short text takes
    // the direct path (identical to the previous behavior).
    let (chunk_source, suffix_marker) = normalize_synthesis_text(args.engine, &processed_text);
    let chunk_word_limit = max_chunk_words(args.engine);
    let mut chunks = chunk_text_for_synthesis(&chunk_source, chunk_word_limit);
    if let Some(marker) = suffix_marker.as_deref() {
        for chunk in &mut chunks {
            if args.engine == TtsEngine::FishAudio {
                *chunk = format!("{} {}", marker, chunk.trim_start());
            } else {
                *chunk = format!("{} {}", chunk.trim_end(), marker);
            }
        }
    }
    if chunks.len() <= 1 {
        let single_text = chunks
            .first()
            .map(String::as_str)
            .unwrap_or(processed_text.as_str());
        let (audio_path, duration_sec) = synth_one_line(
            &manager,
            args.engine,
            &args.clip_id,
            &args.voice_id,
            &reference_audio_path,
            &args.reference_text,
            single_text,
            args.language.as_deref(),
            &invocation_salt,
            0,
        )?;
        return Ok(SynthesizeResult {
            audio_path,
            duration_sec,
            elapsed_sec: synth_started.elapsed().as_secs_f64(),
        });
    }

    eprintln!(
        "[synth] clip {} long-form: {} chunks (≤{} words each)",
        args.clip_id,
        chunks.len(),
        chunk_word_limit
    );
    let mut rendered: Vec<Vec<f32>> = Vec::new();
    let mut rate: u32 = 0;
    let mut first_path: Option<std::path::PathBuf> = None;
    for (i, chunk) in chunks.iter().enumerate() {
        let (path, _dur) = synth_one_line(
            &manager,
            args.engine,
            &args.clip_id,
            &args.voice_id,
            &reference_audio_path,
            &args.reference_text,
            chunk,
            args.language.as_deref(),
            &invocation_salt,
            i,
        )?;
        let pb = std::path::PathBuf::from(&path);
        let (r, ch, samples) = read_wav_pcm_mono(&pb)?;
        if ch != 1 {
            return Err(format!("chunk {} WAV is not mono", i));
        }
        if rate == 0 {
            rate = r;
        } else if r != rate {
            return Err(format!("chunk {} sample rate {} != {}", i, r, rate));
        }
        let chunk_samples = if trim_long_form_chunk_edges(args.engine) {
            trim_silence_edges(&samples, rate).to_vec()
        } else {
            samples
        };
        rendered.push(chunk_samples);
        if first_path.is_none() {
            first_path = Some(pb);
        }
    }
    equalize_chunk_loudness(&mut rendered, rate);
    let mut combined: Vec<f32> = Vec::new();
    for (i, chunk) in rendered.iter().enumerate() {
        if i > 0 {
            let gap = (rate as f64 * CHUNK_GAP_SEC) as usize;
            combined.extend(std::iter::repeat(0.0f32).take(gap));
        }
        combined.extend_from_slice(chunk);
    }
    let dir = first_path
        .as_ref()
        .and_then(|p| p.parent())
        .ok_or("no chunk output dir")?
        .to_path_buf();
    let out_path = dir.join(format!(
        "synth-{}-full-{}.wav",
        args.clip_id, invocation_salt
    ));
    write_wav_pcm16_mono(&out_path, rate, &combined)?;
    let duration_sec = combined.len() as f64 / rate as f64;
    eprintln!(
        "[synth] clip {} long-form done: {:.2}s audio across {} chunks in {:.2}s wall",
        args.clip_id,
        duration_sec,
        chunks.len(),
        synth_started.elapsed().as_secs_f64()
    );
    Ok(SynthesizeResult {
        audio_path: out_path.to_string_lossy().into_owned(),
        duration_sec,
        elapsed_sec: synth_started.elapsed().as_secs_f64(),
    })
}

/// Replace inline periods ('. ' inside the body) with ', '. CosyVoice3's LLM
/// treats the period-followed-by-space pattern as a sentence boundary and
/// emits EOS too early on the second sentence — empirically observed at 7/12
/// seeds for "Then we end this together. Tonight." A comma keeps the prosody
/// pause but doesn't trip the EOS attractor. The final period (if any) is
/// preserved so the model still gets a clean stop cue at the natural end.
fn preprocess_target(text: &str) -> String {
    // Operate on bytes — '.' and ' ' are both ASCII so byte-level is safe.
    let trimmed_end = text.trim_end();
    if trimmed_end.is_empty() {
        return text.to_string();
    }
    let (body, suffix) = match trimmed_end.chars().last() {
        Some(c) if matches!(c, '.' | '?' | '!') => {
            let last_idx = trimmed_end
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
            (&trimmed_end[..last_idx], &trimmed_end[last_idx..])
        }
        _ => (trimmed_end, ""),
    };
    let processed = body.replace(". ", ", ");
    let mut out = String::with_capacity(processed.len() + suffix.len() + 1);
    out.push_str(&processed);
    out.push_str(suffix);
    // Preserve any whitespace the caller had at the very end.
    let original_trailing = &text[trimmed_end.len()..];
    out.push_str(original_trailing);
    out
}

fn is_style_tag_name(tag: &str) -> bool {
    let mut chars = tag.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn split_suffix_style_tag(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_end();
    let trailing = &text[trimmed.len()..];
    if !trimmed.ends_with('>') {
        return (text.to_string(), None);
    }
    let Some(start) = trimmed.rfind('<') else {
        return (text.to_string(), None);
    };
    let tag = trimmed[start + 1..trimmed.len() - 1].trim();
    if tag.starts_with('/') || !is_style_tag_name(tag) {
        return (text.to_string(), None);
    }
    let body = trimmed[..start].trim_end();
    (format!("{body}{trailing}"), Some(tag.to_ascii_lowercase()))
}

fn split_suffix_bracket_tag(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_end();
    let trailing = &text[trimmed.len()..];
    if !trimmed.ends_with(']') {
        return (text.to_string(), None);
    }
    let Some(start) = trimmed.rfind('[') else {
        return (text.to_string(), None);
    };
    let tag = trimmed[start + 1..trimmed.len() - 1].trim();
    if !is_style_tag_name(tag) {
        return (text.to_string(), None);
    }
    let body = trimmed[..start].trim_end();
    (format!("{body}{trailing}"), Some(tag.to_ascii_lowercase()))
}

fn split_leading_bracket_tag(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('[') {
        return (text.to_string(), None);
    }
    let Some(end) = trimmed.find(']') else {
        return (text.to_string(), None);
    };
    let tag = trimmed[1..end].trim();
    if !is_style_tag_name(tag) {
        return (text.to_string(), None);
    }
    (
        trimmed[end + 1..].trim_start().to_string(),
        Some(tag.to_ascii_lowercase()),
    )
}

fn split_wrapped_angle_tag(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim();
    if !trimmed.starts_with('<') {
        return (text.to_string(), None);
    }
    let Some(open_end) = trimmed.find('>') else {
        return (text.to_string(), None);
    };
    let tag = trimmed[1..open_end].trim();
    if tag.starts_with('/') || !is_style_tag_name(tag) {
        return (text.to_string(), None);
    }
    let close = format!("</{tag}>");
    if !trimmed.ends_with(&close) {
        return (text.to_string(), None);
    }
    let body = &trimmed[open_end + 1..trimmed.len() - close.len()];
    (body.trim().to_string(), Some(tag.to_ascii_lowercase()))
}

fn split_leading_parenthetical_marker(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('(') {
        return (text.to_string(), None);
    }
    let Some(end) = trimmed.find(')') else {
        return (text.to_string(), None);
    };
    let tag = trimmed[1..end].trim();
    if tag.len() > 40
        || tag.is_empty()
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '-' || c == '/')
    {
        return (text.to_string(), None);
    }
    (
        trimmed[end + 1..].trim_start().to_string(),
        Some(tag.to_ascii_lowercase()),
    )
}

fn split_first_style_marker(text: &str) -> (String, Option<String>) {
    for splitter in [
        split_suffix_style_tag as fn(&str) -> (String, Option<String>),
        split_leading_bracket_tag,
        split_suffix_bracket_tag,
        split_wrapped_angle_tag,
        split_leading_parenthetical_marker,
    ] {
        let (body, tag) = splitter(text);
        if tag.is_some() {
            return (body, tag);
        }
    }
    (text.to_string(), None)
}

fn map_indic_mio_marker(tag: &str) -> Option<&'static str> {
    let normalized = tag.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "happy" | "excited" | "warm" | "soft" | "calm" | "laughs" | "laughing" => Some("happy"),
        "sad" => Some("sad"),
        "angry" | "intense" | "dramatic" => Some("angry"),
        "disgust" | "disgusted" => Some("disgust"),
        "fear" | "fearful" => Some("fear"),
        "surprise" | "surprised" => Some("surprise"),
        _ => None,
    }
}

fn map_fish_audio_marker(tag: &str) -> Option<&'static str> {
    let normalized = tag.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "pause" => Some("pause"),
        "emphasis" => Some("emphasis"),
        "laughs" | "laughing" => Some("laughing"),
        "excited" | "happy" | "warm" => Some("excited"),
        "angry" | "intense" => Some("angry"),
        "whisper" | "whispering" | "soft" => Some("whisper"),
        "screaming" => Some("screaming"),
        "shouting" | "dramatic" => Some("shouting"),
        "surprise" | "surprised" => Some("surprised"),
        "sad" => Some("sad"),
        _ => None,
    }
}

fn normalize_synthesis_text(engine: TtsEngine, text: &str) -> (String, Option<String>) {
    match engine {
        TtsEngine::IndicMio => {
            let (body, marker) = split_first_style_marker(text);
            let clean = strip_style_markers_for_grading(&body);
            let suffix = marker
                .as_deref()
                .and_then(map_indic_mio_marker)
                .map(|tag| format!("<{tag}>"));
            (clean, suffix)
        }
        TtsEngine::FishAudio => {
            let (body, marker) = split_first_style_marker(text);
            let clean = strip_style_markers_for_grading(&body);
            let suffix = marker
                .as_deref()
                .and_then(map_fish_audio_marker)
                .map(|tag| format!("[{tag}]"));
            (clean, suffix)
        }
        // Qwen3 ignores style entirely. Strip stale Studio markers so they are
        // not rendered literally after switching from a style-aware engine.
        TtsEngine::Qwen3 => (strip_style_markers_for_grading(text), None),
        _ => (text.to_string(), None),
    }
}

fn strip_angle_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for ch in text.chars() {
        match ch {
            '<' => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    out
}

fn strip_bracket_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    let mut tag = String::new();
    for ch in text.chars() {
        match ch {
            '[' if !inside => {
                inside = true;
                tag.clear();
            }
            ']' if inside => {
                if !is_style_tag_name(tag.trim()) {
                    out.push('[');
                    out.push_str(&tag);
                    out.push(']');
                }
                inside = false;
                tag.clear();
            }
            _ if inside => tag.push(ch),
            _ => out.push(ch),
        }
    }
    if inside {
        out.push('[');
        out.push_str(&tag);
    }
    out
}

fn strip_leading_parenthetical_marker(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('(') {
        return text;
    }
    let Some(end) = trimmed.find(')') else {
        return text;
    };
    let tag = trimmed[1..end].trim();
    if tag.len() > 40
        || tag.is_empty()
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '-' || c == '/')
    {
        return text;
    }
    trimmed[end + 1..].trim_start()
}

fn strip_style_markers_for_grading(text: &str) -> String {
    let without_angle = strip_angle_tags(text);
    let without_brackets = strip_bracket_tags(&without_angle);
    strip_leading_parenthetical_marker(&without_brackets)
        .trim()
        .to_string()
}

fn canon_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| {
            // Combining marks aren't is_alphanumeric() but are word-internal
            // in Indic/Arabic scripts (matras, nukta, anusvara, tashkeel) —
            // splitting on them shreds every Devanagari word into fragments
            // and inflates word counts. Danda (U+0964/65) stays a separator.
            let word_mark = ('\u{0900}'..='\u{0963}').contains(&c)
                || ('\u{0610}'..='\u{061A}').contains(&c)
                || ('\u{064B}'..='\u{065F}').contains(&c)
                || c == '\u{0670}'
                || ('\u{06D6}'..='\u{06ED}').contains(&c);
            if c.is_alphanumeric() || c == '\'' || word_mark {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

// ---------- demo seed ----------
//
// The demo embeds human reference WAVs. Engines such as Qwen3-TTS and Fish
// Audio need the reference transcript to match that WAV closely, otherwise
// prompt words can leak into the synthesized take.
//
// First-ever invocation: downloads ~300MB of model weights from HuggingFace,
// then ~2-5s per line. Subsequent invocations reuse the warm model.

#[derive(Serialize)]
struct DemoVoiceSeed {
    #[serde(rename = "referenceAudioPath")]
    reference_audio_path: String,
    #[serde(rename = "referenceText")]
    reference_text: String,
}

#[derive(Serialize)]
struct DemoClipSeed {
    #[serde(rename = "speakerIndex")]
    speaker_index: usize,
    // Pre-rendered audio if it's cached on disk; null when not synthesized
    // yet (frontend renders the clip with no audio — user runs Regenerate
    // to synthesize on demand).
    #[serde(rename = "audioPath", skip_serializing_if = "Option::is_none")]
    audio_path: Option<String>,
    #[serde(rename = "durationSec", skip_serializing_if = "Option::is_none")]
    duration_sec: Option<f64>,
    text: String,
}

#[derive(Serialize)]
struct DemoSeed {
    voices: Vec<DemoVoiceSeed>,
    clips: Vec<DemoClipSeed>,
}

const DEMO_ANNA_REFERENCE_TEXT: &str = "The Hispaniola was rolling scuppers under in the ocean swell. The booms were tearing at the blocks. The rudder was banging.";
const DEMO_MAREK_REFERENCE_TEXT: &str = "It is a pretty little spot there, a green grass plateau running along by the water's edge and overhung by willows.";

fn short_hash(s: &str) -> u32 {
    // FNV-1a 32-bit. Stable across runs without pulling another crate.
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

// Per-clip audio cache. Must stay in sync with the sidecar's own cache dir
// (see clips_cache_dir() in core-sidecar/src/main.cpp and clipsCacheDir() in
// the Swift sidecar). `dirs::cache_dir()` resolves to the platform-native
// location: ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows, and
// $XDG_CACHE_HOME (or ~/.cache) on Linux.
fn clip_cache_dir() -> std::path::PathBuf {
    let dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("audio.soniqo.studio")
        .join("clips");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn dictation_cache_dir() -> std::path::PathBuf {
    let dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("audio.soniqo.studio")
        .join("dictation");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn wav_duration_sec(path: &std::path::Path) -> Result<f64, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header).map_err(|e| e.to_string())?;
    let channels = u16::from_le_bytes([header[22], header[23]]) as u32;
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]) as u32;
    let byte_rate = sample_rate * channels * (bits_per_sample / 8);
    if byte_rate == 0 {
        return Err("invalid wav header".into());
    }
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let audio_bytes = metadata.len().saturating_sub(44);
    Ok(audio_bytes as f64 / byte_rate as f64)
}

#[derive(Deserialize)]
struct SaveDictationAudioArgs {
    #[serde(rename = "wavBase64")]
    wav_base64: String,
}

#[derive(Serialize)]
struct SaveDictationAudioResult {
    #[serde(rename = "audioPath")]
    audio_path: String,
    #[serde(rename = "durationSec")]
    duration_sec: f64,
}

#[tauri::command]
async fn save_dictation_audio(
    args: SaveDictationAudioArgs,
) -> Result<SaveDictationAudioResult, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args.wav_base64.trim())
        .map_err(|e| format!("invalid dictation audio payload: {e}"))?;
    const MAX_DICTATION_WAV_BYTES: usize = 100 * 1024 * 1024;
    if bytes.len() > MAX_DICTATION_WAV_BYTES {
        return Err("dictation recording is too large".into());
    }
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("dictation audio must be a WAV file".into());
    }

    let path =
        dictation_cache_dir().join(format!("dictation-{}.wav", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write dictation audio: {e}"))?;
    let duration_sec = wav_duration_sec(&path).unwrap_or(0.0);
    Ok(SaveDictationAudioResult {
        audio_path: path.to_string_lossy().to_string(),
        duration_sec,
    })
}

#[derive(Deserialize)]
struct TranscribeAudioArgs {
    #[serde(rename = "audioPath")]
    audio_path: String,
    model: Option<AsrModel>,
    language: Option<String>,
}

#[derive(Serialize)]
struct TranscribeAudioResult {
    text: String,
    #[serde(rename = "modelName")]
    model_name: String,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "durationSec")]
    duration_sec: f64,
    #[serde(rename = "elapsedSec")]
    elapsed_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

#[tauri::command]
async fn transcribe_audio(
    manager: State<'_, SidecarManager>,
    args: TranscribeAudioArgs,
) -> Result<TranscribeAudioResult, String> {
    let model = args.model.unwrap_or(AsrModel::ParakeetTdtV3);
    let info = asr_model_info(model);
    let audio_path = PathBuf::from(&args.audio_path);
    let metadata = std::fs::metadata(&audio_path)
        .map_err(|e| format!("cannot read dictation audio {}: {e}", audio_path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "dictation audio path is not a file: {}",
            audio_path.display()
        ));
    }

    let started = Instant::now();
    let payload = serde_json::json!({
        "id": format!("asr-{}", uuid::Uuid::new_v4().simple()),
        "command": model.sidecar_command(),
        "audioPath": audio_path.to_string_lossy(),
        "language": args.language,
    });
    let raw = manager.request(&payload)?;
    let env: SidecarResponse = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if !env.ok {
        return Err(env
            .error
            .unwrap_or_else(|| format!("{} transcription failed", info.display_name)));
    }

    let result = env.result.unwrap_or_default();
    let text = result
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let language = result
        .get("language")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let duration_sec = result
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .or_else(|| wav_duration_sec(&audio_path).ok())
        .unwrap_or(0.0);
    let elapsed_sec = result
        .get("elapsedSec")
        .and_then(|v| v.as_f64())
        .unwrap_or_else(|| started.elapsed().as_secs_f64());

    Ok(TranscribeAudioResult {
        text,
        model_name: info.model_name,
        model_id: info.model_id,
        duration_sec,
        elapsed_sec,
        language,
    })
}

#[derive(Serialize, Clone)]
struct DemoProgress {
    phase: &'static str,
    current: usize,
    total: usize,
    message: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    phase: &'static str,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "demo_progress",
        DemoProgress {
            phase,
            current,
            total,
            message: message.into(),
        },
    );
}

fn demo_clip_seeds(cache_prefix: &str, lines: &[(usize, &str)]) -> Vec<DemoClipSeed> {
    let cache_dir = clip_cache_dir();
    let mut clips = Vec::with_capacity(lines.len());
    for (idx, (speaker_idx, text)) in lines.iter().enumerate() {
        let stable_id = format!(
            "{}-s{}-l{}-{:x}",
            cache_prefix,
            speaker_idx,
            idx,
            short_hash(text)
        );
        let cached_path = cache_dir.join(format!("{}.wav", stable_id));
        let (audio_path, duration_sec) = if cached_path.exists() {
            let dur = wav_duration_sec(&cached_path).ok();
            (Some(cached_path.to_string_lossy().to_string()), dur)
        } else {
            (None, None)
        };

        clips.push(DemoClipSeed {
            speaker_index: *speaker_idx,
            audio_path,
            duration_sec,
            text: (*text).to_string(),
        });
    }
    clips
}

#[tauri::command]
async fn seed_demo(app: tauri::AppHandle) -> Result<DemoSeed, String> {
    eprintln!("[seed_demo] start (lazy mode: bundled references only)");
    emit_progress(&app, "references", 0, 1, "Preparing reference voices…");
    let dir = std::env::temp_dir().join("soniqo-demo");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    eprintln!("[seed_demo] dir = {}", dir.display());

    // Step 1 — bundle real human-voice reference clips into the binary so the
    // demo uses distinct natural voices instead of `say`'s synthetic output.
    // Sources (downloaded from HuggingFace; permissively licensed Coqui demo
    // clips, ~450 KB each, embedded via include_bytes!):
    //   Anna  → female reader, ~10s, literary narration.
    //   Marek → male reader, ~9s, calm narration.
    // Reference text must be exact for Qwen3-TTS ICL. A stale Anna transcript
    // leaked prompt words into the synthesized take, while Marek stayed clean.
    let ref_specs: [(&[u8], &str, &str); 2] = [
        (
            include_bytes!("../resources/voices/anna.wav"),
            DEMO_ANNA_REFERENCE_TEXT,
            "ref-anna.wav",
        ),
        (
            include_bytes!("../resources/voices/marek.wav"),
            DEMO_MAREK_REFERENCE_TEXT,
            "ref-marek.wav",
        ),
    ];

    let mut voices = Vec::with_capacity(ref_specs.len());
    for (bytes, ref_text, filename) in ref_specs.iter() {
        let path = dir.join(filename);
        // Always overwrite — bundled bytes are the source of truth and may have
        // changed across builds (e.g. when we swap the reference voice).
        std::fs::write(&path, bytes)
            .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
        eprintln!(
            "[seed_demo] wrote bundled reference {} ({} bytes)",
            path.display(),
            bytes.len()
        );
        voices.push(DemoVoiceSeed {
            reference_audio_path: path.to_string_lossy().to_string(),
            reference_text: (*ref_text).to_string(),
        });
    }
    eprintln!("[seed_demo] references ready; synthesis is on demand");

    // Step 2 — demo lines, each wrapped in a VoxCPM2 style marker. The
    // sidecar's extractFirstEmotionTag pulls the tag name out and passes it
    // as `instruct` to the model; the body inside the tags is what gets
    // synthesised. Emotion choices map to the scene beats:
    //   Anna   — soft relief opening the scene
    //   Marek  — warm reassurance
    //   Anna   — urgent whisper
    //   Marek  — intense, decisive close
    let lines: [(usize, &str); 4] = [
        (0, "(dramatic) I never thought we'd make it this far."),
        (1, "(warm) I knew you would make it, no matter what."),
        (0, "(whispering) Just stay quiet for a moment, please."),
        (1, "(intense) Then we end this together. Tonight."),
    ];

    // Build clip metadata. If a cached WAV already exists for this exact line,
    // attach its path so the user can immediately play it; otherwise leave
    // audio_path = None and let the user trigger synthesis explicitly via
    // Regenerate. No Qwen3 calls happen here — Load demo is ~instant.
    let clips = demo_clip_seeds("demo", &lines);

    Ok(DemoSeed { voices, clips })
}

#[tauri::command]
async fn seed_hindi_demo(app: tauri::AppHandle) -> Result<DemoSeed, String> {
    eprintln!("[seed_hindi_demo] start");
    emit_progress(&app, "references", 0, 1, "Preparing Hindi reference voice…");
    let dir = std::env::temp_dir().join("soniqo-demo");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;

    // Two FLEURS hi_in test-split speakers (CC-BY, PCM16 mono 16 kHz), one per
    // gender. Reference text must be exact for voice-clone ICL — both
    // transcripts are the raw FLEURS transcriptions, ASR-verified against the
    // audio (a mismatched transcript leaks prompt words into the takes).
    let ref_specs: [(&[u8], &str, &str); 2] = [
        (
            include_bytes!("../resources/voices/hindi_fleurs.wav"),
            "लूना को साथी पहलवानों ने भी श्रद्धांजलि दी.",
            "ref-hindi-fleurs.wav",
        ),
        (
            include_bytes!("../resources/voices/hindi_fleurs_female.wav"),
            "यह शहर देश के बाकी शहरों से अलग है क्योंकि यह किसी अफ्रीकी शहर की बजाय अरब शहर लगता है.",
            "ref-hindi-fleurs-female.wav",
        ),
    ];

    let mut voices = Vec::with_capacity(ref_specs.len());
    for (bytes, ref_text, filename) in ref_specs.iter() {
        let path = dir.join(filename);
        std::fs::write(&path, bytes)
            .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
        voices.push(DemoVoiceSeed {
            reference_audio_path: path.to_string_lossy().to_string(),
            reference_text: (*ref_text).to_string(),
        });
    }

    // Male (0) and female (1) speakers alternate, like the English demo.
    let lines: [(usize, &str); 4] = [
        (0, "(happy) नमस्ते, आज हम हिंदी आवाज़ का परीक्षण कर रहे हैं।"),
        (1, "(sad) यह पंक्ति शांत और भावुक सुनाई देनी चाहिए।"),
        (0, "(angry) अब आवाज़ में थोड़ी तीव्रता और ज़ोर चाहिए।"),
        (1, "(surprised) अंत में यह वाक्य साफ़ और उत्साहित होना चाहिए।"),
    ];
    let clips = demo_clip_seeds("demo-hi", &lines);

    Ok(DemoSeed { voices, clips })
}

#[derive(Deserialize)]
struct ExportArgs {
    #[serde(rename = "outPath")]
    out_path: String,
    /// Project duration in seconds. Determines the length of the output mix
    /// buffer; clips past this point are truncated, gaps stay as silence.
    #[serde(rename = "durationSec")]
    duration_sec: f64,
    /// Flat list of clips to mix in. The Rust side doesn't need the full
    /// project tree — just the per-clip start time and audio path.
    clips: Vec<ExportClip>,
}

#[derive(Deserialize)]
struct ExportClip {
    #[serde(rename = "startSec")]
    start_sec: f64,
    #[serde(rename = "audioPath")]
    audio_path: String,
}

#[derive(Serialize)]
struct ExportResult {
    #[serde(rename = "outPath")]
    out_path: String,
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    #[serde(rename = "durationSec")]
    duration_sec: f64,
    #[serde(rename = "clipCount")]
    clip_count: usize,
}

// ---------------------------------------------------------------------------
// Project persistence — JSON files under <app_data_dir>/projects/.
//
// Format: one file per project, named <project-id>.json, wrapped in a
// versioned envelope so the schema can evolve:
//   { "formatVersion": 1, "savedAt": "<rfc3339>", "project": { ...Project } }
// The frontend owns (de)serialization of the Project shape; Rust treats it
// as opaque JSON and only reads id/name for the listing.
// ---------------------------------------------------------------------------

const PROJECT_FORMAT_VERSION: u64 = 1;

fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("projects");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[derive(Serialize)]
struct ProjectMeta {
    id: String,
    name: String,
    #[serde(rename = "savedAt")]
    saved_at: String,
}

#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_dir(&app)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let project = &v["project"];
        let (Some(id), Some(name)) = (project["id"].as_str(), project["name"].as_str()) else {
            continue; // unreadable/foreign file — skip, don't fail the listing
        };
        out.push(ProjectMeta {
            id: id.to_string(),
            name: name.to_string(),
            saved_at: v["savedAt"].as_str().unwrap_or_default().to_string(),
        });
    }
    // Most recently saved first.
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

#[derive(Deserialize)]
struct SaveProjectArgs {
    /// JSON serialization of the frontend Project object.
    #[serde(rename = "projectJson")]
    project_json: String,
}

#[tauri::command]
async fn save_project(app: tauri::AppHandle, args: SaveProjectArgs) -> Result<ProjectMeta, String> {
    let project: serde_json::Value =
        serde_json::from_str(&args.project_json).map_err(|e| format!("parse project: {e}"))?;
    let id = project["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .ok_or("project.id missing or not a plain uuid")?
        .to_string();
    let name = project["name"].as_str().unwrap_or("Untitled").to_string();
    let saved_at = chrono::Utc::now().to_rfc3339();

    let envelope = serde_json::json!({
        "formatVersion": PROJECT_FORMAT_VERSION,
        "savedAt": saved_at,
        "project": project,
    });
    let dir = projects_dir(&app)?;
    let path = dir.join(format!("{id}.json"));
    // Write-then-rename so a crash mid-write can't corrupt an existing save.
    let tmp = dir.join(format!("{id}.json.tmp"));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename to {}: {e}", path.display()))?;

    Ok(ProjectMeta { id, name, saved_at })
}

#[derive(Deserialize)]
struct LoadProjectArgs {
    id: String,
}

#[tauri::command]
async fn load_project(app: tauri::AppHandle, args: LoadProjectArgs) -> Result<String, String> {
    if !args
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid project id".into());
    }
    let path = projects_dir(&app)?.join(format!("{}.json", args.id));
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    let version = v["formatVersion"].as_u64().unwrap_or(0);
    if version > PROJECT_FORMAT_VERSION {
        return Err(format!(
            "project was saved by a newer Speech Studio (format v{version}); update the app"
        ));
    }
    serde_json::to_string(&v["project"]).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_project(app: tauri::AppHandle, args: LoadProjectArgs) -> Result<(), String> {
    if !args
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid project id".into());
    }
    let path = projects_dir(&app)?.join(format!("{}.json", args.id));
    std::fs::remove_file(&path).map_err(|e| format!("delete {}: {e}", path.display()))
}

#[tauri::command]
async fn export_project(args: ExportArgs) -> Result<ExportResult, String> {
    if args.clips.is_empty() {
        return Err("no clips with rendered audio to export".into());
    }
    if args.duration_sec <= 0.0 {
        return Err("project duration must be > 0".into());
    }

    // Probe the sample rate from the first clip. All synth output uses the
    // same engine, so every clip is at the same rate (24 kHz for CosyVoice,
    // 48 kHz for VoxCPM2); mixing different rates without resampling would
    // pitch-shift, so reject any mismatched clip explicitly.
    let first = &args.clips[0];
    let (first_rate, _, _) = read_wav_header(std::path::Path::new(&first.audio_path))?;
    let sample_rate = first_rate;
    let total_frames = (args.duration_sec * sample_rate as f64).ceil() as usize;
    let mut mix: Vec<f32> = vec![0.0; total_frames];

    for (idx, clip) in args.clips.iter().enumerate() {
        let path = std::path::Path::new(&clip.audio_path);
        let (rate, channels, samples) = read_wav_pcm_mono(path)?;
        if rate != sample_rate {
            return Err(format!(
                "clip {} sample rate {} Hz differs from project rate {} Hz; resampling not implemented",
                idx, rate, sample_rate
            ));
        }
        let _ = channels; // already collapsed to mono by read_wav_pcm_mono.
        let start_frame = (clip.start_sec * sample_rate as f64).round() as isize;
        // Drop frames that fall before t=0 or past the project end. We don't
        // expect either in practice (the UI clamps clip start to >= 0 and the
        // mix buffer is sized to project duration) but handle them safely.
        for (i, &s) in samples.iter().enumerate() {
            let frame = start_frame + i as isize;
            if frame < 0 {
                continue;
            }
            let frame = frame as usize;
            if frame >= mix.len() {
                break;
            }
            mix[frame] += s;
        }
    }

    // Soft clip in case overlapping clips on different speaker tracks summed
    // past ±1.0. A hard clamp keeps the WAV writable without distortion at
    // the obvious cost of squashing transients past the threshold.
    for s in mix.iter_mut() {
        if *s > 1.0 {
            *s = 1.0;
        } else if *s < -1.0 {
            *s = -1.0;
        }
    }

    write_wav_pcm16_mono(std::path::Path::new(&args.out_path), sample_rate, &mix)?;
    eprintln!(
        "[export] wrote {} ({} frames @ {} Hz from {} clips)",
        args.out_path,
        mix.len(),
        sample_rate,
        args.clips.len()
    );

    Ok(ExportResult {
        out_path: args.out_path,
        sample_rate,
        duration_sec: mix.len() as f64 / sample_rate as f64,
        clip_count: args.clips.len(),
    })
}

/// Read the basic WAV format chunk: returns (sample_rate, channels, bits).
/// Assumes the 44-byte canonical PCM header — same shape we write and the
/// same shape speech-swift's WAVWriter emits.
fn read_wav_header(path: &std::path::Path) -> Result<(u32, u16, u16), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header)
        .map_err(|e| format!("read header {}: {}", path.display(), e))?;
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits = u16::from_le_bytes([header[34], header[35]]);
    Ok((sample_rate, channels, bits))
}

/// Read all PCM samples from a WAV, normalising to mono f32 in [-1, 1].
/// Multi-channel sources are folded by averaging across channels.
fn read_wav_pcm_mono(path: &std::path::Path) -> Result<(u32, u16, Vec<f32>), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header)
        .map_err(|e| format!("read header {}: {}", path.display(), e))?;
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits = u16::from_le_bytes([header[34], header[35]]);
    if bits != 16 {
        return Err(format!(
            "{}: only 16-bit PCM supported (got {})",
            path.display(),
            bits
        ));
    }
    if channels == 0 {
        return Err(format!("{}: zero channels", path.display()));
    }
    let mut audio = Vec::new();
    f.read_to_end(&mut audio)
        .map_err(|e| format!("read pcm {}: {}", path.display(), e))?;
    // Interleaved 16-bit signed samples.
    let frame_size = channels as usize * 2;
    let frame_count = audio.len() / frame_size;
    let mut out = Vec::with_capacity(frame_count);
    let inv_max = 1.0_f32 / 32768.0;
    for f_idx in 0..frame_count {
        let mut acc: f32 = 0.0;
        for ch in 0..channels as usize {
            let off = f_idx * frame_size + ch * 2;
            let s = i16::from_le_bytes([audio[off], audio[off + 1]]) as f32 * inv_max;
            acc += s;
        }
        out.push(acc / channels as f32);
    }
    Ok((sample_rate, channels, out))
}

/// Write a mono f32-in-[-1,1] buffer as a 16-bit PCM WAV.
fn write_wav_pcm16_mono(
    path: &std::path::Path,
    sample_rate: u32,
    samples: &[f32],
) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
    }
    let mut f =
        std::fs::File::create(path).map_err(|e| format!("create {}: {}", path.display(), e))?;
    let bits_per_sample = 16u16;
    let channels = 1u16;
    let byte_rate = sample_rate * channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let data_bytes = samples.len() as u32 * (bits_per_sample as u32 / 8);
    let riff_size = 36 + data_bytes;

    // RIFF / fmt / data chunks. Standard canonical 44-byte PCM header.
    f.write_all(b"RIFF").map_err(|e| e.to_string())?;
    f.write_all(&riff_size.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(b"WAVE").map_err(|e| e.to_string())?;
    f.write_all(b"fmt ").map_err(|e| e.to_string())?;
    f.write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?; // fmt chunk size
    f.write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?; // PCM
    f.write_all(&channels.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&block_align.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&bits_per_sample.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(b"data").map_err(|e| e.to_string())?;
    f.write_all(&data_bytes.to_le_bytes())
        .map_err(|e| e.to_string())?;

    // Samples.
    let mut buf = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = if s > 1.0 {
            1.0
        } else if s < -1.0 {
            -1.0
        } else {
            s
        };
        let v = (clamped * 32767.0).round() as i16;
        buf.extend_from_slice(&v.to_le_bytes());
    }
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // resource_dir() is where Tauri stages bundled `resources` (incl.
            // libLiteRt on Windows/Linux). None in some dev layouts — that's
            // fine, the sidecar's own dir covers dev.
            let resource_dir = app.path().resource_dir().ok();
            app.manage(SidecarManager::new(resource_dir, app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping_sidecar,
            available_tts_engines,
            available_asr_models,
            init_model,
            interrupt_model_load,
            pick_video,
            pick_audio,
            import_reference_audio,
            probe_reference,
            clone_voice,
            save_dictation_audio,
            transcribe_audio,
            synthesize_clip,
            export_project,
            list_projects,
            save_project,
            load_project,
            delete_project,
            seed_demo,
            seed_hindi_demo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_engine_protocol_names_are_stable() {
        let cosy: TtsEngine = serde_json::from_str("\"cosyvoice\"").unwrap();
        assert_eq!(cosy, TtsEngine::CosyVoice);
        let parakeet: AsrModel = serde_json::from_str("\"parakeet-tdt-v3\"").unwrap();
        assert_eq!(parakeet, AsrModel::ParakeetTdtV3);
        assert_eq!(
            serde_json::to_string(&TtsEngine::VoxCPM2).unwrap(),
            "\"voxcpm2\""
        );
        assert_eq!(
            serde_json::to_string(&AsrModel::ParakeetTdtV3).unwrap(),
            "\"parakeet-tdt-v3\""
        );
        assert_eq!(
            serde_json::to_string(&TtsEngine::IndicMio).unwrap(),
            "\"indic-mio\""
        );
        assert_eq!(
            serde_json::to_string(&TtsEngine::FishAudio).unwrap(),
            "\"fish-audio\""
        );
        assert_eq!(cosy.sidecar_command(), "synthesize_cosyvoice");
        assert_eq!(
            TtsEngine::IndicMio.sidecar_command(),
            "synthesize_indic_mio"
        );
        assert_eq!(
            TtsEngine::FishAudio.sidecar_command(),
            "synthesize_fish_audio"
        );
        assert_eq!(parakeet.sidecar_command(), "transcribe_parakeet");
    }

    #[test]
    fn parses_sidecar_model_progress_lines() {
        let ev = parse_sidecar_progress("[sidecar] fish-audio  42% Downloading weights")
            .expect("progress event");
        assert_eq!(ev.percent, 42.0);
        assert!((ev.progress - 0.42).abs() < f64::EPSILON);
        assert_eq!(ev.message, "fish-audio: Downloading weights");

        let ev = parse_sidecar_progress(
            "[sidecar] fish-audio 0.7% Downloading Fish Audio S2 Pro 72 MB / 10225 MB",
        )
        .expect("decimal progress event");
        assert_eq!(ev.percent, 0.7);
        assert!((ev.progress - 0.007).abs() < f64::EPSILON);
        assert_eq!(
            ev.message,
            "fish-audio: Downloading Fish Audio S2 Pro 72 MB / 10225 MB"
        );
    }

    #[test]
    fn ignores_non_progress_sidecar_lines() {
        assert!(parse_sidecar_progress("[sidecar] loading Fish Audio model").is_none());
        assert!(parse_sidecar_progress("fish-audio 42% Downloading").is_none());
        assert!(parse_sidecar_progress("[sidecar] fish-audio 120% nope").is_none());
    }

    #[test]
    fn cosyvoice_requires_reference_transcript() {
        assert!(TtsEngine::CosyVoice.requires_reference_transcript());
        assert!(TtsEngine::FishAudio.requires_reference_transcript());
        assert!(!TtsEngine::VoxCPM2.requires_reference_transcript());
    }

    #[test]
    fn demo_anna_reference_transcript_matches_bundled_audio() {
        assert!(
            !DEMO_ANNA_REFERENCE_TEXT.contains("ruddering"),
            "stale Anna transcript leaks reference text into Qwen3-TTS ICL output"
        );
        assert!(DEMO_ANNA_REFERENCE_TEXT.ends_with("The rudder was banging."));
    }

    #[test]
    fn chatterbox_engine_wiring() {
        let c: TtsEngine = serde_json::from_str("\"chatterbox\"").unwrap();
        assert_eq!(c, TtsEngine::Chatterbox);
        assert_eq!(c.sidecar_command(), "synthesize_chatterbox");
        // Multilingual clone: needs a language, but no reference transcript.
        assert!(c.requires_language());
        assert!(!c.requires_reference_transcript());
        assert!(!TtsEngine::VoxCPM2.requires_language());
        // Style is intensity-only for Chatterbox; instruction for VoxCPM2/Cosy; none for Qwen3.
        assert_eq!(c.style_mode(), "intensity");
        assert_eq!(TtsEngine::VoxCPM2.style_mode(), "instruction");
        assert_eq!(TtsEngine::IndicMio.style_mode(), "suffix-tag");
        assert_eq!(TtsEngine::FishAudio.style_mode(), "bracket-tag");
        assert_eq!(TtsEngine::OmniVoice.style_mode(), "controlled-vocabulary");
        assert_eq!(TtsEngine::Qwen3.style_mode(), "none");
    }

    #[test]
    fn tts_engine_info_exposes_model_capabilities() {
        let vox = tts_engine_info(TtsEngine::VoxCPM2);
        assert_eq!(vox.languages.len(), 30);
        assert!(vox.languages.iter().any(|language| language == "hi"));
        assert!(vox.languages.iter().any(|language| language == "vi"));
        assert!(!vox.requires_language);
        assert_eq!(vox.model_name, "voxcpm2-mlx-bf16");
        assert_eq!(vox.model_id, "aufklarer/VoxCPM2-MLX-bf16");
        assert_eq!(vox.precision, "bf16");

        let cosy = tts_engine_info(TtsEngine::CosyVoice);
        assert!(cosy.requires_language);
        assert_eq!(
            cosy.languages,
            ["en", "zh", "ja", "ko", "de", "es", "fr", "it", "ru"]
        );
        assert!(cosy
            .supported_markers
            .iter()
            .any(|marker| marker == "excited"));

        let qwen = tts_engine_info(TtsEngine::Qwen3);
        assert_eq!(qwen.model_name, "qwen3-tts-1.7b-mlx-bf16");
        assert_eq!(qwen.model_id, "aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-bf16");
        assert_eq!(qwen.voice_profile_modes, ["reference-clone"]);
        assert!(qwen.requires_reference_audio);
        assert!(qwen.requires_reference_transcript);
        assert!(qwen.requires_language);
        assert!(!qwen.supports_instruct);
        assert_eq!(qwen.style_mode, "none");
        assert!(qwen.languages.iter().any(|language| language == "en"));
        assert!(qwen.languages.iter().any(|language| language == "ru"));
        assert!(qwen.supported_markers.is_empty());
        assert_eq!(qwen.precision, "bf16");

        let chatterbox = tts_engine_info(TtsEngine::Chatterbox);
        assert_eq!(chatterbox.languages.len(), 22);
        assert!(chatterbox.languages.iter().any(|language| language == "zh"));
        assert!(chatterbox.languages.iter().any(|language| language == "ja"));
        assert!(!chatterbox.languages.iter().any(|language| language == "he"));
        assert!(chatterbox.languages.iter().any(|language| language == "ko"));
        assert_eq!(chatterbox.precision, "fp16");

        let omni = tts_engine_info(TtsEngine::OmniVoice);
        assert_eq!(omni.model_name, "omnivoice-mlx-fp16");
        assert_eq!(omni.model_id, "aufklarer/OmniVoice-MLX-fp16");
        assert_eq!(omni.precision, "fp16");

        let indic = tts_engine_info(TtsEngine::IndicMio);
        assert_eq!(indic.style_mode, "suffix-tag");
        assert_eq!(indic.sample_rate, 24_000);
        assert!(!indic.requires_language);
        assert_eq!(
            indic.model_name,
            if cfg!(target_os = "macos") {
                "indic-mio-mlx-fp16"
            } else {
                "indic-mio-litert-fp16"
            }
        );
        assert_eq!(
            indic.model_id,
            if cfg!(target_os = "macos") {
                "aufklarer/Indic-Mio-MLX-fp16"
            } else {
                "soniqo/Indic-Mio-LiteRT"
            }
        );
        assert_eq!(
            indic.runtime,
            if cfg!(target_os = "macos") {
                "MLX"
            } else {
                "LiteRT"
            }
        );

        let fish = tts_engine_info(TtsEngine::FishAudio);
        assert_eq!(fish.style_mode, "bracket-tag");
        assert!(fish.languages.len() > 70);
        assert!(fish
            .benchmark_languages
            .iter()
            .any(|language| language == "hi"));
        assert!(fish
            .supported_markers
            .iter()
            .any(|marker| marker == "excited"));
        assert_eq!(fish.use_policy, "research-only");
        assert!(!fish.needs_trim);
    }

    #[test]
    fn hindi_demo_reference_is_bundled_pcm_wav() {
        let path = std::env::temp_dir().join(format!(
            "speech-studio-hindi-ref-{}.wav",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(
            &path,
            include_bytes!("../resources/voices/hindi_fleurs.wav"),
        )
        .unwrap();

        let (sample_rate, channels, bits) = read_wav_header(&path).unwrap();
        assert_eq!(sample_rate, 16_000);
        assert_eq!(channels, 1);
        assert_eq!(bits, 16);

        let duration = wav_duration_sec(&path).unwrap();
        assert!(
            (3.7..4.0).contains(&duration),
            "unexpected Hindi reference duration: {duration}"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tts_registry_defaults_keep_16bit_precision_floor() {
        for entry in MODEL_REGISTRY
            .tts_engines
            .iter()
            .filter(|entry| engine_is_supported(entry.info.id))
        {
            assert!(
                matches!(entry.info.precision.as_str(), "bf16" | "fp16"),
                "{} default precision should stay 16-bit, got {}",
                entry.info.model_name,
                entry.info.precision
            );
            assert!(
                !entry.info.model_id.contains("int8")
                    && !entry.info.model_id.contains("8bit")
                    && !entry.info.model_id.contains("4bit"),
                "{} default model id should not be quantized: {}",
                entry.info.model_name,
                entry.info.model_id
            );
        }
    }

    #[test]
    fn asr_registry_uses_parakeet_family_on_all_platforms() {
        let parakeet = asr_model_info(AsrModel::ParakeetTdtV3);
        assert_eq!(parakeet.model_name, "parakeet-tdt-v3-0.6b-int8");
        assert_eq!(parakeet.sample_rate, 16_000);
        assert_eq!(parakeet.max_segment_sec, 30);
        assert!(parakeet.streaming);
        assert_eq!(parakeet.readiness, "production");
        assert_eq!(parakeet.languages, ["en"]);
        assert_eq!(
            parakeet.runtime,
            if cfg!(target_os = "macos") {
                "coreml"
            } else {
                "litert"
            }
        );
        assert_eq!(
            parakeet.model_id,
            if cfg!(target_os = "macos") {
                "aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s"
            } else {
                "soniqo/Parakeet-TDT-0.6B-v3-LiteRT-INT8"
            }
        );
    }

    #[test]
    fn studio_registry_keeps_qwen_on_bf16() {
        let ids: Vec<TtsEngine> = MODEL_REGISTRY
            .tts_engines
            .iter()
            .map(|entry| entry.info.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                TtsEngine::VoxCPM2,
                TtsEngine::CosyVoice,
                TtsEngine::Qwen3,
                TtsEngine::Chatterbox,
                TtsEngine::OmniVoice,
                TtsEngine::IndicMio,
                TtsEngine::FishAudio,
            ]
        );

        let qwen = TtsEngine::Qwen3.registry_entry();
        assert_eq!(qwen.info.model_name, "qwen3-tts-1.7b-mlx-bf16");
        assert_eq!(
            qwen.info.model_id,
            "aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-bf16"
        );
        assert!(!qwen.info.model_name.contains("8bit"));
        assert!(!qwen.info.model_id.contains("8bit"));
        assert!(!qwen.info.model_name.contains("0.6b"));
        assert_eq!(qwen.info.precision, "bf16");
        assert_eq!(qwen.info.style_mode, "none");
    }

    #[test]
    fn qwen_synth_budget_is_bounded_for_short_lines() {
        assert_eq!(synth_max_tokens(TtsEngine::Qwen3, 2), 40);
        assert_eq!(synth_max_tokens(TtsEngine::Qwen3, 6), 44);
        assert_eq!(synth_max_tokens(TtsEngine::Qwen3, 20), 96);
        assert_eq!(synth_max_tokens(TtsEngine::CosyVoice, 6), 112);
    }

    #[test]
    fn indic_mio_uses_smaller_chunks_for_litert_prompt_bucket() {
        assert_eq!(max_chunk_words(TtsEngine::IndicMio), 6);
        assert_eq!(max_chunk_words(TtsEngine::VoxCPM2), 14);
    }

    #[test]
    fn sidecar_language_normalization_preserves_chatterbox_hi() {
        assert_eq!(
            normalize_sidecar_language(TtsEngine::CosyVoice, Some("ru")).as_deref(),
            Some("russian")
        );
        assert_eq!(
            normalize_sidecar_language(TtsEngine::CosyVoice, Some("ja")).as_deref(),
            Some("japanese")
        );
        assert_eq!(
            normalize_sidecar_language(TtsEngine::Chatterbox, Some("hi")).as_deref(),
            Some("hi")
        );
        assert_eq!(
            normalize_sidecar_language(TtsEngine::OmniVoice, Some("hi")).as_deref(),
            Some("hindi")
        );
        assert_eq!(
            normalize_sidecar_language(TtsEngine::IndicMio, Some("hin")).as_deref(),
            Some("hindi")
        );
    }

    #[test]
    fn audio_rms_peak_detects_silent_render() {
        let silent = vec![0.0001f32; 1000];
        let voiced = vec![0.02f32, -0.02, 0.01, -0.01];
        let (silent_rms, silent_peak) = audio_rms_peak(&silent);
        let (voiced_rms, voiced_peak) = audio_rms_peak(&voiced);
        assert!(silent_rms < 0.0005);
        assert!(silent_peak < 0.006);
        assert!(voiced_rms > 0.0005);
        assert!(voiced_peak > 0.006);
    }

    #[test]
    fn download_errors_include_model_access_hint() {
        let message = humanize_sidecar_error(
            TtsEngine::FishAudio,
            "failedToDownload(\"aufklarer/Fish-Audio-S2-Pro-MLX-fp16: File not found: main\")"
                .to_string(),
        );
        assert!(message.contains("Could not download Fish Audio S2 Pro model"));
        assert!(message.contains("private, gated, or unavailable"));
    }

    #[test]
    fn cosyvoice_availability_matches_platform() {
        assert_eq!(
            engine_is_supported(TtsEngine::CosyVoice),
            cfg!(target_os = "macos")
        );
        assert!(engine_is_supported(TtsEngine::IndicMio));
    }

    // The clip cache must live under the app namespace and end in `clips`, so
    // the Rust side and both sidecars (which compute it independently) agree.
    #[test]
    fn clip_cache_dir_under_app_namespace() {
        let dir = clip_cache_dir();
        assert!(
            dir.ends_with("clips"),
            "cache dir should end with clips: {:?}",
            dir
        );
        assert!(
            dir.to_string_lossy().contains("audio.soniqo.studio"),
            "cache dir should be under the app namespace: {:?}",
            dir
        );
    }

    #[test]
    fn dictation_cache_dir_under_app_namespace() {
        let dir = dictation_cache_dir();
        assert!(
            dir.ends_with("dictation"),
            "dictation dir should end with dictation: {:?}",
            dir
        );
        assert!(
            dir.to_string_lossy().contains("audio.soniqo.studio"),
            "dictation dir should be under the app namespace: {:?}",
            dir
        );
    }

    // Simulates the installed-bundle layout: the sidecar binary sits next to
    // the main app binary while libLiteRt is staged in a separate resource dir.
    // The search path must include both so the loader finds the runtime.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn sidecar_lib_dirs_includes_binary_and_resource_dirs() {
        let sidecar = std::path::Path::new("/app/bin/speech-core-tts-sidecar");
        let res = std::path::Path::new("/app/resources");
        let dirs = sidecar_lib_dirs(sidecar, Some(res));
        assert_eq!(
            dirs,
            vec![
                std::path::PathBuf::from("/app/bin"),
                std::path::PathBuf::from("/app/resources"),
            ]
        );

        // Dev layout (no resource dir resolved) still yields the sidecar's dir.
        let dirs = sidecar_lib_dirs(sidecar, None);
        assert_eq!(dirs, vec![std::path::PathBuf::from("/app/bin")]);
    }

    #[test]
    fn preprocess_target_strips_inline_period() {
        // Marek2 demo line: inline period triggers early-EOS short failures.
        // Final period preserved as natural EOS cue.
        assert_eq!(
            preprocess_target("Then we end this together. Tonight."),
            "Then we end this together, Tonight."
        );
    }

    #[test]
    fn preprocess_target_leaves_single_sentence_alone() {
        assert_eq!(
            preprocess_target("I never thought we'd make it this far."),
            "I never thought we'd make it this far."
        );
    }

    #[test]
    fn preprocess_target_handles_no_trailing_punctuation() {
        assert_eq!(preprocess_target("hello world"), "hello world");
    }

    #[test]
    fn strip_style_markers_for_grading_removes_prefix_and_suffix_markers() {
        assert_eq!(
            strip_style_markers_for_grading("(happy) नमस्ते आज मौसम अच्छा है।"),
            "नमस्ते आज मौसम अच्छा है।"
        );
        assert_eq!(
            strip_style_markers_for_grading("नमस्ते आज मौसम अच्छा है। <happy>"),
            "नमस्ते आज मौसम अच्छा है।"
        );
        assert_eq!(
            strip_style_markers_for_grading("नमस्ते आज मौसम अच्छा है। [excited]"),
            "नमस्ते आज मौसम अच्छा है।"
        );
        assert_eq!(
            strip_style_markers_for_grading("<sad>Hello there</sad>"),
            "Hello there"
        );
    }

    #[test]
    fn suffix_style_tag_can_be_reapplied_after_chunking() {
        let (body, tag) = split_suffix_style_tag("यह पहला वाक्य है। यह दूसरा वाक्य है। <angry>");
        assert_eq!(tag.as_deref(), Some("angry"));
        let mut chunks = chunk_text_for_synthesis(&body, 4);
        for chunk in &mut chunks {
            *chunk = format!("{} <{}>", chunk.trim_end(), tag.as_deref().unwrap());
        }
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.ends_with("<angry>")));
    }

    #[test]
    fn bracket_style_tag_can_be_reapplied_after_chunking() {
        let (body, tag) = split_first_style_marker("[excited] यह पहला वाक्य है। यह दूसरा वाक्य है।");
        assert_eq!(tag.as_deref(), Some("excited"));
        let mut chunks = chunk_text_for_synthesis(&body, 4);
        for chunk in &mut chunks {
            *chunk = format!("[{}] {}", tag.as_deref().unwrap(), chunk.trim_start());
        }
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.starts_with("[excited]")));
    }

    #[test]
    fn indic_mio_normalization_does_not_render_stale_markers() {
        let (body, marker) =
            normalize_synthesis_text(TtsEngine::IndicMio, "(warm) नमस्ते आज मौसम अच्छा है।");
        assert_eq!(body, "नमस्ते आज मौसम अच्छा है।");
        assert_eq!(marker.as_deref(), Some("<happy>"));

        let (body, marker) =
            normalize_synthesis_text(TtsEngine::IndicMio, "नमस्ते आज मौसम अच्छा है। <angry>");
        assert_eq!(body, "नमस्ते आज मौसम अच्छा है।");
        assert_eq!(marker.as_deref(), Some("<angry>"));

        let (body, marker) = normalize_synthesis_text(TtsEngine::IndicMio, "(whispering) नमस्ते");
        assert_eq!(body, "नमस्ते");
        assert_eq!(marker, None);
    }

    #[test]
    fn fish_audio_normalization_converts_stale_parenthetical_markers() {
        let (body, marker) = normalize_synthesis_text(TtsEngine::FishAudio, "(whispering) hello");
        assert_eq!(body, "hello");
        assert_eq!(marker.as_deref(), Some("[whisper]"));

        let (body, marker) = normalize_synthesis_text(TtsEngine::FishAudio, "[sad] hello");
        assert_eq!(body, "hello");
        assert_eq!(marker.as_deref(), Some("[sad]"));
    }

    #[test]
    fn trim_sheds_far_short_tail_bursts() {
        // Shape measured on a real take: 3 s speech, 1.1 s dead air, a 0.1 s
        // click, 0.65 s dead air, a 0.25 s non-verbal burst at the very end.
        // The click and burst must be shed; the speech body must survive.
        let rate = 48000u32;
        let mut s: Vec<f32> = Vec::new();
        let mut push = |secs: f64, amp: f32| {
            let n = (secs * rate as f64) as usize;
            for i in 0..n {
                s.push(if i % 2 == 0 { amp } else { -amp });
            }
        };
        push(3.0, 0.02);
        push(1.1, 0.0);
        push(0.10, 0.05);
        push(0.65, 0.0);
        push(0.25, 0.03);
        let dur = trim_silence_edges(&s, rate).len() as f64 / rate as f64;
        assert!(dur < 3.3, "tail junk not shed: {:.2}s", dur);
        assert!(dur > 2.9, "speech body cut: {:.2}s", dur);
    }

    #[test]
    fn fish_audio_long_form_preserves_chunk_edges() {
        assert!(!trim_long_form_chunk_edges(TtsEngine::FishAudio));
        assert!(trim_long_form_chunk_edges(TtsEngine::VoxCPM2));
        assert!(trim_long_form_chunk_edges(TtsEngine::IndicMio));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn colocate_metallib_simulates_bundle_layout() {
        // Simulate `<App>.app/Contents/{MacOS,Resources}/` and verify the
        // helper links the bundled metallib next to the sidecar binary.
        let root = std::env::temp_dir().join(format!("soniqo-colocate-{}", uuid::Uuid::new_v4()));
        let macos = root.join("MacOS");
        let resources = root.join("Resources");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        let src = resources.join("mlx.metallib");
        std::fs::write(&src, b"fake metallib bytes").unwrap();

        // Sidecar dir doesn't have it yet.
        let dest = macos.join("mlx.metallib");
        assert!(!dest.exists());

        colocate_metallib(&macos);
        assert!(dest.exists(), "expected colocated metallib");
        // Reads back identical contents (whether via symlink or copy).
        assert_eq!(std::fs::read(&dest).unwrap(), b"fake metallib bytes");

        // Idempotent: second call is a no-op and doesn't error.
        colocate_metallib(&macos);
        assert!(dest.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn colocate_metallib_noop_when_source_absent() {
        // Dev/unbundled layout: no Resources/ sibling. Helper should do nothing
        // (sidecar is expected to find the metallib via the dev-path workflow).
        let root =
            std::env::temp_dir().join(format!("soniqo-colocate-noop-{}", uuid::Uuid::new_v4()));
        let macos = root.join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        colocate_metallib(&macos);
        assert!(!macos.join("mlx.metallib").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wav_roundtrip_preserves_signal() {
        // Write a small sinusoid, read it back, check sample-rate + duration
        // and that the signal energy is preserved within quantisation noise.
        let dir = std::env::temp_dir().join("soniqo-wav-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("roundtrip.wav");
        let rate: u32 = 24000;
        let samples: Vec<f32> = (0..rate as usize)
            .map(|i| (i as f32 * 0.05).sin() * 0.4)
            .collect();
        write_wav_pcm16_mono(&path, rate, &samples).unwrap();
        let (read_rate, channels, read_samples) = read_wav_pcm_mono(&path).unwrap();
        assert_eq!(read_rate, rate);
        assert_eq!(channels, 1);
        assert_eq!(read_samples.len(), samples.len());
        let err: f32 = samples
            .iter()
            .zip(read_samples.iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / samples.len() as f32;
        // 16-bit step is ~3e-5; allow generous margin.
        assert!(err < 1e-3, "mean abs error {err} too high");
    }
}
