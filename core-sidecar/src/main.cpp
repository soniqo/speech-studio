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

#include <speech_core/voxcpm2_c.h>
#include <speech_core/util/json.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
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

// Escape a string for inclusion in a JSON double-quoted value.
static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
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
// WAV read / write (mirrors speech-core/examples/litert/voxcpm2_clone.cpp)
// ---------------------------------------------------------------------------

// Minimal mono-float loader for a canonical PCM-16 RIFF/WAVE file. Multi-channel
// input is down-mixed by averaging. Returns false on any parse failure.
static bool load_wav_mono(const std::string& path, std::vector<float>& out, int& sample_rate) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;

    char riff[4], wave[4];
    uint32_t file_size = 0;
    f.read(riff, 4);
    f.read(reinterpret_cast<char*>(&file_size), 4);
    f.read(wave, 4);
    if (std::memcmp(riff, "RIFF", 4) != 0 || std::memcmp(wave, "WAVE", 4) != 0) return false;

    char chunk_id[4];
    uint32_t chunk_size = 0;
    uint16_t audio_format = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    bool have_fmt = false;

    while (f.read(chunk_id, 4)) {
        f.read(reinterpret_cast<char*>(&chunk_size), 4);
        if (std::memcmp(chunk_id, "fmt ", 4) == 0) {
            f.read(reinterpret_cast<char*>(&audio_format), 2);
            f.read(reinterpret_cast<char*>(&channels), 2);
            f.read(reinterpret_cast<char*>(&rate), 4);
            f.seekg(6, std::ios::cur);                 // byte_rate + block_align
            f.read(reinterpret_cast<char*>(&bits), 2);
            if (chunk_size > 16) f.seekg(chunk_size - 16, std::ios::cur);
            have_fmt = true;
        } else if (std::memcmp(chunk_id, "data", 4) == 0) {
            if (!have_fmt || audio_format != 1 || bits != 16 || channels == 0) return false;
            const size_t n = chunk_size / 2;
            std::vector<int16_t> pcm(n);
            f.read(reinterpret_cast<char*>(pcm.data()), chunk_size);
            const size_t frames = n / channels;
            out.resize(frames);
            for (size_t i = 0; i < frames; ++i) {
                int acc = 0;
                for (uint16_t c = 0; c < channels; ++c) acc += pcm[i * channels + c];
                out[i] = static_cast<float>(acc) / (channels * 32768.0f);
            }
            sample_rate = static_cast<int>(rate);
            return true;
        } else {
            f.seekg(chunk_size, std::ios::cur);
        }
    }
    return false;
}

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

static std::string safe_filename(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' ||
            c == '"' || c == '<' || c == '>' || c == '|') {
            c = '_';
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Emotion-tag extraction (ports extractFirstEmotionTag + emotionInstructs from
// the Swift sidecar so style markers behave identically across platforms).
// ---------------------------------------------------------------------------

static const std::unordered_map<std::string, std::string>& emotion_instructs() {
    static const std::unordered_map<std::string, std::string> m = {
        {"excited", "Speak with energetic, animated excitement while staying natural and conversational."},
        {"happy", "Speak warmly and lightly, with a small smile in the voice."},
        {"calm", "Speak calmly and clearly, with steady, unhurried pacing."},
        {"soft", "Speak softly and gently, with a quiet, reflective tone."},
        {"serious", "Speak with focused confidence and measured emphasis."},
        {"warm", "Speak warmly and reassuringly, with a friendly, supportive tone."},
        {"surprised", "Speak with a brief sense of impressed surprise, then return to clarity."},
        {"whisper", "Speak softly and intimately, almost a whisper, but keep the words clear."},
        {"whispers", "Speak softly and intimately, almost a whisper, but keep the words clear."},
        {"whispering", "Speak softly and intimately, almost a whisper, but keep the words clear."},
        {"sad", "Speak gently and reflectively without sounding theatrical."},
        {"angry", "Speak with controlled urgency, not aggression."},
        {"intense", "Speak with quiet intensity and resolute determination."},
        {"dramatic", "Speak with theatrical weight, holding the listener's attention."},
        {"laughs", "Add a light amused tone without reading laughter literally."},
    };
    return m;
}

static std::string to_lower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

// Returns {clean_body, instruct?}.
static std::pair<std::string, std::optional<std::string>>
extract_first_emotion_tag(const std::string& s) {
    std::optional<std::string> first_tag;
    std::string body = s;

    // Parenthetical form: "(tag)" — letters, spaces, hyphens, slashes.
    {
        std::smatch m;
        std::regex re(R"(\(\s*([a-zA-Z][a-zA-Z\s/\-]*?)\s*\))");
        if (std::regex_search(body, m, re)) {
            std::string inner = trim(m[1].str());
            if (!inner.empty()) first_tag = to_lower(inner);
            body = m.prefix().str() + m.suffix().str();
        }
    }

    // XML-like form: <tag>...</tag>. Strip all <...> segments.
    if (!first_tag) {
        std::smatch m;
        std::regex open_re(R"(<\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*>)");
        if (std::regex_search(body, m, open_re)) {
            std::string name = to_lower(trim(m[1].str()));
            if (!name.empty()) first_tag = name;
        }
        body = std::regex_replace(body, std::regex(R"(<[^>]+>)"), "");
    }

    // Collapse double spaces, trim.
    std::string clean = std::regex_replace(body, std::regex("  "), " ");
    clean = trim(clean);
    std::string final_body = clean.empty() ? body : clean;

    if (!first_tag) return {final_body, std::nullopt};
    const auto& map = emotion_instructs();
    auto it = map.find(*first_tag);
    return {final_body, it != map.end() ? it->second : *first_tag};
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

static void handle_synthesize(const json::Dict& req, const std::string& id) {
    const std::string ref_path = get(req, "referenceAudioPath");
    const std::string text = get(req, "text");
    if (ref_path.empty() || text.empty()) {
        emit_error(id, "synthesize_voxcpm2 requires referenceAudioPath and text");
        return;
    }

    if (std::string err = ensure_model(); !err.empty()) {
        emit_error(id, err);
        return;
    }

    std::vector<float> ref;
    int ref_rate = 0;
    if (!load_wav_mono(ref_path, ref, ref_rate) || ref.empty()) {
        emit_error(id, "could not read reference WAV (16-bit PCM RIFF/WAVE required): " + ref_path);
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

    sc_voxcpm2_clear_reference(g_synth);
    sc_voxcpm2_set_instruction(g_synth, instruct.c_str());
    sc_voxcpm2_set_seed(g_synth, seed);
    sc_voxcpm2_set_max_steps(g_synth, static_cast<int>(max_steps));
    sc_voxcpm2_set_min_steps_before_stop(g_synth, 32);

    if (sc_voxcpm2_set_reference(g_synth, ref.data(), ref.size(), ref_rate) != 0) {
        emit_error(id, std::string("set_reference failed: ") + sc_voxcpm2_last_error(g_synth));
        return;
    }

    log_err("[sidecar] vox synth voice=" + get(req, "voiceId", "?") +
            " chars=" + std::to_string(clean_text.size()) +
            " refSamples=" + std::to_string(ref.size()) +
            " seed=" + std::to_string(seed) +
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
        } else {
            emit_error(id, "unknown command: " + command);
        }
    }

    if (g_synth) sc_voxcpm2_destroy(g_synth);
    return 0;
}
