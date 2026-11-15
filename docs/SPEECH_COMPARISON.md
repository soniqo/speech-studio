# Voice comparison and ESpeech bundles

The Compare page uses one reference recording, transcript and target text to
compare Qwen3-TTS, VoxCPM2 and ESpeech. Results, selected weights, language,
regeneration, WAV saves, synthesis timing and memory measurements are kept
separately for each engine.

The interface supports English, Russian and Traditional Chinese. Switching the
interface language changes labels and validation messages; it preserves the
reference transcript, target text and selected synthesis language. Voice names
and backend diagnostic messages are displayed as supplied.

## Engines and local operation

| Registry key | Weights | Runtime | Sample rate | Variants |
| --- | --- | --- | --- | --- |
| `qwen3` | `aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-*` | MLX, in-context clone | 24 kHz | bf16, 8-bit |
| `voxcpm2` | `aufklarer/VoxCPM2-MLX-*` | MLX, reference clone | 48 kHz | bf16, int8 |
| `espeech` | `local/ESpeech-TTS-1-RL-V2-MLX-fp16` | MLX F5-TTS v1 | 24 kHz | fp16 |

This comparison workflow targets macOS on Apple Silicon. Qwen3 and ESpeech
are macOS-only in Studio; Windows/Linux retain the standard LiteRT engines.
Standalone mode uses the bundled sidecar without requiring a separate daemon.

The project voice library accepts imported or recorded references and an
editable transcript. Model controls report cached paths, file sizes and load
state. Qwen3/VoxCPM2 weights can be downloaded; ESpeech requires a converted
local bundle.

## Preparing an ESpeech bundle

ESpeech-TTS-1 RL-V2 is an F5-TTS v1 Russian fine-tune. Studio loads converted
weights through the existing F5-TTS runtime and its local-bundle API; it does
not add a separate ESpeech runtime or Russian text-normalization module.

Install the development dependency, then convert a trusted checkpoint using a
compatible F5-TTS v1 MLX reference bundle:

```sh
python3 -m pip install -r scripts/requirements-conversion.txt
python3 scripts/convert_espeech_checkpoint.py \
    --checkpoint /path/to/espeech_tts_rlv2.pt \
    --f5-bundle /path/to/F5TTS-v1-Base-MLX-fp16 \
    --out /path/to/ESpeech-TTS-1-RL-V2-MLX-fp16
```

The converter writes `model.safetensors` and ESpeech metadata in `config.json`.
It copies the vocoder weights, `vocos_config.yaml`, vocabulary and architecture
settings from the reference F5 bundle. The reference vocabulary and architecture
must match the fine-tune. It generates `README.md`, which the consumed bundle
loader requires. No PyTorch or safetensors Python package is needed, and no
Python runs during synthesis.

Use **Import bundle** on the Compare page to copy the converted directory into
the model cache. Import checks all six required files before replacing an
existing bundle: `config.json`, `README.md`, `model.safetensors`,
`vocos.safetensors`, `vocos_config.yaml` and `vocab.txt`.

The default cache is
`~/Library/Caches/qwen3-speech/models/local/ESpeech-TTS-1-RL-V2-MLX-fp16`;
`SONIQO_ESPEECH_BUNDLE_DIR` overrides it. The sidecar command is
`synthesize_espeech`.

Studio preserves RUAccent `+` markup for ESpeech and strips it for Qwen3 and
VoxCPM2 in comparisons. This preserves input tokens; it does not establish
correct acoustic stress placement or automatic Russian number expansion.

## Optional shared Speech Runtime

Configure a local daemon with the TTS API before enabling shared mode. Studio
releases its locally loaded model and routes initialization and synthesis to
the daemon. Unsupported engines report an error instead of loading a local
fallback. Reference normalization currently uses macOS `afconvert`.

The default endpoint is `http://127.0.0.1:8477`, authenticated with the local
daemon token. Only loopback endpoints are allowed. `SPEECH_RUNTIME_URL` and
`SPEECH_RUNTIME_TOKEN_FILE` override the endpoint and token for tests.

| Route | Client operation |
| --- | --- |
| `GET /health` | Connection status |
| `POST /v1/audio/transcriptions?model=parakeet-ultra&priority=batch` | Reference transcription |
| `GET /v1/tts/models` | Available models and load state |
| `POST /v1/tts/models/load` | Load or reuse a model and optional variant |
| `POST /v1/tts/models/unload` | Unload a model |
| `GET/POST/DELETE /v1/tts/voices` | Manage shared voice profiles |
| `POST /v1/tts/synthesize` | Generate WAV audio |
| `POST /v1/tts/cancel` | Cancel a request by ID |

The Compare toggle selects the configured backend. The separate
`speech_runtime_write_tts_config` and `speech_runtime_restart` commands are
available for setup integrations; toggling the backend does not configure or
restart the daemon.

## Current automated verification

See [REGRESSION_TESTS.md](REGRESSION_TESTS.md) for the commands and test scope.
Coverage includes browser playback, project migration, locale switching,
export payloads, native IPC, an isolated loopback daemon, safe checkpoint
reading, converter output and the actual consumed F5 bundle loader's file and
configuration contract. These fixtures do not load model weights or evaluate
voice quality.

Real ESpeech synthesis, speaker similarity, acoustic stress control and
model-backed Windows/Linux inference still require the actual model bundles
and hardware. The measurements below were supplied with the original
contribution; they were not reproduced during the current regression review,
and their source revision was not recorded. They are historical observations,
not current-head validation or general quality guarantees.

## Contributor-reported benchmarks (historical)

Machine: Apple M4, 16 GB unified memory, macOS 27.2. No M5 Pro was available, so
the 48 GB checks are **not** run.

### Three-engine A/B (real synthesis, one reference sample)

Reference: 6.0 s Russian sample, verified transcript, seed 7, one sidecar
process per engine so peak memory is attributable.

| Engine | Long text (86 chars) cold | warm | RTF (long) | Peak RSS |
| --- | --- | --- | --- | --- |
| qwen3 8-bit | 11.8 s for 11.8 s audio | 11.1 s | 0.94–0.99 | 4.6 GB |
| voxcpm2 int8 | 22.8 s for 11.2 s audio | 22.6 s | 2.01–2.04 | 6.3 GB |
| espeech fp16 | 26.2 s for 14.2 s audio | 26.2 s | 1.84 | 2.0 GB |

ASR round-trip (Parakeet Ultra on the generated WAVs):

| Text | qwen3 | voxcpm2 | espeech |
| --- | --- | --- | --- |
| long (plain Russian) | WER 0.00 | WER 0.04 | WER 0.00 |
| stress markup (`+` before the stressed vowel) | WER 0.83 — reads the `+` as the word «плюс» | WER 0.50 — same artifact | WER 0.00 — markup consumed, no artifact |
| mixed RU/EN (`Kubernetes, Docker и CI/CD`) | frame perfect, terms rendered | frame perfect, terms rendered | frame perfect, «Docker» heard as «доктор» |

Contributor interpretation of this sample:

- **Stress markup is ESpeech-only.** Qwen3 and VoxCPM2 were never trained on
  RUAccent markup and speak the `+` out loud. The Compare page therefore strips
  stress marks for those two engines and passes them to ESpeech unchanged.
- **ESpeech had the lowest reported word error** on these plain and stress-marked
  Russian samples, at the cost of being the slowest (RTF 1.8–2.8).
- **Qwen3 is the fastest** (RTF < 1) and second-most accurate on plain text.
- **VoxCPM2 int8 is the heaviest** (6.3 GB peak) and slowest per second of
  audio; its quality is close to Qwen3 on plain text.
- Mixed RU/EN scoring through Russian ASR is approximate: the recogniser writes
  English product names in Cyrillic, so raw WER (0.36–0.43) overstates errors.
  The transcripts above are the actual evidence; the frame is intact in all
  three.

### Reported runtime adapter smoke checks

| Step | Result |
| --- | --- |
| `GET /v1/tts/models` | three models listed with real paths, `exists: true`, byte counts (ESpeech 701 MB, Qwen3 2.42 GB) |
| `POST /v1/tts/models/load {"model":"espeech"}` | `{ready: true}` |
| `POST /v1/tts/synthesize` (reference path) | 2.75 s WAV @ 24 kHz, `wallMs` 10.5 s |
| `POST /v1/tts/voices` + synth by `voiceId` | profile stored under `SpeechRuntime/voices/`, 2.43 s WAV |
| `POST /v1/tts/cancel` while a long synth is pending | `{cancelled: true}`, client got `request cancelled`, model stayed loaded |
| `POST /v1/tts/models/unload` | `{ready: false}`, `/health` reports `loaded: false` |
| `/health` `tts` block | `rssMb 730`, `footprintMb 1775`, `peakMb 2081` from sidecar snapshots |
| Studio's Rust client (`speech_runtime_tts_synthesize`) | reference path normalised by `afconvert`, 3.58 s WAV written to the Studio clip cache |
| Idle unload (`--idle-unload 30`) | resident ESpeech model unloaded on the next monitor tick, `loaded: false` |
| Studio's exact sidecar payloads (`init_model` + synth, rebuilt sidecar) | espeech 4.54 s WAV, qwen3 2.56 s WAV, voxcpm2 2.58 s WAV, all `ok: true` |
