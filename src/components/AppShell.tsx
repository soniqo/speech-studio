import { TopBar } from "./TopBar";
import { LeftRail } from "./LeftRail";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { Transport } from "./Transport";
import { usePlayheadTick } from "../hooks/usePlayheadTick";
import { useAudioScheduler } from "../hooks/useAudioScheduler";
import { useDemoProgress } from "../hooks/useDemoProgress";
import { TooltipProvider } from "./ui/tooltip";

export function AppShell() {
  usePlayheadTick();
  useAudioScheduler();
  useDemoProgress();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <LeftRail />
          <Timeline />
          <Inspector />
        </div>
        <Transport />
      </div>
    </TooltipProvider>
  );
}
