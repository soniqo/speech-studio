# Regression and integration checks

Run these from the repository root after `pnpm install`:

```sh
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

On a Mac with Google Chrome installed, `PLAYWRIGHT_CHANNEL=chrome pnpm
test:browser` uses that browser instead of downloading Chromium. The suite
starts a separate headless browser with muted audio and a temporary profile.
Playwright and its browser are development test tools.

The browser suite mounts the real application components and IPC wrappers,
with a fixture replacing the native host. It decodes a generated 20-second
WAV, checks playback beyond five seconds, opens and saves legacy projects,
tests failed model-load recovery, restores shared-mode startup and switches
the navigation, comparison form and export controls between supported locales
without changing the synthesis input.

For the native dispatcher and daemon boundary, prepare the normal Tauri build
inputs described in `AGENTS.md`, then run:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --features integration-tests
```

The TypeScript and Rust tests consume the same JSON command packets from
`src/ipc/fixtures/ttsCommands.json`. The native suite passes those packets
through Tauri's dispatcher and an isolated loopback HTTP server. It verifies
authentication, model variants, cancellation, voice deletion, returned WAV
audio and release of the local sidecar before shared-mode initialization.
The editor synthesis command is also tested on macOS, where reference audio
conversion uses `afconvert`. No model weights or installed Speech Runtime
service are required for these tests.

The checkpoint reader has a separate security regression suite:

```sh
python3 -m pip install -r scripts/requirements-conversion.txt
SPEECH_SWIFT_DIR=/path/to/speech-swift \
  python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

Set `SPEECH_SWIFT_DIR` to the same checkout consumed by the sidecar. The suite
compiles the actual F5 bundle loader and configuration types with a small
Foundation-only runner, converts a synthetic checkpoint through the real CLI,
and checks the resulting bundle. Missing `README.md` and vocoder configuration
are also rejected. This needs `swiftc`, but does not load MLX or model weights.
The vocabulary fixture includes combining accent marks before Cyrillic entries.
The runner compiles the consumed tokenizer and verifies the exact Russian token
IDs, so a runtime pin that reintroduces extra vocabulary rows fails this check.
The loader contract test is skipped when `SPEECH_SWIFT_DIR` is unset; macOS CI
sets it to the pinned dependency checkout so that check is mandatory there.

The suite also accepts a tensor state-dict fixture without installing PyTorch
and rejects an executable pickle before its callable runs. It checks strided tensor
bounds before copying data. Unsupported checkpoint globals are errors; they
are never resolved through Python's general pickle loader.

CI runs the frontend and browser suite in its own Linux job, and runs native
IPC and checkpoint checks alongside the macOS tests. These deterministic
checks cover application behavior and transport contracts. Real model-backed
synthesis and voice quality still need the relevant weights and hardware.

## Real ESpeech content gate (Apple Silicon)

Build the sidecar with the pinned runtime, convert or import the real ESpeech
bundle, and use a short Russian reference with its exact transcript:

```sh
python3 scripts/test_espeech_e2e.py \
  --sidecar swift-sidecar/.build/debug/soniqo-tts-sidecar \
  --bundle /path/to/ESpeech-TTS-1-RL-V2-MLX-fp16 \
  --reference /path/to/russian-reference.wav \
  --transcript 'Точный текст эталонной записи.' \
  --out out/espeech-e2e
```

This opt-in check synthesizes plain and stress-marked Russian, validates WAV
output, releases the TTS process, then grades both recordings with local
Parakeet ASR. The reference itself must pass the same ASR control. Each target
must have word error rate at most 20%; extra reference words and missing words
count as errors. It saves the audio, transcripts, WAV hashes and results in
`report.json` and exits nonzero on failure. It never plays audio. The ESpeech
bundle and Parakeet model weights must be available locally; the latter uses
the sidecar's usual first-run download if absent. No hosted inference runs.

The sidecar trims silent reference edges with a margin for quiet consonants,
then appends a short silent pad before ESpeech conditioning. Keep references
under 12 seconds and end on a sentence boundary. This gate checks content,
not speaker similarity or the acoustic placement of stress.
