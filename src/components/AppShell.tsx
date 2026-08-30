import { TopBar } from "./TopBar";
import { LeftRail } from "./LeftRail";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { Transport } from "./Transport";
import { ActivityPanel } from "./ActivityPanel";
import { usePlayheadTick } from "../hooks/usePlayheadTick";
import { useAudioScheduler } from "../hooks/useAudioScheduler";
import { useDemoProgress } from "../hooks/useDemoProgress";
import { useActivityLog } from "../hooks/useActivityLog";
import { useProjectStore } from "../state/projectStore";
import { TooltipProvider } from "./ui/tooltip";
import { clampPercent, formatPercent } from "../lib/formatPercent";
import { localizeModelProgressMessage } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

function ModelLoadingBanner() {
  const { locale, messages: t } = useI18n();
  const model = useProjectStore((s) => s.model);

  if (model.status !== "loading") return null;

  const engineName =
    model.engines.find((candidate) => candidate.id === model.engine)?.displayName ??
    model.engine;
  const progress = model.progress;
  const percent = progress ? clampPercent(progress.percent) : null;
  const message = progress
    ? localizeModelProgressMessage(locale, progress.message)
    : t.appShell.preparingDownload;

  return (
    <div className="border-b border-border bg-muted/35 px-3 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0 truncate text-foreground/85">
          <span className="font-medium">{engineName}</span>
          <span className="text-muted-foreground"> · {message}</span>
        </div>
        <div className="shrink-0 tabular-nums text-muted-foreground">
          {percent == null ? "…" : formatPercent(percent)}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-background/70">
        <div
          className={
            percent == null
              ? "h-full w-1/3 animate-pulse rounded-full bg-primary/70"
              : "h-full rounded-full bg-primary transition-[width] duration-300"
          }
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function AppShell() {
  usePlayheadTick();
  useAudioScheduler();
  useDemoProgress();
  useActivityLog();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopBar />
        <ModelLoadingBanner />
        <div className="flex min-h-0 flex-1">
          <LeftRail />
          <Timeline />
          <Inspector />
        </div>
        <ActivityPanel />
        <Transport />
      </div>
    </TooltipProvider>
  );
}
