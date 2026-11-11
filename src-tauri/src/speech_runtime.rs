//! Optional Speech Runtime adapter: reference transcripts and, when the
//! daemon declares TTS support, shared-residency synthesis. Calls only the
//! explicitly configured loopback service; no audio leaves the machine.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const RUNTIME_URL: &str = "http://127.0.0.1:8477";
const MAX_REFERENCE_BYTES: u64 = 64 * 1024 * 1024;

/// Base URL of the Speech Runtime daemon. `SPEECH_RUNTIME_URL` overrides the
/// default so Studio's client mode can be verified against an isolated
/// runtime instance on another port. Read per call, never cached.
fn runtime_url() -> String {
    std::env::var("SPEECH_RUNTIME_URL").unwrap_or_else(|_| RUNTIME_URL.to_string())
}

/// Token file of the Speech Runtime daemon. `SPEECH_RUNTIME_TOKEN_FILE`
/// overrides the default location (paired with `SPEECH_RUNTIME_URL` for
/// isolated instances that write their token elsewhere).
fn runtime_token_path() -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("SPEECH_RUNTIME_TOKEN_FILE") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(std::path::PathBuf::from(path));
        }
    }
    Ok(dirs::home_dir()
        .ok_or_else(|| "Home directory unavailable".to_string())?
        .join("Library/Application Support/SpeechRuntime/token"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    connected: bool,
    detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeReferenceArgs {
    audio_path: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Speech Runtime HTTP client: {e}"))
}

#[tauri::command]
pub async fn speech_runtime_health() -> RuntimeHealth {
    let response = match client() {
        Ok(client) => client.get(format!("{}/health", runtime_url())).send().await,
        Err(err) => {
            return RuntimeHealth { connected: false, detail: err };
        }
    };
    match response {
        Ok(resp) if resp.status().is_success() => RuntimeHealth {
            connected: true,
            detail: "Speech Runtime доступен на 127.0.0.1:8477".into(),
        },
        Ok(resp) => RuntimeHealth {
            connected: false,
            detail: format!("Speech Runtime returned HTTP {}", resp.status()),
        },
        Err(e) => RuntimeHealth { connected: false, detail: e.to_string() },
    }
}

#[cfg(target_os = "macos")]
struct TemporaryWav(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl Drop for TemporaryWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(not(target_os = "macos"))]
fn convert_reference_to_wav16(path: &str) -> Result<Vec<u8>, String> {
    let _ = path;
    Err("Speech Runtime audio conversion currently supports macOS only".into())
}

#[cfg(target_os = "macos")]
fn convert_reference_to_wav16(path: &str) -> Result<Vec<u8>, String> {
    use std::path::Path;
    let input = Path::new(path);
    let metadata = std::fs::metadata(input).map_err(|e| format!("Reference file: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_REFERENCE_BYTES {
        return Err("Reference must be a file of at most 64 MiB".into());
    }
    let out = std::env::temp_dir().join(format!(
        "speech-studio-runtime-{}.wav",
        uuid::Uuid::new_v4()
    ));
    let _cleanup = TemporaryWav(out.clone());
    // Apple's afconvert handles the formats accepted by the reference picker.
    // Speech Runtime's existing /v1/audio/transcriptions endpoint requires
    // 16kHz audio and does not resample the input itself.
    let result = std::process::Command::new("/usr/bin/afconvert")
        .args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"])
        .arg(input)
        .arg(&out)
        .output()
        .map_err(|e| format!("afconvert unavailable: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "Failed to convert reference to 16kHz WAV: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let wav = std::fs::read(&out).map_err(|e| e.to_string())?;
    if wav.is_empty() || wav.len() as u64 > MAX_REFERENCE_BYTES {
        return Err("Converted reference is empty or too large".into());
    }
    Ok(wav)
}

#[tauri::command]
pub async fn speech_runtime_transcribe_reference(
    args: TranscribeReferenceArgs,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = args;
        Err("Speech Runtime reference adapter currently supports macOS only".into())
    }
    #[cfg(target_os = "macos")]
    {
        let token_path = runtime_token_path()?;
        let token = std::fs::read_to_string(token_path)
            .map_err(|e| format!("Speech Runtime token unavailable: {e}"))?;
        if token.trim().is_empty() {
            return Err("Speech Runtime token is empty".into());
        }
        let audio_path = args.audio_path;
        let wav = tauri::async_runtime::spawn_blocking(move || convert_reference_to_wav16(&audio_path))
            .await
            .map_err(|e| format!("Audio conversion task failed: {e}"))??;
        let response = client()?
            .post(format!(
                "{}/v1/audio/transcriptions?model=parakeet-ultra&priority=batch",
                runtime_url()
            ))
            .bearer_auth(token.trim())
            .header(reqwest::header::CONTENT_TYPE, "audio/wav")
            .body(wav)
            .send()
            .await
            .map_err(|e| format!("Speech Runtime request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Speech Runtime HTTP {status}: {}", body.chars().take(300).collect::<String>()));
        }
        let payload: serde_json::Value = response.json().await
            .map_err(|e| format!("Invalid Speech Runtime JSON: {e}"))?;
        let text = payload.get("text").and_then(|v| v.as_str())
            .ok_or_else(|| "Speech Runtime response contains no 'text'".to_string())?;
        if text.trim().is_empty() {
            return Err("Speech Runtime did not recognize speech in the reference".into());
        }
        Ok(text.to_owned())
    }
}


// ---------- TTS client (daemon >= 0.3) ----------

fn runtime_token() -> Result<String, String> {
    let token = std::fs::read_to_string(runtime_token_path()?)
        .map_err(|e| format!("Speech Runtime token unavailable: {e}"))?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Speech Runtime token is empty".into());
    }
    Ok(token)
}

async fn runtime_call(
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let token = runtime_token()?;
    let mut request = client()?
        .request(method, format!("{}{path}", runtime_url()))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Speech Runtime request failed: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Speech Runtime HTTP {status}: {}",
            text.chars().take(400).collect::<String>()
        ));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("Invalid Speech Runtime JSON: {e}"))
}

#[tauri::command]
pub async fn speech_runtime_tts_models() -> Result<serde_json::Value, String> {
    runtime_call(reqwest::Method::GET, "/v1/tts/models", None).await
}

#[tauri::command]
pub async fn speech_runtime_tts_load(model: String, variant: Option<String>) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({ "model": model });
    if let Some(variant) = variant {
        body["variant"] = serde_json::Value::String(variant);
    }
    runtime_call(reqwest::Method::POST, "/v1/tts/models/load", Some(body)).await
}

#[tauri::command]
pub async fn speech_runtime_tts_unload(model: String) -> Result<serde_json::Value, String> {
    runtime_call(
        reqwest::Method::POST,
        "/v1/tts/models/unload",
        Some(serde_json::json!({ "model": model })),
    )
    .await
}

#[tauri::command]
pub async fn speech_runtime_tts_voices() -> Result<serde_json::Value, String> {
    runtime_call(reqwest::Method::GET, "/v1/tts/voices", None).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterVoiceArgs {
    name: String,
    language: Option<String>,
    reference_text: String,
    audio_path: String,
}

#[tauri::command]
pub async fn speech_runtime_tts_register_voice(
    args: RegisterVoiceArgs,
) -> Result<serde_json::Value, String> {
    let audio_path = args.audio_path.clone();
    let wav = tauri::async_runtime::spawn_blocking(move || convert_reference_to_wav16(&audio_path))
        .await
        .map_err(|e| format!("Audio conversion task failed: {e}"))??;
    let body = serde_json::json!({
        "name": args.name,
        "language": args.language,
        "referenceText": args.reference_text,
        "audioBase64": base64::engine::general_purpose::STANDARD.encode(wav),
    });
    runtime_call(reqwest::Method::POST, "/v1/tts/voices", Some(body)).await
}

#[tauri::command]
pub async fn speech_runtime_tts_delete_voice(id: String) -> Result<serde_json::Value, String> {
    runtime_call(
        reqwest::Method::DELETE,
        &format!("/v1/tts/voices?id={}", urlencode(&id)),
        None,
    )
    .await
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSynthesizeArgs {
    pub request_id: String,
    pub model: String,
    pub voice_id: Option<String>,
    pub reference_audio_path: Option<String>,
    pub reference_text: Option<String>,
    pub text: String,
    pub language: Option<String>,
    pub seed: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSynthesizeResult {
    pub audio_path: String,
    pub sample_rate: u32,
    pub duration_sec: f64,
}

#[tauri::command]
pub async fn speech_runtime_tts_synthesize(
    args: RuntimeSynthesizeArgs,
) -> Result<RuntimeSynthesizeResult, String> {
    let mut payload = serde_json::json!({
        "requestId": args.request_id,
        "model": args.model,
        "text": args.text,
        "language": args.language,
        "seed": args.seed,
    });
    if let Some(voice_id) = args.voice_id.filter(|v| !v.trim().is_empty()) {
        payload["voiceId"] = serde_json::Value::String(voice_id);
    }
    if let Some(reference_text) = args.reference_text.filter(|v| !v.trim().is_empty()) {
        payload["referenceText"] = serde_json::Value::String(reference_text);
    }
    if let Some(path) = args.reference_audio_path.filter(|v| !v.trim().is_empty()) {
        let wav = tauri::async_runtime::spawn_blocking(move || convert_reference_to_wav16(&path))
            .await
            .map_err(|e| format!("Audio conversion task failed: {e}"))??;
        payload["referenceAudioBase64"] =
            serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(wav));
    }
    if payload.get("voiceId").is_none() && payload.get("referenceAudioBase64").is_none() {
        return Err("Runtime synthesis needs a voice profile or reference audio".into());
    }
    let response =
        runtime_call(reqwest::Method::POST, "/v1/tts/synthesize", Some(payload)).await?;
    let encoded = response
        .get("audioBase64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Speech Runtime TTS response has no audioBase64".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid Speech Runtime audio payload: {e}"))?;
    let sample_rate = response.get("sampleRate").and_then(|v| v.as_u64()).unwrap_or(24000) as u32;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
        return Err("Speech Runtime TTS response is not a WAV file".into());
    }
    let path = crate::clip_cache_dir().join(format!("runtime-{}.wav", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Could not write runtime audio: {e}"))?;
    let duration_sec = crate::wav_duration_sec(&path).unwrap_or_else(|_| {
        response
            .get("durationSec")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
    });
    Ok(RuntimeSynthesizeResult {
        audio_path: path.to_string_lossy().into_owned(),
        sample_rate,
        duration_sec,
    })
}

#[tauri::command]
pub async fn speech_runtime_tts_cancel(request_id: String) -> Result<serde_json::Value, String> {
    runtime_call(
        reqwest::Method::POST,
        "/v1/tts/cancel",
        Some(serde_json::json!({ "requestId": request_id })),
    )
    .await
}

// ---------- client-mode configuration ----------

/// The tts.models entry keys (and per-entry shape) the daemon's
/// `TtsModelEntry` decodes: `engine`, `modelId`, `displayName`,
/// `sampleRate`, `variants`.
#[cfg(target_os = "macos")]
const RUNTIME_TTS_ENGINES: [&str; 3] = ["qwen3", "voxcpm2", "espeech"];

/// launchd service label the Speech Runtime installer registers.
#[cfg(target_os = "macos")]
const RUNTIME_LAUNCHD_LABEL: &str = "com.speechruntime.agent";

#[cfg(target_os = "macos")]
fn runtime_config_path() -> Result<std::path::PathBuf, String> {
    Ok(runtime_support_dir()?.join("app-config.json"))
}

#[cfg(target_os = "macos")]
fn runtime_support_dir() -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = std::env::var("SPEECH_RUNTIME_SUPPORT_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(std::path::PathBuf::from(dir));
        }
    }
    Ok(dirs::home_dir()
        .ok_or_else(|| "Home directory unavailable".to_string())?
        .join("Library/Application Support/SpeechRuntime"))
}

/// Build the `tts` block Studio contributes to the daemon's
/// `app-config.json`. The model entries mirror the registry's qwen3,
/// voxcpm2 and espeech engines; `binary` points at the sidecar Studio
/// itself runs (`sidecar_path()`), so the daemon spawns the exact build
/// Studio validated instead of a second, unknown copy.
#[cfg(target_os = "macos")]
fn build_tts_config_block(sidecar: &std::path::Path) -> Result<serde_json::Value, String> {
    if !sidecar.is_file() {
        return Err(format!(
            "Speech Runtime TTS sidecar not found at {} — build the Swift sidecar first (see swift-sidecar/README)",
            sidecar.display()
        ));
    }
    let mut models = serde_json::Map::new();
    for engine in RUNTIME_TTS_ENGINES {
        let info = crate::runtime_client_engine_info(engine)
            .ok_or_else(|| format!("model-registry.json has no {engine} engine"))?;
        models.insert(
            engine.to_string(),
            serde_json::json!({
                "engine": engine,
                "modelId": info.model_id,
                "displayName": info.display_name,
                "sampleRate": info.sample_rate,
            }),
        );
    }
    Ok(serde_json::json!({
        "binary": sidecar.display().to_string(),
        "models": models,
    }))
}

/// Pure merge: existing daemon config + generated `tts` block → merged
/// config. Preserves every other top-level key (`port`, `models`, ASR
/// entries, …) and, within `tts.models`, keeps entries for engines Studio
/// does not know about. Invalid JSON input is an error (the caller refuses
/// to overwrite a config it cannot parse).
pub(crate) fn merge_runtime_tts_config(
    existing: &str,
    tts_block: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut root: serde_json::Value = serde_json::from_str(existing)
        .map_err(|e| format!("Speech Runtime config is not valid JSON: {e}"))?;
    if !root.is_object() {
        return Err("Speech Runtime config root must be a JSON object".into());
    }
    let generated_models = tts_block
        .get("models")
        .and_then(|m| m.as_object())
        .ok_or_else(|| "generated tts block has no models object".to_string())?;
    let mut merged_models = serde_json::Map::new();
    if let Some(existing_tts) = root.get("tts").and_then(|t| t.get("models")).and_then(|m| m.as_object()) {
        for (name, entry) in existing_tts {
            // Entries Studio cannot regenerate (unknown engines) survive
            // verbatim; known ones are replaced by the freshly built entry.
            if !generated_models.contains_key(name) {
                merged_models.insert(name.clone(), entry.clone());
            }
        }
    }
    for (name, entry) in generated_models {
        merged_models.insert(name.clone(), entry.clone());
    }
    let mut tts = root.get("tts").cloned().unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    if !tts.is_object() {
        tts = serde_json::Value::Object(Default::default());
    }
    tts["models"] = serde_json::Value::Object(merged_models);
    for (key, value) in tts_block.as_object().into_iter().flatten() {
        if key != "models" {
            tts[key] = value.clone();
        }
    }
    root["tts"] = tts;
    Ok(root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTtsConfigResult {
    pub path: String,
    pub models: Vec<String>,
    pub restarted_required: bool,
}

/// Write the `tts` block into the Speech Runtime daemon's app-config.json
/// (merging, never clobbering: `port`, `models`, `batchChunkMs`,
/// `idleUnloadSeconds` and unknown `tts.models` engines are preserved) and
/// return the config path plus the declared model names. macOS only — the
/// file is atomic (temp + rename) so a crash cannot half-write the daemon's
/// config. Requires a runtime build with the `/v1/tts/*` routes (daemon
/// >= 0.3); older installed builds will simply not expose them. The caller
/// must restart the daemon for the change to take effect.
#[tauri::command]
pub async fn speech_runtime_write_tts_config() -> Result<RuntimeTtsConfigResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        Err("Speech Runtime config writing currently supports macOS only".into())
    }
    #[cfg(target_os = "macos")]
    {
        let sidecar = crate::sidecar_path();
        let tts_block = build_tts_config_block(&sidecar)?;
        let path = runtime_config_path()?;
        let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
        let merged = merge_runtime_tts_config(&existing, &tts_block)?;
        let models = merged
            .get("tts")
            .and_then(|t| t.get("models"))
            .and_then(|m| m.as_object())
            .map(|m| m.keys().cloned().collect::<Vec<String>>())
            .unwrap_or_default();
        let mut sorted_models = models;
        sorted_models.sort();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create Speech Runtime config dir: {e}"))?;
        }
        let temp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&merged)
            .map_err(|e| format!("Could not serialize Speech Runtime config: {e}"))?;
        std::fs::write(&temp, body)
            .map_err(|e| format!("Could not write Speech Runtime config: {e}"))?;
        std::fs::rename(&temp, &path)
            .map_err(|e| format!("Could not replace Speech Runtime config: {e}"))?;
        Ok(RuntimeTtsConfigResult {
            path: path.to_string_lossy().into_owned(),
            models: sorted_models,
            restarted_required: true,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRestartResult {
    pub restarted: bool,
    pub reason: Option<String>,
}

/// Restart the Speech Runtime daemon via launchd (`launchctl kickstart -k
/// gui/<uid>/com.speechruntime.agent`). If launchd does not know the
/// service, returns `restarted: false` with a reason instead of touching
/// anything: a process Studio cannot attribute to the launchd label is
/// never killed.
#[tauri::command]
pub async fn speech_runtime_restart() -> Result<RuntimeRestartResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        Err("Speech Runtime restart currently supports macOS only".into())
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let uid = String::from_utf8_lossy(
            &Command::new("id")
                .arg("-u")
                .output()
                .map_err(|e| format!("Could not resolve uid: {e}"))?
                .stdout,
        )
        .trim()
        .to_string();
        if uid.is_empty() {
            return Err("Could not resolve current uid".into());
        }
        let service = format!("gui/{uid}/{RUNTIME_LAUNCHD_LABEL}");
        // Confirm launchd owns the service before touching it: a process
        // Studio cannot attribute to the launchd label is never killed.
        let status = Command::new("launchctl")
            .arg("print")
            .arg(&service)
            .output()
            .map_err(|e| format!("launchctl unavailable: {e}"))?;
        if !status.status.success() {
            return Ok(RuntimeRestartResult {
                restarted: false,
                reason: Some("not running under launchd".into()),
            });
        }
        let kick = Command::new("launchctl")
            .args(["kickstart", "-k"])
            .arg(&service)
            .output()
            .map_err(|e| format!("launchctl kickstart failed: {e}"))?;
        if !kick.status.success() {
            return Err(format!(
                "launchctl kickstart failed: {}",
                String::from_utf8_lossy(&kick.stderr).trim()
            ));
        }
        Ok(RuntimeRestartResult {
            restarted: true,
            reason: None,
        })
    }
}

