import { useRef } from "react";
import { EMOTION_TAGS, EmotionTag } from "../types/project";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// Match `(tag)` or `<tag>...</tag>` wrappers at the start of a line so we can
// swap them out cleanly. Permissive on tag character set to allow custom
// emotion descriptors like `(slow and dreamy)`.
const LEADING_PAREN_TAG = /^\s*\(\s*([a-zA-Z][a-zA-Z\s/\-]*?)\s*\)\s*/;
const LEADING_XML_TAG = /^\s*<\s*([a-zA-Z][a-zA-Z0-9_\-]*)\s*>/;
const TRAILING_XML_CLOSE = /<\s*\/\s*[a-zA-Z][a-zA-Z0-9_\-]*\s*>\s*$/;

function stripLeadingEmotionTag(text: string): string {
  let out = text;
  const xmlOpen = out.match(LEADING_XML_TAG);
  if (xmlOpen) {
    out = out.slice(xmlOpen[0].length);
    out = out.replace(TRAILING_XML_CLOSE, "");
  } else {
    out = out.replace(LEADING_PAREN_TAG, "");
  }
  return out;
}

export function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const currentTag = (value.match(LEADING_PAREN_TAG)?.[1] || value.match(LEADING_XML_TAG)?.[1] || "")
    .trim()
    .toLowerCase();

  function applyTag(tag: EmotionTag) {
    const body = stripLeadingEmotionTag(value).trimStart();
    if (currentTag === tag) {
      // Toggle off: clicking the active tag removes it.
      onChange(body);
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
      <div className="flex flex-wrap gap-1">
        {EMOTION_TAGS.map((t) => {
          const active = currentTag === t;
          return (
            <Button
              key={t}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => applyTag(t)}
              title={
                active
                  ? `Remove (${t}) marker`
                  : `Set this line's tone to (${t})`
              }
              className="h-6 px-2 text-[11px] font-normal"
            >
              {t}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
