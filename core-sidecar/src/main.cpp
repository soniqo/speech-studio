// Speech Studio cross-platform (Linux/Windows) TTS sidecar.
//
// Mirrors the macOS Swift sidecar (swift-sidecar/Sources/soniqo-tts-sidecar/
// main.swift) so the Rust host (src-tauri/src/lib.rs SidecarManager) talks to
// either over the same NDJSON protocol: one JSON object per line on stdin →
// one JSON object per line on stdout. The Rust side keeps one process alive so
// the model stays warm; commands are dispatched on this single read loop.
//
// Engine: speech-core's VoxCPM2 LiteRT voice-cloning backend via the C ABI in
// <speech_core/voxcpm2_c.h>. The model bundle (4 *.tflite + tokenizer.json)
// directory is taken from SONIQO_VOXCPM2_BUNDLE_DIR.
//
// Commands:
//   ping                 — health check.
//   init_model           — create + warm the VoxCPM2 handle.
//   synthesize_voxcpm2   — clone-and-synthesize a line; writes a 48 kHz WAV.
//   probe_reference      — decode a reference clip, report rate/duration/
//                          rms/peak (no model load). Used at clone time to
//                          reject/warn on nearly-silent references.
//   transcribe           — ASR a rendered take (Omnilingual CTC-300M) so the
//                          host can grade it against the target text and
//                          retry bad takes. Model dir comes per-request.

#include <speech_core/voxcpm2_c.h>
#include <speech_core/audio/resampler.h>
#include <speech_core/models/litert_omnilingual_stt.h>
#include <speech_core/util/json.h>

#include "audio_decode.h"
#include "sidecar_text.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <unordered_map>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

static void log_err(const std::string& msg) {
    std::fprintf(stderr, "%s\n", msg.c_str());
    std::fflush(stderr);
}

// Emit one NDJSON line on stdout and flush.
static void emit_line(const std::string& line) {
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

static void emit_error(const std::string& id, const std::string& error) {
    emit_line("{\"id\":\"" + json_escape(id) + "\",\"ok\":false,\"error\":\"" +
              json_escape(error) + "\"}");
}

// ---------------------------------------------------------------------------
// WAV writer for synthesized output. Reference *input* decoding (WAV/MP3/FLAC)
// lives in audio_decode.{h,cpp} via the vendored dr_libs.
// ---------------------------------------------------------------------------

static bool write_wav(const std::string& path, const float* samples, size_t count, int rate) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    auto put32 = [&](uint32_t v) {
        char b[4] = {char(v & 0xFF), char((v >> 8) & 0xFF),
                     char((v >> 16) & 0xFF), char((v >> 24) & 0xFF)};
        f.write(b, 4);
    };
    auto put16 = [&](uint16_t v) {
        char b[2] = {char(v & 0xFF), char((v >> 8) & 0xFF)};
        f.write(b, 2);
    };
    const uint32_t data_bytes = static_cast<uint32_t>(count) * 2;
    f.write("RIFF", 4); put32(36 + data_bytes);
    f.write("WAVE", 4);
    f.write("fmt ", 4); put32(16);
    put16(1);                                          // PCM
    put16(1);                                          // mono
    put32(static_cast<uint32_t>(rate));
    put32(static_cast<uint32_t>(rate) * 2);            // byte rate
    put16(2);                                          // block align
    put16(16);                                         // bits/sample
    f.write("data", 4); put32(data_bytes);
    for (size_t i = 0; i < count; ++i) {
        float s = samples[i];
        if (s < -1.0f) s = -1.0f;
        if (s >  1.0f) s =  1.0f;
        put16(static_cast<uint16_t>(static_cast<int16_t>(s * 32767.0f)));
    }
    return f.good();
}

// ---------------------------------------------------------------------------
// Output cache dir — must match the Rust side's clip_cache_dir()
// (dirs::cache_dir()/audio.soniqo.studio/clips):
//   Windows : %LOCALAPPDATA%\audio.soniqo.studio\clips
//   macOS   : ~/Library/Caches/audio.soniqo.studio/clips
//   Linux   : $XDG_CACHE_HOME (or ~/.cache)/audio.soniqo.studio/clips
// ---------------------------------------------------------------------------

static std::string env_or(const char* name, const std::string& fallback) {
    const char* v = std::getenv(name);
    return (v && *v) ? std::string(v) : fallback;
}

static fs::path clips_cache_dir() {
    fs::path base;
#if defined(_WIN32)
    base = env_or("LOCALAPPDATA", env_or("TEMP", "."));
#elif defined(__APPLE__)
    base = fs::path(env_or("HOME", ".")) / "Library" / "Caches";
#else
    const char* xdg = std::getenv("XDG_CACHE_HOME");
    base = (xdg && *xdg) ? fs::path(xdg) : fs::path(env_or("HOME", ".")) / ".cache";
#endif
    fs::path dir = base / "audio.soniqo.studio" / "clips";
    std::error_code ec;
    fs::create_directories(dir, ec);
    return dir;
}

// ---------------------------------------------------------------------------
// VoxCPM2 model state (one warm handle across calls)
// ---------------------------------------------------------------------------

static sc_voxcpm2_t g_synth = nullptr;

// Throttled download progress → stderr (Rust captures it). Logs each file at
// 10% steps so the user sees first-run download progress without log spam.
static void on_download_progress(const char* file, int idx, int count,
                                 uint64_t downloaded, uint64_t total, void* /*ctx*/) {
    static std::string last_file;
    static int last_pct = -1;
    if (file && last_file != file) {
        last_file = file;
        last_pct = -1;
    }
    int pct = total ? static_cast<int>((100ull * downloaded) / total) : 0;
    if (pct != last_pct && (pct % 10 == 0 || pct == 100)) {
        last_pct = pct;
        log_err("[sidecar] downloading [" + std::to_string(idx + 1) + "/" +
                std::to_string(count) + "] " + (file ? file : "?") + " " +
                std::to_string(pct) + "%");
    }
}

// Create the warm handle if needed. Returns an error string on failure ("" = ok).
//
// Two modes, mirroring the macOS sidecar:
//   - SONIQO_VOXCPM2_BUNDLE_DIR set → load that local bundle directly (dev /
//     offline-provisioned override).
//   - otherwise → ensure the bundle for SONIQO_VOXCPM2_MODEL_ID (default
//     "soniqo/VoxCPM2-LiteRT") is downloaded/cached via speech-core, then load
//     it. This is the first-run auto-download path, like speech-swift's
//     fromPretrained on macOS.
static std::string ensure_model() {
    if (g_synth) return "";

    std::string dir = env_or("SONIQO_VOXCPM2_BUNDLE_DIR", "");
    if (!dir.empty()) {
        if (!fs::exists(fs::path(dir) / "tokenizer.json")) {
            return "VoxCPM2 bundle not found at " + dir + " (missing tokenizer.json)";
        }
        log_err("[sidecar] loading VoxCPM2 LiteRT bundle from " + dir + " …");
        g_synth = sc_voxcpm2_create(dir.c_str());
        if (!g_synth) return "sc_voxcpm2_create failed for bundle " + dir + " (see stderr)";
        log_err("[sidecar] vox ready");
        return "";
    }

    if (!sc_voxcpm2_has_download_support()) {
        return "SONIQO_VOXCPM2_BUNDLE_DIR is unset and this speech-core build has no "
               "model-download support (rebuild with -DSPEECH_CORE_WITH_HF_DOWNLOAD=ON)";
    }
    const std::string model_id = env_or("SONIQO_VOXCPM2_MODEL_ID", "soniqo/VoxCPM2-LiteRT");
    // NULL cache_dir → speech-core's per-user default (override via
    // SONIQO_MODEL_CACHE_DIR / SPEECH_CORE_CACHE_DIR).
    const std::string cache = env_or("SONIQO_MODEL_CACHE_DIR", "");
    log_err("[sidecar] ensuring VoxCPM2 bundle " + model_id +
            " (first run downloads ~4.6 GB from Hugging Face)…");
    g_synth = sc_voxcpm2_create_from_pretrained(
        model_id.c_str(), "main", cache.empty() ? nullptr : cache.c_str(),
        on_download_progress, nullptr);
    if (!g_synth) return "failed to obtain VoxCPM2 bundle " + model_id + " (see stderr)";
    log_err("[sidecar] vox ready");
    return "";
}

// Accumulates streamed chunks.
static void on_chunk(const float* samples, size_t length, bool /*is_final*/, void* ctx) {
    if (samples && length) {
        auto* buf = static_cast<std::vector<float>*>(ctx);
        buf->insert(buf->end(), samples, samples + length);
    }
}

// ---------------------------------------------------------------------------
// Request field helpers
// ---------------------------------------------------------------------------

static std::string get(const json::Dict& d, const char* k, const std::string& dflt = "") {
    auto it = d.find(k);
    return it != d.end() ? it->second : dflt;
}

static std::optional<long long> get_int(const json::Dict& d, const char* k) {
    auto it = d.find(k);
    if (it == d.end() || it->second.empty()) return std::nullopt;
    try {
        return std::stoll(it->second);
    } catch (...) {
        return std::nullopt;
    }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

// probe_reference — decode a candidate reference clip and report its level
// stats WITHOUT loading the model. Lets the frontend reject/warn on
// nearly-silent references at clone time instead of silently producing
// inaudible clones (VoxCPM2 output tracks reference amplitude; field case:
// a -25 dB reference was accepted without a word).
static void handle_probe(const json::Dict& req, const std::string& id) {
    const std::string ref_path = get(req, "referenceAudioPath");
    if (ref_path.empty()) {
        emit_error(id, "probe_reference requires referenceAudioPath");
        return;
    }
    std::vector<float> ref;
    int ref_rate = 0;
    if (!load_audio_mono(ref_path, ref, ref_rate) || ref.empty()) {
        emit_error(id, "could not decode reference audio (supported: WAV, MP3, FLAC): " + ref_path);
        return;
    }
    const AudioStats stats = compute_audio_stats(ref);
    const double duration = static_cast<double>(ref.size()) / static_cast<double>(ref_rate);
    char fields[160];
    std::snprintf(fields, sizeof(fields),
                  "\"sampleRate\":%d,\"durationSec\":%.6f,\"rms\":%.8f,\"peak\":%.6f",
                  ref_rate, duration, stats.rms, static_cast<double>(stats.peak));
    log_err("[sidecar] probe refSamples=" + std::to_string(ref.size()) +
            " " + fields + " ref=" + ref_path);
    emit_line("{\"id\":\"" + json_escape(id) + "\",\"ok\":true,\"result\":{" +
              fields + "}}");
}

// transcribe — ASR a rendered take so the host can grade it against the
// target text (seed-ladder retry). Lazily loads Omnilingual CTC-300M from the
// `modelDir` given in the request (omnilingual-ctc-300m.tflite +
// tokenizer.model) and keeps it warm for subsequent grades.
static std::unique_ptr<speech_core::LiteRTOmnilingualStt> g_stt;
static std::string g_stt_dir;

static void handle_transcribe(const json::Dict& req, const std::string& id) {
    const std::string audio_path = get(req, "audioPath");
    const std::string model_dir = get(req, "modelDir");
    if (audio_path.empty() || model_dir.empty()) {
        emit_error(id, "transcribe requires audioPath and modelDir");
        return;
    }
    std::vector<float> audio;
    int rate = 0;
    if (!load_audio_mono(audio_path, audio, rate) || audio.empty()) {
        emit_error(id, "could not decode audio: " + audio_path);
        return;
    }
    if (!g_stt || g_stt_dir != model_dir) {
        const std::string model = model_dir + "/omnilingual-ctc-300m.tflite";
        const std::string tok = model_dir + "/tokenizer.model";
        if (!fs::exists(model) || !fs::exists(tok)) {
            emit_error(id, "STT model files not found under: " + model_dir);
            return;
        }
        log_err("[sidecar] loading grading STT (Omnilingual CTC-300M) from " + model_dir);
        try {
            g_stt = std::make_unique<speech_core::LiteRTOmnilingualStt>(model, tok, false);
            g_stt_dir = model_dir;
        } catch (const std::exception& e) {
            g_stt.reset();
            emit_error(id, std::string("STT load failed: ") + e.what());
            return;
        }
    }
    std::vector<float> a16 = (rate == 16000)
        ? std::move(audio)
        : speech_core::Resampler::resample(audio.data(), audio.size(), rate, 16000);
    auto res = g_stt->transcribe(a16.data(), a16.size(), 16000);
    emit_line("{\"id\":\"" + json_escape(id) + "\",\"ok\":true,\"result\":{" +
              "\"text\":\"" + json_escape(res.text) + "\"}}");
}

static void handle_synthesize(const json::Dict& req, const std::string& id) {
    const std::string ref_path = get(req, "referenceAudioPath");
    const std::string text = get(req, "text");
    if (ref_path.empty() || text.empty()) {
        emit_error(id, "synthesize_voxcpm2 requires referenceAudioPath and text");
        return;
    }

    // Decode the reference first — it's cheap, and a bad/unsupported file
    // should fail immediately rather than after a multi-second model load.
    std::vector<float> ref;
    int ref_rate = 0;
    if (!load_audio_mono(ref_path, ref, ref_rate) || ref.empty()) {
        emit_error(id, "could not decode reference audio (supported: WAV, MP3, FLAC): " + ref_path);
        return;
    }

    if (std::string err = ensure_model(); !err.empty()) {
        emit_error(id, err);
        return;
    }

    // Inline emotion markers like "(excited) ..." or "<excited>...</excited>"
    // are stripped from the body; the first marker maps to VoxCPM2's native
    // style-conditioning input. An explicit `instruct` field overrides.
    auto [clean_text, extracted] = extract_first_emotion_tag(text);
    std::string explicit_instruct = get(req, "instruct");
    std::string instruct = !explicit_instruct.empty() ? explicit_instruct
                          : (extracted ? *extracted : std::string());

    // seed: deterministic per seed; the Rust ladder varies it across retries.
    uint32_t seed = static_cast<uint32_t>(get_int(req, "seed").value_or(1000));
    // maxTokens (AR steps): the Rust side computes a tight per-line cap. Clamp
    // to a sane window; rely on the stop token for the natural end. cfgValue
    // has no LiteRT equivalent and is ignored.
    long long max_steps = get_int(req, "maxTokens").value_or(256);
    if (max_steps < 32) max_steps = 32;
    if (max_steps > 512) max_steps = 512;
    // minStopSteps: ignore the model's stop signal before this many AR steps.
    // The Rust side scales it with word count — VoxCPM2 fires its stop token
    // prematurely on long non-Latin-script lines (measured: a 19-word Hindi
    // sentence stops at ~40 steps ≈ 6 s, audibly truncated), and with ASR
    // grading unavailable on this platform the cut take would be accepted.
    long long min_stop = get_int(req, "minStopSteps").value_or(32);
    if (min_stop < 8) min_stop = 8;
    if (min_stop > max_steps - 8) min_stop = max_steps - 8;

    sc_voxcpm2_clear_reference(g_synth);
    sc_voxcpm2_set_instruction(g_synth, instruct.c_str());
    sc_voxcpm2_set_seed(g_synth, seed);
    sc_voxcpm2_set_max_steps(g_synth, static_cast<int>(max_steps));
    sc_voxcpm2_set_min_steps_before_stop(g_synth, static_cast<int>(min_stop));

    if (sc_voxcpm2_set_reference(g_synth, ref.data(), ref.size(), ref_rate) != 0) {
        emit_error(id, std::string("set_reference failed: ") + sc_voxcpm2_last_error(g_synth));
        return;
    }

    // Level stats in the log line make "user cloned from a near-silent
    // reference" diagnosable from session logs alone — the field report that
    // motivated this took a multi-day investigation without them.
    const AudioStats ref_stats = compute_audio_stats(ref);
    char ref_levels[64];
    std::snprintf(ref_levels, sizeof(ref_levels), " refRms=%.6f refPeak=%.4f",
                  ref_stats.rms, static_cast<double>(ref_stats.peak));
    log_err("[sidecar] vox synth voice=" + get(req, "voiceId", "?") +
            " chars=" + std::to_string(clean_text.size()) +
            " refSamples=" + std::to_string(ref.size()) +
            " refRate=" + std::to_string(ref_rate) + ref_levels +
            " seed=" + std::to_string(seed) +
            " maxSteps=" + std::to_string(max_steps) +
            " minStop=" + std::to_string(min_stop) +
            " instruct=" + (instruct.empty() ? "(none)" : instruct));

    std::vector<float> audio;
    int rc = sc_voxcpm2_synthesize(g_synth, clean_text.c_str(), on_chunk, &audio);
    if (rc != 0) {
        emit_error(id, std::string("synthesize failed: ") + sc_voxcpm2_last_error(g_synth));
        return;
    }
    if (audio.empty()) {
        emit_error(id, "synthesis produced no audio");
        return;
    }

    int sample_rate = sc_voxcpm2_output_sample_rate(g_synth);
    fs::path out = clips_cache_dir() / (safe_filename(id) + ".wav");
    if (!write_wav(out.string(), audio.data(), audio.size(), sample_rate)) {
        emit_error(id, "could not write output WAV: " + out.string());
        return;
    }
    double duration = static_cast<double>(audio.size()) / static_cast<double>(sample_rate);

    // audioPath needs OS-native separators escaped for JSON (backslashes on
    // Windows). json_escape handles that.
    char dur_buf[64];
    std::snprintf(dur_buf, sizeof(dur_buf), "%.6f", duration);
    emit_line("{\"id\":\"" + json_escape(id) + "\",\"ok\":true,\"result\":{" +
              "\"audioPath\":\"" + json_escape(out.string()) + "\"," +
              "\"sampleRate\":" + std::to_string(sample_rate) + "," +
              "\"durationSec\":" + dur_buf + "}}");
}

int main() {
#if defined(_WIN32)
    // Keep '\n' from being translated to "\r\n" on stdout and avoid CRLF
    // surprises on stdin — the NDJSON protocol is strictly '\n'-delimited.
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    std::string line;
    while (std::getline(std::cin, line)) {
        // Tolerate a trailing '\r' if the host ever writes CRLF.
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;

        json::Dict req = json::parse_flat_object(line);
        const std::string id = get(req, "id");
        const std::string command = get(req, "command");
        if (command.empty()) {
            emit_error(id, "malformed request");
            continue;
        }

        if (command == "ping") {
            emit_line("{\"id\":\"" + json_escape(id) +
                      "\",\"ok\":true,\"result\":{\"pong\":true,\"version\":\"0.1.0\"}}");
        } else if (command == "init_model") {
            if (std::string err = ensure_model(); !err.empty()) {
                log_err("[sidecar] init_model failed: " + err);
                emit_error(id, err);
            } else {
                emit_line("{\"id\":\"" + json_escape(id) +
                          "\",\"ok\":true,\"result\":{\"ready\":true}}");
            }
        } else if (command == "synthesize_voxcpm2") {
            handle_synthesize(req, id);
        } else if (command == "probe_reference") {
            handle_probe(req, id);
        } else if (command == "transcribe") {
            handle_transcribe(req, id);
        } else {
            emit_error(id, "unknown command: " + command);
        }
    }

    if (g_synth) sc_voxcpm2_destroy(g_synth);
    return 0;
}
