import { Mic, Sparkles } from "lucide-react";

export function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Mic className="h-10 w-10 text-muted-foreground" />
        <div className="text-base font-medium">No tracks yet</div>
        <p className="text-sm text-muted-foreground">
          Add a speaker track from the rail on the left and assign it a cloned
          voice, or hit <span className="inline-flex items-center gap-1 font-medium text-foreground"><Sparkles className="h-3 w-3" /> Load demo</span> in the
          top bar to spin up a four-line scene with two cloned voices and
          emotion markers.
        </p>
      </div>
    </div>
  );
}
