import { Mic, Sparkles } from "lucide-react";
import { useI18n } from "../i18n/useI18n";

export function EmptyState() {
  const { messages: t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Mic className="h-10 w-10 text-muted-foreground" />
        <div className="text-base font-medium">{t.emptyState.title}</div>
        <p className="text-sm text-muted-foreground">
          {t.emptyState.beforeDemo}{" "}
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Sparkles className="h-3 w-3" /> {t.emptyState.loadDemo}
          </span>{" "}
          {t.emptyState.afterDemo}
        </p>
      </div>
    </div>
  );
}
