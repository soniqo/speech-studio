//! Format-aware, non-truncating offline mixer for Speech Studio.
//!
//! WAV is written natively; FFmpeg is only needed for compressed formats and
//! decoding non-PCM audio tracks. No shell is invoked for file paths.
use super::{read_wav_pcm_mono, write_wav_pcm16_mono, ExportArgs, ExportResult};
use std::path::{Path, PathBuf};
use std::process::Command;

const MIX_RATE: u32 = 48_000;

struct TemporaryWav(PathBuf);

impl TemporaryWav {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "speech-studio-{}.wav",
            uuid::Uuid::new_v4().simple()
        )))
    }
}

impl Drop for TemporaryWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn ffmpeg_executable() -> Result<String, String> {
    for name in ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if let Ok(output) = Command::new(name).arg("-version").output() {
            if output.status.success() {
                return Ok(name.to_string());
            }
        }
    }
    Err("FFmpeg is required for this format. Install it (brew install ffmpeg) and restart Speech Studio.".into())
}

fn ffmpeg_run(executable: &str, args: &[&str], input: &Path, output: &Path) -> Result<(), String> {
    let result = Command::new(executable)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(input)
        .args(args)
        .arg(output)
        .output()
        .map_err(|e| format!("could not run FFmpeg: {e}"))?;
    if !result.status.success() {
        let diagnostic = String::from_utf8_lossy(&result.stderr);
        return Err(format!("FFmpeg conversion failed: {}", diagnostic.trim()));
    }
    Ok(())
}

fn read_audio(path: &Path) -> Result<(u32, Vec<f32>), String> {
    // Sidecars produce canonical mono 16-bit PCM WAV. Those need no decoder.
    if path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("wav")) {
        if let Ok((rate, _, audio)) = read_wav_pcm_mono(path) {
            if rate > 0 { return Ok((rate, audio)); }
        }
    }

    // Imported audio tracks may be MP3, M4A, FLAC, etc.
    let ffmpeg = ffmpeg_executable()?;
    let tmp = TemporaryWav::new();
    ffmpeg_run(&ffmpeg, &["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"], path, &tmp.0)?;
    let (rate, _, samples) = read_wav_pcm_mono(&tmp.0)?;
    if rate == 0 { return Err("decoded audio has invalid sample rate".into()); }
    Ok((rate, samples))
}

fn frames_for_rate(source_frames: usize, source_rate: u32, target_rate: u32) -> Result<usize, String> {
    if source_rate == 0 || target_rate == 0 {
        return Err("invalid sample rate".into());
    }
    let length = source_frames as f64 * target_rate as f64 / source_rate as f64;
    if !length.is_finite() || length > usize::MAX as f64 {
        return Err("audio duration is too large".into());
    }
    Ok(length.ceil() as usize)
}

fn format_extension(path: &Path) -> Result<&'static str, String> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "wav" => Ok("wav"),
        "mp3" => Ok("mp3"),
        "ogg" => Ok("ogg"),
        "opus" => Ok("opus"),
        "flac" => Ok("flac"),
        "m4a" => Ok("m4a"),
        "aif" | "aiff" => Ok("aiff"),
        _ => Err(format!("unsupported audio export format: .{ext}; use wav, mp3, ogg, opus, flac, m4a, or aiff")),
    }
}

fn encode_mix(path: &Path, rate: u32, samples: &[f32]) -> Result<(), String> {
    let format = format_extension(path)?;
    if format == "wav" {
        return write_wav_pcm16_mono(path, rate, samples);
    }

    let ffmpeg = ffmpeg_executable()?;
    let tmp = TemporaryWav::new();
    write_wav_pcm16_mono(&tmp.0, rate, samples)?;
    let flags: &[&str] = match format {
        "mp3" => &["-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        "ogg" => &["-map", "0:a:0", "-vn", "-c:a", "libvorbis", "-q:a", "5"],
        "opus" => &["-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", "160k"],
        "flac" => &["-map", "0:a:0", "-vn", "-c:a", "flac", "-compression_level", "5"],
        "m4a" => &["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k"],
        "aiff" => &["-map", "0:a:0", "-vn", "-c:a", "pcm_s16be"],
        _ => unreachable!(),
    };
    ffmpeg_run(&ffmpeg, flags, &tmp.0, path)
}

pub(super) fn write_export(args: &ExportArgs) -> Result<ExportResult, String> {
    if args.clips.is_empty() {
        return Err("no audible clips to export".into());
    }
    if !args.duration_sec.is_finite() || args.duration_sec < 0.0 {
        return Err("invalid project duration".into());
    }
    let output = Path::new(&args.out_path);
    format_extension(output)?;

    // No timeline-duration truncation: the actual decoded audio length wins.
    // The legacy 30-second project canvas is not a render/export limit.
    let mut rendered = Vec::with_capacity(args.clips.len());
    let mut actual_end = args.duration_sec;
    for clip in &args.clips {
        if !clip.start_sec.is_finite() || clip.start_sec < 0.0 || !clip.gain_db.is_finite() {
            return Err("invalid audio clip timing or gain".into());
        }
        let (rate, samples) = read_audio(Path::new(&clip.audio_path))?;
        let out_frames = frames_for_rate(samples.len(), rate, MIX_RATE)?;
        let end = clip.start_sec + out_frames as f64 / MIX_RATE as f64;
        actual_end = actual_end.max(end);
        rendered.push((clip.start_sec, clip.gain_db, rate, samples, out_frames));
    }

    let total_frames = (actual_end * MIX_RATE as f64).ceil();
    // Standard RIFF/PCM WAV is limited to just under 4GiB.
    if !total_frames.is_finite() || total_frames < 0.0 || total_frames > ((u32::MAX as f64 - 36.0) / 2.0) {
        return Err("mix exceeds the 4 GiB WAV intermediate limit".into());
    }
    let mut mix: Vec<f32> = vec![0.0; total_frames as usize];
    for (start_sec, gain_db, rate, samples, length) in rendered {
        let start = (start_sec * MIX_RATE as f64).round() as usize;
        let gain = 10.0f32.powf(gain_db / 20.0);
        if samples.is_empty() { continue; }
        for dest_idx in 0..length {
            let frame = start + dest_idx;
            if frame >= mix.len() { break; }
            let source_pos = dest_idx as f64 * rate as f64 / MIX_RATE as f64;
            let lower = (source_pos.floor() as usize).min(samples.len() - 1);
            let upper = (lower + 1).min(samples.len() - 1);
            let fraction = (source_pos - lower as f64) as f32;
            let sample = samples[lower] * (1.0 - fraction) + samples[upper] * fraction;
            mix[frame] += sample * gain;
        }
    }
    for sample in &mut mix { *sample = sample.clamp(-1.0, 1.0); }
    encode_mix(output, MIX_RATE, &mix)?;
    super::log_line(super::LogSource::Studio, format!(
        "[export] wrote {} ({} frames @ {} Hz from {} clips, format {})",
        args.out_path,
        mix.len(),
        MIX_RATE,
        args.clips.len(),
        format_extension(output)?,
    ));
    Ok(ExportResult {
        out_path: args.out_path.clone(),
        sample_rate: MIX_RATE,
        duration_sec: mix.len() as f64 / MIX_RATE as f64,
        clip_count: args.clips.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codecs_cover_all_ui_options() {
        for ext in ["wav", "mp3", "ogg", "opus", "flac", "m4a", "aiff", "aif"] {
            assert!(format_extension(Path::new(&format!("test.{ext}"))).is_ok());
        }
        assert!(format_extension(Path::new("test.wma")).is_err());
    }

    #[test]
    fn resampling_preserves_duration() {
        assert_eq!(frames_for_rate(24_000 * 42, 24_000, MIX_RATE).unwrap(), 48_000 * 42);
        assert_eq!(frames_for_rate(48_000 * 65, 48_000, MIX_RATE).unwrap(), 48_000 * 65);
    }

    #[test]
    fn wav_export_is_not_truncated_at_thirty_seconds() {
        let source = TemporaryWav::new();
        let output = TemporaryWav::new();
        let waveform = vec![0.08f32; 16_000 * 36];
        write_wav_pcm16_mono(&source.0, 16_000, &waveform).unwrap();
        let args = ExportArgs {
            out_path: output.0.to_string_lossy().into_owned(),
            duration_sec: 30.0,
            clips: vec![super::super::ExportClip {
                start_sec: 0.0,
                audio_path: source.0.to_string_lossy().into_owned(),
                gain_db: 0.0,
            }],
        };
        let result = write_export(&args).unwrap();
        assert!(result.duration_sec >= 36.0);
        assert!(read_wav_pcm_mono(&output.0).unwrap().2.len() >= 48_000 * 36);
    }
}
