# Agent Instructions

This file is for any AI coding agent working in this repo (Claude, Codex, Cursor, Aider, etc.).

## Project

**speech-studio** — Speech Studio, a Soniqo project. Open-source desktop app for content creators.

**MVP scope.** Voice cloning + adjusting a cloned voice over a video timeline + emotional markers (style / prosody tags on the synthesized speech). The first end-to-end story:

1. Drop a short reference clip → clone the speaker.
2. Drop a video → extract / line up the existing dialogue.
3. Rewrite or re-record lines in the cloned voice, with inline emotion markers (e.g. `<whisper>`, `<excited>`, `<sad>`).
4. Preview against the video; export muxed output.

Status: the clone → script → synthesize → export pipeline works end to end. macOS runs the MLX engines — `VoxCPM2` by default, with `CosyVoice3`, `Qwen3-TTS`, and `Chatterbox` (multilingual) selectable from the toolbar; Windows/Linux run `VoxCPM2` through speech-core's LiteRT backend.

## Stack

**Tauri** (Rust shell + web frontend) wrapping the Soniqo speech engines.

- **Rust process** — Tauri app, owns the window, menu, file pickers, IPC, model lifecycle, file I/O. Talks to a voice-cloning TTS backend through a **sidecar** chosen at compile time per OS:
  - **macOS (Apple Silicon)** — `speech-swift` (Swift / MLX) via the `swift-sidecar/` binary. `VoxCPM2` is the default cloning engine; `CosyVoice3`, `Qwen3-TTS`, and the multilingual `Chatterbox` are also selectable (all MLX, macOS-only).
  - **Windows / Linux (x86_64)** — `speech-core` (C++) via the `core-sidecar/` binary, cloning + cloned-voice TTS with the `VoxCPM2` **LiteRT** model through the C ABI in `include/speech_core/voxcpm2_c.h`.
  - **v1+** — `speech-core`'s broader C ABI (`speech_core_c.h`) for STT (Parakeet), VAD (Silero), noise suppression (DeepFilterNet3), audio utilities.
- **Web frontend** — **React + Vite**, rendered into the OS WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Owns the video timeline, voice-clone manager, script editor with emotion markers, and waveform views. Talks to Rust via Tauri `invoke()` commands and events.
- **Bridge mechanism** — a stateful **sidecar binary** bundled with the app. Tauri spawns it; Rust talks to it over stdin/stdout using an NDJSON protocol (one JSON object per line each way). The sidecar loads the model once and keeps it resident across calls, so per-line synthesis after warmup is fast. The protocol (`ping` / `init_model` / per-engine `synthesize_*`) is implemented by both sidecars — the Swift sidecar handles every macOS engine (`synthesize_voxcpm2` / `_cosyvoice` / `_chatterbox` / `_icl`), the C++ sidecar handles `synthesize_voxcpm2` — so `SidecarManager` (`src-tauri/src/lib.rs`) only varies the binary path per OS. `init_model` carries the selected engine. Code: `swift-sidecar/` (Swift package, macOS) and `core-sidecar/` (CMake C++, Windows/Linux).

**Target platforms.**

- **v0: macOS (Apple Silicon)** — MLX engines via `swift-sidecar`: `VoxCPM2` (default, cloning + emotional markers) plus selectable `CosyVoice3`, `Qwen3-TTS`, and the multilingual `Chatterbox`. These engines are macOS-only — Windows/Linux don't list them.
- **v0: Windows / Linux (x86_64)** — `VoxCPM2` via speech-core's LiteRT backend (`core-sidecar`). Same clone + emotion-marker story without MLX. ASR-graded retry isn't wired here yet (see Notes); the first successful take is accepted.

Why Tauri (vs Electron): smaller binaries, native shell, easier C++ FFI from Rust, desktop-first distribution. Matches the "deploy-anywhere" positioning.

**No Chromium, no Node in the shipped app.** WKWebView is part of macOS; the only JS that ships is our built bundle. Node lives on dev machines as a build-time toolchain (like Cargo) — never in the `.app`.

## Sibling repos under `~/repos/`

- **speech-core** — C++ engine. **v0 dependency on Windows/Linux**: the `core-sidecar` links its `speech_core_models_litert` static lib + the `libLiteRt` runtime and drives `VoxCPM2` via `include/speech_core/voxcpm2_c.h`. Also the v1+ source of truth for VAD / STT / non-cloned TTS / enhancement. Build it with `-DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=...` first (see its `AGENTS.md` for the C ABI and CMake targets).
- **speech-swift** — speech models runtime for Apple Silicon (MLX / CoreML). The macOS voice-cloning backend: `VoxCPM2TTS` (default), `CosyVoiceTTS`, `Qwen3TTS` (ICL clone API in `Qwen3TTS+ICL.swift`), and `ChatterboxTTS` (multilingual, `Sources/ChatterboxTTS/`).
- **speech-models** — model artifacts on Hugging Face (`aufklarer/`). Studio bundles or downloads from here on first use.

## Build

Common: Rust 1.95+ via `rustup`, Node 20+ and `pnpm` 11+.

**macOS (Apple Silicon)** — Swift sidecar:
- macOS 15+, Xcode 26+ (check with `xcode-select -p`)

**Windows / Linux (x86_64)** — C++ sidecar linking speech-core:
- A C++17 toolchain + CMake 3.16+ (MSVC + Visual Studio on Windows; gcc/clang on Linux)
- A built `speech-core` checkout with LiteRT **and** the model downloader: `-DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=... -DSPEECH_CORE_WITH_HF_DOWNLOAD=ON`. The download feature needs libcurl (`find_package(CURL)`) — system libcurl on Linux; on Windows, vcpkg (`vcpkg install curl:x64-windows-static-md`, then pass the vcpkg toolchain + triplet at configure).
- The `VoxCPM2-LiteRT` model bundle (~8.8 GB fp16 on disk, ~10 GiB RAM at load) is **downloaded on first run** by the sidecar (`sc_voxcpm2_create_from_pretrained`) — no manual fetch needed. To use a pre-downloaded bundle instead, set `SONIQO_VOXCPM2_BUNDLE_DIR`.

### One-time install

```bash
pnpm install                          # frontend + Tauri CLI deps
```

macOS sidecar:
```bash
cd swift-sidecar && swift build       # binary at .build/debug/soniqo-tts-sidecar
```

Windows / Linux sidecar (from the speech-studio root). The sidecar links
speech-core's prebuilt libs and libcurl; on Windows pass the vcpkg toolchain so
`find_package(CURL)` resolves:
```bash
cmake -B core-sidecar/build core-sidecar \
    -DSPEECH_CORE_DIR=../speech-core \
    -DSPEECH_CORE_BUILD_DIR=../speech-core/build      # build dir with HF download on
    # Windows only — add:
    # -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake \
    # -DVCPKG_TARGET_TRIPLET=x64-windows-static-md
cmake --build core-sidecar/build --config Release
# → core-sidecar/build[/Release]/speech-core-tts-sidecar(.exe), with libLiteRt colocated
```

### Run

```bash
pnpm tauri dev                        # opens the app, hot-reloads the frontend
```

On Windows/Linux the sidecar downloads the VoxCPM2-LiteRT bundle from Hugging
Face on first run (cached under the OS cache dir / `SPEECH_CORE_CACHE_DIR`). To
skip that and use a local bundle, `export SONIQO_VOXCPM2_BUNDLE_DIR=/path/to/bundle`.

### Release build

macOS:
```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # .app + .dmg under src-tauri/target/release/bundle/
```

Windows / Linux: build the C++ sidecar (above), then stage it for Tauri's
`externalBin` (the bundler appends the target triple) before `pnpm tauri build`:
```bash
mkdir -p src-tauri/binaries
# Windows example (x86_64-pc-windows-msvc):
cp core-sidecar/build/Release/speech-core-tts-sidecar.exe \
   src-tauri/binaries/speech-core-tts-sidecar-x86_64-pc-windows-msvc.exe
cp core-sidecar/build/Release/libLiteRt.dll src-tauri/binaries/libLiteRt.dll
pnpm tauri build                      # add --no-bundle to skip msi/nsis installers
```

### Notes

- `pnpm-workspace.yaml` whitelists `esbuild` for pnpm 11's `allowBuilds` check. Don't drop it — without it `pnpm exec` fails before any script runs.
- The Rust side keeps one sidecar process alive across calls (see `SidecarManager` in `src-tauri/src/lib.rs`) so the model stays warm. Spawned lazily on first IPC. `sidecar_path()` picks the per-OS binary; dev spawns from the sidecar's build dir, release from next to the app binary.
- Per-OS Tauri bundle settings live in `tauri.{macos,windows,linux}.conf.json` (merged over `tauri.conf.json`): `externalBin` selects the sidecar, `resources` ships its runtime (`mlx.metallib` on macOS, `libLiteRt.dll`/`.so` on Windows/Linux). `tauri-build` verifies `externalBin` on **every** cargo build, so stage `src-tauri/binaries/<name>-<triple>` first (it's gitignored) or even `cargo test --lib` fails.
- **macOS sidecar (`swift-sidecar`)**: the build doesn't emit `mlx.metallib` next to the binary on its own — copy it once from the speech-swift build that does (`~/repos/speech-swift/.build/arm64-apple-macosx/debug/mlx.metallib` → `swift-sidecar/.build/arm64-apple-macosx/debug/mlx.metallib`) or you'll get `MLX error: Failed to load the default metallib`. The Rust `colocate_metallib` helper (macOS-only) handles the bundled `.app` layout.
- **Windows/Linux sidecar (`core-sidecar`)**: `cfg`'d off macOS. On `init_model` it loads the bundle from `SONIQO_VOXCPM2_BUNDLE_DIR` if set, else calls `sc_voxcpm2_create_from_pretrained` to download+cache it (`SONIQO_VOXCPM2_MODEL_ID`, default `soniqo/VoxCPM2-LiteRT`; cache via `SONIQO_MODEL_CACHE_DIR`/`SPEECH_CORE_CACHE_DIR`). The CMake colocates `libLiteRt` next to the binary; libcurl is linked statically (no extra DLL). `cfgValue` from the synth ladder has no LiteRT knob and is ignored (the ladder still varies `seed`).
- **TTS model**: macOS MLX path defaults to `aufklarer/VoxCPM2-MLX-int8`. Windows/Linux use the `VoxCPM2-LiteRT` bundle — downloaded on first run (resumable; see speech-core's `SPEECH_CORE_WITH_HF_DOWNLOAD`) or supplied via `SONIQO_VOXCPM2_BUNDLE_DIR`.
- Generated clip audio is cached under `dirs::cache_dir()/audio.soniqo.studio/clips/` (`~/Library/Caches/...` on macOS, `%LOCALAPPDATA%\...` on Windows, `$XDG_CACHE_HOME`/`~/.cache` on Linux). The Rust and sidecar sides compute this independently and must stay in sync.
- **Follow-ups**: (1) ASR-graded retry is macOS-only (`GRADING_AVAILABLE` in `lib.rs`); Windows/Linux accept the first successful take — wiring Parakeet-via-sidecar grading is TODO. (2) The Windows/Linux CI lanes (`build.yml` `build-windows` / `build-linux`) build the sidecar, run `ctest`, `pnpm tauri build`, and attach installers to the Release on tag — but they check out speech-core at the moving `ref: main` (not a pinned SHA) and run no model inference, so an x86_64 LiteRT runtime regression can still slip past CI. First-run model download is handled by speech-core, so installers don't embed the bundle.

## Structure

```
.
├── AGENTS.md                              project conventions (this file)
├── CLAUDE.md                              symlink → AGENTS.md
├── package.json                           React + Vite + @tauri-apps deps
├── pnpm-workspace.yaml                    allowBuilds: esbuild (pnpm 11)
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── index.html                             Vite entry
├── src/                                   React frontend
│   ├── App.tsx                            v0 sanity-check UI (ping_sidecar)
│   ├── main.tsx
│   └── …
├── public/                                static assets served by Vite
├── src-tauri/                             Rust Tauri shell
│   ├── Cargo.toml
│   ├── tauri.conf.json                    base config (productName, window)
│   ├── tauri.macos.conf.json              macOS sidecar + metallib + .app/.dmg
│   ├── tauri.windows.conf.json            Windows sidecar + libLiteRt + msi/nsis
│   ├── tauri.linux.conf.json              Linux sidecar + libLiteRt + deb/appimage
│   ├── binaries/                          staged sidecars for externalBin (gitignored)
│   ├── src/lib.rs                         Tauri commands + SidecarManager
│   ├── src/main.rs
│   ├── capabilities/
│   └── icons/
├── swift-sidecar/                         macOS sidecar (Swift/MLX, VoxCPM2)
│   ├── Package.swift                      macOS 15+, Swift 6.0
│   └── Sources/soniqo-tts-sidecar/
│       └── main.swift                     NDJSON request loop
└── core-sidecar/                          Windows/Linux sidecar (C++/LiteRT, VoxCPM2)
    ├── CMakeLists.txt                     links speech-core's speech_core_models_litert
    └── src/main.cpp                       NDJSON loop over voxcpm2_c.h
```

## Commits and pull requests

- Do **not** mention Claude, Codex, Cursor, Anthropic, OpenAI, or any AI assistant in commit messages, PR titles, PR descriptions, or code comments.
- Do **not** add `Co-Authored-By: <AI> ...` trailers or `Generated with …` footers.
- Write as if authored by a human contributor: focus on the *why* of the change.

## Workflow

- **Never push directly to `main`.** Branch → PR → merge.
- Branch naming: `feat/description`, `fix/description`, `chore/description`, `docs/description`.
- PR description: summary, what changed, test plan. No marketing fluff.
- **Don't commit unless explicitly asked.** Likewise for `git push`.
- **Never amend commits or force-push** unless the user explicitly asks.
- **Always ask for confirmation before externally-visible actions** — pushes, PRs, comments, external service calls. Local commits and local builds are fine without asking.

## Cross-repo changes

When a Studio feature needs a change in `speech-core` (new TTS knob, new model, new C-ABI symbol), one PR per repo, merged in order:

1. **speech-core** lands first — adds the API.
2. **speech-studio** bumps the `speech-core` pin and uses the new API.

Don't bundle a single PR that straddles repos; each repo has its own review and release cadence.
