# Speech Studio: three cloning engines, comparison page, and the Speech Runtime adapter

This fork turns Speech Studio's single-engine studio into a local voice-cloning
workbench with a side-by-side comparison page and an optional Speech Runtime
client mode. It was built on top of `speech-studio-voice-compare.patch`, which
supplied the page skeleton, the loopback runtime adapter, and a two-engine
comparison; everything below replaces or extends that skeleton.

## What is in the fork

- **Compare page** (`src/components/VoiceCompare.tsx`, left rail → `Compare`):
  one reference sample and one text drive three cloning engines with fully
  independent results. Per engine: precision variant, language, seed,
  Regenerate, WAV export, cold/warm timing, RTF and peak unified memory. The
  reference sample is imported from disk or recorded from the microphone, and
  the verified reference transcript is editable before the take.
- **Voice profiles** (`voiceStore` in the frontend + `VoiceStore` in Speech
  Runtime): saved as `{name, language, referenceText, audio}` and reusable
  across engines and sessions.
- **Model management**: every engine reports artifact path, on-disk bytes,
  existence, resident state and the sidecar's memory snapshot; bundles can be
  downloaded (sidecar's Hugging Face fetch), imported from a local directory
  (`import_tts_bundle`) and deleted from disk (`delete_tts_model`).
- **Speech Runtime client mode** (toggle in Compare): reference transcription
  through Parakeet Ultra and synthesis through the daemon's `/v1/tts/*` routes,
  so the app and other clients share one resident model instead of loading a
  second copy.
- **Standalone mode** (default): everything runs in-process through the bundled
  Swift/MLX sidecar, with no runtime installed.

## Engines

| Registry key | Weights | Runtime | Sample rate | Variants |
| --- | --- | --- | --- | --- |
| `qwen3` | `aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-*` | MLX, in-context clone | 24 kHz | bf16, 8-bit |
| `voxcpm2` | `aufklarer/VoxCPM2-MLX-*` | MLX, reference clone | 48 kHz | bf16, int8 |
| `espeech` | `local/ESpeech-TTS-1-RL-V2-MLX-fp16` | MLX F5-TTS v1 | 24 kHz | fp16 |

Qwen3 and VoxCPM2 reuse the existing engines, holders, variant selection and
download plumbing. ESpeech is new.

### ESpeech-TTS-1 RL-V2

ESpeech is an F5-TTS v1 Russian fine-tune published as a PyTorch `.pt` plus
`vocab.txt`. `scripts/convert_espeech_checkpoint.py` maps the checkpoint into an
MLX bundle that `speech-swift`'s `F5TTS` module loads:

- DiT config is copied from the ESpeech checkpoint (`dim=1024, depth=22,
  heads=16, ff_mult=2, text_dim=512, conv_layers=4, text_mask_padding=false`);
- weights are renamed to the Swift module's layout and stored as
  `model.safetensors`; the vocoder is `vocos.safetensors`;
- `vocab.txt` is copied verbatim and parsed by the F5 tokenizer.

The bundle lives at
`~/Library/Caches/qwen3-speech/models/local/ESpeech-TTS-1-RL-V2-MLX-fp16`
(overridable with `SONIQO_ESPEECH_BUNDLE_DIR`), which is also what
`import_tts_bundle` writes to. The sidecar exposes it as
`synthesize_espeech`; the registry entry lists `languages: ["ru"]` and was
registered after the real-audio checks below passed.

Two library bugs had to be fixed before Russian synthesis worked at all:

1. **CRLF vocab parsing.** The tokenizer split the vocab into `Character`s with
   a CRLF-sensitive rule, so the published CRLF vocabularies produced phantom
   entries and Cyrillic text tokenised into unknown tokens — output was noise.
   It now splits on newlines, strips the CR, and tokenises by Unicode scalar.
2. **No Russian frontend.** `F5TTSRussian` keeps RUAccent stress markup
   (`молок+о`) verbatim — the fine-tune was trained on the literal `+` token and
   the vocabulary has an entry for it — drops stray `+`, and spells out numbers
   and `%`/`₽`/`€` for Cyrillic input.

## Speech Runtime adapter

The daemon keeps its existing ASR surface and gains TTS. One `TtsHost` owns a
single `soniqo-tts-sidecar` child and one resident engine; every client of the
runtime shares it.

| Route | Purpose |
| --- | --- |
| `GET /v1/tts/models` | catalog: engine, model id, variants, artifact path/bytes/exists, loaded model and variant, memory, sidecar pid/restarts |
| `POST /v1/tts/models/load` | `{model, variant?}` → load or reuse; a different explicit variant re-inits |
| `POST /v1/tts/models/unload` | unload the resident engine |
| `GET/POST/DELETE /v1/tts/voices` | list, register (`name`, `referenceText`, `audioBase64`), delete (`?id=`) |
| `POST /v1/tts/synthesize` | `{model, text, language?, seed?, variant?, voiceId? | referenceAudioPath? | referenceAudioBase64?, referenceText?, requestId?}` → `{audioBase64, sampleRate, durationSec, model, engine, wallMs}` |
| `POST /v1/tts/cancel` | `{requestId}` → `{cancelled, pending}`; the pending synth request fails with `request cancelled` |

Behaviour worth knowing:

- **Shared residency.** A synth call with no `variant` reuses whatever is
  resident; an explicit different variant reloads. The Studio client never
  spawns its own sidecar while runtime mode is on.
- **Cancellation** matches `requestId`; cancelling a pending request makes the
  client call return an error, and the model stays loaded.
- **Idle unload** reuses `idleUnloadSeconds`: the daemon's 30 s monitor unloads
  the TTS engine, but never while a request is in flight.
- **Memory** comes from the sidecar's `[sidecar] mem …` stderr snapshots
  (`rssMb`, `footprintMb`, `peakMb`) and is exposed in `/health` and the catalog.
- **Temp files**: a WAV written from `referenceAudioBase64` is deleted in a
  `defer`; caller-supplied paths and voice-profile files are never deleted.
- Studio writes its `tts` block into `~/Library/Application Support/SpeechRuntime/app-config.json`
  (preserving `port`, ASR `models`, `batchChunkMs`, `idleUnloadSeconds`, unknown
  engines) and restarts the daemon through `launchctl kickstart -k
  gui/<uid>/com.speechruntime.agent`. The block points `binary` at the exact
  sidecar Studio itself runs.
- Reference audio is normalised to 16 kHz mono PCM WAV with `/usr/bin/afconvert`
  before transcription or synthesis; only loopback traffic is used.

## Verification

Machine: Apple M4, 16 GB unified memory, macOS 27.2. No M5 Pro was available, so
the 48 GB checks are **not** run.

### Builds and tests

| Check | Result |
| --- | --- |
| `speech-swift` F5-TTS tests (`swift test --filter F5TTSTests`) | 22 passed |
| `Speech-Runtime` daemon (`swift test`) | 65 passed (11 new TTS tests, fake-sidecar driven) |
| `speech-studio` Rust (`cargo test --lib`) | 48 passed |
| `speech-studio` frontend (`tsc --noEmit`, `vitest run`) | `tsc` clean; 92 tests in 15 files pass, including 6 for the Compare page |
| Swift sidecar (`swift build`) | debug build from this tree; the staged `src-tauri/binaries/` binary is the one the checks below ran against |

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

Interpretation:

- **Stress markup is ESpeech-only.** Qwen3 and VoxCPM2 were never trained on
  RUAccent markup and speak the `+` out loud. The Compare page therefore strips
  stress marks for those two engines and passes them to ESpeech unchanged.
- **ESpeech is the most accurate Russian reader** on plain and stress-marked
  text, at the cost of being the slowest (RTF 1.8–2.8).
- **Qwen3 is the fastest** (RTF < 1) and second-most accurate on plain text.
- **VoxCPM2 int8 is the heaviest** (6.3 GB peak) and slowest per second of
  audio; its quality is close to Qwen3 on plain text.
- Mixed RU/EN scoring through Russian ASR is approximate: the recogniser writes
  English product names in Cyrillic, so raw WER (0.36–0.43) overstates errors.
  The transcripts above are the actual evidence; the frame is intact in all
  three.

### Runtime adapter (real sidecar, private daemon on port 8499)

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

## Limitations (verified vs. unverified)

- **Unverified:** the 48 GB / M5 Pro scenario, and any Windows/Linux path (the
  fork's Compare page and ESpeech are macOS-only; the LiteRT engines are
  unchanged).
- **Unverified:** a click-through of the Compare page in the running window.
  The app boots, the WebView loads the page, the shell spawns the sidecar and
  the model calls it makes are proven (table above and the 6 DOM tests), but
  the machine's screen was locked during verification, so no screenshot or
  pointer-driven run of the page exists.
- **Unverified:** acoustic stress control. ESpeech consumes the `+` token and
  produces the correct words, but no listener study or F0 analysis was run, so
  "the stress lands on the marked vowel" is not proven.
- **No speaker-similarity metric.** There is no speaker-verification model in
  the stack, so voice similarity was judged only by ear and by ASR word
  accuracy; no embedding cosine score is reported.
- **Mixed RU/EN** is scored through a Russian ASR that transliterates Latin
  terms; numbers in that row are indicative only.
- **Cold/warm** means first/second synthesis after `init_model`; model loading
  and first-run downloads are timed separately and excluded from RTF.
- **VoxCPM2 int8** load from a cold disk took ~274 s in an early run (download
  included); a cached reload is much faster but was not measured per engine.
- **Qwen3/VoxCPM2 stress markup** is stripped by the UI, not by the engines.
- **Runtime TTS** requires a daemon build that includes `/v1/tts/*`; an older
  daemon returns 404 and the page says so. The bundled runtime in this
  workspace was rebuilt from this fork's sources.
- **Idle unload** is covered by unit tests with a fake sidecar and was observed
  live: with `--idle-unload 30` the resident ESpeech model dropped back to
  `loaded: false` within one monitor tick. The 15-minute production default was
  not waited out.
- **Memory figures** are the sidecar's own MLX/phys-footprint snapshots; they
  exclude the Rust shell and the WebView.

## Rebuilding the ESpeech bundle

```bash
python3 scripts/convert_espeech_checkpoint.py \
    --checkpoint /path/to/espeech_tts_rlv2.pt \
    --vocab /path/to/vocab.txt \
    --out ~/Library/Caches/qwen3-speech/models/local/ESpeech-TTS-1-RL-V2-MLX-fp16
```

The script only reads the checkpoint's tensors and config; it needs Python,
`numpy` and `safetensors` once, at development time. Nothing in the shipped app
depends on Python.
