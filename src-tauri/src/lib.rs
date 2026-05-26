use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ---------- sidecar process management ----------

fn sidecar_path() -> PathBuf {
    // In a Tauri release bundle the sidecar lives next to the main binary at
    // `<App>.app/Contents/MacOS/soniqo-tts-sidecar` (Tauri's externalBin
    // bundler strips the target-triple suffix). In dev we read from the Swift
    // package's debug build dir so `pnpm tauri dev` and `cargo run` both
    // find the freshly-built sidecar.
    if !cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let bundled = parent.join("soniqo-tts-sidecar");
                if bundled.exists() {
                    return bundled;
                }
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("swift-sidecar")
        .join(".build")
        .join("debug")
        .join("soniqo-tts-sidecar")
}

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Default)]
pub struct SidecarManager {
    inner: Mutex<Option<SidecarProcess>>,
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
    }
}

impl SidecarManager {
    fn spawn() -> Result<SidecarProcess, String> {
        let path = sidecar_path();
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("spawn {} failed: {}", path.display(), e))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
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
            *guard = Some(Self::spawn()?);
        }

        let proc = guard.as_mut().expect("just spawned");
        let line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        writeln!(proc.stdin, "{}", line).map_err(|e| e.to_string())?;
        proc.stdin.flush().map_err(|e| e.to_string())?;

        let mut response = String::new();
        proc.stdout
            .read_line(&mut response)
            .map_err(|e| e.to_string())?;
        if response.trim().is_empty() {
            return Err("sidecar closed connection".into());
        }
        serde_json::from_str(&response)
            .map_err(|e| format!("parse sidecar response: {} (raw: {})", e, response.trim()))
    }
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

#[tauri::command]
async fn ping_sidecar(manager: State<'_, SidecarManager>) -> Result<SidecarResponse, String> {
    let payload = serde_json::json!({
        "id": format!("ping-{}", uuid::Uuid::new_v4()),
        "command": "ping",
    });
    let raw = manager.request(&payload)?;
    serde_json::from_value(raw).map_err(|e| e.to_string())
}

#[tauri::command]
async fn init_model(manager: State<'_, SidecarManager>) -> Result<(), String> {
    let payload = serde_json::json!({
        "id": format!("init-{}", uuid::Uuid::new_v4()),
        "command": "init_model",
    });
    let raw = manager.request(&payload)?;
    let env: SidecarResponse = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    if !env.ok {
        return Err(env.error.unwrap_or_else(|| "init_model failed".into()));
    }
    Ok(())
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
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Audio", &["wav", "mp3", "m4a", "aac", "flac", "ogg"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked.map(|p| PickedAudio {
        path: p.to_string(),
    }))
}

#[derive(Deserialize)]
struct CloneVoiceArgs {
    #[serde(rename = "referencePath")]
    reference_path: String,
    name: String,
    #[serde(rename = "referenceText", default)]
    reference_text: String,
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
}

#[tauri::command]
async fn clone_voice(args: CloneVoiceArgs) -> Result<Voice, String> {
    // Qwen3-TTS is pure ICL: there's no separate "clone" step. A Voice is
    // metadata pointing at a reference clip + transcript that synthesis pulls
    // in at every call. No sidecar round-trip needed here.
    Ok(Voice {
        id: uuid::Uuid::new_v4().to_string(),
        name: args.name,
        source_kind: "library",
        reference_audio_path: args.reference_path,
        reference_text: args.reference_text,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[derive(Deserialize)]
struct SynthesizeArgs {
    #[serde(rename = "clipId")]
    clip_id: String,
    text: String,
    #[serde(rename = "voiceId")]
    voice_id: String,
    #[serde(rename = "referenceAudioPath")]
    reference_audio_path: String,
    #[serde(rename = "referenceText")]
    reference_text: String,
    #[allow(dead_code)]
    mode: String,
    #[serde(rename = "targetDurationSec", default)]
    #[allow(dead_code)]
    target_duration_sec: Option<f64>,
}

#[derive(Serialize)]
struct SynthesizeResult {
    #[serde(rename = "audioPath")]
    audio_path: String,
}

#[tauri::command]
async fn synthesize_clip(
    manager: State<'_, SidecarManager>,
    args: SynthesizeArgs,
) -> Result<SynthesizeResult, String> {
    if args.text.trim().is_empty() {
        return Err("clip text is empty".into());
    }
    // CosyVoice is the active engine. Reference transcript is recommended but
    // not strictly required (CosyVoice falls back to spk-embedding-only cloning
    // if absent); validate the audio path though.
    if args.reference_audio_path.trim().is_empty() {
        return Err("reference audio path is required".into());
    }

    // VoxCPM2 is the active engine. Cloning is much more deterministic than
    // CosyVoice (no FSQ-prompt leak, no inline-period EOS bug), so we keep a
    // small ladder of seeds in case any single take grades badly — the demo
    // sweep showed most takes pass on seed 1000 with this engine.
    const SEED_LADDER: &[u64] = &[1000, 1001, 1002, 1010, 1011, 1012];

    // cfg_value ladder. CLI default is 2.0. We bump to 2.5 on retries because
    // higher classifier-free-guidance pulls the model harder toward the text,
    // suppressing trailing repetition ("Tonight. Tonight."). Past ~3.5 the
    // prosody starts flattening, so we cap there.
    const CFG_LADDER: &[f32] = &[2.0, 2.5, 3.0];

    // Hard upper bound on generated audio patches. Each patch is ~50 ms of
    // audio at VoxCPM2's mel rate, so 200 patches ≈ 10 s. For a typical demo
    // line (~3 s) this is far more than enough, but tight enough to cut off
    // a runaway repeat before it can complete a full second cycle. The
    // library defaults to 2000 (≈100 s) — way too loose for short clips.
    let target_word_count = canon_tokens(&args.text).len();
    let max_tokens = (target_word_count.saturating_mul(12) + 40).clamp(60, 240);

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

    let mut best: Option<(String, Grade, u64)> = None;
    let mut last_error: Option<String> = None;

    for (attempt_idx, &seed) in SEED_LADDER.iter().enumerate() {
        let cfg = CFG_LADDER[attempt_idx.min(CFG_LADDER.len() - 1)];
        let payload = serde_json::json!({
            "id": format!("synth-{}-s{}", args.clip_id, seed),
            "command": "synthesize_voxcpm2",
            "text": processed_text,
            "voiceId": args.voice_id,
            "referenceAudioPath": args.reference_audio_path,
            // VoxCPM2 ignores referenceText; we still pass it for parity with
            // the cosyvoice fallback path.
            "referenceText": args.reference_text,
            "seed": seed,
            "cfgValue": cfg,
            "maxTokens": max_tokens,
        });

        let raw = match manager.request(&payload) {
            Ok(v) => v,
            Err(e) => {
                last_error = Some(format!("attempt {} (seed={}): {}", attempt_idx, seed, e));
                eprintln!("[synth] {}", last_error.as_ref().unwrap());
                continue;
            }
        };
        let env: SidecarResponse = match serde_json::from_value(raw) {
            Ok(e) => e,
            Err(e) => {
                last_error = Some(format!("parse response: {}", e));
                eprintln!("[synth] {}", last_error.as_ref().unwrap());
                continue;
            }
        };
        if !env.ok {
            last_error = Some(env.error.unwrap_or_else(|| "sidecar error".into()));
            eprintln!(
                "[synth] clip {} attempt {} (seed={}) failed: {}",
                args.clip_id, attempt_idx, seed, last_error.as_ref().unwrap()
            );
            continue;
        }
        let result = env.result.unwrap_or_default();
        let audio_path = match result.get("audioPath").and_then(|v| v.as_str()) {
            Some(p) => p.to_string(),
            None => continue,
        };
        let duration = result.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);

        // ASR-grade via Parakeet, then check transcript shape.
        let grade = asr_grade(&audio_path, &processed_text).unwrap_or_else(|| Grade {
            coverage: 0.0,
            prefix_words: 0,
            suffix_words: 0,
            repeated_target_words: 0,
            transcript: String::new(),
        });
        eprintln!(
            "[synth] clip {} attempt {} (seed={}) {} cov={:.0}% pre={} suf={} rep={} ({:.2}s)",
            args.clip_id, attempt_idx, seed,
            if grade.is_clean() { "✓" } else { "✗" },
            grade.coverage * 100.0,
            grade.prefix_words,
            grade.suffix_words,
            grade.repeated_target_words,
            duration,
        );

        // Keep the best attempt as fallback (composite score, not raw coverage).
        let take_it = best
            .as_ref()
            .map(|(_, g, _)| g.score() < grade.score())
            .unwrap_or(true);
        if take_it {
            best = Some((audio_path.clone(), grade.clone(), seed));
        }

        if grade.is_clean() {
            eprintln!(
                "[synth] clip {} accepted on attempt {} (seed={}, cov={:.0}%)",
                args.clip_id, attempt_idx, seed, grade.coverage * 100.0
            );
            return Ok(SynthesizeResult { audio_path });
        }
    }

    if let Some((audio_path, grade, seed)) = best {
        eprintln!(
            "[synth] clip {} all attempts below threshold; returning best (seed={}, cov={:.0}%, score={:.2})",
            args.clip_id, seed, grade.coverage * 100.0, grade.score()
        );
        return Ok(SynthesizeResult { audio_path });
    }
    Err(last_error.unwrap_or_else(|| "all synth attempts failed".into()))
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

/// Result of grading a synth take. Captures the four signals we use to decide
/// accept/reject: how much of the target text appears, and whether the
/// transcript is "shaped right" (no prefix junk, no trailing repetition).
#[derive(Debug, Clone)]
struct Grade {
    /// Fraction of target words present in the transcript (via LCS).
    coverage: f64,
    /// Number of transcript words BEFORE the first aligned target word.
    /// Detects reference-echo leak ("Capit, ruttering, quilt, JUST STAY…").
    prefix_words: usize,
    /// Number of transcript words AFTER the last aligned target word.
    /// Detects trailing garbage (model failed to EOS cleanly).
    suffix_words: usize,
    /// Count of target words that appear 2+ times in the transcript.
    /// Detects line repetition (model regenerated the line after first EOS).
    repeated_target_words: usize,
    /// Raw ASR transcript, kept for logging only.
    #[allow(dead_code)]
    transcript: String,
}

impl Grade {
    /// Accept rule. Tuned against a 48-take sweep:
    ///   - Coverage ≥ 0.75 lets through clean substitutions (e.g. "end" → "and").
    ///   - prefix ≤ 1 allows one short attack word ("And…", "Oh…") but blocks
    ///     reference-echo prefixes which are typically 3+ junk words.
    ///   - suffix ≤ 2 allows a trailing pause/period word but blocks tail
    ///     repetition or filler.
    ///   - repeated == 0 blocks line-repetition takes entirely.
    fn is_clean(&self) -> bool {
        self.coverage >= 0.75
            && self.prefix_words <= 1
            && self.suffix_words <= 2
            && self.repeated_target_words == 0
    }

    /// Composite score for ladder-exhausted fallback. Weights chosen so that
    /// a clean cov=75% take beats a leaked cov=100% take; a repetition take
    /// is heavily penalised because it doubles the audio length audibly.
    fn score(&self) -> f64 {
        self.coverage
            - 0.1 * self.prefix_words as f64
            - 0.05 * self.suffix_words as f64
            - 0.2 * self.repeated_target_words as f64
    }
}

/// Run `speech transcribe --engine parakeet` and grade the transcript against
/// the target. Returns None only if the ASR command itself fails — an empty
/// transcript is graded as 0% coverage, not None.
fn asr_grade(audio_path: &str, target: &str) -> Option<Grade> {
    let out = Command::new("speech")
        .args(["transcribe", "--engine", "parakeet", audio_path])
        .output()
        .ok()?;
    if !out.status.success() {
        eprintln!(
            "[synth] parakeet failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let transcript = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("Result: ").map(|s| s.trim().to_string()))
        .unwrap_or_default();
    Some(grade_transcript(&transcript, target))
}

/// LCS-based grading: find the longest subsequence of `target` words that
/// appears (in order, with skips allowed) inside `transcript`. The position
/// of the first/last aligned transcript words tells us about prefix/suffix
/// junk. Repetition is detected separately as "did any target word appear 2+
/// times in the transcript?".
fn grade_transcript(transcript: &str, target: &str) -> Grade {
    let trans = canon_tokens(transcript);
    let targ = canon_tokens(target);
    if targ.is_empty() {
        return Grade {
            coverage: 0.0,
            prefix_words: 0,
            suffix_words: 0,
            repeated_target_words: 0,
            transcript: transcript.to_string(),
        };
    }
    if trans.is_empty() {
        return Grade {
            coverage: 0.0,
            prefix_words: 0,
            suffix_words: 0,
            repeated_target_words: 0,
            transcript: transcript.to_string(),
        };
    }

    let n = trans.len();
    let m = targ.len();
    // dp[i][j] = LCS length over trans[0..i] vs targ[0..j].
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            dp[i][j] = if trans[i - 1] == targ[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }
    let matched = dp[n][m] as usize;
    if matched == 0 {
        return Grade {
            coverage: 0.0,
            prefix_words: 0,
            suffix_words: trans.len(),
            repeated_target_words: 0,
            transcript: transcript.to_string(),
        };
    }

    // Backtrack to find FIRST and LAST aligned transcript indices.
    let mut aligned: Vec<usize> = Vec::with_capacity(matched);
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        if trans[i - 1] == targ[j - 1] {
            aligned.push(i - 1);
            i -= 1;
            j -= 1;
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    aligned.reverse();
    let first = aligned[0];
    let last = aligned[aligned.len() - 1] + 1;

    // Repeated target words: count target words appearing 2+ times in
    // transcript. Uses a small set lookup since target is short.
    let targ_set: std::collections::HashSet<&String> = targ.iter().collect();
    let mut counts: std::collections::HashMap<&String, usize> = std::collections::HashMap::new();
    for w in &trans {
        if targ_set.contains(w) {
            *counts.entry(w).or_insert(0) += 1;
        }
    }
    let repeated = counts.values().filter(|&&c| c >= 2).count();

    Grade {
        coverage: matched as f64 / m as f64,
        prefix_words: first,
        suffix_words: trans.len() - last,
        repeated_target_words: repeated,
        transcript: transcript.to_string(),
    }
}

fn canon_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

// ---------- demo seed ----------
//
// The demo uses real Qwen3-TTS ICL synthesis. Since Qwen3-TTS needs a
// reference audio + reference transcript per voice, and we don't ship any
// audio in this repo, we bootstrap the references by calling macOS `say`
// (Samantha / Daniel) into a temp WAV. Then we synthesize each demo line
// through the sidecar, which loads the Qwen3-TTS model on first call.
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

fn short_hash(s: &str) -> u32 {
    // FNV-1a 32-bit. Stable across runs without pulling another crate.
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn clip_cache_dir() -> std::path::PathBuf {
    let home = dirs_home();
    let dir = home
        .join("Library/Caches/audio.soniqo.studio/clips");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
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

// ---------- Synthesis quality detection ----------
//
// Qwen3-TTS occasionally fails to emit EOS and produces a long tail of
// silence or garbage. MLX-swift's Metal compute is non-deterministic across
// processes, so the same input may succeed on one run and fail on another.
// We detect failures heuristically (duration far off from text length, or
// silent tail) and retry with a different sampling strategy.

fn estimate_speech_duration_sec(text: &str) -> f64 {
    // English speech ≈ 12 non-space chars per second.
    let chars = text.chars().filter(|c| !c.is_whitespace()).count() as f64;
    chars / 12.0
}

/// Read the last `tail_fraction` of a 16-bit PCM WAV and return RMS in [0,1].
fn wav_tail_rms(path: &std::path::Path, tail_fraction: f64) -> Result<f64, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header).map_err(|e| e.to_string())?;
    let channels = u16::from_le_bytes([header[22], header[23]]) as u32;
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]) as u32;
    if bits_per_sample != 16 || channels == 0 {
        return Err("unsupported wav format".into());
    }
    let bytes_per_frame = (bits_per_sample / 8) as u64 * channels as u64;
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let audio_bytes = metadata.len().saturating_sub(44);
    let total_frames = audio_bytes / bytes_per_frame;
    if total_frames == 0 {
        return Ok(0.0);
    }
    let tail_frames = ((total_frames as f64 * tail_fraction.clamp(0.05, 1.0)) as u64).max(1);
    let tail_start = 44u64 + (total_frames - tail_frames) * bytes_per_frame;
    f.seek(SeekFrom::Start(tail_start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((tail_frames * bytes_per_frame) as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut sum_sq: f64 = 0.0;
    let mut count: u64 = 0;
    for chunk in buf.chunks_exact(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0;
        sum_sq += sample * sample;
        count += 1;
    }
    if count == 0 {
        return Ok(0.0);
    }
    Ok((sum_sq / count as f64).sqrt())
}

/// Returns `Some(reason)` if the audio looks like a failed synthesis.
fn synthesis_failure_reason(
    audio_path: &str,
    duration_sec: f64,
    text: &str,
) -> Option<String> {
    let expected = estimate_speech_duration_sec(text).max(0.8);
    // 1) Duration way off: model didn't emit EOS, or got truncated.
    let max_ok = expected * 3.0 + 1.5;
    if duration_sec > max_ok {
        return Some(format!(
            "audio too long ({:.1}s vs expected ≤ {:.1}s for {} chars)",
            duration_sec,
            max_ok,
            text.chars().filter(|c| !c.is_whitespace()).count()
        ));
    }
    if duration_sec < 0.4 {
        return Some(format!("audio too short ({:.2}s)", duration_sec));
    }
    // 2) Tail is silent: likely 30s+ of empty audio after a partial utterance.
    //    Only check if audio is suspiciously long.
    if duration_sec > expected + 2.0 {
        match wav_tail_rms(std::path::Path::new(audio_path), 0.3) {
            Ok(rms) if rms < 0.005 => {
                return Some(format!(
                    "audio tail silent (RMS={:.4} over last 30%)",
                    rms
                ));
            }
            _ => {}
        }
    }
    None
}

#[derive(Serialize, Clone)]
struct DemoProgress {
    phase: &'static str,
    current: usize,
    total: usize,
    message: String,
}

fn emit_progress(app: &tauri::AppHandle, phase: &'static str, current: usize, total: usize, message: impl Into<String>) {
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

#[tauri::command]
async fn seed_demo(app: tauri::AppHandle) -> Result<DemoSeed, String> {
    eprintln!("[seed_demo] start (lazy mode: no Qwen3 synth, only `say` references)");
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
    // Reference text was produced by Parakeet ASR over the same WAV — close
    // enough to verbatim for ICL.
    let ref_specs: [(&[u8], &str, &str); 2] = [
        (
            include_bytes!("../resources/voices/anna.wav"),
            "The Hispaniola was rolling scuppers under in the ocean swell. The booms were tearing at the blocks, ruddering.",
            "ref-anna.wav",
        ),
        (
            include_bytes!("../resources/voices/marek.wav"),
            "It is a pretty little spot there, a green grass plateau running along by the water's edge and overhung by willows.",
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
        eprintln!("[seed_demo] wrote bundled reference {} ({} bytes)", path.display(), bytes.len());
        voices.push(DemoVoiceSeed {
            reference_audio_path: path.to_string_lossy().to_string(),
            reference_text: (*ref_text).to_string(),
        });
    }
    eprintln!("[seed_demo] references ready, starting Qwen3-TTS synthesis (first call downloads model)");

    // Step 2 — demo lines, each wrapped in a VoxCPM2 style marker. The
    // sidecar's extractFirstEmotionTag pulls the tag name out and passes it
    // as `instruct` to the model; the body inside the tags is what gets
    // synthesised. Emotion choices map to the scene beats:
    //   Anna   — soft relief opening the scene
    //   Marek  — warm reassurance
    //   Anna   — urgent whisper
    //   Marek  — intense, decisive close
    let lines: [(usize, &str); 4] = [
        (0, "(soft) I never thought we'd make it this far."),
        (1, "(warm) I knew you would make it, no matter what."),
        (0, "(whispering) Just stay quiet for a moment, please."),
        (1, "(intense) Then we end this together. Tonight."),
    ];

    // Build clip metadata. If a cached WAV already exists for this exact line,
    // attach its path so the user can immediately play it; otherwise leave
    // audio_path = None and let the user trigger synthesis explicitly via
    // Regenerate. No Qwen3 calls happen here — Load demo is ~instant.
    let cache_dir = clip_cache_dir();
    let mut clips = Vec::with_capacity(lines.len());
    for (idx, (speaker_idx, text)) in lines.iter().enumerate() {
        let stable_id = format!(
            "demo-s{}-l{}-{:x}",
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
            if frame < 0 { continue; }
            let frame = frame as usize;
            if frame >= mix.len() { break; }
            mix[frame] += s;
        }
    }

    // Soft clip in case overlapping clips on different speaker tracks summed
    // past ±1.0. A hard clamp keeps the WAV writable without distortion at
    // the obvious cost of squashing transients past the threshold.
    for s in mix.iter_mut() {
        if *s > 1.0 { *s = 1.0; }
        else if *s < -1.0 { *s = -1.0; }
    }

    write_wav_pcm16_mono(std::path::Path::new(&args.out_path), sample_rate, &mix)?;
    eprintln!(
        "[export] wrote {} ({} frames @ {} Hz from {} clips)",
        args.out_path, mix.len(), sample_rate, args.clips.len()
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
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
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
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header)
        .map_err(|e| format!("read header {}: {}", path.display(), e))?;
    let channels = u16::from_le_bytes([header[22], header[23]]);
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits = u16::from_le_bytes([header[34], header[35]]);
    if bits != 16 {
        return Err(format!("{}: only 16-bit PCM supported (got {})", path.display(), bits));
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
    let mut f = std::fs::File::create(path)
        .map_err(|e| format!("create {}: {}", path.display(), e))?;
    let bits_per_sample = 16u16;
    let channels = 1u16;
    let byte_rate = sample_rate * channels as u32 * (bits_per_sample as u32 / 8);
    let block_align = channels * (bits_per_sample / 8);
    let data_bytes = samples.len() as u32 * (bits_per_sample as u32 / 8);
    let riff_size = 36 + data_bytes;

    // RIFF / fmt / data chunks. Standard canonical 44-byte PCM header.
    f.write_all(b"RIFF").map_err(|e| e.to_string())?;
    f.write_all(&riff_size.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"WAVE").map_err(|e| e.to_string())?;
    f.write_all(b"fmt ").map_err(|e| e.to_string())?;
    f.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;       // fmt chunk size
    f.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;        // PCM
    f.write_all(&channels.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&sample_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&byte_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&block_align.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&bits_per_sample.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"data").map_err(|e| e.to_string())?;
    f.write_all(&data_bytes.to_le_bytes()).map_err(|e| e.to_string())?;

    // Samples.
    let mut buf = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = if s > 1.0 { 1.0 } else if s < -1.0 { -1.0 } else { s };
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
        .setup(|app| {
            app.manage(SidecarManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping_sidecar,
            init_model,
            pick_video,
            pick_audio,
            clone_voice,
            synthesize_clip,
            export_project,
            seed_demo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn grade_clean_take_passes() {
        let g = grade_transcript(
            "I knew you would make it, no matter what.",
            "I knew you would make it, no matter what.",
        );
        assert_eq!(g.coverage, 1.0);
        assert_eq!(g.prefix_words, 0);
        assert_eq!(g.suffix_words, 0);
        assert_eq!(g.repeated_target_words, 0);
        assert!(g.is_clean());
    }

    #[test]
    fn grade_detects_reference_leak_prefix() {
        // Clip 1 from the sweep: "Can be." prefix + line repeated twice.
        let g = grade_transcript(
            "Can be. I never thought we'd make it this far. Ruttering. I never thought we'd make it this far.",
            "I never thought we'd make it this far.",
        );
        assert_eq!(g.coverage, 1.0); // all target words present
        assert!(g.prefix_words >= 2, "expected prefix junk, got {}", g.prefix_words);
        assert!(g.repeated_target_words >= 4, "expected repetition, got {}", g.repeated_target_words);
        assert!(!g.is_clean());
    }

    #[test]
    fn grade_detects_short_take() {
        let g = grade_transcript("Tonight.", "Then we end this together. Tonight.");
        assert!(g.coverage < 0.5);
        assert!(!g.is_clean());
    }

    #[test]
    fn grade_accepts_minor_substitution() {
        // "end" -> "and" — one-word substitution still passes if coverage stays
        // above the 0.75 threshold.
        let g = grade_transcript(
            "Then we and this together. Tonight.",
            "Then we end this together. Tonight.",
        );
        assert!(g.coverage >= 0.75, "expected >=0.75, got {}", g.coverage);
        assert_eq!(g.prefix_words, 0);
        assert!(g.is_clean(), "should accept minor substitution");
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

    #[test]
    fn score_prefers_clean_low_cov_over_leaked_high_cov() {
        // The whole point of the composite score: when ladder exhausts, prefer
        // a clean cov=75% take over a cov=100% leak.
        let clean = grade_transcript(
            "I knew you would make.",
            "I knew you would make it.",
        );
        let leaked = grade_transcript(
            "Capit ruttering quilt I knew you would make it",
            "I knew you would make it.",
        );
        assert!(
            clean.score() > leaked.score(),
            "clean.score={} leaked.score={}",
            clean.score(), leaked.score()
        );
    }
}
