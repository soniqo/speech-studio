#ifndef SONIQO_AUDIO_DECODE_H
#define SONIQO_AUDIO_DECODE_H

#include <string>
#include <vector>

// Decode an audio file to mono float PCM in [-1, 1]. Supports WAV (any bit
// depth / float), MP3, and FLAC via the vendored dr_libs decoders — the macOS
// Swift sidecar gets this for free from AudioFileLoader; this gives the
// Windows/Linux sidecar the same reach beyond bare 16-bit PCM WAV.
//
// Returns false if the file can't be opened or isn't a supported format. On
// success, `out` holds the mono samples and `sample_rate` the native rate
// (the VoxCPM2 C ABI resamples to 16 kHz internally).
bool load_audio_mono(const std::string& path, std::vector<float>& out, int& sample_rate);

// Level statistics over a decoded clip. Used by the probe_reference command
// to surface "this reference is nearly silent" at clone time — the field
// failure this guards against was a -25 dB reference accepted without a
// word, producing inaudible clones (VoxCPM2 tracks reference amplitude).
struct AudioStats {
    double rms  = 0.0;  // full-clip root-mean-square, [0, 1] scale
    float  peak = 0.0f; // max |sample|
};
AudioStats compute_audio_stats(const std::vector<float>& samples);

#endif  // SONIQO_AUDIO_DECODE_H
