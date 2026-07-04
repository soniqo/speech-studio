import { useRef } from "react";
import { EMOTION_TAGS } from "../types/project";
import { useProjectStore } from "../state/projectStore";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { useI18n } from "../i18n/useI18n";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// Match `(tag)` or `<tag>...</tag>` wrappers at the start of a line so we can
// swap them out cleanly. Permissive on tag character set to allow custom
// emotion descriptors like `(slow and dreamy)`.
const LEADING_PAREN_TAG = /^\s*\(\s*([a-zA-Z][a-zA-Z\s/\-]*?)\s*\)\s*/;
const LEADING_BRACKET_TAG = /^\s*\[\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*\]\s*/;
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
    out = out.replace(LEADING_BRACKET_TAG, "").replace(LEADING_PAREN_TAG, "");
  }
  return out.replace(TRAILING_XML_SUFFIX, "").replace(TRAILING_BRACKET_SUFFIX, "");
}

function rawMarkerValue(marker: string): string {
  const value = marker.trim();
  if (
    (value.startsWith("<") && value.endsWith(">")) ||
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("(") && value.endsWith(")"))
  ) {
    return value.slice(1, -1).trim().toLowerCase();
  }
  return value.toLowerCase();
}

function suffixMarker(marker: string): string {
  const value = marker.trim();
  return value.startsWith("<") && value.endsWith(">") ? value : `<${value}>`;
}

function bracketMarker(marker: string): string {
  const value = marker.trim();
  return value.startsWith("[") && value.endsWith("]") ? value : `[${value}]`;
}

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  const { messages: m } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);
  const engineInfo = useProjectStore(
    (s) => s.model.engines.find((e) => e.id === s.model.engine),
  );
  const styleMode = engineInfo?.styleMode ?? "instruction";
  const markersIgnored = styleMode === "none";
  const suffixMode = styleMode === "suffix-tag";
  const bracketMode = styleMode === "bracket-tag";
  const markerTags = markersIgnored
    ? []
    : engineInfo?.supportedMarkers.length
      ? engineInfo.supportedMarkers
      : [...EMOTION_TAGS];
  const rawCurrentTag = suffixMode
    ? value.match(TRAILING_XML_SUFFIX)?.[1]
    : bracketMode
      ? value.match(LEADING_BRACKET_TAG)?.[1] || value.match(TRAILING_BRACKET_SUFFIX)?.[1]
    : value.match(LEADING_PAREN_TAG)?.[1] || value.match(LEADING_XML_TAG)?.[1];
  const currentTag = (rawCurrentTag ?? "").trim().toLowerCase();
  const styleHint =
    styleMode === "intensity"
      ? m.script.styleHints.intensity
      : styleMode === "controlled-vocabulary"
        ? m.script.styleHints.controlledVocabulary
      : styleMode === "suffix-tag"
        ? m.script.styleHints.suffixTag
        : styleMode === "bracket-tag"
          ? m.script.styleHints.bracketTag
          : styleMode === "none"
            ? m.script.styleHints.none
            : m.script.styleHints.instruction;

  function applyTag(tag: string) {
    const body = stripEmotionTag(value).trim();
    const rawTag = rawMarkerValue(tag);
    if (currentTag === rawTag) {
      // Toggle off: clicking the active tag removes it.
      onChange(body);
    } else if (suffixMode) {
      onChange(`${body} ${suffixMarker(tag)}`.trim());
    } else if (bracketMode) {
      onChange(`${bracketMarker(tag)} ${body}`.trim());
    } else {
      onChange(`(${rawTag}) ${body}`);
    }
    requestAnimationFrame(() => ref.current?.focus());
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {m.script.label}
      </div>
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={m.script.placeholder}
        className="min-h-[88px]"
      />
      <div className={`flex flex-wrap gap-1 ${markersIgnored ? "opacity-50" : ""}`}>
        {markerTags.map((tag) => {
          const rawTag = rawMarkerValue(tag);
          const active = currentTag === rawTag;
          const markerLabel = suffixMode
            ? suffixMarker(tag)
            : bracketMode
              ? bracketMarker(tag)
              : `(${rawTag})`;
          return (
            <Button
              key={tag}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => applyTag(tag)}
              title={
                active
                  ? m.script.removeMarker(markerLabel)
                  : m.script.setMarker(markerLabel)
              }
              className="h-6 px-2 text-[11px] font-normal"
            >
              {rawTag}
            </Button>
          );
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">{styleHint}</div>
    </div>
  );
}
