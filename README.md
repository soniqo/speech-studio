# Speech Studio

**English** · [简体中文](README.zh-CN.md)

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
- **VoxCPM2** is the default engine on every platform — via [`speech-swift`](https://github.com/soniqo/speech-swift) (MLX) on macOS and [`speech-core`](https://github.com/soniqo/speech-core) (LiteRT) on Windows/Linux. On macOS you can switch engines from the toolbar: **CosyVoice3**, **Qwen3-TTS**, **Chatterbox** (multilingual cloning across 23 languages), **OmniVoice** (600+ language cloning), **Indic-Mio** (Hindi/Indic emotion tags), and **Fish Audio S2 Pro** (experimental clone + bracket markers). Those MLX engines are macOS-only; Windows/Linux runs VoxCPM2.

## Engines

Switch engine from the toolbar dropdown (macOS only — Windows/Linux always use VoxCPM2, so the dropdown doesn't appear).

| Engine | Platforms | Backend | Voice cloning | Emotion markers | Languages |
|---|---|---|:---:|---|:---:|
| **VoxCPM2** · default | macOS · Windows · Linux | MLX / LiteRT | ✅ | style instructions | 30 |
| **CosyVoice 3** | macOS only | MLX | ✅ | style instructions | 9 |
| **Qwen3-TTS** | macOS only | MLX | ✅ (ICL) | — | 10 |
| **Chatterbox** | macOS only | MLX | ✅ | intensity only¹ | 23 |
| **OmniVoice** | macOS only | MLX | ✅ | restricted instruct² | 600+ |
| **Indic-Mio** | macOS only | MLX | ✅³ | suffix tags | Indic |
| **Fish Audio S2 Pro** | macOS only | MLX | ✅⁴ | bracket tags | 80+ |

The MLX engines (CosyVoice 3, Qwen3-TTS, Chatterbox, OmniVoice, Indic-Mio, Fish Audio S2 Pro) are **macOS-only**; Windows/Linux run VoxCPM2 through speech-core's LiteRT backend.

¹ Chatterbox has no free-text style input — emotion markers map to an expressiveness/intensity level (more vs. less expressive), not a specific emotion.

² OmniVoice supports broad voice-design attributes such as accent, age, gender, pitch, and whisper. Studio only passes valid `instruct` vocabulary items: `whisper` maps directly, while emotion markers map to pitch hints (`high pitch`, `low pitch`, etc.). Strong emotions are approximations, not true emotional acting.

³ Indic-Mio is exposed as an experimental Hindi/Indic emotion-marker engine. It uses suffix tags such as `<happy>` / `<angry>` and clones from reference audio through WavLM → MioCodec global speaker embeddings. It does not need a reference transcript.

⁴ Fish Audio S2 Pro uses bracket markers such as `[excited]`, `[angry]`, and `[whisper]`. It needs an accurate reference transcript for cloning, and the public weights are research/non-commercial unless separately licensed.

## Emotion markers

Wrap a line in a parenthetical tag to steer the prosody:

```
(dramatic) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

Supported tags include `soft`, `warm`, `whispering`, `intense`, `excited`, `happy`, `calm`, `serious`, `surprised`, `sad`, `angry`, `dramatic`, `laughs`.

How a marker is applied depends on the engine: **VoxCPM2** and **CosyVoice 3** turn it into a short natural-language style instruction (custom tags like `(slow and dreamy)` pass through verbatim); **OmniVoice** maps only known markers to its fixed `instruct` vocabulary (`whisper` or pitch hints) and drops anything unmappable; **Chatterbox** maps markers to an expressiveness/intensity level (it has no per-emotion control, only more vs. less expressive); **Indic-Mio** appends supported suffix tags like `<happy>`; **Fish Audio S2 Pro** appends bracket tags like `[excited]`; **Qwen3-TTS** ignores markers (they're stripped from the text).

## Research note: strong Hindi emotion cloning

Current open-source/on-device candidates for Hindi voice cloning with stronger emotion control:

- **VoxCPM2** remains the best product-fit baseline for Speech Studio: Apache-2.0, on-device, supports Hindi, and supports controllable voice cloning through natural-language style guidance. It still needs a Hindi emotion bake-off against the models below before we claim strong acting range.
- **Fish Audio S2 Pro** looks strongest for expressive control: 80+ languages, short-reference voice cloning, and inline free-form emotion/prosody tags such as `[angry]`, `[sad]`, `[whisper]`, and `[shouting]`. It is now available as an experimental macOS engine, but its public model license is research/non-commercial unless separately licensed, so it remains outside the default path.
- **Svara-TTS v1** is the most relevant Indic-specific open model: Apache-2.0, 19 Indian languages, tags such as `<happy>`, `<sad>`, `<anger>`, and `<fear>`, plus zero-shot adaptation paths. Exact speaker similarity is less proven than VoxCPM2/Fish, but it is a good candidate for Hindi emotion fine-tuning.
- **Chatterbox Multilingual Hindi** is the permissive small fallback: MIT, a dedicated Hindi checkpoint, and zero-shot voice cloning. Its control is mainly exaggeration/intensity rather than explicit angry/sad/crying-style acting.
- **OmniVoice** is best kept for broad language coverage. Its instruction space is fixed to voice-design attributes, so Studio treats whisper as real control and maps other markers only to pitch.

Useful references: [VoxCPM2](https://github.com/OpenBMB/VoxCPM), [Fish Audio S2 Pro](https://huggingface.co/fishaudio/s2-pro), [Svara-TTS v1](https://huggingface.co/kenpath/svara-tts-v1), [Chatterbox Hindi](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-hi), [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice).

## Download

Grab the latest build from the [**releases page**](https://github.com/soniqo/speech-studio/releases/latest):

| Platform | Artifact | Status |
|---|---|---|
| **macOS** (Apple Silicon) | [`.dmg`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |
| **Windows** (x86_64) | [`.msi` / `.exe`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |
| **Linux** (x86_64) | [`.deb` / `.AppImage`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Published |

Every platform **downloads its speech model on first run** and caches it, so the installers stay small:

- **macOS** — `.dmg` (~46 MB); drag into `/Applications`. First run pulls ~2.75 GB of MLX weights into `~/Library/Caches/qwen3-speech/`.
- **Windows** — `.msi` or the NSIS `-setup.exe`. First run pulls the ~8.8 GB VoxCPM2-LiteRT bundle into `%LOCALAPPDATA%\speech-core`.
- **Linux** — `.deb` or `.AppImage`. First run pulls the same bundle into `~/.cache/speech-core`.

The Windows/Linux LiteRT bundle is fp16 and needs **~10 GiB of free RAM** to load — an 8 GB machine may fall short.

The **macOS build is signed and notarized** (from v0.0.5 on) — it opens like any other app, no Gatekeeper hoops. The Windows installers are still unsigned: SmartScreen needs *More info → Run anyway*.

### Manual model download (macOS)

If the in-app download keeps failing on a flaky or slow network (`Download stalled for …: no progress` / `Failed to download …`), fetch the model yourself and place it where the app looks. Two pieces: the model weights and a small set of tokenizer files.

**Option A — `hf` CLI (recommended: it resumes interrupted downloads):**

```bash
pip install -U huggingface_hub

hf download aufklarer/VoxCPM2-MLX-int8 \
  --local-dir ~/Library/Caches/qwen3-speech/models/aufklarer/VoxCPM2-MLX-int8

hf download openbmb/VoxCPM2 \
  config.json tokenizer.json tokenizer_config.json \
  tokenization_voxcpm2.py special_tokens_map.json \
  --local-dir ~/Library/Caches/qwen3-speech-voxcpm2-tokenizer/models/openbmb/VoxCPM2
```

**Option B — browser:** download the files from [aufklarer/VoxCPM2-MLX-int8](https://huggingface.co/aufklarer/VoxCPM2-MLX-int8/tree/main) and [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2/tree/main) into the same two directories. Minimum set: the model directory needs `config.json` plus every `*.safetensors` file; the tokenizer directory needs the five files listed in the command above.

The app detects the files on the next launch and skips the download entirely. If you overrode `SONIQO_VOXCPM2_MODEL_ID`, substitute that repo id in the model path. Source builds launched from a terminal can also extend the in-app stall patience with `HF_DOWNLOAD_STALL_TIMEOUT=<seconds>`.

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

Same ~2.75 GB model download on first synth (into `~/Library/Caches/qwen3-speech/` — see [Manual model download](#manual-model-download-macos) if your network keeps dropping it).

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

Measured on an Apple Silicon Mac (M-series, unified memory). The **resident** column is the real process footprint (Activity Monitor's "Memory" — `vmmap` physical footprint), which is the figure to check against your RAM. **MLX active/peak** is MLX's own accounting (peak is over a multi-line session). Note: plain `ps rss` under-reports by ~3× on Apple Silicon — Metal unified-memory buffers don't count as RSS, so use the resident figures below.

The default **VoxCPM2** engine:

| Variant | Disk | MLX active | MLX peak | Resident (real) | Default |
|---|---|---|---|---|---|
| `aufklarer/VoxCPM2-MLX-int8`  | 2.75 GB | 3.1 GB | 5.4 GB | **~4–5 GB** | ✅ |
| `aufklarer/VoxCPM2-MLX-bf16`  | 4.6 GB  | 9.1 GB | 11.4 GB | ~12 GB | |

The other macOS engines load separately when you select them — only one is resident at a time (switching unloads the previous): **Chatterbox** ~4 GB resident (1.3 GB on disk), **CosyVoice 3** lighter, **Qwen3-TTS** (1.7B bf16) heavier. OmniVoice is downloaded and loaded separately when selected.

The MLX buffer cache is capped at 1 GB (`SONIQO_MLX_CACHE_MB` to override) — without that cap, peak grows to tens of GB on long sessions as varying-shape buffers accumulate. Override the default model with `SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-bf16` if you want the higher-fidelity weights.

### Try the demo

Hit **Load demo** in the top bar. It bootstraps a Scene 04 storyboard with two cloned voices (Anna and Marek) and four lines of dialogue — one with each emotion marker — then synthesizes everything via VoxCPM2.

### Packaging your own .app / .dmg

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

## Sibling repos

- [`speech-swift`](https://github.com/soniqo/speech-swift) — Apple Silicon speech engines (VoxCPM2, CosyVoice3, Qwen3-TTS, Chatterbox, OmniVoice, Indic-Mio, Fish Audio S2 Pro, Parakeet, Silero VAD).
- [`speech-core`](https://github.com/soniqo/speech-core) — C++ engines (VoxCPM2 cloning on Windows/Linux, plus STT, VAD, denoise).

## Contributing

See `AGENTS.md` for project conventions. Short version: branch → PR → merge, no force-pushes, no AI co-author trailers, never commit unless explicitly asked.

## Licence

[Apache License 2.0](LICENSE) — same as [speech-swift](https://github.com/soniqo/speech-swift) and [speech-core](https://github.com/soniqo/speech-core).
