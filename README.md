# Speech Studio

> A [Soniqo](https://soniqo.audio) project.

Open-source desktop app for content creators. Clone a voice from a short reference clip, write a script line by line, and synthesize the whole thing in that voice — with inline emotion markers for tone.

> **Status:** v0 — audio-only MVP. macOS 15+ on Apple Silicon is the primary, fully-exercised target. Linux and Windows now build too: where there's no MLX, synthesis runs through [`speech-core`](https://github.com/soniqo/speech-core)'s LiteRT VoxCPM2 engine over a C ABI instead of the Swift/MLX sidecar (compile + link verified in CI and in a local Linux container; on-device runtime is wired but not yet hardware-validated). Video playback against the timeline and an audio-over-video export step are on the roadmap.

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
- **VoxCPM2** is the default speech engine (via [`speech-swift`](https://github.com/soniqo/speech-swift)) on macOS. CosyVoice3 and Qwen3-TTS are kept as fallbacks behind `SONIQO_TTS_ENGINE=cosyvoice` / `qwen3`.
- **Cross-platform backend** — on Linux and Windows there's no MLX, so synthesis links [`speech-core`](https://github.com/soniqo/speech-core)'s LiteRT VoxCPM2 engine directly over its `sc_voxcpm2_*` C ABI (FFI in `src-tauri/src/voxcpm2.rs`, build/link wiring in `src-tauri/build.rs`). Same voice-cloning recipe, no Swift sidecar.

## Emotion markers

Wrap a line in a parenthetical tag to steer the prosody:

```
(dramatic) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

Supported tags include `soft`, `warm`, `whispering`, `intense`, `excited`, `happy`, `calm`, `serious`, `surprised`, `sad`, `angry`, `dramatic`, `laughs`. Each maps to a short natural-language style instruction that's passed to the model; custom tags (e.g. `(slow and dreamy)`) pass through verbatim.

## Quick start

### Prerequisites (macOS)

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

First run downloads ~2.75 GB of model weights from Hugging Face into `~/.cache/huggingface/hub/`. Subsequent runs reuse the cache.

### Linux / Windows

These platforms skip the Swift sidecar and link `speech-core`'s LiteRT VoxCPM2 engine over FFI, so the build needs the `speech-core` source as a sibling checkout plus a copy of the `libLiteRt` runtime.

**Prerequisites**

- Rust 1.95+ and Node 20+ / `pnpm` 11+ (as above)
- A C++ toolchain and CMake 3.28+
- Python 3.10+ (only used to fetch the `libLiteRt` runtime wheel)
- [`speech-core`](https://github.com/soniqo/speech-core) checked out next to this repo (`../speech-core`)
- Linux: the usual Tauri deps — `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev build-essential pkg-config`
- Windows: the MSVC build tools (run from a Developer Command Prompt, or use `ilammy/msvc-dev-cmd` in CI)

**Build**

```bash
# 1. One-off: fetch the libLiteRt runtime into speech-core.
cd ../speech-core && ./scripts/fetch_litert.sh "$PWD/litert" && cd -

# 2. Build the shell. SPEECH_CORE_DIR defaults to ../../speech-core (sibling
#    layout); LITERT_DIR is required and points at the fetched runtime.
SPEECH_CORE_DIR=../speech-core \
LITERT_DIR=../speech-core/litert \
  pnpm tauri build --no-bundle
```

On first synthesis the ~4 GB LiteRT model bundle (`soniqo/VoxCPM2-LiteRT-INT8`) is downloaded to the user cache (`$XDG_CACHE_HOME/soniqo/voxcpm2-litert` on Linux, `%LOCALAPPDATA%\soniqo\voxcpm2-litert` on Windows). Set `SONIQO_VOXCPM2_BUNDLE` to point at a local copy instead.

> Both lanes run in CI (`.github/workflows/build.yml`), and the Linux build also reproduces locally in an Ubuntu container. They currently verify that the FFI backend **compiles and links** — end-to-end cloning on Linux/Windows hardware is the next validation step.

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

### Release build

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

## Sibling repos

- [`speech-swift`](https://github.com/soniqo/speech-swift) — Apple Silicon speech engines (VoxCPM2, CosyVoice3, Qwen3-TTS, Parakeet, Silero VAD).
- [`speech-core`](https://github.com/soniqo/speech-core) — C++ engines (STT, VAD, denoise) plus the LiteRT VoxCPM2 synthesis backend that powers voice cloning on Linux/Windows.

## Contributing

See `AGENTS.md` for project conventions. Short version: branch → PR → merge, no force-pushes, no AI co-author trailers, never commit unless explicitly asked.

## Licence

[Apache License 2.0](LICENSE) — same as [speech-swift](https://github.com/soniqo/speech-swift) and [speech-core](https://github.com/soniqo/speech-core).
