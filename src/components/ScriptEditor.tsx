import { useRef } from "react";
import { EMOTION_TAGS, EmotionTag } from "../types/project";
import { useProjectStore } from "../state/projectStore";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

/** Honest, per-engine note about how the selected engine applies markers. */
const STYLE_HINTS: Record<string, string> = {
  instruction: "Markers steer this line's tone.",
  intensity:
    "Chatterbox applies markers as intensity only — more vs. less expressive, not a specific emotion.",
  "suffix-tag": "Indic-Mio uses suffix tags like <happy> and clones from the reference audio.",
  "bracket-tag": "Fish Audio uses bracket tags like [excited] and requires a reference transcript for cloning.",
  none: "This engine ignores emotion markers.",
};

const INDIC_MIO_TAGS = ["happy", "sad", "angry", "disgust", "fear", "surprise"] as const;
const FISH_AUDIO_TAGS = [
  "pause",
  "emphasis",
  "laughing",
  "excited",
  "angry",
  "whisper",
  "screaming",
  "shouting",
  "surprised",
  "sad",
] as const;

// Match `(tag)` or `<tag>...</tag>` wrappers at the start of a line so we can
// swap them out cleanly. Permissive on tag character set to allow custom
// emotion descriptors like `(slow and dreamy)`.
const LEADING_PAREN_TAG = /^\s*\(\s*([a-zA-Z][a-zA-Z\s/\-]*?)\s*\)\s*/;
const LEADING_XML_TAG = /^\s*<\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*>/;
const TRAILING_XML_CLOSE = /<\s*\/\s*[a-zA-Z][a-zA-Z0-9_\-]*\s*>\s*$/;
const TRAILING_XML_SUFFIX = /\s*<\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*>\s*$/;
const TRAILING_BRACKET_SUFFIX = /\s*\[\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*\]\s*$/;

function stripEmotionTag(text: string): string {
  let out = text;
  const xmlOpen = out.match(LEADING_XML_TAG);
  if (xmlOpen) {
    out = out.slice(xmlOpen[0].length);
    out = out.replace(TRAILING_XML_CLOSE, "");
  } else {
    out = out.replace(LEADING_PAREN_TAG, "");
  }
  return out.replace(TRAILING_XML_SUFFIX, "").replace(TRAILING_BRACKET_SUFFIX, "");
}

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const styleMode = useProjectStore(
    (s) => s.model.engines.find((e) => e.id === s.model.engine)?.styleMode ?? "instruction",
  );
  const markersIgnored = styleMode === "none";
  const suffixMode = styleMode === "suffix-tag";
  const bracketMode = styleMode === "bracket-tag";
  const markerTags = suffixMode ? INDIC_MIO_TAGS : bracketMode ? FISH_AUDIO_TAGS : EMOTION_TAGS;
  const rawCurrentTag = suffixMode
    ? value.match(TRAILING_XML_SUFFIX)?.[1]
    : bracketMode
      ? value.match(TRAILING_BRACKET_SUFFIX)?.[1]
    : value.match(LEADING_PAREN_TAG)?.[1] || value.match(LEADING_XML_TAG)?.[1];
  const currentTag = (rawCurrentTag ?? "").trim().toLowerCase();

  function applyTag(
    tag: EmotionTag | (typeof INDIC_MIO_TAGS)[number] | (typeof FISH_AUDIO_TAGS)[number],
  ) {
    const body = stripEmotionTag(value).trim();
    if (currentTag === tag) {
      // Toggle off: clicking the active tag removes it.
      onChange(body);
    } else if (suffixMode) {
      onChange(`${body} <${tag}>`.trim());
    } else if (bracketMode) {
      onChange(`${body} [${tag}]`.trim());
    } else {
      onChange(`(${tag}) ${body}`);
    }
    requestAnimationFrame(() => ref.current?.focus());
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Script
      </div>
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write the line. Pick an emotion below to set the tone."
        className="min-h-[88px]"
      />
      <div className={`flex flex-wrap gap-1 ${markersIgnored ? "opacity-50" : ""}`}>
        {markerTags.map((t) => {
          const active = currentTag === t;
          const markerLabel = suffixMode ? `<${t}>` : bracketMode ? `[${t}]` : `(${t})`;
          return (
            <Button
              key={t}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => applyTag(t)}
              title={
                active
                  ? `Remove ${markerLabel} marker`
                  : `Set this line's tone to ${markerLabel}`
              }
              className="h-6 px-2 text-[11px] font-normal"
            >
              {t}
            </Button>
          );
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">{STYLE_HINTS[styleMode]}</div>
    </div>
  );
}
