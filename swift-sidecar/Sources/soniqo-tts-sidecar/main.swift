import Foundation
import AudioCommon
import MLX
import CosyVoiceTTS
import Qwen3TTS
import VoxCPM2TTS

// NDJSON protocol: one JSON object per line on stdin → one JSON object per
// line on stdout. The Rust side keeps one sidecar process alive so the MLX
// model stays warm; commands are dispatched on this single read loop.
//
// Commands:
//   ping                  — health check.
//   init_model            — preload the active TTS engine (CosyVoice by default,
//                           Qwen3-TTS when SONIQO_TTS_ENGINE=qwen3).
//   synthesize_cosyvoice  — CosyVoice zero-shot voice clone. Default engine.
//                           Caches the per-reference voice profile so a second
//                           call against the same reference WAV skips the
//                           ~1s feature-extraction step.
//   synthesize_icl        — Qwen3-TTS ICL voice clone. Legacy fallback path,
//                           kept for one release behind SONIQO_TTS_ENGINE=qwen3.

struct Request: Decodable {
    let id: String
    let command: String
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
        // 1.7B 8-bit gives noticeably better fidelity than 0.6B 4-bit; we have
        // it cached locally. Override via SONIQO_TTS_MODEL_ID if needed.
        let modelId = ProcessInfo.processInfo.environment["SONIQO_TTS_MODEL_ID"]
            ?? "aufklarer/Qwen3-TTS-12Hz-1.7B-Base-MLX-8bit"
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
        let modelId = ProcessInfo.processInfo.environment["SONIQO_COSYVOICE_MODEL_ID"]
            ?? "aufklarer/CosyVoice3-0.5B-MLX-8bit-full"
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
}

let cosyHolder = CosyHolder()

// MARK: - VoxCPM2 model state

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
        // Default variant: bf16 (full quality). The CLI uses the same
        // default; int8/int4 are smaller but slightly less faithful.
        // Override with SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-<int8|int4>.
        let modelId = ProcessInfo.processInfo.environment["SONIQO_VOXCPM2_MODEL_ID"]
            ?? "aufklarer/VoxCPM2-MLX-bf16"
        logErr("[sidecar] loading VoxCPM2 model \(modelId)…")
        let m = try await VoxCPM2TTSModel.fromPretrained(
            modelId: modelId,
            progressHandler: { progress, message in
                logErr(String(format: "[sidecar] vox %3d%% %@", Int(progress * 100), message))
            }
        )
        model = m
        logErr("[sidecar] vox ready")
        return m
    }
}

let voxHolder = VoxCPM2Holder()

// Engine selector. VoxCPM2 is the default for v0.2 — much better cloning
// quality without the reference-transcript fragility. SONIQO_TTS_ENGINE=cosyvoice
// or =qwen3 keep the older paths for A/B and rollback.
enum TTSEngine: String {
    case voxcpm2, cosyvoice, qwen3
}

let activeEngine: TTSEngine = {
    if let raw = ProcessInfo.processInfo.environment["SONIQO_TTS_ENGINE"]?.lowercased(),
       let e = TTSEngine(rawValue: raw) { return e }
    return .voxcpm2
}()

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
func extractFirstEmotionTag(_ s: String) -> (text: String, instruct: String?) {
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
        return (trimmedBody, nil)
    }
    let instruct = emotionInstructs[tag] ?? tag  // fall back to raw tag
    return (trimmedBody, instruct)
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
        do {
            switch activeEngine {
            case .voxcpm2:
                _ = try await voxHolder.load()
            case .cosyvoice:
                _ = try await cosyHolder.load()
            case .qwen3:
                _ = try await holder.load()
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
            let (cleanText, extractedInstruct) = extractFirstEmotionTag(targetText)
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
            let (model, _) = try await cosyHolder.load()
            let refURL = URL(fileURLWithPath: refPath)
            // Match the CLI: load reference at 16 kHz. extractVoiceProfile
            // resamples to 16k for the speech tokenizer and 24k for the flow
            // mel internally; feeding it 16k avoids a redundant 24k→16k resample
            // that produces marginally different FSQ codes.
            let refSamples = try AudioFileLoader.load(url: refURL, targetSampleRate: 16000)

            let cleanText = stripEmotionTags(targetText)
            logErr("[sidecar] cosy synth voice=\(request.voiceId ?? "?") chars=\(cleanText.count) refSamples=\(refSamples.count)")

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
                instruction: "You are a helpful assistant.",
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
