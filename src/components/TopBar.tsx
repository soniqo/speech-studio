import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertCircle, ArrowDownToLine, Loader2 } from "lucide-react";
import { useProjectStore, type ModelStatus } from "../state/projectStore";
import { DevPing } from "./DevPing";
import { ProjectsMenu } from "./ProjectsMenu";
import { useSynthesizeAll, useUnsynthesizedCount } from "../hooks/useSynthesizeAll";
import { useUpdater } from "../hooks/useUpdater";
import { exportProject, initModel, type ExportClip, type TtsEngineId } from "../ipc/commands";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "@/lib/utils";
import { clipAudioPath } from "../lib/clipAudio";

/** Quiet until an update exists; one click downloads + relaunches. */
function UpdateChip() {
  const { status, version, progress, install } = useUpdater();
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <Badge variant="destructive" title="Update failed — try again from the next launch, or download manually from GitHub releases">
        update failed
      </Badge>
    );
  }
  const downloading = status === "downloading";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={install}
      disabled={downloading}
      title={`Update to v${version} and restart`}
    >
      {downloading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" />
      )}
      {downloading
        ? progress != null
          ? `Updating ${Math.round(progress * 100)}%`
          : "Updating…"
        : `Update to v${version}`}
    </Button>
  );
}

function ModelChip({
  status,
  error,
  engineName,
}: {
  status: ModelStatus;
  error?: string;
  engineName: string;
}) {
  const variant =
    status === "ready" ? "success" : status === "error" ? "destructive" : "muted";
  const label =
    status === "ready"
      ? `${engineName} ready`
      : status === "loading"
        ? `${engineName} loading…`
        : status === "error"
          ? `${engineName} error`
          : `${engineName} idle`;
  return (
    <Badge variant={variant} title={error ?? `Model status: ${status}`}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "ready" && "bg-emerald-400",
          status === "error" && "bg-destructive",
          status === "loading" && "bg-muted-foreground animate-pulse",
          status === "idle" && "bg-muted-foreground",
        )}
      />
      {label}
    </Badge>
  );
}

/** Languages a per-language engine (Chatterbox) can synthesize today. */
const TTS_LANGUAGES: { id: string; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ar", label: "العربية" },
  { id: "hi", label: "हिन्दी" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "it", label: "Italiano" },
  { id: "pt", label: "Português" },
];

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const renameProject = useProjectStore((s) => s.renameProject);
  const model = useProjectStore((s) => s.model);
  const setModelStatus = useProjectStore((s) => s.setModelStatus);
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);
  const setTtsLanguage = useProjectStore((s) => s.setTtsLanguage);
  const synthesisStatus = useProjectStore((s) => s.synthesisStatus);
  const synthesisProgress = useProjectStore((s) => s.synthesisProgress);
  const hasContent = project.tracks.length > 0;
  const missingCount = useUnsynthesizedCount();
  const { run: runSynthesize } = useSynthesizeAll();
  const [actionError, setActionError] = useState<string | null>(null);

  const synthBusy = synthesisStatus === "running";
  const modelStatus = model.status;
  const engineInfo = model.engines.find((candidate) => candidate.id === model.engine);
  const engineName = engineInfo?.displayName ?? "VoxCPM2";
  const synthDisabled = synthBusy || modelStatus !== "ready" || !hasContent;
  const synthMode: "missing" | "all" = missingCount > 0 ? "missing" : "all";
  const synthLabel = synthBusy
    ? synthesisProgress
      ? `Synth ${synthesisProgress.current}/${synthesisProgress.total} — ${synthesisProgress.label}`
      : "Synthesizing…"
    : missingCount > 0
      ? `Synthesize (${missingCount})`
      : "Resynthesize all";

  async function onSynthesize() {
    setActionError(null);
    try {
      const result = await runSynthesize(synthMode);
      if (result.total === 0) {
        setActionError(
          "Nothing to synthesize — clips need text and an assigned voice (locked clips are skipped)",
        );
      } else if (result.failed > 0) {
        setActionError(`${result.failed}/${result.total} clips failed — see console`);
      }
    } catch (e) {
      console.error("synthesize failed", e);
      setActionError(String(e));
    }
  }

  async function onEngineChange(next: TtsEngineId) {
    if (next === model.engine || synthBusy) return;
    setActionError(null);
    setTtsEngine(next);
    setModelStatus("loading");
    try {
      await initModel(next);
      setModelStatus("ready");
    } catch (e) {
      setModelStatus("error", String(e));
    }
  }

  // Flatten every rendered clip into the {startSec, audioPath} payload the
  // Rust mixer expects. Clips without renderedAudioPath are skipped — they'd
  // become silent gaps in the mix, which is the desired behaviour.
  function exportClips(): ExportClip[] {
    const clips: ExportClip[] = [];
    for (const t of project.tracks) {
      if (t.kind !== "speaker") continue;
      for (const c of t.clips) {
        const audioPath = clipAudioPath(c);
        if (!audioPath) continue;
        clips.push({ startSec: c.startSec, audioPath });
      }
    }
    return clips;
  }
  const renderedCount = exportClips().length;
  const exportDisabled = renderedCount === 0;

  async function onExport() {
    const clips = exportClips();
    if (clips.length === 0) return;
    const defaultName = `${project.name.trim() || "soniqo-export"}.wav`;
    const chosen = await save({
      title: "Export mix as WAV",
      defaultPath: defaultName,
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
    });
    if (!chosen) return;
    try {
      const result = await exportProject({
        outPath: chosen,
        durationSec: Math.max(project.durationSec, 1),
        clips,
      });
      console.log("[export] ok", result);
    } catch (e) {
      console.error("[export] failed", e);
      setActionError(`export failed: ${e}`);
    }
  }

  return (
    <header className="flex h-11 items-center gap-3 border-b border-border bg-card/60 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/40">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="flex items-center gap-2 text-sm">
          <img
            src="/soniqo.png"
            alt="Soniqo"
            className="h-6 w-6 shrink-0 rounded"
          />
          <span className="font-semibold tracking-tight text-foreground">
            Speech Studio
          </span>
        </span>
        <Input
          className="h-7 max-w-[220px] text-xs"
          value={project.name}
          onChange={(e) => renameProject(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <UpdateChip />
        {model.engines.length > 1 && (
          <Select
            value={model.engine}
            onValueChange={(value) => void onEngineChange(value as TtsEngineId)}
            disabled={modelStatus === "loading" || synthBusy}
          >
            <SelectTrigger
              className="h-7 w-[158px] text-xs"
              title="Switches the loaded voice-cloning engine"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {model.engines.map((engine) => (
                <SelectItem key={engine.id} value={engine.id}>
                  {engine.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {engineInfo?.requiresLanguage && (
          <Select
            value={model.language}
            onValueChange={(value) => setTtsLanguage(value)}
            disabled={synthBusy}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-xs"
              title="Synthesis language — Chatterbox prepends this as its language token"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TTS_LANGUAGES.map((lang) => (
                <SelectItem key={lang.id} value={lang.id}>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ModelChip status={modelStatus} error={model.error} engineName={engineName} />
        <DevPing />
        <ProjectsMenu />
        {actionError && (
          <span
            className="flex items-center gap-1 truncate text-xs text-destructive max-w-[280px]"
            title={actionError}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {actionError}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={onSynthesize}
          disabled={synthDisabled}
          title={
            modelStatus !== "ready"
              ? `Wait for ${engineName} to finish loading`
              : !hasContent
                ? "Load a project first"
                : missingCount > 0
                  ? `Synthesize ${missingCount} clip(s) that don't have audio yet`
                  : "Re-synthesize all non-locked clips"
          }
        >
          {synthBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {synthLabel}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onExport}
          disabled={exportDisabled}
          title={
            renderedCount === 0
              ? "Synthesize at least one clip before exporting"
              : `Export a WAV mix of ${renderedCount} clip${renderedCount === 1 ? "" : "s"}`
          }
        >
          Export
        </Button>
      </div>
    </header>
  );
}
