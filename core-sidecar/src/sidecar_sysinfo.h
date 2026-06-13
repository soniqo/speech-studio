#ifndef SONIQO_SIDECAR_SYSINFO_H
#define SONIQO_SIDECAR_SYSINFO_H

#include <cstdint>
#include <string>

// System-resource helpers for the sidecar, split out from main.cpp so the pure
// decision logic can be unit-tested without an actual low-memory machine.
//
// Motivation: the fp16 VoxCPM2-LiteRT bundle needs ~10 GiB resident at load. On
// a machine with less, sc_voxcpm2_create() is OOM-killed mid-load — a silent
// SIGKILL of the whole sidecar with no diagnosable error. The pre-flight guard
// below turns that into an actionable message before we attempt the load.

// Best-effort total + available physical RAM, in bytes. Returns false if it
// cannot be determined on this platform (callers should then skip the guard
// rather than block on missing data). `available_bytes` may be left 0 when the
// platform exposes only the total.
bool query_physical_memory(uint64_t& total_bytes, uint64_t& available_bytes);

// Render a byte count as a one-decimal GiB string, e.g. "7.8 GiB".
std::string format_gib(uint64_t bytes);

struct RamCheckResult {
    bool ok;              // true => safe (enough RAM, unknown, or overridden)
    std::string message;  // populated only when !ok: actionable guidance
};

// Pure decision: can a model needing `required_bytes` resident be loaded given
// `total_bytes` / `available_bytes` physical RAM? Prefers the "available"
// figure (what can actually be allocated now) and falls back to total when the
// platform reports only that. `force` (env override) and unknown memory (both
// zero) both yield ok=true — we never block on missing data, only on a positive
// signal that RAM is short.
RamCheckResult check_model_ram(uint64_t total_bytes, uint64_t available_bytes,
                               uint64_t required_bytes, bool force);

#endif  // SONIQO_SIDECAR_SYSINFO_H
