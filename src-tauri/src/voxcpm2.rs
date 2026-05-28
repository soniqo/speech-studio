//! Non-macOS synthesis backend: VoxCPM2 voice cloning via speech-core's LiteRT
//! C ABI (`sc_voxcpm2_*`). On macOS the app talks to the Swift/MLX sidecar; on
//! Linux/Windows there's no MLX, so we link speech-core's LiteRT engine
//! directly and drive it over FFI. Build/link wiring lives in `build.rs`.
//!
//! The model bundle (~4.3 GB of .tflite + tokenizer files) is resolved lazily
//! on first synthesis — from `SONIQO_VOXCPM2_BUNDLE` if set, otherwise
//! downloaded to the user cache, mirroring how the macOS sidecar pulls MLX
//! weights on first use.

#![cfg(not(target_os = "macos"))]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ---------- C ABI (speech_core/voxcpm2_c.h) ----------

#[repr(C)]
struct ScVoxcpm2 {
    _private: [u8; 0],
}
type ScVoxcpm2T = *mut ScVoxcpm2;
type ChunkFn = extern "C" fn(*const f32, usize, bool, *mut c_void);

extern "C" {
    fn sc_voxcpm2_create(bundle_dir: *const c_char) -> ScVoxcpm2T;
    fn sc_voxcpm2_destroy(s: ScVoxcpm2T);
    fn sc_voxcpm2_set_instruction(s: ScVoxcpm2T, instruction: *const c_char);
    fn sc_voxcpm2_set_max_steps(s: ScVoxcpm2T, max_steps: c_int);
    fn sc_voxcpm2_set_min_steps_before_stop(s: ScVoxcpm2T, min_steps: c_int);
    fn sc_voxcpm2_set_reference(
        s: ScVoxcpm2T,
        pcm: *const f32,
        length: usize,
        sample_rate: c_int,
    ) -> c_int;
    fn sc_voxcpm2_output_sample_rate(s: ScVoxcpm2T) -> c_int;
    fn sc_voxcpm2_synthesize(
        s: ScVoxcpm2T,
        text: *const c_char,
        on_chunk: ChunkFn,
        context: *mut c_void,
    ) -> c_int;
    fn sc_voxcpm2_last_error(s: ScVoxcpm2T) -> *const c_char;
}

// Trampoline: the C side streams chunks here; we accumulate into a Vec<f32>.
extern "C" fn collect_chunk(samples: *const f32, length: usize, _is_final: bool, ctx: *mut c_void) {
    if samples.is_null() || length == 0 || ctx.is_null() {
        return;
    }
    // SAFETY: ctx is the &mut Vec<f32> we passed to sc_voxcpm2_synthesize; the C
    // side calls this synchronously from within that call, so the borrow is live.
    let out = unsafe { &mut *(ctx as *mut Vec<f32>) };
    let slice = unsafe { std::slice::from_raw_parts(samples, length) };
    out.extend_from_slice(slice);
}

/// Owns a `sc_voxcpm2_t`. Not `Sync`/`Send` by default (raw pointer); we guard
/// it behind a `Mutex` in the manager so synthesis is serialized.
struct Synth {
    handle: ScVoxcpm2T,
}

impl Synth {
    fn create(bundle_dir: &Path) -> Result<Self, String> {
        let c_dir = CString::new(bundle_dir.to_string_lossy().as_bytes())
            .map_err(|e| e.to_string())?;
        // SAFETY: c_dir outlives the call; create copies what it needs.
        let handle = unsafe { sc_voxcpm2_create(c_dir.as_ptr()) };
        if handle.is_null() {
            return Err(format!(
                "sc_voxcpm2_create failed for bundle {} (see stderr)",
                bundle_dir.display()
            ));
        }
        Ok(Synth { handle })
    }

    fn last_error(&self) -> String {
        // SAFETY: returns a pointer owned by the handle, valid until the next call.
        let ptr = unsafe { sc_voxcpm2_last_error(self.handle) };
        if ptr.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }

    fn set_instruction(&self, instruction: &str) {
        if let Ok(c) = CString::new(instruction) {
            unsafe { sc_voxcpm2_set_instruction(self.handle, c.as_ptr()) };
        }
    }

    fn set_reference(&self, pcm: &[f32], sample_rate: i32) -> Result<(), String> {
        let rc = unsafe {
            sc_voxcpm2_set_reference(self.handle, pcm.as_ptr(), pcm.len(), sample_rate as c_int)
        };
        if rc != 0 {
            return Err(format!("set_reference failed: {}", self.last_error()));
        }
        Ok(())
    }

    fn synthesize(&self, text: &str) -> Result<Vec<f32>, String> {
        let c_text = CString::new(text).map_err(|e| e.to_string())?;
        let mut audio: Vec<f32> = Vec::new();
        let rc = unsafe {
            sc_voxcpm2_synthesize(
                self.handle,
                c_text.as_ptr(),
                collect_chunk,
                &mut audio as *mut Vec<f32> as *mut c_void,
            )
        };
        if rc != 0 {
            return Err(format!("synthesize failed: {}", self.last_error()));
        }
        Ok(audio)
    }

    fn output_sample_rate(&self) -> u32 {
        let r = unsafe { sc_voxcpm2_output_sample_rate(self.handle) };
        if r > 0 {
            r as u32
        } else {
            48000
        }
    }
}

impl Drop for Synth {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { sc_voxcpm2_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

// ---------- lazy, process-wide engine ----------

/// Lazily-created synthesizer kept resident across calls (model load is slow).
#[derive(Default)]
pub struct Voxcpm2Manager {
    inner: Mutex<Option<Synth>>,
}

impl Voxcpm2Manager {
    fn ensure(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let bundle = resolve_bundle_dir()?;
            *guard = Some(Synth::create(&bundle)?);
        }
        Ok(())
    }

    /// Eagerly load (and on first run download) the model — used by init_model.
    pub fn init(&self) -> Result<(), String> {
        self.ensure()
    }

    /// Clone the reference clip's voice and synthesize `text`, returning the
    /// 48 kHz mono PCM. `instruction` is the emotion/style prefix.
    pub fn synthesize_cloned(
        &self,
        reference_pcm: &[f32],
        reference_rate: u32,
        text: &str,
        instruction: &str,
        max_steps: i32,
    ) -> Result<(Vec<f32>, u32), String> {
        self.ensure()?;
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let synth = guard.as_ref().ok_or("voxcpm2 engine not initialized")?;
        synth.set_instruction(instruction);
        unsafe { sc_voxcpm2_set_min_steps_before_stop(synth.handle, 32) };
        unsafe { sc_voxcpm2_set_max_steps(synth.handle, max_steps as c_int) };
        synth.set_reference(reference_pcm, reference_rate as i32)?;
        let audio = synth.synthesize(text)?;
        if audio.is_empty() {
            return Err("synthesis produced no audio".into());
        }
        Ok((audio, synth.output_sample_rate()))
    }
}

// ---------- model bundle resolution ----------

const DEFAULT_REPO: &str = "soniqo/VoxCPM2-LiteRT-INT8";
const BUNDLE_FILES: &[&str] = &[
    "voxcpm2-text-prefill.tflite",
    "voxcpm2-token-step.tflite",
    "voxcpm2-audio-encoder.tflite",
    "voxcpm2-audio-decoder.tflite",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "generation_config.json",
    "config.json",
];

fn cache_dir() -> PathBuf {
    // XDG-ish: $XDG_CACHE_HOME or ~/.cache on Linux; %LOCALAPPDATA% on Windows.
    if let Ok(x) = std::env::var("XDG_CACHE_HOME") {
        if !x.is_empty() {
            return PathBuf::from(x).join("soniqo").join("voxcpm2-litert");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("soniqo").join("voxcpm2-litert");
            }
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cache").join("soniqo").join("voxcpm2-litert")
}

/// Resolve the bundle directory, downloading it on first use if needed.
fn resolve_bundle_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("SONIQO_VOXCPM2_BUNDLE") {
        if !dir.is_empty() {
            let p = PathBuf::from(dir);
            if bundle_complete(&p) {
                return Ok(p);
            }
            return Err(format!(
                "SONIQO_VOXCPM2_BUNDLE={} is missing required files",
                p.display()
            ));
        }
    }
    let dir = cache_dir();
    if bundle_complete(&dir) {
        return Ok(dir);
    }
    download_bundle(&dir)?;
    if !bundle_complete(&dir) {
        return Err(format!(
            "bundle download to {} left required files missing",
            dir.display()
        ));
    }
    Ok(dir)
}

fn bundle_complete(dir: &Path) -> bool {
    // The .tflite graphs + tokenizer are mandatory; the small aux JSONs are
    // optional for loading, so only gate on the load-critical files.
    let required = [
        "voxcpm2-text-prefill.tflite",
        "voxcpm2-token-step.tflite",
        "voxcpm2-audio-encoder.tflite",
        "voxcpm2-audio-decoder.tflite",
        "tokenizer.json",
    ];
    required.iter().all(|f| {
        let p = dir.join(f);
        std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
    })
}

fn download_bundle(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let repo = std::env::var("SONIQO_VOXCPM2_REPO").unwrap_or_else(|_| DEFAULT_REPO.into());
    let base = format!("https://huggingface.co/{}/resolve/main", repo);
    eprintln!(
        "[voxcpm2] downloading LiteRT bundle {} → {} (first run, ~4 GB)",
        repo,
        dir.display()
    );
    for file in BUNDLE_FILES {
        let dest = dir.join(file);
        if std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        let url = format!("{}/{}", base, file);
        eprintln!("[voxcpm2]   fetch {}", file);
        let status = std::process::Command::new("curl")
            .args(["-fL", "--retry", "3", "-o"])
            .arg(&dest)
            .arg(&url)
            .status()
            .map_err(|e| format!("spawn curl failed (is curl installed?): {}", e))?;
        if !status.success() {
            let _ = std::fs::remove_file(&dest);
            // Aux JSONs may legitimately 404 on some bundles; only fail on the
            // load-critical files.
            let critical = file.ends_with(".tflite") || *file == "tokenizer.json";
            if critical {
                return Err(format!("download {} failed ({})", file, status));
            }
        }
    }
    Ok(())
}
