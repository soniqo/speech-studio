# Speech Studio

> A [Soniqo](https://soniqo.audio) project.

Open-source desktop app for content creators. Clone a voice from a short reference clip, write a script line by line, and synthesize the whole thing in that voice — with inline emotion markers for tone.

> **Status:** v0 — audio-only MVP. Works on macOS 15+ on Apple Silicon. Video playback against the timeline and an audio-over-video export step are on the roadmap. Linux and Windows are also planned once an on-device controllable TTS lands in `speech-core`.

## What it does

1. **Drop a short reference clip** of a speaker → register a cloned voice. Repeat for as many speakers as you need.
2. **Write a script line per clip** and pick which speaker says it. Wrap the line in an emotion marker — `(whispering) Just stay quiet for a moment, please.` — and the synth will follow that direction.
3. **Hit Synthesize** to render every line in the assigned cloned voice. The synth pipeline auto-grades each take with on-device ASR and retries with a different seed if the line came out wrong.
4. **Play the script** to hear the whole scene back-to-back. Export a single WAV mix (export wiring is in progress).

The clone is local. The synth is local. No audio leaves your machine.

## Stack

- **Tauri 2** shell (Rust + WKWebView) so the shipped app is a small native binary, not a Chromium fork.
- **React + Vite** frontend for the timeline, voice library, and script editor.
- **Swift sidecar** (`swift-sidecar/`) holds the speech engines warm in a single process. Tauri spawns it once and talks NDJSON over stdin/stdout, so per-line synthesis is sub-second after the first warm-up.
- **VoxCPM2** is the default speech engine (via [`speech-swift`](https://github.com/soniqo/speech-swift)). CosyVoice3 and Qwen3-TTS are kept as fallbacks behind `SONIQO_TTS_ENGINE=cosyvoice` / `qwen3`.

## Emotion markers

Wrap a line in a parenthetical tag to steer the prosody:

```
(soft) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

Supported tags include `soft`, `warm`, `whispering`, `intense`, `excited`, `happy`, `calm`, `serious`, `surprised`, `sad`, `angry`, `dramatic`, `laughs`. Each maps to a short natural-language style instruction that's passed to the model; custom tags (e.g. `(slow and dreamy)`) pass through verbatim.

## Quick start

### Prerequisites

- macOS 15+ on Apple Silicon (M1/M2/M3/M4)
- Xcode 26+ (Swift 6.0 toolchain)
- Rust 1.95+ via `rustup` (`. "$HOME/.cargo/env"` if `cargo` isn't on `PATH`)
- Node 20+ and `pnpm` 11+

### Install + run (dev)

```bash
pnpm install                          # installs the frontend + Tauri CLI
cd swift-sidecar && swift build       # builds the sidecar
cd .. && pnpm tauri dev               # launches the app, hot-reloads the UI
```

First run downloads ~1.5 GB of model weights from Hugging Face into `~/.cache/huggingface/hub/`. Subsequent runs reuse the cache.

### Try the demo

Hit **Load demo** in the top bar. It bootstraps a Scene 04 storyboard with two cloned voices (Anna and Marek) and four lines of dialogue — one with each emotion marker — then synthesizes everything via VoxCPM2.

### Release build

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

## Sibling repos

- [`speech-swift`](https://github.com/soniqo/speech-swift) — Apple Silicon speech engines (VoxCPM2, CosyVoice3, Qwen3-TTS, Parakeet, Silero VAD).
- [`speech-core`](https://github.com/soniqo/speech-core) — C++ engines (STT, VAD, denoise) targeted for Linux/Windows.

## Contributing

See `AGENTS.md` for project conventions. Short version: branch → PR → merge, no force-pushes, no AI co-author trailers, never commit unless explicitly asked.

## Licence

TBD — placeholder while v0 stabilises.
