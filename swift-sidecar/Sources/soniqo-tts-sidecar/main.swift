import Foundation
import AudioCommon
import MLX
import ChatterboxTTS
import CosyVoiceTTS
import FishAudioTTS
import IndicMioTTS
import OmniVoiceTTS
import ParakeetASR
import Qwen3TTS
import VoxCPM2TTS

// NDJSON protocol: one JSON object per line on stdin → one JSON object per
// line on stdout. The Rust side keeps one sidecar process alive so the MLX
// model stays warm; commands are dispatched on this single read loop.
//
// Commands:
//   ping                  — health check.
//   init_model            — preload the requested TTS engine and release the
//                           inactive one before it can retain Metal memory.
//                           `modelId` picks the artifact; a different id on a
//                           loaded engine swaps the weights.
//   synthesize_voxcpm2    — VoxCPM2 voice clone (48 kHz).
//   synthesize_cosyvoice  — CosyVoice zero-shot voice clone (24 kHz).
//   synthesize_chatterbox — Chatterbox multilingual voice clone (24 kHz).
//   synthesize_indic_mio  — Indic-Mio Hindi/Indic emotion synthesis (24 kHz).
//   synthesize_fish_audio — Fish Audio S2 Pro clone + bracket markers (44.1 kHz).
//   synthesize_icl        — Qwen3-TTS ICL voice clone; legacy fallback only.
//   transcribe_parakeet   — local dictation / transcription via Parakeet ASR.

struct Request: Decodable {
    let id: String
    let command: String
    // Selected backend. The Studio sends this for init_model and synthesis;
    // SONIQO_TTS_ENGINE remains a compatibility default for direct callers.
    let engine: String?
    // Exact artifact selected by the Studio model registry.
    let modelId: String?
    let text: String?
    let voiceId: String?
    let audioPath: String?
    let referenceAudioPath: String?
    let referenceText: String?
    // Optional sampling overrides — used by the debug test to A/B params
    // without rebuilding. Falls back to library defaults when omitted.
    let temperature: Float?
    let topK: Int?
    let maxTokens: Int?
    let minStopSteps: Int?
    let repetitionPenalty: Float?
    // Optional seed for the CosyVoice / VoxCPM2 path. Defaults to 1000 when
    // omitted. Rust-side retry varies this across attempts.
    let seed: UInt64?
    // VoxCPM2: style/emotion instruction (e.g. "excited", "whispering").
    // Library wraps as "(<instruct>){text}" before tokenising.
    let instruct: String?
    // VoxCPM2: classifier-free guidance scale (default 2.0).
    let cfgValue: Float?
    // Optional synthesis language for engines that declare requiresLanguage.
    let language: String?
    // Chatterbox: direct exaggeration override (emotion intensity). When nil the
    // handler maps the inline emotion marker to a value.
    let exaggeration: Float?
}

struct PingResult: Encodable {
    let pong: Bool
    let version: String
}

struct SynthResult: Encodable {
    let audioPath: String
    let sampleRate: Int
    let durationSec: Double
}

struct TranscribeResult: Encodable {
    let text: String
    let modelName: String
    let modelId: String
    let sampleRate: Int
    let durationSec: Double
    let elapsedSec: Double
}

struct InitResult: Encodable {
    let ready: Bool
}

struct SuccessResponse<R: Encodable>: Encodable {
    let id: String
    let ok: Bool
    let result: R
}

struct ErrorResponse: Encodable {
    let id: String
    let ok: Bool
    let error: String
}

// MARK: - I/O helpers

let encoder = JSONEncoder()
let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError
let newline = Data([0x0A])

func emit<T: Encodable>(_ value: T) {
    guard let data = try? encoder.encode(value) else { return }
    stdoutHandle.write(data)
    stdoutHandle.write(newline)
}

func logErr(_ message: String) {
    stderrHandle.write(Data((message + "\n").utf8))
}

func logProgress(_ stage: String, _ progress: Double, _ message: String) {
    let clamped = min(100.0, max(0.0, progress * 100.0))
    let percent: String
    if clamped > 0.0, clamped < 1.0 {
        percent = String(format: "%.2f", clamped)
    } else if clamped < 10.0 {
        percent = String(format: "%.1f", clamped)
    } else {
        percent = String(format: "%.0f", clamped)
    }
    logErr("[sidecar] \(stage) \(percent)% \(message)")
}

// MARK: - model state

// The model is not thread-safe (per Qwen3TTS docs) but this sidecar reads from
// stdin one line at a time and dispatches synchronously, so all mutations
// happen on the same thread.
final class ModelHolder: @unchecked Sendable {
    private var model: Qwen3TTSModel?
    private var tokenizerEncoder: SpeechTokenizerEncoder?
    private var loadedModelId: String?

    /// `requestedId == nil` reuses whatever is loaded; a different id reloads.
    func load(modelId requestedId: String? = nil) async throws -> (Qwen3TTSModel, SpeechTokenizerEncoder) {
        if let m = model, let e = tokenizerEncoder,
           requestedId == nil || requestedId == loadedModelId {
            return (m, e)
        }
        if model != nil { unload() }
        // 1.7B bf16 is the highest-fidelity variant. Its 4-bit was dropped (it
        // degraded badly — near-silent/garbled on some inputs); 8-bit remains an
        // option through the Studio's weights picker. SONIQO_TTS_MODEL_ID only
        // covers direct callers that omit modelId.
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_TTS_MODEL_ID"]
            ?? Qwen3TTSModel.defaultModelId
        logErr("[sidecar] loading Qwen3-TTS model \(modelId) (first run downloads weights from HuggingFace)…")
        let result = try await Qwen3TTSModel.fromPretrainedWithEncoder(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] model %3d%% %@", Int(progress * 100), message))
            }
        )
        model = result.0
        tokenizerEncoder = result.1
        loadedModelId = modelId
        logErr("[sidecar] model ready")
        return result
    }

    func unload() {
        model?.unload()
        model = nil
        tokenizerEncoder = nil
        loadedModelId = nil
    }
}

let holder = ModelHolder()

// MARK: - CosyVoice model state

/// Lazily loaded CosyVoice model + auxiliary models needed for voice cloning.
/// Profile cache lives here too — voice cloning has two phases (profile
/// extraction ~1s, synthesis ~1s) and the profile only depends on the
/// reference clip, so we key by `referenceAudioPath` + the file's mtime/size.
final class CosyHolder: @unchecked Sendable {
    private var model: CosyVoiceTTSModel?
    private var speechTokenizer: SpeechTokenizerModel?
    private var profileCache: [String: CosyVoiceVoiceProfile] = [:]
    private var loadedModelId: String?

    /// `requestedId == nil` reuses whatever is loaded; a different id reloads
    /// (the Studio's weights picker: bf16 ↔ 8-bit bundles).
    func load(modelId requestedId: String? = nil) async throws -> (CosyVoiceTTSModel, SpeechTokenizerModel) {
        if let m = model, let s = speechTokenizer,
           requestedId == nil || requestedId == loadedModelId {
            return (m, s)
        }
        if model != nil { unload() }
        // Default: the full bf16 bundle — LLM and DiT unquantized (~2.1 GB on
        // disk), the quality-first choice. The Studio registry selects the
        // artifact per request; the env var only covers direct callers.
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_COSYVOICE_MODEL_ID"]
            ?? CosyVoiceTTSModel.defaultModelId
        logErr("[sidecar] loading CosyVoice model \(modelId)…")

        // 1. Main TTS bundle (LLM + Flow + HiFiGAN + tokenizer)
        let cosy = try await CosyVoiceTTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] cosy %3d%% %@", Int(progress * 100), message))
            }
        )

        // 2. Speech tokenizer (S3 v3) — produces FSQ codes from reference audio.
        // CosyVoiceTTSModel.fromPretrained doesn't fetch speech_tokenizer.safetensors,
        // so we download it explicitly into the same cache dir.
        let cacheDir = try HuggingFaceDownloader.getCacheDirectory(for: modelId)
        let stURL = cacheDir.appendingPathComponent("speech_tokenizer.safetensors")
        if !FileManager.default.fileExists(atPath: stURL.path) {
            logErr("[sidecar] downloading speech_tokenizer.safetensors…")
            try await HuggingFaceDownloader.downloadWeights(
                modelId: modelId,
                to: cacheDir,
                additionalFiles: ["speech_tokenizer.safetensors"],
                progressHandler: { progress in
                    logErr(String(format: "[sidecar] cosy speech_tokenizer %3d%%", Int(progress * 100)))
                }
            )
        }
        let tokenizer = try SpeechTokenizerModel.fromSafetensors(at: stURL)
        logErr("[sidecar] cosy speech tokenizer loaded")

        // Deliberately NOT loading CAM++ — for single-voice zero-shot cloning
        // the CLI passes prompt_token + prompt_feat WITHOUT a speaker embedding
        // (mixing them causes the LLM to emit neutral-voice tokens that
        // conflict with the flow's anchors; see CosyVoiceTTS.swift L226).
        // CAM++ is only needed for multi-speaker dialogue, which the studio
        // doesn't use.

        model = cosy
        speechTokenizer = tokenizer
        loadedModelId = modelId
        logErr("[sidecar] cosy ready")
        return (cosy, tokenizer)
    }

    /// Get or compute the voice profile for a reference clip. Keyed by
    /// path + mtime + size so an edited reference invalidates the cache.
    func voiceProfile(
        for refPath: String,
        referenceText: String?,
        samples: [Float],
        sampleRate: Int
    ) throws -> CosyVoiceVoiceProfile {
        guard let tokenizer = speechTokenizer else {
            throw NSError(domain: "soniqo-sidecar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CosyVoice models not loaded yet"
            ])
        }
        guard let model = model else {
            throw NSError(domain: "soniqo-sidecar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "CosyVoice model not loaded"
            ])
        }
        // Re-extract every call (cache disabled while we debug). The cached
        // MLXArrays may have been evicted by MLX memory pressure across synth
        // calls, leaving stale dangling references.
        _ = (refPath, profileCache)  // keep params + field for now
        let profile = try model.extractVoiceProfile(
            audio: samples,
            sampleRate: sampleRate,
            speechTokenizer: tokenizer,
            camppSpeaker: nil,
            referenceTranscript: referenceText
        )
        logErr("[sidecar] cosy extracted voice profile fresh (\(samples.count) samples @ \(sampleRate)Hz)")
        return profile
    }

    private func cacheKey(for path: String, referenceText: String?) -> String {
        // Use file mtime + size in the key so re-uploading a different clip at
        // the same path invalidates the cache. Falls back to path alone if
        // stat fails (rare).
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let size = (attrs?[.size] as? Int) ?? 0
        let textHash = referenceText?.hashValue ?? 0
        return "\(path)#\(Int(mtime))#\(size)#\(textHash)"
    }

    func unload() {
        model?.unload()
        model = nil
        speechTokenizer = nil
        profileCache.removeAll()
        loadedModelId = nil
    }
}

let cosyHolder = CosyHolder()

// MARK: - VoxCPM2 model state

/// A model-download failure annotated with the manual recovery path.
///
/// The request loop serializes errors with `"\(error)"` interpolation, which
/// calls `String(describing:)` — NOT `errorDescription`. A plain
/// LocalizedError struct would render as a reflection dump there, so the
/// guidance lives in CustomStringConvertible.description and
/// errorDescription forwards to it.
struct ModelDownloadFailure: LocalizedError, CustomStringConvertible {
    let underlying: Error
    let modelId: String
    let modelDir: String
    let tokenizerDir: String

    var description: String {
        """
        \(underlying.localizedDescription) \
        You can pre-download the model manually: weights from \
        huggingface.co/\(modelId) into \(modelDir), tokenizer files from \
        huggingface.co/openbmb/VoxCPM2 into \(tokenizerDir). See "Manual \
        model download" in the README: \
        https://github.com/soniqo/speech-studio#manual-model-download-macos
        """
    }

    var errorDescription: String? { description }
}

/// Lazily loaded VoxCPM2 TTS model. VoxCPM2 cloning is dramatically simpler
/// than CosyVoice ICL: pass `refAudio` (16 kHz samples) and the model encodes
/// it through its AudioVAE — no reference transcript required, no FSQ codes,
/// no flow-anchor coupling. The `instruct` parameter carries emotional/style
/// cues (e.g. "excited", "whispering") which the library wraps as
/// "(<instruct>){text}" before tokenising.
final class VoxCPM2Holder: @unchecked Sendable {
    private var model: VoxCPM2TTSModel?
    private var loadedModelId: String?

    func load(modelId requestedId: String? = nil) async throws -> VoxCPM2TTSModel {
        // Default variant: bf16. The Studio's weights picker selects int8 for
        // low-memory machines by sending its modelId; SONIQO_VOXCPM2_MODEL_ID
        // only covers direct callers that omit modelId.
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_VOXCPM2_MODEL_ID"]
            ?? VoxCPM2TTSModel.defaultModelId
        if let m = model, loadedModelId == modelId { return m }
        if model != nil { unload() }
        logErr("[sidecar] loading VoxCPM2 model \(modelId)…")
        let m: VoxCPM2TTSModel
        do {
            m = try await VoxCPM2TTSModel.fromPretrained(
                modelId: modelId,
                progressHandler: { progress, message in
                    logErr(String(format: "[sidecar] vox %3d%% %@", Int(progress * 100), message))
                }
            )
        } catch let error as DownloadError {
            // The user-facing dead end of issue #15: a failed first-run
            // download with no hint where to put manually-fetched files.
            // Resolve the live cache dirs once, here (honors QWEN3_CACHE_DIR
            // overrides), so rendering the message later has no side effects.
            let modelDir = (try? HuggingFaceDownloader.getCacheDirectory(for: modelId))?.path
                ?? "~/Library/Caches/qwen3-speech/models/\(modelId)"
            let tokenizerDir = (try? HuggingFaceDownloader.getCacheDirectory(
                for: "openbmb/VoxCPM2", cacheDirName: "qwen3-speech-voxcpm2-tokenizer"))?.path
                ?? "~/Library/Caches/qwen3-speech-voxcpm2-tokenizer/models/openbmb/VoxCPM2"
            throw ModelDownloadFailure(
                underlying: error, modelId: modelId,
                modelDir: modelDir, tokenizerDir: tokenizerDir)
        }
        model = m
        loadedModelId = modelId
        logErr("[sidecar] vox ready")
        return m
    }

    func unload() {
        model?.unload()
        model = nil
        loadedModelId = nil
    }
}

let voxHolder = VoxCPM2Holder()

// MARK: - Chatterbox model state

/// Lazily loaded Chatterbox multilingual TTS model. Cloning takes the reference
/// clip + target text + a language id (the `[lang]` token the tokenizer
/// prepends) — no reference transcript. The published bundle ships its conformer
/// + S3 tokenizer weights, so the load is self-contained.
final class ChatterboxHolder: @unchecked Sendable {
    private var model: ChatterboxTTSModel?
    private var loadedModelId: String?

    /// `requestedId == nil` reuses the loaded model; a different id reloads (quant switch).
    func load(modelId requestedId: String? = nil) async throws -> ChatterboxTTSModel {
        if let m = model, requestedId == nil || requestedId == loadedModelId { return m }
        if model != nil { unload() }
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_CHATTERBOX_MODEL_ID"]
            ?? ChatterboxTTSModel.defaultModelId
        logErr("[sidecar] loading Chatterbox model \(modelId)…")
        let m = try await ChatterboxTTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] cbx %3d%% %@", Int(progress * 100), message))
            }
        )
        model = m
        loadedModelId = modelId
        logErr("[sidecar] cbx ready")
        return m
    }

    func unload() {
        // ChatterboxTTSModel has no explicit teardown; drop the reference and let
        // ARC + MLX.Memory.clearCache() (in unloadInactiveModels) reclaim Metal.
        model = nil
        loadedModelId = nil
    }
}

let chatterboxHolder = ChatterboxHolder()

// MARK: - OmniVoice model state

/// Lazily loaded OmniVoice model (NAR diffusion + Higgs codec). Cloning takes the
/// reference clip + target text + a language id; a reference transcript is optional
/// but improves prosody. The published fp16 bundle is self-contained (backbone +
/// codec + tokenizer).
final class OmniVoiceHolder: @unchecked Sendable {
    private var model: OmniVoiceTTSModel?
    private var loadedModelId: String?

    func load(modelId requestedId: String? = nil) async throws -> OmniVoiceTTSModel {
        if let m = model, requestedId == nil || requestedId == loadedModelId { return m }
        if model != nil { unload() }
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_OMNIVOICE_MODEL_ID"]
            ?? OmniVoiceTTSModel.defaultModelId
        logErr("[sidecar] loading OmniVoice model \(modelId)…")
        let m = try await OmniVoiceTTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] omni %3d%% %@", Int(progress * 100), message))
            }
        )
        model = m
        loadedModelId = modelId
        logErr("[sidecar] omni ready")
        return m
    }

    func unload() {
        model = nil
        loadedModelId = nil
    }
}

let omnivoiceHolder = OmniVoiceHolder()

// MARK: - Indic-Mio model state

/// Lazily loaded Indic-Mio model (Qwen3 speech-token LM + MioCodec decoder).
///
/// The model supports Hindi/Indic emotion tags such as `<happy>` and `<angry>`,
/// plus reference-audio cloning through its WavLM → MioCodec global embedding
/// path.
final class IndicMioHolder: @unchecked Sendable {
    private var model: IndicMioTTSModel?
    private var loadedModelId: String?
    // The global speaker embedding is a pure function of the reference audio,
    // so cache it per reference path. WavLM (a heavy SSL transformer over the
    // whole reference) then runs once per voice instead of once per synthesis
    // — the dominant per-call cost. Reference paths are content-hashed, so a
    // changed clip lands on a new key. Cleared whenever the model is swapped.
    private var embeddingCache: [String: [Float]] = [:]

    func load(modelId requestedId: String? = nil) async throws -> IndicMioTTSModel {
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_INDIC_MIO_MODEL_ID"]
            ?? IndicMioTTSModel.defaultModelId
        if let m = model, loadedModelId == modelId { return m }
        if model != nil { unload() }
        logErr("[sidecar] loading Indic-Mio model \(modelId)…")
        let m = try await IndicMioTTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] indic-mio %3d%% %@", Int(progress * 100), message))
            }
        )
        model = m
        loadedModelId = modelId
        logErr("[sidecar] indic-mio ready")
        return m
    }

    /// Global speaker embedding for a reference, computed once per path and
    /// reused thereafter. `model` must be the currently loaded instance so the
    /// cache and the embedding space stay in sync.
    func globalEmbedding(
        using model: IndicMioTTSModel,
        referencePath: String,
        referenceAudio: [Float],
        referenceSampleRate: Int
    ) async throws -> (embedding: [Float], cached: Bool) {
        if let cached = embeddingCache[referencePath] {
            return (cached, true)
        }
        let embedding = try await model.extractGlobalEmbedding(
            referenceAudio: referenceAudio,
            referenceSampleRate: referenceSampleRate)
        embeddingCache[referencePath] = embedding
        return (embedding, false)
    }

    func unload() {
        model = nil
        loadedModelId = nil
        embeddingCache.removeAll()
    }
}

let indicMioHolder = IndicMioHolder()

// MARK: - Fish Audio model state

/// Lazily loaded Fish Audio S2 Pro runtime. It supports raw reference-audio
/// cloning when the caller also supplies the reference transcript, and explicit
/// inline bracket markers such as `[excited]`, `[angry]`, and `[whisper]`.
final class FishAudioHolder: @unchecked Sendable {
    private var model: FishAudioTTSModel?
    private var loadedModelId: String?

    func load(modelId requestedId: String? = nil) async throws -> FishAudioTTSModel {
        let modelId = requestedId
            ?? ProcessInfo.processInfo.environment["SONIQO_FISH_AUDIO_MODEL_ID"]
            ?? FishAudioTTSModel.defaultModelId
        if let m = model, loadedModelId == modelId { return m }
        if model != nil { unload() }
        logErr("[sidecar] loading Fish Audio model \(modelId)…")
        let m = try await FishAudioTTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logProgress("fish-audio", progress, message)
            }
        )
        model = m
        loadedModelId = modelId
        logErr("[sidecar] fish-audio ready")
        return m
    }

    func unload() {
        model = nil
        loadedModelId = nil
    }
}

let fishAudioHolder = FishAudioHolder()

// MARK: - Parakeet ASR model state

/// Lazily loaded Parakeet ASR model for dictation. It is separate from the
/// voice-cloning engine selector: recording a transcript should not force the
/// user to switch TTS models.
final class ParakeetHolder: @unchecked Sendable {
    private var model: ParakeetASRModel?
    private var loadedModelId: String?

    func load() async throws -> ParakeetASRModel {
        if let m = model { return m }
        let modelId = ProcessInfo.processInfo.environment["SONIQO_PARAKEET_ASR_MODEL_ID"]
            ?? ParakeetASRModel.defaultModelId
        logErr("[sidecar] loading Parakeet ASR model \(modelId)…")
        let m = try await ParakeetASRModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logProgress("parakeet", progress, message)
            }
        )
        try m.warmUp()
        model = m
        loadedModelId = modelId
        logErr("[sidecar] parakeet ready")
        return m
    }

    func modelId() -> String {
        loadedModelId ?? ProcessInfo.processInfo.environment["SONIQO_PARAKEET_ASR_MODEL_ID"]
            ?? ParakeetASRModel.defaultModelId
    }

    func unload() {
        model = nil
        loadedModelId = nil
    }
}

let parakeetHolder = ParakeetHolder()

// Engine selector. CosyVoice is the default. SONIQO_TTS_ENGINE remains a
// process-level compatibility override, but Studio chooses the engine per
// request so a user can switch without restarting the app.
enum TTSEngine: String {
    case voxcpm2, cosyvoice, qwen3, chatterbox, omnivoice
    case indicMio = "indic-mio"
    case fishAudio = "fish-audio"
}

let defaultEngine: TTSEngine = {
    if let raw = ProcessInfo.processInfo.environment["SONIQO_TTS_ENGINE"]?.lowercased(),
       let e = TTSEngine(rawValue: raw) { return e }
    return .cosyvoice
}()

func requestedEngine(for request: Request) -> TTSEngine? {
    guard let raw = request.engine?.lowercased() else { return defaultEngine }
    return TTSEngine(rawValue: raw)
}

/// Legacy direct callers selected a backend by command name. Preserve that
/// behavior when `engine` is omitted, while making mismatched Studio requests
/// fail rather than accidentally synthesizing with the wrong model.
func requestMatchesEngine(_ request: Request, _ expected: TTSEngine) -> Bool {
    guard let raw = request.engine?.lowercased() else { return true }
    return TTSEngine(rawValue: raw) == expected
}

func unloadInactiveModels(keeping engine: TTSEngine) {
    // Keep exactly one large model resident; release every other engine.
    if engine != .voxcpm2 { voxHolder.unload() }
    if engine != .cosyvoice { cosyHolder.unload() }
    if engine != .qwen3 { holder.unload() }
    if engine != .chatterbox { chatterboxHolder.unload() }
    if engine != .omnivoice { omnivoiceHolder.unload() }
    if engine != .indicMio { indicMioHolder.unload() }
    if engine != .fishAudio { fishAudioHolder.unload() }
    MLX.Memory.clearCache()
}

// The NDJSON loop is synchronous, so this process-wide state cannot race.
// It avoids clearing MLX's reusable buffer cache for ordinary synthesis while
// still guaranteeing that an engine switch releases the old model first.
var residentEngine: TTSEngine?

func activateEngine(_ engine: TTSEngine) {
    guard residentEngine != engine else { return }
    unloadInactiveModels(keeping: engine)
    residentEngine = engine
}

// MARK: - output cache

func clipsCacheDir() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Caches", isDirectory: true)
        .appendingPathComponent("audio.soniqo.studio", isDirectory: true)
        .appendingPathComponent("clips", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func conditionAudioEdges(
    _ samples: [Float],
    sampleRate: Int,
    preTrimMs: Int = 0,
    leadInMs: Int = 100,
    postRollMs: Int = 240,
    fadeInMs: Int = 40,
    fadeOutMs: Int = 40
) -> [Float] {
    guard !samples.isEmpty else { return samples }

    let preTrim = min(samples.count, max(0, sampleRate * preTrimMs / 1000))
    var body = Array(samples.dropFirst(preTrim))
    guard !body.isEmpty else { return samples }

    let fadeIn = min(body.count, max(0, sampleRate * fadeInMs / 1000))
    if fadeIn > 1 {
        for i in 0..<fadeIn {
            let t = Float(i) / Float(fadeIn - 1)
            let gain = t * t * (3 - 2 * t)
            body[i] *= gain
        }
    }

    let fadeOut = min(body.count, max(0, sampleRate * fadeOutMs / 1000))
    if fadeOut > 1 {
        for i in 0..<fadeOut {
            let idx = body.count - fadeOut + i
            let t = 1 - Float(i) / Float(fadeOut - 1)
            let gain = t * t * (3 - 2 * t)
            body[idx] *= gain
        }
    }

    let lead = max(0, sampleRate * leadInMs / 1000)
    let tail = max(0, sampleRate * postRollMs / 1000)
    guard lead > 0 || tail > 0 else { return body }

    var out = [Float]()
    out.reserveCapacity(lead + body.count + tail)
    out.append(contentsOf: repeatElement(0.0, count: lead))
    out.append(contentsOf: body)
    out.append(contentsOf: repeatElement(0.0, count: tail))
    return out
}

/// Remove non-speech junk some engines emit before the real speech onset.
/// Two measured shapes of the same reference-dependent codec-boundary
/// artifact: Qwen3 ICL opens Marek renders with ~100 ms of quiet
/// fricative-like hiss (median ZCR ≈ 0.4, 25 dB below the speech peak);
/// OmniVoice opens Anna renders with ~200 ms of low-frequency hum (median
/// ZCR ≈ 0.02, 10–15 dB below the peak). Both are followed by a silence gap
/// before the phrase. A fixed pre-trim can't cover them: the residue runs
/// past 150 ms on affected renders while unaffected ones start voiced within
/// 25 ms, so any constant either leaves junk or eats a first phoneme.
///
/// Detect instead: group audio into energy islands and drop leading islands
/// that are short, clearly quieter than the clip's loudest island, and
/// separated from what follows by a silence gap (a genuine onset phoneme
/// hangs directly onto its word). Real first words live in islands hundreds
/// of ms long, so the length + gap + quietness tests do the heavy lifting;
/// see the two-tier shape test below for how the borderline loudness band
/// is handled. Junk-free audio returns unchanged.
func trimLeadingJunk(_ samples: [Float], sampleRate: Int) -> [Float] {
    let win = max(1, sampleRate * 5 / 1000)  // 5 ms analysis windows
    let total = samples.count / win
    guard total > 8 else { return samples }

    var dbs = [Float]()
    var zcrs = [Float]()
    dbs.reserveCapacity(total)
    zcrs.reserveCapacity(total)
    for i in 0..<total {
        var energy: Float = 0
        var crossings = 0
        for j in (i * win)..<((i + 1) * win) {
            energy += samples[j] * samples[j]
            if j > i * win && (samples[j] < 0) != (samples[j - 1] < 0) {
                crossings += 1
            }
        }
        energy /= Float(win)
        dbs.append(energy > 0 ? 10 * log10(energy) : -120)
        zcrs.append(Float(crossings) / Float(win - 1))
    }

    // Islands: runs of windows above the noise floor, closed by ≥50 ms quiet.
    // Track each island's peak and its median ZCR over above-floor windows.
    let floorDb: Float = -60
    let closeGap = 10
    struct Island {
        var start: Int
        var end: Int
        var peak: Float
        var zcrSamples: [Float]
        var medianZcr: Float {
            let sorted = zcrSamples.sorted()
            return sorted.isEmpty ? 0 : sorted[sorted.count / 2]
        }
    }
    var islands = [Island]()
    var open: Island?
    var quiet = 0
    for (i, db) in dbs.enumerated() {
        if db > floorDb {
            if open == nil {
                open = Island(start: i, end: i, peak: db, zcrSamples: [])
            }
            open!.peak = max(open!.peak, db)
            open!.zcrSamples.append(zcrs[i])
            quiet = 0
        } else if open != nil {
            quiet += 1
            if quiet >= closeGap {
                open!.end = i - quiet + 1
                islands.append(open!)
                open = nil
            }
        }
    }
    if var last = open {
        last.end = total
        islands.append(last)
    }
    guard let maxPeak = islands.map(\.peak).max(), maxPeak > -40 else {
        return samples
    }

    var trimIdx = 0
    for (i, island) in islands.enumerated() {
        // Junk shape, two tiers: ≥20 dB below the loudest island is
        // unmistakably sub-speech (the Qwen hiss runs 27 dB down, and no
        // intended word sits that far under its own clip's peak). Between
        // 8 and 20 dB down (the OmniVoice hum: 10–15 dB), additionally
        // require a pure low-frequency signature so short isolated words
        // with any consonant content are spared. Median ZCR is amplitude-
        // invariant, so fades and gain don't move it.
        //
        // Deliberately NOT gap-based: a quiet, short, gap-separated leading
        // island can be a real whispered onset word (VoxCPM2 renders "Just, …"
        // exactly that way), so trimming on the gap alone eats the first word.
        let quietDb = maxPeak - island.peak
        let shapeMatches = quietDb >= 20
            || (quietDb >= 8 && island.medianZcr <= 0.06)
        let isJunk = i < islands.count - 1
            && island.start * 5 <= 800             // near the head of the clip
            && (island.end - island.start) * 5 <= 300
            && (islands[i + 1].start - island.end) * 5 >= 80  // gap after
            && shapeMatches
        if !isJunk {
            // Trim only when junk islands were actually skipped, to just
            // before the first real island — keeping 60 ms of natural
            // lead-in ahead of the onset. Junk-free audio returns unchanged.
            if i > 0 {
                trimIdx = max(0, island.start - 12)
            }
            break
        }
    }
    guard trimIdx > 0 else { return samples }
    return Array(samples.dropFirst(trimIdx * win))
}

/// The onset pipeline every cloning engine runs before writing its WAV: strip
/// leading codec/reference-boundary junk, then edge-condition. Several engines
/// (reference- and seed-dependent) open a take with a short quiet blip and a
/// silence gap before the first word — audible especially on quiet/whisper
/// takes. trimLeadingJunk removes it and returns clean audio unchanged, so
/// engines without junk are unaffected. `engine` labels the trim log line.
func conditionSynthOutput(
    _ generated: [Float],
    sampleRate: Int,
    engine: String,
    preTrimMs: Int = 0,
    leadInMs: Int = 100,
    postRollMs: Int = 240,
    fadeInMs: Int = 40,
    fadeOutMs: Int = 40
) -> [Float] {
    let dejunked = trimLeadingJunk(generated, sampleRate: sampleRate)
    if dejunked.count != generated.count {
        let trimmedMs = (generated.count - dejunked.count) * 1000 / sampleRate
        logErr("[sidecar] \(engine) onset junk: trimmed leading \(trimmedMs)ms")
    }
    return conditionAudioEdges(
        dejunked,
        sampleRate: sampleRate,
        preTrimMs: preTrimMs,
        leadInMs: leadInMs,
        postRollMs: postRollMs,
        fadeInMs: fadeInMs,
        fadeOutMs: fadeOutMs
    )
}

func safeFilename(_ s: String) -> String {
    s.replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: ":", with: "_")
}

// Strip XML-style emotion markers (<whisper>…</whisper>) from the script.
// Qwen3-TTS ICL doesn't consume inline markers; once a model that supports
// them lands, this becomes a passthrough.
func stripEmotionTags(_ s: String) -> String {
    var result = ""
    var inside = false
    for ch in s {
        if ch == "<" { inside = true; continue }
        if ch == ">" { inside = false; continue }
        if !inside { result.append(ch) }
    }
    return result
}

/// Map of short emotion tag names → full natural-language instruct sentences
/// for VoxCPM2. Borrowed from soniqo-web's remotion voiceover pipeline:
/// passing the descriptive sentence (not just the tag name) gives the model
/// a much richer style signal and produces noticeably more consistent
/// renditions of the same emotion across different lines.
let emotionInstructs: [String: String] = [
    "excited": "Speak with energetic, animated excitement while staying natural and conversational.",
    "happy": "Speak warmly and lightly, with a small smile in the voice.",
    "calm": "Speak calmly and clearly, with steady, unhurried pacing.",
    "soft": "Speak softly and gently, with a quiet, reflective tone.",
    "serious": "Speak with focused confidence and measured emphasis.",
    "warm": "Speak warmly and reassuringly, with a friendly, supportive tone.",
    "surprised": "Speak with a brief sense of impressed surprise, then return to clarity.",
    "whisper": "Speak softly and intimately, almost a whisper, but keep the words clear.",
    "whispers": "Speak softly and intimately, almost a whisper, but keep the words clear.",
    "whispering": "Speak softly and intimately, almost a whisper, but keep the words clear.",
    "sad": "Speak gently and reflectively without sounding theatrical.",
    "angry": "Speak with controlled urgency, not aggression.",
    "intense": "Speak with quiet intensity and resolute determination.",
    "dramatic": "Speak with theatrical weight, holding the listener's attention.",
    "laughs": "Add a light amused tone without reading laughter literally.",
]

/// OmniVoice's `instruct` is a RESTRICTED vocabulary, not free text: only
/// accent / age / gender / pitch / `whisper` items are valid (e.g. "whisper",
/// "high pitch", "low pitch"). An unrecognized free-text string tokenizes into
/// garbage `<|instruct|>` tokens that corrupt generation (rushed pacing, repeated
/// words, spurious leading words) and is otherwise ignored. So markers map to the
/// closest valid item: `whisper` directly, and emotions approximated by pitch
/// (heightened -> high pitch, subdued -> low pitch). Markers with no sensible item
/// fall through to no instruct.
let omniVoiceInstructs: [String: String] = [
    "whisper": "whisper", "whispers": "whisper", "whispering": "whisper",
    "excited": "high pitch", "happy": "high pitch", "surprised": "very high pitch",
    "laughs": "high pitch", "angry": "high pitch", "intense": "high pitch",
    "dramatic": "high pitch",
    "sad": "low pitch", "calm": "low pitch", "serious": "low pitch",
    "soft": "low pitch", "warm": "low pitch",
]

/// Pull the first emotion marker out of a clip's text and return the cleaned
/// body alongside the descriptive instruct sentence. Two marker shapes are
/// supported (only the first match is used):
///
///   (excited) Welcome to the show.    — parenthetical, soniqo-web style
///   <excited>Welcome to the show.</excited>  — XML-like, our earlier syntax
///
/// The tag name is looked up in `emotionInstructs`. If it matches a known
/// emotion we return the full descriptive sentence as `instruct`; if it
/// doesn't match a known emotion we pass the raw tag name through (so
/// custom one-off descriptions like `(very calm)` still work).
func extractFirstEmotionTag(_ s: String) -> (text: String, tag: String?, instruct: String?) {
    var firstTag: String? = nil
    var body = s

    // Parenthetical form first: matches "(tag)" at the start of the line or
    // anywhere else. Allow lowercase letters, spaces, hyphens, slashes — same
    // permissive shape soniqo-web uses.
    if let parenRange = body.range(
        of: #"\(\s*([a-zA-Z][a-zA-Z\s/\-]*?)\s*\)"#,
        options: .regularExpression
    ) {
        let inner = body[parenRange]
            .dropFirst().dropLast()  // strip ( and )
            .trimmingCharacters(in: .whitespaces)
        if !inner.isEmpty {
            firstTag = inner.lowercased()
        }
        body.removeSubrange(parenRange)
    }

    // XML-like form: <tag>...</tag>. Pull the tag name from the opening tag,
    // then strip ALL angle-bracketed segments from the body.
    if firstTag == nil {
        if let openRange = body.range(
            of: #"<\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*>"#,
            options: .regularExpression
        ) {
            let opener = body[openRange]
            let tagName = opener
                .dropFirst().dropLast()
                .trimmingCharacters(in: .whitespaces)
                .lowercased()
            if !tagName.isEmpty {
                firstTag = tagName
            }
        }
        // Strip all <...> sequences from the body (open + close tags).
        body = body.replacingOccurrences(
            of: #"<[^>]+>"#, with: "", options: .regularExpression
        )
    }

    let cleanBody = body
        .replacingOccurrences(of: "  ", with: " ")
        .trimmingCharacters(in: .whitespaces)
    let trimmedBody = cleanBody.isEmpty ? body : cleanBody

    guard let tag = firstTag else {
        return (trimmedBody, nil, nil)
    }
    let instruct = emotionInstructs[tag] ?? tag  // fall back to raw tag
    return (trimmedBody, tag, instruct)
}

/// Chatterbox has no free-text style input — its only emotion lever is a single
/// `exaggeration` scalar (T3's emotion-advisor input; 0.5 ≈ neutral, higher =
/// more emotionally intense/expressive, lower = flatter/calmer). It can't pick a
/// *kind* of emotion, only intensity, so map each marker to an intensity here.
/// Unknown / no marker → 0.5 (neutral).
/// Chatterbox's exaggeration response is flat between ~0.5 and ~1.0 and only
/// becomes expressive above ~1.5 (measured: f0 mean 174→203 Hz, f0 std 18→52
/// from 1.0→2.0). So high-emotion tags reach into 1.5–2.0 and calm tags sit at
/// 0.3–0.5 — straddling the dead middle so the contrast is actually audible.
let emotionExaggeration: [String: Float] = [
    "dramatic": 2.0, "intense": 1.8, "excited": 1.8, "angry": 1.7,
    "surprised": 1.5, "laughs": 1.5, "happy": 1.3,
    "warm": 0.5, "serious": 0.5,
    "sad": 0.4, "calm": 0.35, "soft": 0.35,
    "whisper": 0.3, "whispers": 0.3, "whispering": 0.3,
]

// MARK: - MLX memory

// MLX defaults the buffer-pool cache limit to ~1.5× Metal's recommended
// working-set size. On unified-memory Macs that lets RSS grow to tens of GB
// after a handful of synth calls — KV / flow / vocoder buffers of varying
// shapes never recycle and accumulate. Cap the cache to keep steady-state
// memory predictable. Override with SONIQO_MLX_CACHE_MB=<int> when tuning.
let mlxCacheMB: Int = {
    if let raw = ProcessInfo.processInfo.environment["SONIQO_MLX_CACHE_MB"],
       let n = Int(raw), n > 0 {
        return n
    }
    return 1024
}()
MLX.Memory.cacheLimit = mlxCacheMB * 1024 * 1024
logErr("[sidecar] mlx cacheLimit=\(mlxCacheMB) MB")

/// Process-level figures to go with MLX's own accounting. `phys_footprint` is
/// what Activity Monitor shows as "Memory" and includes Metal unified-memory
/// buffers; plain resident size under-reports those by ~3× on Apple Silicon.
func processMemoryMB() -> (rss: Int, footprint: Int)? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) { ptr in
        ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    guard kr == KERN_SUCCESS else { return nil }
    let mb = 1024 * 1024
    return (Int(info.resident_size) / mb, Int(info.phys_footprint) / mb)
}

/// One line the Studio parses into its Activity panel's memory readout:
/// `[sidecar] mem <label> active=..M cache=..M peak=..M rss=..M footprint=..M`.
func logMemorySnapshot(_ label: String) {
    let snap = MLX.Memory.snapshot()
    let mb = { (b: Int) in b / (1024 * 1024) }
    var line = "[sidecar] mem \(label) active=\(mb(snap.activeMemory))M cache=\(mb(snap.cacheMemory))M peak=\(mb(snap.peakMemory))M"
    if let proc = processMemoryMB() {
        line += " rss=\(proc.rss)M footprint=\(proc.footprint)M"
    }
    logErr(line)
}

// MARK: - main loop

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }

    guard let request = try? JSONDecoder().decode(Request.self, from: data) else {
        emit(ErrorResponse(id: "", ok: false, error: "malformed request"))
        continue
    }

    switch request.command {
    case "ping":
        emit(SuccessResponse(
            id: request.id,
            ok: true,
            result: PingResult(pong: true, version: "0.1.0")
        ))

    case "init_model":
        guard let engine = requestedEngine(for: request) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "unsupported engine: \(request.engine ?? "")"
            ))
            continue
        }
        do {
            // Keep exactly one large model resident. Loading both VoxCPM2 and
            // CosyVoice would needlessly exhaust unified memory on common
            // Apple Silicon configurations.
            activateEngine(engine)
            switch engine {
            case .voxcpm2:
                _ = try await voxHolder.load(modelId: request.modelId)
            case .cosyvoice:
                _ = try await cosyHolder.load(modelId: request.modelId)
            case .qwen3:
                _ = try await holder.load(modelId: request.modelId)
            case .chatterbox:
                _ = try await chatterboxHolder.load(modelId: request.modelId)
            case .omnivoice:
                _ = try await omnivoiceHolder.load(modelId: request.modelId)
            case .indicMio:
                _ = try await indicMioHolder.load(modelId: request.modelId)
            case .fishAudio:
                _ = try await fishAudioHolder.load(modelId: request.modelId)
            }
            logMemorySnapshot("post-load-\(engine.rawValue)")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: InitResult(ready: true)
            ))
        } catch {
            logErr("[sidecar] init_model failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "transcribe_parakeet":
        guard let audioPath = request.audioPath, !audioPath.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "transcribe_parakeet requires audioPath"
            ))
            continue
        }

        do {
            let model = try await parakeetHolder.load()
            let started = CFAbsoluteTimeGetCurrent()
            let audio = try AudioFileLoader.load(
                url: URL(fileURLWithPath: audioPath),
                targetSampleRate: 16000
            )
            let text = try model.transcribeAudio(audio, sampleRate: 16000, language: request.language)
            let elapsed = CFAbsoluteTimeGetCurrent() - started
            let durationSec = Double(audio.count) / 16000.0
            logErr(String(format: "[sidecar] parakeet transcribed %.2fs in %.2fs", durationSec, elapsed))
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: TranscribeResult(
                    text: text,
                    modelName: "parakeet-tdt-v3-0.6b-int8",
                    modelId: parakeetHolder.modelId(),
                    sampleRate: 16000,
                    durationSec: durationSec,
                    elapsedSec: elapsed
                )
            ))
        } catch {
            logErr("[sidecar] parakeet transcription failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_voxcpm2":
        guard requestMatchesEngine(request, .voxcpm2) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_voxcpm2 requires engine voxcpm2"
            ))
            continue
        }
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_voxcpm2 requires referenceAudioPath and text"
            ))
            continue
        }

        do {
            activateEngine(.voxcpm2)
            let model = try await voxHolder.load(modelId: request.modelId)
            let refURL = URL(fileURLWithPath: refPath)
            // VoxCPM2's AudioVAE runs at 16 kHz internally; load the ref at
            // that rate so it lines up byte-for-byte with the CLI recipe.
            let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: 16000)

            // Inline emotion markers like "<excited>foo</excited>" are
            // stripped from the body and the first marker's name becomes the
            // instruct parameter — VoxCPM2's native style-conditioning input.
            // Markers nested across the whole line are flattened; mid-sentence
            // tag changes aren't supported yet (CosyVoice's model only takes
            // one global instruct anyway).
            let (cleanText, _, extractedInstruct) = extractFirstEmotionTag(targetText)
            let finalInstruct = request.instruct?.isEmpty == false
                ? request.instruct!
                : extractedInstruct

            logErr("[sidecar] vox synth voice=\(request.voiceId ?? "?") chars=\(cleanText.count) refSamples=\(refSamples.count) instruct=\(finalInstruct ?? "(none)")")

            // Seed CosyVoice-style. VoxCPM2 is deterministic per seed across
            // the LM + flow + vocoder; same seed → same audio.
            let seed = request.seed ?? 1000
            MLX.seed(seed)
            logErr("[sidecar] vox seed=\(seed)")

            let cfgValue = request.cfgValue ?? 2.0
            // Cap patch budget. The Rust side computes a tight per-clip cap
            // (~12 patches per text-word + headroom) to stop runaway repeats
            // before they finish a second pass. Default 2000 is far too loose
            // for short clips. Allow the Rust value through if smaller than
            // the library default; otherwise fall back to 2000.
            let maxTokens = request.maxTokens.map { Int($0) } ?? 2000
            let generatedAudio = try await model.generateVoxCPM2(
                text: cleanText,
                language: nil,
                maxTokens: maxTokens,
                minTokens: 2,
                refText: nil,           // VoxCPM2 doesn't need a transcript
                refAudio: refSamples,
                promptText: nil,
                promptAudio: nil,
                inferenceTimesteps: 10,
                cfgValue: cfgValue,
                streamingPrefixLen: 4,
                warmupPatches: 0,
                instruct: finalInstruct
            )

            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let sampleRate = model.sampleRate
            let audio = conditionSynthOutput(generatedAudio, sampleRate: sampleRate, engine: "voxcpm2")
            try WAVWriter.write(samples: audio, sampleRate: sampleRate, to: outURL)
            let durationSec = Double(audio.count) / Double(sampleRate)
            logMemorySnapshot("post-vox-synth")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: sampleRate,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] vox synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_cosyvoice":
        guard requestMatchesEngine(request, .cosyvoice) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_cosyvoice requires engine cosyvoice"
            ))
            continue
        }
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_cosyvoice requires referenceAudioPath and text"
            ))
            continue
        }

        do {
            activateEngine(.cosyvoice)
            let (model, _) = try await cosyHolder.load(modelId: request.modelId)
            let refURL = URL(fileURLWithPath: refPath)
            // Match the CLI: load reference at 16 kHz. extractVoiceProfile
            // resamples to 16k for the speech tokenizer and 24k for the flow
            // mel internally; feeding it 16k avoids a redundant 24k→16k resample
            // that produces marginally different FSQ codes.
            let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: 16000)

            // CosyVoice accepts one global instruction per clone render. The
            // speech-swift `instruct2` clone path keeps the Flow voice anchor
            // while applying this first inline emotion marker to the LLM.
            let (cleanText, _, extractedInstruct) = extractFirstEmotionTag(targetText)
            let finalInstruct = request.instruct?.isEmpty == false
                ? request.instruct!
                : extractedInstruct ?? "You are a helpful assistant."
            let language = request.language?.isEmpty == false ? request.language! : "english"
            logErr("[sidecar] cosy synth voice=\(request.voiceId ?? "?") lang=\(language) chars=\(cleanText.count) refSamples=\(refSamples.count) instruct=\(finalInstruct)")

            // Extract the voice profile from the reference.
            let profile = try cosyHolder.voiceProfile(
                for: refPath,
                referenceText: request.referenceText,
                samples: refSamples,
                sampleRate: 16000
            )

            // Seed MLX before each synth. CosyVoice is fully deterministic
            // given a seed (same seed → byte-identical audio), but quality
            // varies by seed: some (voice, text, seed) triples produce clean
            // target speech, others produce gibberish. The caller passes the
            // seed and is responsible for picking good ones (the Rust side
            // walks 1000, 1007, 1013, … with ASR-graded retry). Default 1000
            // matches the CLI's Phase 1 baseline that gave 97% coverage.
            let seed = request.seed ?? 1000
            MLX.seed(seed)
            logErr("[sidecar] cosy seed=\(seed)")

            // Synthesize. CosyVoice trims the prompt region internally using
            // promptMelLen × 480 samples. In practice the HiFi-GAN render
            // smears a fragment of the prompt audio past that boundary, so
            // listeners hear a short leak ("A colourings...", "Yeah. And...")
            // before the target. speakerEmbedding intentionally nil:
            // prompt_token + prompt_feat carries the voice.
            let rawAudio = model.synthesize(
                text: cleanText,
                language: language,
                instruction: finalInstruct,
                speakerEmbedding: nil,
                promptToken: profile.promptToken,
                promptFeat: profile.promptFeat,
                promptText: profile.promptText,
                verbose: false
            )

            // Extra leading-leak trim: drop the first ~0.30 s (7200 samples
            // at 24 kHz) to catch the smear past CosyVoice's internal prompt
            // trim. Skip when the output is shorter than the trim — the
            // unclipped audio is the only thing we've got.
            let extraTrimSamples = 7200
            let trimmedAudio: [Float]
            if rawAudio.count > extraTrimSamples * 2 {
                trimmedAudio = Array(rawAudio.dropFirst(extraTrimSamples))
            } else {
                trimmedAudio = rawAudio
            }

            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let audio = conditionSynthOutput(trimmedAudio, sampleRate: 24000, engine: "cosyvoice")
            try WAVWriter.write(samples: audio, sampleRate: 24000, to: outURL)

            let durationSec = Double(audio.count) / 24000.0
            logMemorySnapshot("post-cosy-synth")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: 24000,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] cosy synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_chatterbox":
        guard requestMatchesEngine(request, .chatterbox) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_chatterbox requires engine chatterbox"
            ))
            continue
        }
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_chatterbox requires referenceAudioPath and text"
            ))
            continue
        }

        do {
            activateEngine(.chatterbox)
            let model = try await chatterboxHolder.load(modelId: request.modelId)
            let refURL = URL(fileURLWithPath: refPath)
            // clone() resamples the reference to the rates it needs (24 kHz mel,
            // 16 kHz tokenizer) internally, so load it once at the mel rate.
            let refSamples = try AudioFileLoader.load(
                url: refURL, targetSampleRate: ChatterboxS3Gen.sampleRate)

            // Strip the inline emotion marker from the spoken text, but keep the
            // tag: Chatterbox can't take a free-text style instruction, so the
            // marker maps to its `exaggeration` intensity scalar instead.
            let (cleanText, emotionTag, _) = extractFirstEmotionTag(targetText)
            // request.exaggeration (0…2) overrides the marker map when supplied —
            // a direct intensity control for a future UI slider.
            let exaggeration = request.exaggeration ?? emotionTag.flatMap { emotionExaggeration[$0] } ?? 0.5
            // Couple cfgWeight to exaggeration as Resemble's reference recommends:
            // for more expressive speech, raise exaggeration AND lower cfg_weight
            // toward ~0.3; neutral (≤0.5) stays at 0.5. This makes the emotion land
            // stably instead of just scaling a flat conditioning. Ramp 0.5→0.3 over
            // exaggeration 0.5→1.0, floored at 0.3.
            let cfgWeight = max(0.3, min(0.5, 0.5 - (exaggeration - 0.5) * 0.4))
            let language = request.language?.isEmpty == false ? request.language! : "en"
            logErr("[sidecar] cbx synth voice=\(request.voiceId ?? "?") lang=\(language) tag=\(emotionTag ?? "(none)") exaggeration=\(exaggeration) cfg=\(cfgWeight) chars=\(cleanText.count) refSamples=\(refSamples.count)")

            // Seed the noise so a given (voice, text, language) is reproducible;
            // the Rust retry ladder varies it across attempts.
            let seed = request.seed ?? 1000
            MLX.seed(seed)

            // Greedy (temperature 0) for determinism. cfgWeight is derived above —
            // the request's cfgValue is VoxCPM2's CFG ladder (2.0+) and must NOT be
            // used as Chatterbox's classifier-free-guidance weight.
            let generatedAudio = try model.clone(
                referenceSamples: refSamples,
                sampleRate: ChatterboxS3Gen.sampleRate,
                text: cleanText,
                languageId: language,
                exaggeration: exaggeration,
                temperature: 0.0,
                cfgWeight: cfgWeight
            )

            let sampleRate = ChatterboxS3Gen.sampleRate
            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let audio = conditionSynthOutput(generatedAudio, sampleRate: sampleRate, engine: "chatterbox")
            try WAVWriter.write(samples: audio, sampleRate: sampleRate, to: outURL)
            let durationSec = Double(audio.count) / Double(sampleRate)
            logMemorySnapshot("post-cbx-synth")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: sampleRate,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] cbx synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_omnivoice":
        guard requestMatchesEngine(request, .omnivoice) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_omnivoice requires engine omnivoice"
            ))
            continue
        }
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_omnivoice requires referenceAudioPath and text"
            ))
            continue
        }

        do {
            activateEngine(.omnivoice)
            let model = try await omnivoiceHolder.load(modelId: request.modelId)
            // OmniVoice takes a restricted style instruction, so map the inline
            // marker to the closest valid vocabulary item and route it to the
            // model's instruct conditioning.
            let (cleanText, emotionTag, _) = extractFirstEmotionTag(targetText)
            // OmniVoice's instruct vocabulary is restricted (accent / age / gender
            // / pitch / whisper). Only pass a mapped valid item; free-text
            // instructions (the shared map or a request override) tokenize to
            // garbage and corrupt generation, so they are deliberately dropped.
            let finalInstruct = emotionTag.flatMap { omniVoiceInstructs[$0] }
            let language = request.language?.isEmpty == false ? request.language! : "en"
            // The diffusion decode is greedy/deterministic, but seed any MLX RNG so
            // the Rust retry ladder can still vary attempts if that changes.
            let seed = request.seed ?? 1000
            MLX.seed(seed)
            logErr("[sidecar] omni synth voice=\(request.voiceId ?? "?") lang=\(language) tag=\(emotionTag ?? "(none)") instruct=\(finalInstruct ?? "(none)") refText=\(request.referenceText != nil) chars=\(cleanText.count)")

            let generatedAudio = try model.generate(
                text: cleanText,
                referenceAudio: URL(fileURLWithPath: refPath),
                referenceText: request.referenceText,
                language: language,
                instruct: finalInstruct,
                duration: nil,
                numSteps: 16
            )

            let sampleRate = model.sampleRate
            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let audio = conditionSynthOutput(generatedAudio, sampleRate: sampleRate, engine: "omnivoice")
            try WAVWriter.write(samples: audio, sampleRate: sampleRate, to: outURL)
            let durationSec = Double(audio.count) / Double(sampleRate)
            logMemorySnapshot("post-omni-synth")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: sampleRate,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] omni synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_indic_mio":
        guard requestMatchesEngine(request, .indicMio) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_indic_mio requires engine indic-mio"
            ))
            continue
        }
        guard let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_indic_mio requires text"
            ))
            continue
        }

        do {
            activateEngine(.indicMio)
            let model = try await indicMioHolder.load(modelId: request.modelId)
            let language = request.language ?? "hindi"
            // Indic-Mio styles via a closed set of inline markers appended as
            // a suffix tag ("… <sad>"). Map the Studio marker onto that
            // vocabulary; unmapped markers are dropped rather than passed
            // through — the model reads unknown parentheticals aloud.
            let (cleanText, emotionTag, _) = extractFirstEmotionTag(targetText)
            let indicMioMarkers: [String: String] = [
                "happy": "happy",
                "sad": "sad",
                "angry": "angry",
                "disgust": "disgust", "disgusted": "disgust",
                "fear": "fear", "afraid": "fear", "scared": "fear",
                "surprise": "surprise", "surprised": "surprise",
            ]
            let mioTag = emotionTag.flatMap { indicMioMarkers[$0.lowercased()] }
            let finalText = mioTag.map { "\(cleanText) <\($0)>" } ?? cleanText
            let sampling = IndicMioSamplingConfig(
                maxNewTokens: request.maxTokens ?? 500,
                temperature: request.temperature ?? 0.3,
                topK: request.topK ?? 50,
                topP: 0.9,
                repetitionPenalty: request.repetitionPenalty ?? 1.0
            )
            logErr("[sidecar] indic-mio synth voice=\(request.voiceId ?? "?") lang=\(language) tag=\(emotionTag ?? "(none)") marker=\(mioTag.map { "<\($0)>" } ?? "(none)") chars=\(cleanText.count)")
            let audio: [Float]
            if let refPath = request.referenceAudioPath, !refPath.isEmpty {
                let refURL = URL(fileURLWithPath: refPath)
                let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: model.sampleRate)
                // Encode the reference once per voice; every later line (and
                // any re-render) reuses the cached speaker embedding instead of
                // re-running WavLM over the whole clip.
                let (embedding, cached) = try await indicMioHolder.globalEmbedding(
                    using: model,
                    referencePath: refPath,
                    referenceAudio: refSamples,
                    referenceSampleRate: model.sampleRate)
                logErr("[sidecar] indic-mio reference=\(refPath) samples=\(refSamples.count) @ \(model.sampleRate) Hz embedding=\(cached ? "cached" : "computed")")
                audio = try await model.generate(
                    text: finalText,
                    language: language,
                    globalEmbedding: embedding,
                    sampling: sampling
                )
            } else {
                audio = try await model.generate(
                    text: finalText,
                    language: language,
                    sampling: sampling
                )
            }
            let sampleRate = model.sampleRate
            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let conditionedAudio = conditionSynthOutput(audio, sampleRate: sampleRate, engine: "indic-mio")
            try WAVWriter.write(samples: conditionedAudio, sampleRate: sampleRate, to: outURL)
            let durationSec = Double(conditionedAudio.count) / Double(sampleRate)
            logErr(String(format: "[sidecar] indic-mio wrote %.2fs → %@", durationSec, outURL.path))
            logMemorySnapshot("post-indic-mio-synth")

            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: sampleRate,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] indic-mio synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_fish_audio":
        guard requestMatchesEngine(request, .fishAudio) else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_fish_audio requires engine fish-audio"
            ))
            continue
        }
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let refText = request.referenceText, !refText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_fish_audio requires referenceAudioPath, referenceText, and text"
            ))
            continue
        }

        do {
            activateEngine(.fishAudio)
            let model = try await fishAudioHolder.load(modelId: request.modelId)
            let seed = request.seed ?? 1000
            MLX.seed(seed)
            let maxTokens = request.maxTokens ?? 256
            let minTokens = min(
                request.minStopSteps ?? min(48, maxTokens),
                max(0, maxTokens - 1)
            )
            let sampling = FishAudioSamplingConfig(
                maxNewTokens: maxTokens,
                temperature: request.temperature ?? 1.0,
                topK: request.topK ?? 30,
                topP: 0.9,
                repetitionPenalty: request.repetitionPenalty ?? 1.0,
                minNewTokens: minTokens
            )
            logErr("[sidecar] fish-audio synth voice=\(request.voiceId ?? "?") seed=\(seed) chars=\(targetText.count) refTextChars=\(refText.count)")
            let generatedAudio = try await model.generate(
                text: targetText,
                referenceAudioURL: URL(fileURLWithPath: refPath),
                referenceText: refText,
                sampling: sampling
            )
            let sampleRate = model.sampleRate
            let audio = conditionSynthOutput(
                generatedAudio,
                sampleRate: sampleRate,
                engine: "fish-audio",
                leadInMs: 120,
                postRollMs: 220
            )
            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            try WAVWriter.write(samples: audio, sampleRate: sampleRate, to: outURL)
            let durationSec = Double(audio.count) / Double(sampleRate)
            logErr(String(format: "[sidecar] fish-audio wrote %.2fs → %@", durationSec, outURL.path))
            logMemorySnapshot("post-fish-audio-synth")

            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: sampleRate,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] fish-audio synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    case "synthesize_icl":
        guard let refPath = request.referenceAudioPath, !refPath.isEmpty,
              let refText = request.referenceText, !refText.isEmpty,
              let targetText = request.text, !targetText.isEmpty else {
            emit(ErrorResponse(
                id: request.id,
                ok: false,
                error: "synthesize_icl requires referenceAudioPath, referenceText, and text"
            ))
            continue
        }

        do {
            activateEngine(.qwen3)
            let (model, codecEncoder) = try await holder.load(modelId: request.modelId)

            let refURL = URL(fileURLWithPath: refPath)
            let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: 24000)

            let cleanText = stripEmotionTags(targetText)
            logErr("[sidecar] synth voice=\(request.voiceId ?? "?") chars=\(cleanText.count) refSamples=\(refSamples.count)")

            // Match speech-swift's CLI defaults for Qwen3. The previous 0.9
            // default was too creative for ICL cloning in Studio: it produced
            // onset junk and unstable EOS on otherwise clean references.
            var sampling = SamplingConfig(
                temperature: request.temperature ?? 0.3,
                topK: request.topK ?? 50,
                maxTokens: request.maxTokens ?? 500
            )
            if let r = request.repetitionPenalty { sampling.repetitionPenalty = r }
            let language = request.language?.trimmingCharacters(in: .whitespacesAndNewlines)
            let finalLanguage = language?.isEmpty == false ? language! : "english"
            let seed = request.seed ?? 1000
            MLX.seed(seed)
            logErr("[sidecar] qwen seed=\(seed) language=\(finalLanguage) sampling t=\(sampling.temperature) topK=\(sampling.topK) maxTok=\(sampling.maxTokens) rp=\(sampling.repetitionPenalty)")
            let generatedAudio = model.synthesizeWithVoiceCloneICL(
                text: cleanText,
                referenceAudio: refSamples,
                referenceSampleRate: 24000,
                referenceText: refText,
                language: finalLanguage,
                sampling: sampling,
                codecEncoder: codecEncoder
            )

            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            let audio = conditionSynthOutput(generatedAudio, sampleRate: 24000, engine: "qwen", preTrimMs: 20)
            try WAVWriter.write(samples: audio, sampleRate: 24000, to: outURL)

            let durationSec = Double(audio.count) / 24000.0
            logMemorySnapshot("post-qwen-synth")
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: SynthResult(
                    audioPath: outURL.path,
                    sampleRate: 24000,
                    durationSec: durationSec
                )
            ))
        } catch {
            logErr("[sidecar] synthesis failed: \(error)")
            emit(ErrorResponse(id: request.id, ok: false, error: "\(error)"))
        }

    default:
        emit(ErrorResponse(
            id: request.id,
            ok: false,
            error: "unknown command: \(request.command)"
        ))
    }
}
