import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AlertCircle, ArrowDownToLine, Check, Loader2, Save } from "lucide-react";
import { useProjectStore, type ModelLoadProgress, type ModelStatus } from "../state/projectStore";
import { DevPing } from "./DevPing";
import { ProjectsMenu } from "./ProjectsMenu";
import { useSynthesizeAll, useUnsynthesizedCount } from "../hooks/useSynthesizeAll";
import { useProjectSave } from "../hooks/useProjectSave";
import { useUpdater } from "../hooks/useUpdater";
import { exportProject, initModel, interruptModelLoad, type ExportClip, type TtsEngineId } from "../ipc/commands";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "@/lib/utils";
import { clipAudioPath } from "../lib/clipAudio";
import { clampPercent, formatPercent } from "../lib/formatPercent";
import { languageLabel } from "../lib/languageLabels";
import { localizeModelProgressMessage, type AppLocale } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

function formatElapsed(seconds: number, locale: AppLocale): string {
  if (!Number.isFinite(seconds) || seconds < 0) return locale === "ru" ? "0 с" : "0s";
  const whole = Math.floor(seconds);
  if (whole < 60) return locale === "ru" ? `${whole} с` : `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return locale === "ru"
    ? `${minutes} мин ${rest.toString().padStart(2, "0")} с`
    : `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

function useElapsedSeconds(startedAt?: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt ? Math.max(0, (now - startedAt) / 1000) : null;
}

/** Quiet until an update exists; one click downloads + relaunches. */
function UpdateChip() {
  const { messages: t } = useI18n();
  const { status, version, progress, install } = useUpdater();
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <Badge variant="destructive" title={t.update.failedTitle}>
        {t.update.failedLabel}
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
      title={t.update.title(version)}
    >
      {downloading ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" />
      )}
      {downloading
        ? progress != null
          ? t.update.updatingPercent(Math.round(progress * 100))
          : t.update.updating
        : t.update.updateTo(version)}
    </Button>
  );
}

function ModelChip({
  status,
  error,
  engineName,
  progress,
}: {
  status: ModelStatus;
  error?: string;
  engineName: string;
  progress?: ModelLoadProgress;
}) {
  const { locale, messages: t } = useI18n();
  const variant =
    status === "ready" ? "success" : status === "error" ? "destructive" : "muted";
  const label =
    status === "ready"
      ? t.model.ready(engineName, "")
      : status === "loading"
        ? progress
          ? `${engineName} ${formatPercent(progress.percent)}`
          : t.model.loading(engineName)
        : status === "error"
          ? t.model.error(engineName)
          : t.model.idle(engineName);
  const title =
    error ??
    (status === "loading"
      ? progress
        ? `${localizeModelProgressMessage(locale, progress.message)} — ${formatPercent(progress.percent)}.`
        : t.model.loadingTitle(engineName)
      : t.model.statusTitle(status));
  return (
    <Badge
      variant={variant}
      title={title}
      className={cn(
        "relative shrink-0 overflow-hidden whitespace-nowrap",
        status === "loading" && "pr-2.5",
      )}
    >
      {status === "loading" && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted-foreground/15">
          <span
            className={cn(
              "absolute bottom-0 left-0 h-full bg-muted-foreground/60",
              !progress && "w-1/2 animate-pulse",
            )}
            style={progress ? { width: `${clampPercent(progress.percent)}%` } : undefined}
          />
        </span>
      )}
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

export function TopBar() {
  const { locale, messages: t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const renameProject = useProjectStore((s) => s.renameProject);
  const model = useProjectStore((s) => s.model);
  const setModelStatus = useProjectStore((s) => s.setModelStatus);
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);
  const setTtsLanguage = useProjectStore((s) => s.setTtsLanguage);
  const synthesisStatus = useProjectStore((s) => s.synthesisStatus);
  const synthesisProgress = useProjectStore((s) => s.synthesisProgress);
  const hasContent = project.tracks.length > 0;
  const { dirty, saving, saveNow } = useProjectSave();
  const missingCount = useUnsynthesizedCount();
  const { run: runSynthesize } = useSynthesizeAll();
  const [actionError, setActionError] = useState<string | null>(null);

  const synthBusy = synthesisStatus === "running";
  const synthElapsed = useElapsedSeconds(
    synthBusy ? synthesisProgress?.startedAt : undefined,
  );
  const modelStatus = model.status;
  const engineInfo = model.engines.find((candidate) => candidate.id === model.engine);
  const engineName = engineInfo?.displayName ?? "VoxCPM2";
  const languageIds = engineInfo?.requiresLanguage ? engineInfo.languages : [];
  const languageOptions = languageIds.map((id) => ({
    id,
    label: languageLabel(id),
  }));
  const selectedLanguage = languageIds.includes(model.language)
    ? model.language
    : languageIds[0];
  const showLanguageSelector = languageOptions.length > 1 && !!selectedLanguage;
  const synthDisabled = synthBusy || modelStatus !== "ready" || !hasContent;
  const engineSwitchDisabled = synthBusy;
  const synthMode: "missing" | "all" = missingCount > 0 ? "missing" : "all";
  const synthLabel = synthBusy
    ? synthesisProgress
      ? t.topBar.synthProgress(
          synthesisProgress.current,
          synthesisProgress.total,
          synthElapsed == null ? "" : formatElapsed(synthElapsed, locale),
          synthesisProgress.label,
        )
      : t.topBar.synthesizing
    : missingCount > 0
      ? t.topBar.synthMissing(missingCount)
      : t.topBar.resynthesizeAll;

  async function onSynthesize() {
    setActionError(null);
    try {
      const result = await runSynthesize(synthMode);
      if (result.total === 0) {
        setActionError(t.topBar.nothingToSynthesize);
      } else if (result.failed > 0) {
        setActionError(t.topBar.clipsFailed(result.failed, result.total));
      }
    } catch (e) {
      console.error("synthesize failed", e);
      setActionError(String(e));
    }
  }

  async function onEngineChange(next: TtsEngineId) {
    if (next === model.engine || synthBusy) return;
    setActionError(null);
    const wasLoading = useProjectStore.getState().model.status === "loading";
    setTtsEngine(next);
    setModelStatus("loading");
    try {
      if (wasLoading) {
        await interruptModelLoad();
      }
      await initModel(next);
      if (useProjectStore.getState().model.engine === next) {
        setModelStatus("ready");
      }
    } catch (e) {
      if (useProjectStore.getState().model.engine === next) {
        setModelStatus("error", String(e));
      }
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
    const defaultName = `${project.name.trim() || t.defaults.exportFileBase}.wav`;
    const chosen = await save({
      title: t.topBar.exportMixTitle,
      defaultPath: defaultName,
      filters: [{ name: t.topBar.wavAudio, extensions: ["wav"] }],
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
      setActionError(t.topBar.exportFailed(String(e)));
    }
  }

  return (
    <header className="flex h-11 items-center gap-3 overflow-hidden border-b border-border bg-card/60 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/40">
      <div className="flex min-w-0 shrink items-center gap-2.5">
        <span className="flex shrink-0 items-center gap-2 text-sm">
          <img
            src="/soniqo.png"
            alt="Soniqo"
            className="h-6 w-6 shrink-0 rounded"
          />
          <span className="hidden whitespace-nowrap font-semibold tracking-tight text-foreground xl:inline">
            Speech Studio
          </span>
        </span>
        <Input
          className="h-7 w-[140px] min-w-[80px] shrink text-xs lg:w-[220px]"
          value={project.name}
          onChange={(e) => renameProject(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <UpdateChip />
        {model.engines.length > 1 && (
          <Select
            value={model.engine}
            onValueChange={(value) => void onEngineChange(value as TtsEngineId)}
            disabled={engineSwitchDisabled}
          >
            <SelectTrigger
              className="h-7 w-[158px] shrink-0 text-xs"
              title={
                modelStatus === "loading"
                  ? t.topBar.switchLoadingEngine(engineName)
                  : t.topBar.switchEngineTitle
              }
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
        {showLanguageSelector && (
          <Select
            value={selectedLanguage}
            onValueChange={(value) => setTtsLanguage(value)}
            disabled={synthBusy}
          >
            <SelectTrigger
              className="h-7 w-[120px] shrink-0 text-xs"
              title={t.topBar.synthesisLanguageTitle}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languageOptions.map((lang) => (
                <SelectItem key={lang.id} value={lang.id}>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ModelChip
          status={modelStatus}
          error={model.error}
          engineName={engineName}
          progress={model.progress}
        />
        <div className="hidden shrink-0 2xl:flex">
          <DevPing />
        </div>
        <div className="shrink-0">
          <ProjectsMenu />
        </div>
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
          className="min-w-0 max-w-[240px] shrink"
          title={
            modelStatus !== "ready"
              ? t.topBar.waitModel(engineName)
              : !hasContent
                ? t.topBar.loadProjectFirst
                : missingCount > 0
                  ? t.topBar.synthesizeMissingTitle(missingCount)
                  : t.topBar.resynthesizeTitle
          }
        >
          {synthBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
          <span className="truncate">{synthLabel}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void saveNow()}
          disabled={!hasContent || (!dirty && !saving)}
          className="shrink-0"
          title={t.topBar.saveTitle}
        >
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : dirty ? (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-400" />
          )}
          {dirty || saving ? t.topBar.save : t.topBar.saved}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onExport}
          disabled={exportDisabled}
          className="shrink-0"
          title={
            renderedCount === 0
              ? t.topBar.exportDisabledTitle
              : t.topBar.exportTitle(renderedCount)
          }
        >
          {t.topBar.exportButton}
        </Button>
      </div>
    </header>
  );
}
