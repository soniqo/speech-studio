// Integration tests for the platform sidecar binary.
//
// These tests spawn the actual sidecar process and exercise the NDJSON
// protocol from outside the Tauri runtime. They live here rather than in
// src/ because they cross the process boundary.
//
// Fast tests (ping, error handling) run on every `cargo test`. The
// voice-cloning tests are `#[ignore]`d — they load real TTS models and can
// download model weights on first run. Run them explicitly with
// `cargo test -- --ignored`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[cfg(target_os = "macos")]
fn sidecar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("swift-sidecar")
}

#[cfg(target_os = "windows")]
fn sidecar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core-sidecar")
        .join("build")
        .join("Release")
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn sidecar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core-sidecar")
        .join("build")
}

#[cfg(target_os = "macos")]
fn sidecar_binary() -> PathBuf {
    sidecar_dir()
        .join(".build")
        .join("debug")
        .join("soniqo-tts-sidecar")
}

#[cfg(target_os = "windows")]
fn sidecar_binary() -> PathBuf {
    sidecar_dir().join("speech-core-tts-sidecar.exe")
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn sidecar_binary() -> PathBuf {
    sidecar_dir().join("speech-core-tts-sidecar")
}

#[cfg(target_os = "macos")]
fn ensure_sidecar_built() {
    if sidecar_binary().exists() {
        return;
    }
    let status = Command::new("swift")
        .args(["build"])
        .current_dir(sidecar_dir())
        .status()
        .expect("`swift build` failed to run");
    assert!(status.success(), "`swift build` exited with {}", status);
    assert!(
        sidecar_binary().exists(),
        "sidecar binary missing after swift build"
    );
}

#[cfg(not(target_os = "macos"))]
fn ensure_sidecar_built() {
    let binary = sidecar_binary();
    assert!(
        binary.exists(),
        "sidecar binary missing at {}; run `cmake --build core-sidecar/build --config Release` first",
        binary.display()
    );
}

#[cfg(not(target_os = "macos"))]
fn add_sidecar_runtime_path(command: &mut Command, dir: &Path) {
    #[cfg(target_os = "windows")]
    let var = "PATH";
    #[cfg(not(target_os = "windows"))]
    let var = "LD_LIBRARY_PATH";

    let mut paths = vec![dir.to_path_buf()];
    if let Some(existing) = std::env::var_os(var) {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env(var, joined);
    }
}

struct SidecarHandle {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl SidecarHandle {
    fn spawn() -> Self {
        ensure_sidecar_built();
        let binary = sidecar_binary();
        let mut command = Command::new(&binary);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(dir) = binary.parent() {
            command.current_dir(dir);
            #[cfg(not(target_os = "macos"))]
            add_sidecar_runtime_path(&mut command, dir);
        }
        let mut child = command.spawn().expect("failed to spawn sidecar");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        SidecarHandle {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        }
    }

    fn send(&mut self, payload: &serde_json::Value) {
        writeln!(self.stdin, "{}", payload).expect("write to sidecar stdin");
        self.stdin.flush().expect("flush sidecar stdin");
    }

    fn recv(&mut self) -> serde_json::Value {
        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .expect("read from sidecar stdout");
        assert!(!line.is_empty(), "sidecar closed stdout before responding");
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("malformed response: {} (raw: {})", e, line.trim()))
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        // Closing stdin signals the sidecar's readLine loop to exit.
        // We can't move out of self.stdin (Drop takes &mut), so we close it
        // by overwriting with a one-shot piped stdin that drops on the next line.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn sidecar_responds_to_ping() {
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({ "id": "t1", "command": "ping" }));
    let v = s.recv();
    assert_eq!(v["id"], "t1");
    assert_eq!(v["ok"], true);
    assert_eq!(v["result"]["pong"], true);
    assert!(v["result"]["version"].is_string());
}

#[test]
fn sidecar_rejects_unknown_command() {
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({ "id": "x", "command": "nonsense" }));
    let v = s.recv();
    assert_eq!(v["id"], "x");
    assert_eq!(v["ok"], false);
    let err = v["error"].as_str().unwrap_or("");
    assert!(err.contains("unknown command"), "unexpected error: {}", err);
}

#[test]
fn sidecar_rejects_synthesize_with_missing_fields() {
    let mut s = SidecarHandle::spawn();
    let payload = if cfg!(target_os = "macos") {
        serde_json::json!({
            "id": "bad",
            "command": "synthesize_icl",
            "text": "hi"
            // referenceAudioPath + referenceText missing
        })
    } else {
        serde_json::json!({
            "id": "bad",
            "command": "synthesize_voxcpm2",
            "text": "hi"
            // referenceAudioPath missing
        })
    };
    s.send(&payload);
    let v = s.recv();
    assert_eq!(v["ok"], false);
    let err = v["error"].as_str().unwrap_or("");
    assert!(
        err.contains("requires") || err.contains("required") || err.contains("missing"),
        "unexpected error: {}",
        err
    );
}

#[test]
fn sidecar_handles_two_pings_on_one_process() {
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({ "id": "a", "command": "ping" }));
    let r1 = s.recv();
    s.send(&serde_json::json!({ "id": "b", "command": "ping" }));
    let r2 = s.recv();
    assert_eq!(r1["id"], "a");
    assert_eq!(r2["id"], "b");
    assert_eq!(r1["ok"], true);
    assert_eq!(r2["ok"], true);
}

/// Tokenize for fuzzy transcript comparison. Lowercase, strip punctuation,
/// keep alphanumerics + apostrophe.
fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
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

/// Word-set coverage: fraction of unique target tokens that appear in the
/// transcript. Order- and frequency-insensitive on purpose — ASR will drop
/// or repeat words and we don't want false negatives from word order.
fn token_coverage(target: &str, transcript: &str) -> (usize, usize, f64) {
    let target_toks: std::collections::HashSet<_> =
        tokenize(target).into_iter().collect();
    let transcript_toks: std::collections::HashSet<_> =
        tokenize(transcript).into_iter().collect();
    let overlap = target_toks.intersection(&transcript_toks).count();
    let total = target_toks.len();
    let frac = if total == 0 { 0.0 } else { overlap as f64 / total as f64 };
    (overlap, total, frac)
}

/// Full voice-clone round-trip through real Qwen3-TTS ICL.
///
/// First run downloads ~300MB of model weights from HuggingFace to
/// `~/.cache/huggingface/`. Subsequent runs reuse the cache (~30s on
/// Apple Silicon). Explicitly opt-in via `cargo test -- --ignored`.
#[test]
#[ignore]
fn sidecar_voice_clones_via_qwen3() {
    // 1. Generate a reference WAV via macOS `say`.
    let dir = std::env::temp_dir().join("soniqo-sidecar-test");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let ref_path = dir.join("ref.wav");
    let ref_text = "This is a reference sentence used for voice cloning, spoken calmly.";

    let status = Command::new("say")
        .args([
            "-v",
            "Samantha",
            "-o",
            ref_path.to_str().unwrap(),
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            ref_text,
        ])
        .status()
        .expect("`say` not available");
    assert!(status.success(), "say exited with {}", status);
    assert!(ref_path.exists());

    // 2. Spawn sidecar, send synthesize_icl, expect a WAV path back.
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({
        "id": "voice-clone-test",
        "command": "synthesize_icl",
        "text": "Hello world from a voice clone integration test.",
        "voiceId": "test-voice",
        "referenceAudioPath": ref_path.to_string_lossy(),
        "referenceText": ref_text,
    }));

    // Give the sidecar time to download / load the model on first run.
    // The recv() call itself blocks; this bound is just a safety net so the
    // test doesn't hang the suite forever. Bump if your network is slow.
    std::thread::sleep(Duration::from_millis(0));

    let v = s.recv();
    assert_eq!(v["id"], "voice-clone-test");
    assert_eq!(
        v["ok"], true,
        "synthesize_icl failed: {}",
        v["error"].as_str().unwrap_or("(no error message)")
    );

    let audio_path = v["result"]["audioPath"]
        .as_str()
        .expect("audioPath in result");
    let metadata = std::fs::metadata(audio_path).expect("output WAV should exist");
    assert!(
        metadata.len() > 1024,
        "output WAV too small ({} bytes) — likely empty/header-only",
        metadata.len()
    );

    let duration = v["result"]["durationSec"].as_f64().unwrap_or(0.0);
    assert!(duration > 0.1, "output duration too short: {}s", duration);
}

/// Synthesize a known sentence via Qwen3-TTS ICL, transcribe the resulting WAV
/// with the speech-swift CLI (Parakeet engine), and assert the transcript
/// covers the source words. Preconditions:
///   - macOS `say` available
///   - `speech` (speech-swift CLI) on PATH
///   - Qwen3-TTS + Parakeet weights cached (or willing to download on first run)
///
/// Run with: `cargo test -- --ignored synthesize_then_transcribe_roundtrip`
#[test]
#[ignore]
fn synthesize_then_transcribe_roundtrip() {
    let dir = std::env::temp_dir().join("soniqo-roundtrip");
    std::fs::create_dir_all(&dir).expect("mkdir");

    // 1. Make a reference clip with `say`.
    let ref_path = dir.join("ref.wav");
    let ref_text = "Hello. This is a clean reference voice spoken slowly and clearly.";
    let st = Command::new("say")
        .args([
            "-v",
            "Samantha",
            "-o",
            ref_path.to_str().unwrap(),
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            ref_text,
        ])
        .status()
        .expect("`say` not available");
    assert!(st.success(), "say exited with {}", st);

    // 2. Synthesize a target sentence via Qwen3-TTS ICL.
    let target = "The quick brown fox jumps over the lazy dog near the river.";
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({
        "id": "roundtrip-synth",
        "command": "synthesize_icl",
        "text": target,
        "voiceId": "roundtrip-voice",
        "referenceAudioPath": ref_path.to_string_lossy(),
        "referenceText": ref_text,
    }));
    let v = s.recv();
    assert_eq!(
        v["ok"], true,
        "synthesize_icl failed: {}",
        v["error"].as_str().unwrap_or("(no error)")
    );
    let audio_path = v["result"]["audioPath"]
        .as_str()
        .expect("audioPath in result")
        .to_string();
    // Close the sidecar before invoking another MLX-using process — `speech`
    // also loads MLX models, and two MLX consumers in the same machine play
    // nicer when they're not contending for the same Metal queue.
    drop(s);

    let synth_size = std::fs::metadata(&audio_path).expect("synth output exists").len();
    assert!(synth_size > 4096, "synth WAV too small: {} bytes", synth_size);
    eprintln!("[roundtrip] synthesized -> {} ({} bytes)", audio_path, synth_size);

    // 3. Transcribe with speech-swift CLI (Parakeet — fastest engine).
    let out = Command::new("speech")
        .args(["transcribe", &audio_path, "--engine", "parakeet"])
        .output()
        .expect("`speech` CLI not available on PATH (install speech-swift)");
    assert!(
        out.status.success(),
        "speech transcribe failed ({}): stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    let transcript = String::from_utf8_lossy(&out.stdout).to_string();
    eprintln!("[roundtrip] transcript: {}", transcript.trim());

    // 4. Token-set coverage check.
    let (overlap, total, frac) = token_coverage(target, &transcript);
    eprintln!(
        "[roundtrip] coverage: {}/{} = {:.0}%",
        overlap,
        total,
        frac * 100.0
    );
    assert!(
        frac >= 0.6,
        "transcript missed too many source words ({}/{} = {:.0}%); target={:?}; transcript={:?}",
        overlap,
        total,
        frac * 100.0,
        target,
        transcript.trim()
    );
}

// -----------------------------------------------------------------------------
// Voice-quality debug test.
//
// Produces a flight of WAVs under /tmp/voice-debug/ for A/B listening:
//   - Anna line 1 and line 3 (Samantha reference) — checks voice consistency
//     for the same speaker across two demo lines.
//   - Marek line 2 cloned from each of {Alex, Tom, Aaron} references —
//     A/B which macOS male voice clones cleanly via Qwen3-TTS.
//
// Spawns one sidecar (model loaded once, reused for all 5 calls). Skipped by
// default because it takes ~60-90s wall time. Run via:
//   cargo test --test sidecar -- --ignored --nocapture debug_voice_variants
// -----------------------------------------------------------------------------

fn generate_say_ref(dir: &std::path::Path, voice: &str, text: &str) -> PathBuf {
    let path = dir.join(format!("ref-{}.wav", voice.to_lowercase()));
    let status = Command::new("say")
        .args([
            "-v",
            voice,
            "-o",
            path.to_str().unwrap(),
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            text,
        ])
        .status()
        .expect("`say` not available");
    assert!(status.success(), "`say` failed for voice {}", voice);
    path
}

struct Take {
    label: String,
    text: &'static str,
    reference_path: PathBuf,
    reference_text: &'static str,
    temperature: Option<f32>,
    top_k: Option<i64>,
    max_tokens: Option<i64>,
}

/// Mirrors the retry strategy in `src/lib.rs::synthesize_clip` so the debug
/// test exercises the same flow the production Tauri command uses.
fn synth_strategies() -> &'static [(&'static str, Option<f32>, Option<i64>, Option<i64>)] {
    // Keep in lockstep with SYNTH_STRATEGIES in src/lib.rs.
    &[
        ("default", None, None, None),
        ("stoch-0.5", Some(0.5), Some(20), None),
        ("stoch-0.7", Some(0.7), Some(30), None),
    ]
}

fn estimate_dur(text: &str) -> f64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as f64 / 12.0
}

fn synth_looks_failed(duration_sec: f64, text: &str, audio_path: &str) -> Option<String> {
    let expected = estimate_dur(text).max(0.8);
    let max_ok = expected * 3.0 + 1.5;
    if duration_sec > max_ok {
        return Some(format!("too long ({:.1}s vs ≤{:.1})", duration_sec, max_ok));
    }
    if duration_sec < 0.4 {
        return Some(format!("too short ({:.2}s)", duration_sec));
    }
    if duration_sec > expected + 2.0 {
        // tail RMS via header + raw read
        if let Ok(rms) = read_wav_tail_rms(audio_path, 0.3) {
            if rms < 0.005 {
                return Some(format!("silent tail (RMS={:.4})", rms));
            }
        }
    }
    None
}

fn read_wav_tail_rms(path: &str, tail_fraction: f64) -> Result<f64, std::io::Error> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let mut header = [0u8; 44];
    f.read_exact(&mut header)?;
    let channels = u16::from_le_bytes([header[22], header[23]]) as u64;
    let bps = u16::from_le_bytes([header[34], header[35]]) as u64;
    if bps != 16 || channels == 0 {
        return Ok(0.0);
    }
    let bpf = bps / 8 * channels;
    let total_bytes = std::fs::metadata(path)?.len().saturating_sub(44);
    let total_frames = total_bytes / bpf;
    let tail_frames = ((total_frames as f64 * tail_fraction) as u64).max(1);
    let tail_start = 44 + (total_frames - tail_frames) * bpf;
    f.seek(SeekFrom::Start(tail_start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let mut sum_sq = 0.0f64;
    let mut n = 0u64;
    for chunk in buf.chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0;
        sum_sq += s * s;
        n += 1;
    }
    if n == 0 {
        return Ok(0.0);
    }
    Ok((sum_sq / n as f64).sqrt())
}

/// Run the retry strategy for one take. Returns (final_audio_path, final_duration,
/// attempts_tried, accepted_strategy_name_or_None).
fn synth_with_retry(
    s: &mut SidecarHandle,
    take: &Take,
    label_prefix: &str,
) -> (Option<String>, f64, usize, Option<&'static str>) {
    let mut best: Option<(String, f64, &'static str)> = None;
    for (i, (name, temp, top_k, max_tok)) in synth_strategies().iter().enumerate() {
        let id = format!("{}-{}-a{}", label_prefix, take.label, i);
        let mut payload = serde_json::json!({
            "id": &id,
            "command": "synthesize_icl",
            "text": take.text,
            "voiceId": &take.label,
            "referenceAudioPath": take.reference_path.to_string_lossy(),
            "referenceText": take.reference_text,
        });
        if let Some(t) = temp { payload["temperature"] = serde_json::json!(t); }
        if let Some(k) = top_k { payload["topK"] = serde_json::json!(k); }
        if let Some(m) = max_tok { payload["maxTokens"] = serde_json::json!(m); }
        s.send(&payload);
        let v = s.recv();
        if v["ok"] != true { continue; }
        let audio = v["result"]["audioPath"].as_str().unwrap_or("").to_string();
        let dur = v["result"]["durationSec"].as_f64().unwrap_or(0.0);
        match synth_looks_failed(dur, take.text, &audio) {
            None => return (Some(audio), dur, i + 1, Some(*name)),
            Some(reason) => {
                eprintln!("  retry: {} attempt {} ({}) suspect: {}", take.label, i + 1, name, reason);
                let expected = estimate_dur(take.text).max(0.8);
                let diff = (dur - expected).abs();
                let take_it = best.as_ref().map(|(_, d, _)| (d - expected).abs() > diff).unwrap_or(true);
                if take_it { best = Some((audio, dur, *name)); }
            }
        }
    }
    match best {
        Some((a, d, n)) => (Some(a), d, synth_strategies().len(), Some(n)),
        None => (None, 0.0, synth_strategies().len(), None),
    }
}

impl Take {
    fn basic(label: impl Into<String>, text: &'static str, ref_path: PathBuf, ref_text: &'static str) -> Self {
        Take {
            label: label.into(),
            text,
            reference_path: ref_path,
            reference_text: ref_text,
            temperature: None,
            top_k: None,
            max_tokens: None,
        }
    }

    fn with_sampling(mut self, temp: f32, top_k: i64, max_tokens: i64) -> Self {
        self.temperature = Some(temp);
        self.top_k = Some(top_k);
        self.max_tokens = Some(max_tokens);
        self
    }
}

#[test]
#[ignore]
fn debug_voice_variants() {
    let dir = std::path::Path::new("/tmp/voice-debug");
    std::fs::create_dir_all(dir).expect("mkdir /tmp/voice-debug");

    // Reference texts — keep them long enough for ICL to capture timbre.
    let samantha_ref_text =
        "Hello. This is the calm narrator voice for the scene. I'm speaking in a measured tone.";
    let male_ref_text =
        "And this is the lower intense voice of the antagonist. Listen carefully. I am speaking with measured weight.";

    eprintln!("\n[debug] generating say references…");
    let samantha = generate_say_ref(dir, "Samantha", samantha_ref_text);
    let victoria = generate_say_ref(dir, "Victoria", samantha_ref_text);
    let karen = generate_say_ref(dir, "Karen", samantha_ref_text);
    let ava = generate_say_ref(dir, "Ava", samantha_ref_text);
    let alex = generate_say_ref(dir, "Alex", male_ref_text);
    let tom = generate_say_ref(dir, "Tom", male_ref_text);
    let aaron = generate_say_ref(dir, "Aaron", male_ref_text);
    eprintln!("[debug] references at {}", dir.display());
    let _ = (&samantha, &victoria, &karen, &ava, &alex, &tom, &aaron);

    // Three matrices to learn from:
    //   1) baseline (defaults) — confirms previous run's broken cases.
    //   2) lower-temperature sampling — does t=0.5 reduce EOS failures?
    //   3) capped max_tokens — does limiting runaway output salvage anything?
    // EXACT lines from the demo (src-tauri/src/lib.rs `lines:`).
    let anna_text1 = "I never thought we'd make it this far.";
    let anna_text3 = "Just stay quiet for a moment, please.";
    let male_target1 = "I knew you would make it, no matter what.";
    let male_target2 = "Then we end this together. Tonight.";

    let _ = (&victoria, &karen, &ava, &samantha, &tom, &aaron);
    // 4 demo lines × 2 takes each. With retry, expect ≥ 90% pass.
    let takes: Vec<Take> = vec![
        Take::basic("anna1-karen", anna_text1, karen.clone(), samantha_ref_text),
        Take::basic("anna3-karen", anna_text3, karen, samantha_ref_text),
        Take::basic("marek1-alex", male_target1, alex.clone(), male_ref_text),
        Take::basic("marek2-alex", male_target2, alex, male_ref_text),
    ];

    eprintln!("[debug] spawning sidecar (model will load once, reused across {} calls)", takes.len());
    let mut s = SidecarHandle::spawn();

    struct Outcome {
        label: String,
        text: String,
        path: PathBuf,
        duration_sec: f64,
        synth_secs: f64,
        attempts: usize,
        strategy: String,
    }

    let mut results: Vec<Outcome> = Vec::new();
    for (i, t) in takes.iter().enumerate() {
        let started = std::time::Instant::now();
        eprintln!("\n[debug] {}/{}: {} — \"{}\"", i + 1, takes.len(), t.label, t.text);
        let (audio_path_opt, duration, attempts, strategy_opt) = synth_with_retry(&mut s, t, "debug");
        let elapsed = started.elapsed().as_secs_f64();
        let audio_path = match audio_path_opt {
            Some(p) => p,
            None => {
                eprintln!("[debug] {} ALL attempts failed", t.label);
                continue;
            }
        };
        let dest = dir.join(format!("{}.wav", t.label));
        std::fs::copy(&audio_path, &dest)
            .unwrap_or_else(|e| panic!("copy {} -> {}: {}", audio_path, dest.display(), e));
        let strategy = strategy_opt.unwrap_or("(none)").to_string();
        eprintln!(
            "[debug] {} done in {:.1}s — {} ({:.2}s audio, {} attempts, accepted: {})",
            t.label, elapsed, dest.display(), duration, attempts, strategy
        );
        results.push(Outcome {
            label: t.label.to_string(),
            text: t.text.to_string(),
            path: dest,
            duration_sec: duration,
            synth_secs: elapsed,
            attempts,
            strategy,
        });
    }

    drop(s);

    // ASR-grade each output so we don't have to listen one at a time.
    eprintln!("\n[debug] grading via `speech transcribe --engine parakeet`…");
    eprintln!(
        "\n{:14} {:>7} {:>7} {:>5}  {:>4} {:>9}  {:<60}",
        "label", "synth", "audio", "cov", "atts", "strategy", "transcript"
    );
    eprintln!("{}", "-".repeat(140));
    let mut pass_count = 0;
    for r in &results {
        let asr_out = Command::new("speech")
            .args(["transcribe", &r.path.to_string_lossy(), "--engine", "parakeet"])
            .output();
        let transcript = match asr_out {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                stdout
                    .lines()
                    .find_map(|l| l.strip_prefix("Result: "))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| stdout.trim().to_string())
            }
            Ok(_) | Err(_) => "<asr unavailable>".into(),
        };
        let (_, _, coverage) = token_coverage(&r.text, &transcript);
        let verdict = if coverage >= 0.8 { "✓" } else if coverage >= 0.5 { "~" } else { "✗" };
        if coverage >= 0.8 { pass_count += 1; }
        let transcript_clip = if transcript.len() > 60 {
            format!("{}…", &transcript[..57])
        } else {
            transcript.clone()
        };
        eprintln!(
            "{:14} {:>6.1}s {:>6.2}s {:>3}% {} {:>4} {:>9}  {:<60}",
            r.label, r.synth_secs, r.duration_sec, (coverage * 100.0) as u32, verdict,
            r.attempts, r.strategy, transcript_clip
        );
    }
    eprintln!("\nPassed: {}/{} (✓ ≥80% target words)", pass_count, results.len());
    eprintln!("Outputs at {}", dir.display());
}

// -----------------------------------------------------------------------------
// Demo-references end-to-end test.
//
// Exercises the EXACT pipeline `seed_demo` + `synthesize_clip` send to the
// sidecar in production, against the bundled human-voice references
// (`src-tauri/resources/voices/{anna,marek}.wav`) and the 4 demo script lines.
// Runs each line REPEATS times in one sidecar process (MLX-Metal output is
// nondeterministic across calls — repeats expose intermittent EOS failures
// that single-shot tests miss). ASR-grades every output via Parakeet.
//
// Pass criteria (deliberately permissive — we want a green build to mean
// "demo loads usably"; subtle prosody regressions need ear evaluation):
//   * Every (line, iteration) cell must produce non-zero audio.
//   * Per-line mean coverage ≥ 60% (allows one bad take per line).
//   * Overall mean coverage ≥ 70%.
//
// Run via:
//   cargo test --test sidecar -- --ignored --nocapture demo_references_e2e
//
// Takes ~60-120s (model load + 4×REPEATS syntheses + ASR per output).
// -----------------------------------------------------------------------------

const DEMO_REPEATS: usize = 3;

fn bundled_voice_path(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("voices")
        .join(format!("{}.wav", name));
    assert!(
        p.exists(),
        "missing bundled reference {}; run seed_demo source review first",
        p.display()
    );
    p
}

// Reference text for the bundled WAVs. Must match seed_demo in src/lib.rs.
const ANNA_REF_TEXT: &str = "The Hispaniola was rolling scuppers under in the ocean swell. The booms were tearing at the blocks. The rudder was banging.";
const MAREK_REF_TEXT: &str = "It is a pretty little spot there, a green grass plateau running along by the water's edge and overhung by willows.";

// Demo target lines. Must match `lines` in `seed_demo`.
const DEMO_LINES: &[(&str, &str)] = &[
    ("anna1",  "I never thought we'd make it this far."),
    ("marek1", "I knew you would make it, no matter what."),
    ("anna3",  "Just stay quiet for a moment, please."),
    ("marek2", "Then we end this together. Tonight."),
];

#[test]
#[ignore]
fn demo_references_e2e() {
    let dir = std::path::Path::new("/tmp/demo-e2e");
    std::fs::create_dir_all(dir).expect("mkdir /tmp/demo-e2e");

    let anna_ref = bundled_voice_path("anna");
    let marek_ref = bundled_voice_path("marek");

    let takes: Vec<(String, &'static str, PathBuf, &'static str)> = DEMO_LINES
        .iter()
        .flat_map(|(label, text)| {
            let (ref_path, ref_text) = if label.starts_with("anna") {
                (anna_ref.clone(), ANNA_REF_TEXT)
            } else {
                (marek_ref.clone(), MAREK_REF_TEXT)
            };
            (0..DEMO_REPEATS).map(move |i| {
                (format!("{}-r{}", label, i), *text, ref_path.clone(), ref_text)
            })
        })
        .collect();

    eprintln!(
        "\n[e2e] {} takes ({} lines × {} repeats), spawning sidecar…",
        takes.len(),
        DEMO_LINES.len(),
        DEMO_REPEATS
    );

    let mut s = SidecarHandle::spawn();

    struct Outcome {
        label: String,
        line_key: String,
        text: String,
        path: Option<PathBuf>,
        duration_sec: f64,
        synth_secs: f64,
        attempts: usize,
        strategy: String,
    }

    let mut results: Vec<Outcome> = Vec::new();
    for (idx, (label, text, ref_path, ref_text)) in takes.iter().enumerate() {
        let started = std::time::Instant::now();
        eprintln!(
            "\n[e2e] {}/{}: {} — \"{}\"",
            idx + 1,
            takes.len(),
            label,
            text
        );
        // Mirror Rust's production retry loop: walk the seed ladder, take
        // the first attempt that ASR-grades ≥ 50% coverage. Each iteration
        // (r0/r1/r2) starts at a different offset so we exercise different
        // seeds across iterations and surface seed-sensitivity in the matrix.
        let label_idx = label
            .rsplit_once("-r")
            .and_then(|(_, n)| n.parse::<usize>().ok())
            .unwrap_or(0);
        let seed_ladder: [u64; 12] = [
            1000, 1001, 1002, 1010, 1011, 1012,
            1020, 1021, 1022, 1030, 1031, 1032,
        ];
        // Start each iteration at a different position in the ladder.
        let start = (label_idx * 3) % seed_ladder.len();

        let mut audio_path_opt: Option<String> = None;
        let mut dur = 0.0;
        let mut best: Option<(String, f64, u64)> = None;
        for k in 0..seed_ladder.len() {
            let seed = seed_ladder[(start + k) % seed_ladder.len()];
            let id = format!("e2e-{}-s{}", label, seed);
            s.send(&serde_json::json!({
                "id": &id,
                "command": "synthesize_cosyvoice",
                "text": text,
                "voiceId": label,
                "referenceAudioPath": ref_path.to_string_lossy(),
                "referenceText": ref_text,
                "seed": seed,
            }));
            let v = s.recv();
            if v["ok"] != true {
                eprintln!("  failed seed={}: {}", seed, v["error"].as_str().unwrap_or("(no error)"));
                continue;
            }
            let p = match v["result"]["audioPath"].as_str() { Some(p) => p.to_string(), None => continue };
            let d = v["result"]["durationSec"].as_f64().unwrap_or(0.0);
            // ASR-grade right here so the test matches the production flow.
            let asr = Command::new("speech")
                .args(["transcribe", "--engine", "parakeet", &p])
                .output();
            let transcript = match asr {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .find_map(|l| l.strip_prefix("Result: ").map(|s| s.trim().to_string()))
                    .unwrap_or_default(),
                _ => String::new(),
            };
            let (_, _, coverage) = token_coverage(text, &transcript);
            eprintln!("  attempt seed={} cov={:.0}%  \"{}\"", seed, coverage * 100.0, transcript);
            if best.as_ref().map(|(_, c, _)| *c < coverage).unwrap_or(true) {
                best = Some((p.clone(), coverage, seed));
            }
            if coverage >= 0.75 {
                audio_path_opt = Some(p);
                dur = d;
                break;
            }
        }
        if audio_path_opt.is_none() {
            if let Some((p, c, seed)) = best.as_ref() {
                eprintln!("  all attempts below threshold; using best seed={} cov={:.0}%", seed, c * 100.0);
                audio_path_opt = Some(p.clone());
                dur = 0.0;
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        let path = audio_path_opt.map(|src| {
            let dest = dir.join(format!("{}.wav", label));
            let _ = std::fs::copy(&src, &dest);
            dest
        });
        let line_key = label
            .rsplit_once('-')
            .map(|(prefix, _)| prefix.to_string())
            .unwrap_or_else(|| label.clone());
        results.push(Outcome {
            label: label.clone(),
            line_key,
            text: text.to_string(),
            path,
            duration_sec: dur,
            synth_secs: elapsed,
            attempts: 1,
            strategy: "cosyvoice".to_string(),
        });
    }

    drop(s);

    // ASR-grade
    eprintln!(
        "\n{:18} {:>7} {:>7} {:>5} {:>4} {:>9}  {:<60}",
        "label", "synth", "audio", "cov", "atts", "strategy", "transcript"
    );
    eprintln!("{}", "-".repeat(140));

    let mut per_line: std::collections::BTreeMap<String, Vec<f64>> = Default::default();
    let mut zero_audio: Vec<String> = Vec::new();
    let mut all_coverages: Vec<f64> = Vec::new();

    for r in &results {
        let (coverage, transcript) = match &r.path {
            Some(p) if p.exists() => {
                let out = Command::new("speech")
                    .args(["transcribe", &p.to_string_lossy(), "--engine", "parakeet"])
                    .output();
                let transcript = match out {
                    Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .find_map(|l| l.strip_prefix("Result: "))
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                let (_, _, frac) = token_coverage(&r.text, &transcript);
                (frac, transcript)
            }
            _ => {
                zero_audio.push(r.label.clone());
                (0.0, String::from("<no audio>"))
            }
        };
        per_line
            .entry(r.line_key.clone())
            .or_default()
            .push(coverage);
        all_coverages.push(coverage);
        let verdict = if coverage >= 0.8 { "✓" } else if coverage >= 0.5 { "~" } else { "✗" };
        let trimmed = if transcript.len() > 60 {
            format!("{}…", &transcript[..57])
        } else {
            transcript
        };
        eprintln!(
            "{:18} {:>6.1}s {:>6.2}s {:>3}% {} {:>4} {:>9}  {:<60}",
            r.label,
            r.synth_secs,
            r.duration_sec,
            (coverage * 100.0) as u32,
            verdict,
            r.attempts,
            r.strategy,
            trimmed
        );
    }

    eprintln!("\n{:18} {}", "line", "per-iteration coverage");
    eprintln!("{}", "-".repeat(60));
    let mut per_line_means: Vec<(String, f64)> = Vec::new();
    for (line, covs) in &per_line {
        let mean = covs.iter().sum::<f64>() / covs.len() as f64;
        per_line_means.push((line.clone(), mean));
        let cells = covs
            .iter()
            .map(|c| format!("{:>3}%", (*c * 100.0) as u32))
            .collect::<Vec<_>>()
            .join("  ");
        eprintln!("{:18} {}  (mean {:>3}%)", line, cells, (mean * 100.0) as u32);
    }
    let overall = all_coverages.iter().sum::<f64>() / all_coverages.len() as f64;
    eprintln!("\noverall mean coverage: {:>3}%", (overall * 100.0) as u32);
    eprintln!("outputs in {}", dir.display());

    // Pass criteria
    assert!(
        zero_audio.is_empty(),
        "{} take(s) produced no audio: {:?}",
        zero_audio.len(),
        zero_audio
    );
    // CosyVoice baseline (Phase 1 measurement): 100/100/94/95 per line, 97%
    // overall. The Qwen3-TTS-era bars (50% per line, 70% overall) were
    // permissive to accommodate Metal-jitter outliers; CosyVoice doesn't
    // need that slack.
    for (line, mean) in &per_line_means {
        assert!(
            *mean >= 0.80,
            "line {} mean coverage {:.0}% < 80%",
            line,
            mean * 100.0
        );
    }
    assert!(
        overall >= 0.90,
        "overall mean coverage {:.0}% < 90%",
        overall * 100.0
    );
}

// -----------------------------------------------------------------------------
// Onset-junk + emotion-marker e2e tests.
//
// Qwen3 ICL and OmniVoice both opened some renders (reference-dependent) with
// a short low-level codec artifact before the first word — quiet hiss for
// Qwen3 on the Marek reference, a low hum for OmniVoice on Anna — followed by
// a silence gap before the phrase. The sidecar removes these via
// trimLeadingJunk before edge conditioning. These tests replay the exact
// production requests that used to produce audible junk (deterministic at
// seed 1000) and assert the first thing you hear is speech-loud.
//
// Indic-Mio styles via a closed suffix-tag vocabulary; the sidecar maps the
// Studio's inline "(happy)"-style marker onto it. Before that mapping the
// model read the marker aloud, so the third test pins "marker is styled, not
// spoken".
//
// All three load real models (cached under ~/.cache/huggingface after the
// first run) and need the `speech` CLI for Parakeet grading. Opt in via:
//   cargo test --test sidecar -- --ignored --nocapture qwen_onset_is_speech_not_junk
//   cargo test --test sidecar -- --ignored --nocapture omnivoice_onset_is_speech_not_junk
//   cargo test --test sidecar -- --ignored --nocapture indic_mio_does_not_speak_emotion_marker
// -----------------------------------------------------------------------------

/// Read a sidecar-written WAV (44-byte header, 16-bit PCM mono) as f32 samples.
fn read_wav_samples(path: &str) -> (Vec<f32>, usize) {
    use std::io::Read;
    let mut f = std::fs::File::open(path).expect("open wav");
    let mut header = [0u8; 44];
    f.read_exact(&mut header).expect("wav header");
    let channels = u16::from_le_bytes([header[22], header[23]]) as usize;
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]) as usize;
    let bps = u16::from_le_bytes([header[34], header[35]]);
    assert_eq!(bps, 16, "expected 16-bit PCM");
    assert_eq!(channels, 1, "expected mono");
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).expect("wav data");
    let samples = buf
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    (samples, sample_rate)
}

/// Group audio into energy islands (5 ms RMS windows above -60 dBFS, closed
/// by ≥50 ms of quiet) and return (first_island_peak_db, max_island_peak_db).
/// Mirrors the sidecar's trimLeadingJunk analysis: a clean render opens with
/// a speech-loud island; onset junk shows up as a first island far below the
/// loudest one (measured 10-28 dB down across both engines).
fn onset_island_peaks(samples: &[f32], sample_rate: usize) -> Option<(f64, f64)> {
    let win = sample_rate * 5 / 1000;
    if win == 0 || samples.len() < win * 8 {
        return None;
    }
    let dbs: Vec<f64> = samples
        .chunks_exact(win)
        .map(|c| {
            let e = c.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / c.len() as f64;
            if e > 0.0 { 10.0 * e.log10() } else { -120.0 }
        })
        .collect();
    let mut peaks: Vec<f64> = Vec::new();
    let mut current: Option<f64> = None;
    let mut quiet = 0;
    for &db in &dbs {
        if db > -60.0 {
            current = Some(current.map_or(db, |p: f64| p.max(db)));
            quiet = 0;
        } else if let Some(peak) = current {
            quiet += 1;
            if quiet >= 10 {
                peaks.push(peak);
                current = None;
            }
        }
    }
    if let Some(peak) = current {
        peaks.push(peak);
    }
    let first = *peaks.first()?;
    let max = peaks.iter().cloned().fold(f64::MIN, f64::max);
    Some((first, max))
}

fn parakeet_transcript(audio_path: &str) -> String {
    let out = Command::new("speech")
        .args(["transcribe", audio_path, "--engine", "parakeet"])
        .output()
        .expect("run `speech transcribe` (install the speech CLI for e2e tests)");
    assert!(
        out.status.success(),
        "speech transcribe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("Result: "))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Send one synthesis request, assert success, and return the output path.
fn synth_expect_ok(s: &mut SidecarHandle, payload: serde_json::Value) -> String {
    let id = payload["id"].as_str().unwrap_or("").to_string();
    s.send(&payload);
    let v = s.recv();
    assert_eq!(v["id"], serde_json::Value::String(id));
    assert_eq!(
        v["ok"],
        true,
        "synthesis failed: {}",
        v["error"].as_str().unwrap_or("(no error)")
    );
    let path = v["result"]["audioPath"].as_str().expect("audioPath").to_string();
    let dur = v["result"]["durationSec"].as_f64().unwrap_or(0.0);
    assert!(
        (1.0..=15.0).contains(&dur),
        "implausible duration {:.2}s for {}",
        dur,
        path
    );
    path
}

/// The first energy island must be speech, not a quiet junk prefix. 8 dB is
/// the sidecar detector's own quiet-junk bound: clean takes measured ≤4.7 dB
/// below the loudest island, junk takes ≥10.2 dB.
fn assert_onset_is_speech(audio_path: &str, target_text: &str) {
    let (samples, sample_rate) = read_wav_samples(audio_path);
    let (first_peak, max_peak) =
        onset_island_peaks(&samples, sample_rate).expect("no energy islands in output");
    let deficit = max_peak - first_peak;
    assert!(
        deficit <= 8.0,
        "onset junk: first island peaks {:.1} dB below the loudest ({:.1} vs {:.1} dBFS) in {}",
        deficit,
        first_peak,
        max_peak,
        audio_path
    );
    let transcript = parakeet_transcript(audio_path);
    let (_, _, cov) = token_coverage(target_text, &transcript);
    assert!(
        cov >= 0.6,
        "coverage {:.0}% < 60% — transcript {:?} vs target {:?}",
        cov * 100.0,
        transcript,
        target_text
    );
}

#[test]
#[ignore]
fn qwen_onset_is_speech_not_junk() {
    let marek = bundled_voice_path("marek");
    let mut s = SidecarHandle::spawn();
    // The exact production request (post-preprocess text, seed 1000) that
    // used to open with ~100 ms of quiet hiss followed by half a second of
    // silence before the phrase.
    let path = synth_expect_ok(
        &mut s,
        serde_json::json!({
            "id": "e2e-qwen-onset",
            "command": "synthesize_icl",
            "engine": "qwen3",
            "text": "Then we end this together, Tonight.",
            "voiceId": "marek",
            "referenceAudioPath": marek.to_string_lossy(),
            "referenceText": MAREK_REF_TEXT,
            "seed": 1000,
            "maxTokens": 44,
        }),
    );
    assert_onset_is_speech(&path, "Then we end this together, Tonight.");
}

#[test]
#[ignore]
fn omnivoice_onset_is_speech_not_junk() {
    let anna = bundled_voice_path("anna");
    let mut s = SidecarHandle::spawn();
    // OmniVoice's variant of the same artifact: a ~200 ms low hum on the
    // Anna reference before the first word.
    let path = synth_expect_ok(
        &mut s,
        serde_json::json!({
            "id": "e2e-omni-onset",
            "command": "synthesize_omnivoice",
            "engine": "omnivoice",
            "modelId": "aufklarer/OmniVoice-MLX-fp16",
            "text": "(dramatic) I never thought we'd make it this far.",
            "voiceId": "anna",
            "referenceAudioPath": anna.to_string_lossy(),
            "referenceText": ANNA_REF_TEXT,
            "language": "en",
            "seed": 1000,
        }),
    );
    assert_onset_is_speech(&path, "I never thought we'd make it this far.");
}

#[test]
#[ignore]
fn indic_mio_does_not_speak_emotion_marker() {
    let anna = bundled_voice_path("anna");
    let mut s = SidecarHandle::spawn();
    let target = "This line should sound bright and clear.";
    let path = synth_expect_ok(
        &mut s,
        serde_json::json!({
            "id": "e2e-indic-marker",
            "command": "synthesize_indic_mio",
            "engine": "indic-mio",
            "modelId": "aufklarer/Indic-Mio-MLX-fp16",
            "text": format!("(happy) {}", target),
            "voiceId": "indic-test",
            "referenceAudioPath": anna.to_string_lossy(),
            "referenceText": ANNA_REF_TEXT,
            "language": "en",
            "seed": 1000,
        }),
    );
    let transcript = parakeet_transcript(&path);
    let (_, _, cov) = token_coverage(target, &transcript);
    assert!(
        cov >= 0.6,
        "coverage {:.0}% < 60% — transcript {:?}",
        cov * 100.0,
        transcript
    );
    assert!(
        !tokenize(&transcript).contains(&"happy".to_string()),
        "emotion marker was spoken aloud — transcript {:?}",
        transcript
    );
}

#[test]
fn sidecar_rejects_engine_mismatch() {
    let mut s = SidecarHandle::spawn();
    let payload = if cfg!(target_os = "macos") {
        serde_json::json!({
            "id": "mismatch",
            "command": "synthesize_omnivoice",
            "engine": "qwen3",
            "text": "hi",
            "referenceAudioPath": "/nonexistent.wav",
        })
    } else {
        serde_json::json!({
            "id": "mismatch",
            "command": "init_model",
            "engine": "omnivoice",
        })
    };
    s.send(&payload);
    let v = s.recv();
    assert_eq!(v["ok"], false);
    let err = v["error"].as_str().unwrap_or("");
    if cfg!(target_os = "macos") {
        assert!(
            err.contains("requires engine"),
            "unexpected error: {}",
            err
        );
    } else {
        assert!(
            err.contains("unsupported engine"),
            "unexpected error: {}",
            err
        );
    }
}

#[test]
fn sidecar_rejects_indic_mio_without_text() {
    let mut s = SidecarHandle::spawn();
    s.send(&serde_json::json!({
        "id": "no-text",
        "command": "synthesize_indic_mio",
        "engine": "indic-mio",
    }));
    let v = s.recv();
    assert_eq!(v["ok"], false);
    let err = v["error"].as_str().unwrap_or("");
    assert!(
        err.contains("requires") && err.contains("text"),
        "unexpected error: {}",
        err
    );
}
