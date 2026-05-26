# Agent Instructions

This file is for any AI coding agent working in this repo (Claude, Codex, Cursor, Aider, etc.).

## Project

**speech-studio** — Speech Studio, a Soniqo project. Open-source desktop app for content creators.

**MVP scope.** Voice cloning + adjusting a cloned voice over a video timeline + emotional markers (style / prosody tags on the synthesized speech). The first end-to-end story:

1. Drop a short reference clip → clone the speaker.
2. Drop a video → extract / line up the existing dialogue.
3. Rewrite or re-record lines in the cloned voice, with inline emotion markers (e.g. `<whisper>`, `<excited>`, `<sad>`).
4. Preview against the video; export muxed output.

Status: v0 scaffold in place. Tauri shell compiles, the Swift sidecar responds to `ping` over stdin/stdout, the Rust side round-trips a JSON request, and the React frontend can invoke the round-trip. Real Qwen3-TTS wiring is the next step.

## Stack

**Tauri** (Rust shell + web frontend) wrapping the Soniqo speech engines.

- **Rust process** — Tauri app, owns the window, menu, file pickers, IPC, model lifecycle, file I/O. Talks to the speech engines via:
  - **v0** — `speech-swift` (Swift / MLX) through the Mac sidecar for voice cloning + cloned-voice TTS via `Qwen3-TTS`. Apple Silicon only.
  - **v1+** — `speech-core` (C++) through the C ABI in `include/speech_core/speech_core_c.h` for cross-platform speech ops: STT (Parakeet), VAD (Silero), noise suppression (DeepFilterNet3), audio utilities.
- **Web frontend** — **React + Vite**, rendered into WKWebView on macOS. Owns the video timeline, voice-clone manager, script editor with emotion markers, and waveform views. Talks to Rust via Tauri `invoke()` commands and events.
- **Bridge mechanism (macOS)** — stateful Swift **sidecar binary** bundled with the app. Tauri spawns it; Rust talks to it over stdin/stdout using an NDJSON protocol (one JSON object per line in each direction). The sidecar loads Qwen3-TTS once and keeps the MLX model resident across calls, so per-line synthesis after warmup is sub-second. Code lives in `swift-sidecar/` (Swift package). v0 ships a `ping` skeleton; adding `speech-swift`'s `Qwen3TTS` as a dependency + `clone_voice` / `synthesize` commands is the next step.

**Target platforms.**

- **v0: macOS (Apple Silicon) only** — driven by Qwen3-TTS requiring MLX. This is the headline cloning + emotional-marker feature; without it there's no studio.
- **v1+: Linux, then Windows** — unlocked once an on-device controllable TTS lands in `speech-core` (or a cloud fallback is wired in).

Why Tauri (vs Electron): smaller binaries, native shell, easier C++ FFI from Rust, desktop-first distribution. Matches the "deploy-anywhere" positioning.

**No Chromium, no Node in the shipped app.** WKWebView is part of macOS; the only JS that ships is our built bundle. Node lives on dev machines as a build-time toolchain (like Cargo) — never in the `.app`.

## Sibling repos under `~/repos/`

- **speech-core** — C++ engine. Source of truth for VAD / STT / non-cloned TTS / enhancement. **v1+ dependency** — will be linked via FFI from the Tauri Rust process when STT / VAD / denoise features land. See its `AGENTS.md` for the C ABI and CMake targets.
- **speech-swift** — speech models runtime for Apple Silicon (MLX / CoreML). v0 voice-cloning + cloned-voice TTS backend on macOS, via `Qwen3-TTS` (`Sources/Qwen3TTS/`, ICL clone API in `Qwen3TTS+ICL.swift`).
- **speech-models** — model artifacts on Hugging Face (`aufklarer/`). Studio bundles or downloads from here on first use.

## Build

### Prerequisites

- macOS 15+ on Apple Silicon
- Xcode 26+ (for the Swift sidecar) — check with `xcode-select -p`
- Rust 1.95+ via `rustup` — run `. "$HOME/.cargo/env"` in fresh shells if `cargo` isn't on `PATH`
- Node 20+ and `pnpm` 11+

### One-time install

```bash
pnpm install                          # frontend + Tauri CLI deps
cd swift-sidecar && swift build       # sidecar binary at .build/debug/soniqo-tts-sidecar
```

### Run

```bash
pnpm tauri dev                        # opens the app, hot-reloads the frontend
```

### Release build

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

### Notes

- `pnpm-workspace.yaml` whitelists `esbuild` for pnpm 11's `allowBuilds` check. Don't drop it — without it `pnpm exec` fails before any script runs.
- The Rust side keeps one sidecar process alive across calls (see `SidecarManager` in `src-tauri/src/lib.rs`) so the MLX model stays warm. Spawned lazily on first IPC.
- The sidecar build doesn't emit `mlx.metallib` next to the binary on its own. Copy it once from the speech-swift build that does (`~/repos/speech-swift/.build/arm64-apple-macosx/debug/mlx.metallib` → `swift-sidecar/.build/arm64-apple-macosx/debug/mlx.metallib`) or you'll get `MLX error: Failed to load the default metallib` at first synth. Automating this as a Swift build plugin is a follow-up.
- **TTS model**: defaults to `aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-8bit` (~1.7 GB on first download to `~/.cache/huggingface/hub/`). The 0.6B 4-bit variant is too quantized for clean voice cloning — audibly noisy output even at greedy decoding. Override with `SONIQO_TTS_MODEL_ID=<hf-model-id>` in the environment if you need to drop to the smaller model on memory-constrained machines.
- Generated clip audio cached at `~/Library/Caches/audio.soniqo.studio/clips/`. Demo's `say`-generated reference WAVs live at `/tmp/soniqo-demo/`.
- Production sidecar bundling via Tauri's `externalBin` + target-triple-suffixed binary: TBD. For now the Rust side spawns from `swift-sidecar/.build/debug/`, so `pnpm tauri build` won't ship a working sidecar yet.

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
│   ├── tauri.conf.json                    productName, identifier, window config
│   ├── src/lib.rs                         Tauri commands — currently ping_sidecar
│   ├── src/main.rs
│   ├── capabilities/
│   └── icons/
└── swift-sidecar/                         Swift sidecar binary (Qwen3-TTS host)
    ├── Package.swift                      macOS 15+, Swift 6.0
    └── Sources/soniqo-tts-sidecar/
        └── main.swift                     NDJSON request loop
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
