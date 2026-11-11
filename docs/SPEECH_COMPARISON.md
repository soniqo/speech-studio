# Speech Studio: local voice-cloning comparison and Speech Runtime adapter

## Delivered

- `Compare` page next to Studio: import an audio reference into the project's voice library, edit its verified reference transcript, synthesize the same Russian text sequentially with Qwen3-TTS Base and VoxCPM2, and play the resulting WAV files side by side.
- Model switching uses Speech Studio's existing `init_model` Tauri command and Swift/MLX sidecar. The two models are not kept in memory together. Existing TopBar model variant selector handles bf16 vs int8/8-bit downloads.
- On macOS, the optional Speech Runtime adapter uses the existing daemon's `GET /health` and `POST /v1/audio/transcriptions?model=parakeet-ultra&priority=batch` endpoints on `127.0.0.1:8477`. It reads the existing bearer token from `~/Library/Application Support/SpeechRuntime/token`, and normalizes reference audio with the built-in `/usr/bin/afconvert` to mono 16kHz LE PCM WAV. No network requests outside loopback. Reference transcripts are editable before saving into the project.
- Timings are the per-clip synthesis elapsed time returned by the existing Studio backend, not a standalone inference benchmark. RTF = elapsed / output duration. First loading/downloading the model is timed separately by Studio and is **not** included in the comparison RTF.

## Not delivered (do not represent as working)

- ESpeech-TTS-1 RL-V2 is intentionally shown as **not integrated**, not selectable for synthesis. The public checkpoint is a PyTorch F5-TTS DiT `.pt` (about 2.7 GB) with a Russian `vocab.txt`; `speech-swift`'s current F5-TTS MLX module accepts its own converted EN/ZH bundle. There is no verified way to load the raw ESpeech checkpoint directly into that Swift engine.
- TTS calls through Speech Runtime are **not implemented**. The current daemon supports ASR and model sessions, but no TTS command/route. This patch only uses its existing transcription route. Do not start a second Speech Runtime service or claim shared GPU/TTS model residency yet.
- Model deletion and downloadable model registry changes are not implemented; existing Studio variant selection and downloads remain unchanged.
- Microphone recording from the Compare page is not added; use the existing audio reference import flow.

## Follow-up to make ESpeech native

1. Compare ESpeech checkpoint tensor dimensions/keys against the native `F5TTS` Swift implementation; verify DiT `dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4` and Vocos compatibility. Avoid loading arbitrary `.pt` pickle data in an app. Convert in an isolated trusted tooling environment into `safetensors`, produce config + vocab + vocoder bundle, record hashes.
2. Add a bundle loader and Russian tokenizer/normalizer; preserve `+` stress markers. Test optional RUAccent separately, without making Python mandatory in the shipping app. Validate Russian pronunciation and any required text normalization against original F5-TTS inference.
3. Register ESpeech only after a Swift/MLX generation roundtrip passes (with reference audio and transcript) and the model can be unloaded. Add runtime downloadable weights, correct disk/RAM values, progress and cleanup, with licenses checked separately for model weights and the vocoder.
4. Run three-way A/B/C on Russian (numbers, declensions, homographs, IT vocabulary), similarity, ASR-CER/WER, latency (cold/warm), peak unified-memory footprint, and failure cases, on both M5 Pro/48 GB and M4/16 GB. Never invent benchmarks.
5. For shared TTS residency, extend **Speech Runtime** with a versioned synthesis contract (model ID, ref audio/profile, ref transcript, target text, language, PCM/WAV response or stream), scheduling, cancellation and idle-unload. Only then switch Studio from local Swift sidecar to the daemon by explicit user preference.

## Build and manual validation (macOS Apple Silicon)

Clone `speech-swift` and `speech-studio` into sibling directories (as required by `swift-sidecar/Package.swift`). In the Studio repo apply this patch with `git apply --check /path/to/patch && git apply /path/to/patch`, then:

```bash
pnpm install
(cd swift-sidecar && swift build)
pnpm test
pnpm build
pnpm tauri dev
```

Verify: import a reference; create a voice; transcribe through an **already-running** Speech Runtime with Parakeet Ultra ready; correct and save the transcript; choose Qwen3 and VoxCPM; synthesize sequentially; play each WAV; check first-time downloads and model unload/switching in Activity. With the daemon stopped, comparison synthesis must still work if the reference transcript is supplied manually. Validate 16GB memory footprint with VoxCPM2 int8 before bf16. This patch has not been executed against Apple hardware in the author's environment.
