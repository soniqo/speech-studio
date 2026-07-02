import { useState } from "react";
import { TrackList } from "./TrackList";
import { VoiceLibrary } from "./VoiceLibrary";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n/useI18n";

type Tab = "tracks" | "voices";

export function LeftRail() {
  const { messages: t } = useI18n();
  const [tab, setTab] = useState<Tab>("tracks");

  return (
    <aside className="flex w-[240px] flex-col border-r border-border bg-card/40">
      <div className="flex border-b border-border">
        {(["tracks", "voices"] as const).map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={cn(
              "flex-1 px-3 py-2 text-xs font-medium uppercase tracking-wider transition-colors",
              tab === item
                ? "text-foreground border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
            )}
          >
            {item === "tracks" ? t.rail.tracks : t.rail.voices}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "tracks" ? <TrackList /> : <VoiceLibrary />}
      </div>
    </aside>
  );
}
