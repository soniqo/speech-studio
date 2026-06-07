# Speech Studio

> A [Soniqo](https://soniqo.audio) project.

Open-source desktop app for content creators. Clone a voice from a short reference clip, write a script line by line, and synthesize the whole thing in that voice — with inline emotion markers for tone.

## 30-second demo

A blind A/B/C — a real voice, the same voice cloned locally by Speech Studio on a MacBook, and the same voice cloned by ElevenLabs in the cloud. Can you tell which is which?

[![Speech Studio — open-source voice cloning on a MacBook](https://i.ytimg.com/vi/EuIU8tOWyzg/maxresdefault.jpg)](https://www.youtube.com/watch?v=EuIU8tOWyzg)

[Watch on YouTube →](https://youtu.be/EuIU8tOWyzg) (30 sec)

> **Status:** v0 — audio-only MVP. Runs on macOS 15+ (Apple Silicon) and Windows / Linux (x86_64): macOS clones via MLX, Windows/Linux via `speech-core`'s on-device LiteRT backend. Video playback against the timeline and an audio-over-video export step are on the roadmap.

## What it does

1. **Drop a short reference clip** of a speaker → register a cloned voice. Repeat for as many speakers as you need.
2. **Write a script line per clip** and pick which speaker says it. Wrap the line in an emotion marker — `(whispering) Just stay quiet for a moment, please.` — and the synth will follow that direction.
3. **Hit Synthesize** to render every line in the assigned cloned voice. The synth pipeline auto-grades each take with on-device ASR and retries with a different seed if the line came out wrong.
4. **Play the script** to hear the whole scene back-to-back. Export a single WAV mix (export wiring is in progress).

The clone is local. The synth is local. No audio leaves your machine.

## Stack

- **Tauri 2** shell (Rust + the OS-native WebView) so the shipped app is a small native binary, not a Chromium fork.
- **React + Vite** frontend for the timeline, voice library, and script editor.
- **A warm sidecar process** holds the speech engine resident so per-line synthesis is fast after the first warm-up. Tauri spawns it once and talks NDJSON over stdin/stdout. On macOS this is the **Swift sidecar** (`swift-sidecar/`, MLX); on Windows/Linux the **C++ sidecar** (`core-sidecar/`, LiteRT).
- **VoxCPM2** is the speech engine on every platform — via [`speech-swift`](https://github.com/soniqo/speech-swift) (MLX) on macOS and [`speech-core`](https://github.com/soniqo/speech-core) (LiteRT) on Windows/Linux. On macOS, CosyVoice3 and Qwen3-TTS are kept as fallbacks behind `SONIQO_TTS_ENGINE=cosyvoice` / `qwen3`.

## Emotion markers

Wrap a line in a parenthetical tag to steer the prosody:

```
(dramatic) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

Supported tags include `soft`, `warm`, `whispering`, `intense`, `excited`, `happy`, `calm`, `serious`, `surprised`, `sad`, `angry`, `dramatic`, `laughs`. Each maps to a short natural-language style instruction that's passed to the model; custom tags (e.g. `(slow and dreamy)`) pass through verbatim.

## Download

Grab the latest build from the [**releases page**](https://github.com/soniqo/speech-studio/releases/latest):

| Platform | Artifact | Status |
|---|---|---|
| **macOS** (Apple Silicon) | [`.dmg`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |
| **Windows** (x86_64) | [`.msi` / `.exe`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |
| **Linux** (x86_64) | [`.deb` / `.AppImage`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |

Every platform **downloads its speech model on first run** (resumable) and caches it, so the installers stay small:

- **macOS** — `.dmg` (~46 MB); drag into `/Applications`. First run pulls ~2.75 GB of MLX weights into `~/.cache/huggingface/hub/`.
- **Windows** — `.msi` or the NSIS `-setup.exe`. First run pulls the ~4.6 GB VoxCPM2-LiteRT bundle into `%LOCALAPPDATA%\speech-core`.
- **Linux** — `.deb` or `.AppImage`. First run pulls the same bundle into `~/.cache/speech-core`.

The builds are **unsigned**: Windows SmartScreen needs *More info → Run anyway*, and macOS needs a right-click → *Open* the first time to bypass Gatekeeper.

## Build from source

### Prerequisites

Common: Rust 1.95+ via `rustup` (`. "$HOME/.cargo/env"` if `cargo` isn't on `PATH`), Node 20+ and `pnpm` 11+.

- **macOS:** 15+ on Apple Silicon (M1/M2/M3/M4), Xcode 26+ (Swift 6.0 toolchain).
- **Windows / Linux (x86_64):** a C++17 toolchain + CMake 3.16+, and a built [`speech-core`](https://github.com/soniqo/speech-core) checkout with the LiteRT backend (`-DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=...`) plus the `VoxCPM2-LiteRT` model bundle.

### Dev loop — macOS

```bash
pnpm install                          # installs the frontend + Tauri CLI
cd swift-sidecar && swift build       # builds the Swift sidecar
cd .. && pnpm tauri dev               # launches the app, hot-reloads the UI
```

Same ~2.75 GB model download on first synth.

### Dev loop — Windows / Linux

```bash
pnpm install
# Build the C++ sidecar against your speech-core checkout (defaults to ../speech-core):
cmake -B core-sidecar/build core-sidecar -DSPEECH_CORE_DIR=../speech-core
cmake --build core-sidecar/build --config Release
# Point it at the VoxCPM2-LiteRT bundle, then launch:
export SONIQO_VOXCPM2_BUNDLE_DIR=/path/to/speech-core/scripts/models-voxcpm2
pnpm tauri dev
```

### Memory footprint

Measured through the 4-line demo on an Apple Silicon Mac (M-series, unified memory). Numbers are MLX's own accounting; OS RSS adds ~500 MB of process overhead on top.

| Variant | Disk | Active | Peak | Default |
|---|---|---|---|---|
| `aufklarer/VoxCPM2-MLX-int8`  | 2.75 GB | 3.1 GB | **5.4 GB** | ✅ |
| `aufklarer/VoxCPM2-MLX-bf16`  | 4.6 GB  | 9.1 GB | 11.4 GB | |
| `aufklarer/VoxCPM2-MLX-int4`  | 1.75 GB | (not benchmarked) | | |

The MLX buffer cache is capped at 1 GB (`SONIQO_MLX_CACHE_MB` to override) — without that cap, peak grows to tens of GB on long sessions as varying-shape buffers accumulate. Override the default model with `SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-bf16` if you want the higher-fidelity weights.

### Try the demo

Hit **Load demo** in the top bar. It bootstraps a Scene 04 storyboard with two cloned voices (Anna and Marek) and four lines of dialogue — one with each emotion marker — then synthesizes everything via VoxCPM2.

### Packaging your own .app / .dmg

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

## Sibling repos

- [`speech-swift`](https://github.com/soniqo/speech-swift) — Apple Silicon speech engines (VoxCPM2, CosyVoice3, Qwen3-TTS, Parakeet, Silero VAD).
- [`speech-core`](https://github.com/soniqo/speech-core) — C++ engines (VoxCPM2 cloning on Windows/Linux, plus STT, VAD, denoise).

## Contributing

See `AGENTS.md` for project conventions. Short version: branch → PR → merge, no force-pushes, no AI co-author trailers, never commit unless explicitly asked.

## Licence

[Apache License 2.0](LICENSE) — same as [speech-swift](https://github.com/soniqo/speech-swift) and [speech-core](https://github.com/soniqo/speech-core).
