//! Optional read-only Speech Runtime adapter for reference transcripts.
//!
//! Calls only the explicitly configured loopback service; no audio is uploaded
//! to an external API. TTS stays in Speech Studio until the separate daemon
//! gains a TTS contract.
use serde::{Deserialize, Serialize};
use std::time::Duration;

const RUNTIME_URL: &str = "http://127.0.0.1:8477";
const MAX_REFERENCE_BYTES: u64 = 64 * 1024 * 1024;

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
        Ok(client) => client.get(format!("{RUNTIME_URL}/health")).send().await,
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
        let token_path = dirs::home_dir()
            .ok_or_else(|| "Home directory unavailable".to_string())?
            .join("Library/Application Support/SpeechRuntime/token");
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
                "{RUNTIME_URL}/v1/audio/transcriptions?model=parakeet-ultra&priority=batch"
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
