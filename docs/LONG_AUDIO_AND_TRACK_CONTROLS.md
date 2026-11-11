# Speech Studio: long synthesis, audio formats, and track monitoring

Apply the combined v2 patch once to the `soniqo/speech-studio` repository. It
includes the earlier voice-comparison changes and this set of playback/export
fixes.

- The initial 30-second canvas is no longer used as a hard duration limit, and
  the canvas is no longer a fixed 30 s backdrop either: project length is
  derived from the clips on load and after every structural edit, so a 10 s
  recording draws a 10 s track instead of 10 s of sound on a 30 s track.
  Loading an older project recomputes its length from its clips, which drops
  the stale 30 s canvas. An explicit length typed into the Inspector is kept
  in `canvasSec` and extends the canvas; clips running past it still expand it.
  A successful long render expands its clip and project duration automatically.
  The export mixer always includes complete decoded audio, even if older saved
  projects have a stale 30-second duration. The *model itself* can still fail
  or stop generating a sentence early; chunking reduces but does not eliminate
  those model-specific limitations.
- Output formats (TopBar format selector): WAV (native, no FFmpeg); MP3, OGG/Vorbis, Opus, FLAC,
  M4A/AAC, AIFF (FFmpeg). On macOS, `brew install ffmpeg` is required for
  compressed exports and for decoding imported non-PCM audio. Restart the app
  if installed while Speech Studio was running. The backend checks the chosen
  file extension and errors on unsupported extensions, never writes WAV data
  into a misleading MP3/OGG filename.
- Per-track Mute and Solo are saved in project JSON. Solo wins over automatic
  selection; Mute always silences a track. Clicking a speaker or its clip
  previews just that track. Clicking **All tracks** in Transport clears the
  temporary selection so all unmuted tracks can play together. Export ignores
  temporary selection but applies explicit Mute/Solo. Imported audio tracks
  are also included in playback and export, with their configured gain.
- The renderer normalizes mixed sample rates to 48 kHz before combining them.
  The current mixer holds PCM in memory and creates a temporary WAV for
  FFmpeg. Very long projects are bounded by the standard WAV/Riff ~4 GiB
  intermediate limit; no arbitrary 30-second cut-off remains.

Verification: run `pnpm test`, `pnpm build`, and `cargo test --manifest-path
src-tauri/Cargo.toml` on a prepared macOS development machine. Check a >60 s
synthesized clip, Mute/Solo changes while playing, a 60+ s export, WAV/OGG/MP3
roundtrips, mixed Qwen3 (24 kHz) and VoxCPM2 (48 kHz) clips, and reopened
projects with saved Mute/Solo state. Actual Swift/MLX inference needs Apple
Silicon and installed model weights; it is not tested by this patch alone.
