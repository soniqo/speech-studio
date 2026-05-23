# Agent Instructions

This file is for any AI coding agent working in this repo (Claude, Codex, Cursor, Aider, etc.).

## Project

**studio** — Soniqo Creator Studio. Open-source desktop app for content creators.

**MVP scope.** Voice cloning + adjusting a cloned voice over a video timeline + emotional markers (style / prosody tags on the synthesized speech). The first end-to-end story:

1. Drop a short reference clip → clone the speaker.
2. Drop a video → extract / line up the existing dialogue.
3. Rewrite or re-record lines in the cloned voice, with inline emotion markers (e.g. `<whisper>`, `<excited>`, `<sad>`).
4. Preview against the video; export muxed output.

Status: greenfield. This file will grow as code lands.

## Stack

**Tauri** (Rust shell + web frontend) wrapping the Soniqo C++ engine.

- **Rust process** — Tauri app, owns the window, menu, file pickers, IPC. Calls into `speech-core` (C++) via FFI for voice cloning, TTS, STT, VAD, enhancement.
- **Web frontend** — renders the video timeline, voice-clone manager, script editor with emotion markers, and waveform views. Framework TBD (React / SolidJS / Svelte) — decide once and document here.
- **C++ engine** — `speech-core` is already C++17 with a stable C ABI (`include/speech_core/speech_core_c.h`), which is what Rust binds against.

**Target platforms** (in priority order): **macOS** first, then **Linux**, then **Windows**. No mobile.

Why Tauri (vs Electron): smaller binaries, native shell, easier C++ FFI from Rust, desktop-first distribution. Matches the "deploy-anywhere" positioning.

## Sibling repos under `~/repos/`

- **speech-core** — C++ engine. Source of truth for VAD / STT / TTS / enhancement. Linked via FFI from the Tauri Rust process. See its `AGENTS.md` for the C ABI and CMake targets.
- **speech-swift** — speech models runtime for Apple Silicon (MLX / CoreML).
- **speech-models** — model artifacts on Hugging Face (`aufklarer/`). Studio bundles or downloads from here on first use.

## Build

TBD — populate once the Tauri scaffold lands. Will document:

- Rust toolchain + Tauri CLI version
- How `speech-core` is built and linked (likely `cmake --build` then a `build.rs` that points `cargo` at the static library and headers)
- Frontend package manager + build command
- Model download / cache location

## Structure

TBD — populate once the scaffold lands. Expected shape:

```
src-tauri/        Rust app + FFI bindings to speech-core
  src/
  build.rs
  Cargo.toml
src/              Web frontend
  components/
  routes/
extern/           speech-core checkout (submodule or path dep)
models/           bundled model manifest (downloads cache elsewhere)
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
2. **studio** bumps the `speech-core` pin and uses the new API.

Don't bundle a single PR that straddles repos; each repo has its own review and release cadence.
