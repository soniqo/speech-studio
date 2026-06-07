#include "audio_decode.h"

#include <algorithm>
#include <cctype>
#include <cstdint>

// Single-translation-unit home for the dr_libs implementations.
#define DR_WAV_IMPLEMENTATION
#define DR_MP3_IMPLEMENTATION
#define DR_FLAC_IMPLEMENTATION
#include "dr_wav.h"
#include "dr_mp3.h"
#include "dr_flac.h"

namespace {

// Average interleaved channels down to mono.
void downmix(const float* interleaved, uint64_t frames, unsigned channels,
             std::vector<float>& out) {
    out.resize(static_cast<size_t>(frames));
    if (channels <= 1) {
        for (uint64_t i = 0; i < frames; ++i) out[i] = interleaved[i];
        return;
    }
    for (uint64_t i = 0; i < frames; ++i) {
        float acc = 0.0f;
        for (unsigned c = 0; c < channels; ++c) acc += interleaved[i * channels + c];
        out[i] = acc / static_cast<float>(channels);
    }
}

std::string lower_ext(const std::string& path) {
    const auto dot = path.find_last_of('.');
    std::string e = (dot == std::string::npos) ? "" : path.substr(dot + 1);
    std::transform(e.begin(), e.end(), e.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return e;
}

bool try_wav(const std::string& p, std::vector<float>& out, int& sr) {
    unsigned ch = 0, rate = 0;
    drwav_uint64 frames = 0;
    float* d = drwav_open_file_and_read_pcm_frames_f32(p.c_str(), &ch, &rate, &frames, nullptr);
    if (!d) return false;
    downmix(d, frames, ch, out);
    sr = static_cast<int>(rate);
    drwav_free(d, nullptr);
    return !out.empty();
}

bool try_flac(const std::string& p, std::vector<float>& out, int& sr) {
    unsigned ch = 0, rate = 0;
    drflac_uint64 frames = 0;
    float* d = drflac_open_file_and_read_pcm_frames_f32(p.c_str(), &ch, &rate, &frames, nullptr);
    if (!d) return false;
    downmix(d, frames, ch, out);
    sr = static_cast<int>(rate);
    drflac_free(d, nullptr);
    return !out.empty();
}

bool try_mp3(const std::string& p, std::vector<float>& out, int& sr) {
    drmp3_config cfg;
    drmp3_uint64 frames = 0;
    float* d = drmp3_open_file_and_read_pcm_frames_f32(p.c_str(), &cfg, &frames, nullptr);
    if (!d) return false;
    downmix(d, frames, cfg.channels, out);
    sr = static_cast<int>(cfg.sampleRate);
    drmp3_free(d, nullptr);
    return !out.empty();
}

}  // namespace

bool load_audio_mono(const std::string& path, std::vector<float>& out, int& sample_rate) {
    const std::string ext = lower_ext(path);

    // Try the format the extension implies first.
    if (ext == "mp3") {
        if (try_mp3(path, out, sample_rate)) return true;
    } else if (ext == "flac") {
        if (try_flac(path, out, sample_rate)) return true;
    } else if (ext == "wav" || ext == "wave") {
        if (try_wav(path, out, sample_rate)) return true;
    }

    // Fall back to content sniffing (handles mislabeled extensions). MP3 last:
    // its frame sync is the most permissive and can mis-detect other formats.
    if (try_wav(path, out, sample_rate)) return true;
    if (try_flac(path, out, sample_rate)) return true;
    if (try_mp3(path, out, sample_rate)) return true;
    return false;
}
