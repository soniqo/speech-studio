// Unit tests for the cross-platform sidecar's pure helpers: audio decoding
// (load_audio_mono), emotion-tag extraction, JSON escaping, and filename
// sanitizing. Dependency-free: a tiny CHECK macro, exits non-zero on failure.

#include "audio_decode.h"
#include "sidecar_text.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#ifndef SIDECAR_FIXTURE_DIR
#define SIDECAR_FIXTURE_DIR "tests/fixtures"
#endif

static int g_fail = 0;
#define CHECK(cond, msg)                                       \
    do {                                                       \
        if (!(cond)) {                                         \
            std::fprintf(stderr, "FAIL: %s\n", (msg));         \
            ++g_fail;                                          \
        } else {                                               \
            std::fprintf(stderr, "ok:   %s\n", (msg));         \
        }                                                      \
    } while (0)

// Write a canonical 16-bit PCM mono WAV with the given samples at `rate`.
static void write_wav16(const std::string& path, const std::vector<int16_t>& samples, uint32_t rate) {
    std::ofstream f(path, std::ios::binary);
    auto put32 = [&](uint32_t v) { char b[4] = {char(v), char(v >> 8), char(v >> 16), char(v >> 24)}; f.write(b, 4); };
    auto put16 = [&](uint16_t v) { char b[2] = {char(v), char(v >> 8)}; f.write(b, 2); };
    const uint32_t data_bytes = static_cast<uint32_t>(samples.size()) * 2;
    f.write("RIFF", 4); put32(36 + data_bytes); f.write("WAVE", 4);
    f.write("fmt ", 4); put32(16); put16(1); put16(1);
    put32(rate); put32(rate * 2); put16(2); put16(16);
    f.write("data", 4); put32(data_bytes);
    f.write(reinterpret_cast<const char*>(samples.data()), data_bytes);
}

static std::string tmp_path(const char* name) {
#if defined(_WIN32)
    const char* t = std::getenv("TEMP");
    return std::string(t ? t : ".") + "\\" + name;
#else
    return std::string("/tmp/") + name;
#endif
}

int main() {
    // --- load_audio_mono: synthetic 16-bit WAV round-trips through dr_wav ---
    {
        std::vector<int16_t> s(100);
        for (int i = 0; i < 100; ++i) s[i] = static_cast<int16_t>(i * 100);
        const std::string p = tmp_path("sidecar_test.wav");
        write_wav16(p, s, 16000);
        std::vector<float> out;
        int sr = 0;
        bool ok = load_audio_mono(p, out, sr);
        CHECK(ok, "wav decodes");
        CHECK(sr == 16000, "wav sample rate preserved");
        CHECK(out.size() == 100, "wav frame count");
        CHECK(std::fabs(out[50] - (5000.0f / 32768.0f)) < 1e-3f, "wav sample value");
        std::remove(p.c_str());
    }

    // --- load_audio_mono: real MP3 fixture (tiny, via dr_mp3) ---
    {
        const std::string mp3 = std::string(SIDECAR_FIXTURE_DIR) + "/tiny.mp3";
        std::vector<float> out;
        int sr = 0;
        bool ok = load_audio_mono(mp3, out, sr);
        CHECK(ok, "mp3 decodes");
        CHECK(sr > 0, "mp3 sample rate set");
        CHECK(!out.empty(), "mp3 produced samples");
    }

    // --- load_audio_mono: a non-audio file fails cleanly ---
    {
        const std::string p = tmp_path("sidecar_test_garbage.bin");
        { std::ofstream g(p, std::ios::binary); g << "this is not audio at all"; }
        std::vector<float> out;
        int sr = 0;
        CHECK(!load_audio_mono(p, out, sr), "garbage file rejected");
        std::remove(p.c_str());
    }

    // --- extract_first_emotion_tag ---
    {
        auto [body, instruct] = extract_first_emotion_tag("(excited) Hello there.");
        CHECK(body == "Hello there.", "paren marker stripped from body");
        CHECK(instruct.has_value() && instruct->find("excitement") != std::string::npos,
              "known tag -> descriptive instruction");

        auto [b2, i2] = extract_first_emotion_tag("No markers at all.");
        CHECK(b2 == "No markers at all." && !i2.has_value(), "no marker -> no instruct");

        auto [b3, i3] = extract_first_emotion_tag("(slow and dreamy) Read this.");
        CHECK(b3 == "Read this." && i3.has_value() && *i3 == "slow and dreamy",
              "unknown tag passes through verbatim");

        auto [b4, i4] = extract_first_emotion_tag("<whisper>Quiet now.</whisper>");
        CHECK(b4 == "Quiet now." && i4.has_value() && i4->find("whisper") != std::string::npos,
              "xml-style marker handled");
    }

    // --- json_escape ---
    {
        CHECK(json_escape("a\"b\\c") == "a\\\"b\\\\c", "json escapes quote and backslash");
        CHECK(json_escape("l1\nl2\t!") == "l1\\nl2\\t!", "json escapes newline and tab");
    }

    // --- safe_filename ---
    {
        CHECK(safe_filename("a/b\\c:d*e?") == "a_b_c_d_e_", "filesystem-unsafe chars replaced");
    }

    if (g_fail == 0) {
        std::fprintf(stderr, "\nALL TESTS PASSED\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d TEST(S) FAILED\n", g_fail);
    return 1;
}
