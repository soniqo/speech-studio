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

#endif  // SONIQO_AUDIO_DECODE_H
