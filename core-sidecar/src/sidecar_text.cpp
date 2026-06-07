#include "sidecar_text.h"

#include <cctype>
#include <cstdio>
#include <regex>
#include <unordered_map>

std::string json_escape(const std::string& s) {
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

std::string safe_filename(const std::string& s) {
    std::string out = s;
    for (char& c : out) {
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' ||
            c == '"' || c == '<' || c == '>' || c == '|') {
            c = '_';
        }
    }
    return out;
}

namespace {

// Short emotion tag → descriptive style instruction (ported from the Swift
// sidecar so markers behave identically across platforms).
const std::unordered_map<std::string, std::string>& emotion_instructs() {
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

std::string to_lower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

}  // namespace

std::pair<std::string, std::optional<std::string>> extract_first_emotion_tag(
    const std::string& s) {
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
