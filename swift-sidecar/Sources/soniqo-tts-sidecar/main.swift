import Foundation
import AudioCommon
import MLX
import ChatterboxTTS
import CosyVoiceTTS
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
//   synthesize_voxcpm2    — VoxCPM2 voice clone (48 kHz).
//   synthesize_cosyvoice  — CosyVoice zero-shot voice clone (24 kHz).
//   synthesize_chatterbox — Chatterbox multilingual voice clone (24 kHz).
//   synthesize_icl        — Qwen3-TTS ICL voice clone; legacy fallback only.

struct Request: Decodable {
    let id: String
    let command: String
    // Selected backend. The Studio sends this for init_model and synthesis;
    // SONIQO_TTS_ENGINE remains a compatibility default for direct callers.
    let engine: String?
    let text: String?
    let voiceId: String?
    let referenceAudioPath: String?
    let referenceText: String?
    // Optional sampling overrides — used by the debug test to A/B params
    // without rebuilding. Falls back to library defaults when omitted.
    let temperature: Float?
    let topK: Int?
    let maxTokens: Int?
    let repetitionPenalty: Float?
    // Optional seed for the CosyVoice / VoxCPM2 path. Defaults to 1000 when
    // omitted. Rust-side retry varies this across attempts.
    let seed: UInt64?
    // VoxCPM2: style/emotion instruction (e.g. "excited", "whispering").
    // Library wraps as "(<instruct>){text}" before tokenising.
    let instruct: String?
    // VoxCPM2: classifier-free guidance scale (default 2.0).
    let cfgValue: Float?
    // Chatterbox: BCP-47-ish language id for the `[lang]` token (e.g. "en",
    // "ar", "hi"). Ignored by the other engines.
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

// MARK: - model state

// The model is not thread-safe (per Qwen3TTS docs) but this sidecar reads from
// stdin one line at a time and dispatches synchronously, so all mutations
// happen on the same thread.
final class ModelHolder: @unchecked Sendable {
    private var model: Qwen3TTSModel?
    private var tokenizerEncoder: SpeechTokenizerEncoder?

    func load() async throws -> (Qwen3TTSModel, SpeechTokenizerEncoder) {
        if let m = model, let e = tokenizerEncoder {
            return (m, e)
        }
        // 1.7B bf16 is the highest-fidelity variant. Its 4-bit was dropped (it
        // degraded badly — near-silent/garbled on some inputs); 8-bit remains an
        // option. Override via SONIQO_TTS_MODEL_ID if needed.
        let modelId = ProcessInfo.processInfo.environment["SONIQO_TTS_MODEL_ID"]
            ?? "aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-bf16"
        logErr("[sidecar] loading Qwen3-TTS model \(modelId) (first run downloads weights from HuggingFace)…")
        let result = try await Qwen3TTSModel.fromPretrainedWithEncoder(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] model %3d%% %@", Int(progress * 100), message))
            }
        )
        model = result.0
        tokenizerEncoder = result.1
        logErr("[sidecar] model ready")
        return result
    }

    func unload() {
        model?.unload()
        model = nil
        tokenizerEncoder = nil
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

    func load() async throws -> (CosyVoiceTTSModel, SpeechTokenizerModel) {
        if let m = model, let s = speechTokenizer {
            return (m, s)
        }
        // Studio uses the full bf16 bundle: both the LLM and DiT remain
        // unquantized (~2.1 GB on disk), which is the quality-first choice.
        let modelId = "aufklarer/CosyVoice3-0.5B-MLX-bf16"
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

    func load() async throws -> VoxCPM2TTSModel {
        if let m = model { return m }
        // Default variant: int8 (~2.75 GB on disk, ~3.1 GB MLX active). The
        // bf16 variant is ~4.6 GB on disk / ~9 GB active and pushes total
        // peak RSS above 11 GB on this 1.7B-param model. int8 stays under
        // 6 GB peak with no audible loss for ICL voice cloning at the demo
        // clip lengths. Override with
        // SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-<bf16|int4>.
        let modelId = ProcessInfo.processInfo.environment["SONIQO_VOXCPM2_MODEL_ID"]
            ?? "aufklarer/VoxCPM2-MLX-int8"
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
        logErr("[sidecar] vox ready")
        return m
    }

    func unload() {
        model?.unload()
        model = nil
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

// Engine selector. VoxCPM2 is the default. SONIQO_TTS_ENGINE remains a
// process-level compatibility default, but Studio chooses the engine per
// request so a user can switch without restarting the app.
enum TTSEngine: String {
    case voxcpm2, cosyvoice, qwen3, chatterbox
}

let defaultEngine: TTSEngine = {
    if let raw = ProcessInfo.processInfo.environment["SONIQO_TTS_ENGINE"]?.lowercased(),
       let e = TTSEngine(rawValue: raw) { return e }
    return .voxcpm2
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
    switch engine {
    case .voxcpm2:
        cosyHolder.unload()
        holder.unload()
        chatterboxHolder.unload()
    case .cosyvoice:
        voxHolder.unload()
        holder.unload()
        chatterboxHolder.unload()
    case .qwen3:
        voxHolder.unload()
        cosyHolder.unload()
        chatterboxHolder.unload()
    case .chatterbox:
        voxHolder.unload()
        cosyHolder.unload()
        holder.unload()
    }
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

func logMemorySnapshot(_ label: String) {
    let snap = MLX.Memory.snapshot()
    let mb = { (b: Int) in b / (1024 * 1024) }
    logErr("[sidecar] mem \(label) active=\(mb(snap.activeMemory))M cache=\(mb(snap.cacheMemory))M peak=\(mb(snap.peakMemory))M")
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
                _ = try await voxHolder.load()
            case .cosyvoice:
                _ = try await cosyHolder.load()
            case .qwen3:
                _ = try await holder.load()
            case .chatterbox:
                _ = try await chatterboxHolder.load()
            }
            emit(SuccessResponse(
                id: request.id,
                ok: true,
                result: InitResult(ready: true)
            ))
        } catch {
            logErr("[sidecar] init_model failed: \(error)")
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
            let model = try await voxHolder.load()
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
            let audio = try await model.generateVoxCPM2(
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
            let (model, _) = try await cosyHolder.load()
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
            logErr("[sidecar] cosy synth voice=\(request.voiceId ?? "?") chars=\(cleanText.count) refSamples=\(refSamples.count) instruct=\(finalInstruct)")

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
                language: "english",
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
            let audio: [Float]
            if rawAudio.count > extraTrimSamples * 2 {
                audio = Array(rawAudio.dropFirst(extraTrimSamples))
            } else {
                audio = rawAudio
            }

            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            try WAVWriter.write(samples: audio, sampleRate: 24000, to: outURL)

            let durationSec = Double(audio.count) / 24000.0
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
            let model = try await chatterboxHolder.load()
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
            let language = request.language?.isEmpty == false ? request.language! : "en"
            logErr("[sidecar] cbx synth voice=\(request.voiceId ?? "?") lang=\(language) tag=\(emotionTag ?? "(none)") exaggeration=\(exaggeration) chars=\(cleanText.count) refSamples=\(refSamples.count)")

            // Seed the noise so a given (voice, text, language) is reproducible;
            // the Rust retry ladder varies it across attempts.
            let seed = request.seed ?? 1000
            MLX.seed(seed)

            // Greedy (temperature 0) for determinism. cfgWeight fixed at 0.5 —
            // the request's cfgValue is VoxCPM2's CFG ladder (2.0+) and must NOT
            // be used as Chatterbox's classifier-free-guidance weight.
            let audio = try model.clone(
                referenceSamples: refSamples,
                sampleRate: ChatterboxS3Gen.sampleRate,
                text: cleanText,
                languageId: language,
                exaggeration: exaggeration,
                temperature: 0.0,
                cfgWeight: 0.5
            )

            let sampleRate = ChatterboxS3Gen.sampleRate
            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
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
            let (model, codecEncoder) = try await holder.load()

            let refURL = URL(fileURLWithPath: refPath)
            let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: 24000)

            let cleanText = stripEmotionTags(targetText)
            logErr("[sidecar] synth voice=\(request.voiceId ?? "?") chars=\(cleanText.count) refSamples=\(refSamples.count)")

            // ICL voice clone. Default matches mlx-audio's working recipe:
            // T=0.9, topK=50, topP=1.0, max_tokens=4096. The ICL path inside
            // speech-swift then text-length-caps maxTokens and (with the
            // current code) leaves repetition_penalty at whatever the caller
            // set (1.05 default). Empirically T=0.9 produces ~75% per-line
            // ASR coverage with the cleaned bundled references; greedy on
            // this 8-bit quantized model produces 0% (degenerate sequences).
            // Cross-process MLX-Metal variance is the residual issue, best
            // handled with ASR-graded retry.
            var sampling = SamplingConfig.default
            if let t = request.temperature { sampling.temperature = t }
            if let k = request.topK { sampling.topK = k }
            if let m = request.maxTokens { sampling.maxTokens = m }
            if let r = request.repetitionPenalty { sampling.repetitionPenalty = r }
            logErr("[sidecar] sampling t=\(sampling.temperature) topK=\(sampling.topK) maxTok=\(sampling.maxTokens) rp=\(sampling.repetitionPenalty)")
            let audio = model.synthesizeWithVoiceCloneICL(
                text: cleanText,
                referenceAudio: refSamples,
                referenceSampleRate: 24000,
                referenceText: refText,
                sampling: sampling,
                codecEncoder: codecEncoder
            )

            let outURL = clipsCacheDir().appendingPathComponent("\(safeFilename(request.id)).wav")
            try WAVWriter.write(samples: audio, sampleRate: 24000, to: outURL)

            let durationSec = Double(audio.count) / 24000.0
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
