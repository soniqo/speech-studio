#ifndef SONIQO_SIDECAR_TEXT_H
#define SONIQO_SIDECAR_TEXT_H

#include <optional>
#include <string>
#include <utility>

// Pure text helpers for the sidecar, split out from main.cpp so they can be
// unit-tested independently of the NDJSON loop and the model.

// Escape a string for inclusion in a JSON double-quoted value.
std::string json_escape(const std::string& s);

// Replace filesystem-unsafe characters with '_' (used to name output WAVs
// after the request id).
std::string safe_filename(const std::string& s);

// Pull the first inline emotion marker out of `text` and return
// {cleaned_body, instruct?}. Two marker shapes are supported (first match
// wins): parenthetical "(excited) …" and XML-like "<excited>…</excited>".
// Known tags map to a descriptive style instruction; unknown tags pass through
// as-is. Mirrors the macOS Swift sidecar's extractFirstEmotionTag.
std::pair<std::string, std::optional<std::string>> extract_first_emotion_tag(
    const std::string& text);

#endif  // SONIQO_SIDECAR_TEXT_H
