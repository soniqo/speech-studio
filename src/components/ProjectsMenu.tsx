import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FilePlus2, FolderOpen, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import { buildDemoProject, buildHindiDemoProject } from "../state/demoProject";
import {
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type ProjectMeta,
} from "../ipc/commands";
import type { Project } from "../types/project";
import { Button } from "./ui/button";
import {
  dateLocale,
  isDefaultProjectName,
  localizeDemoProgressMessage,
} from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

// Projects dropdown: open / delete persisted projects (JSON files under the
// app data dir) plus the built-in demo scene. Changes autosave (debounced)
// whenever the project differs from the last saved snapshot, so switching
// projects is always safe; the TopBar also has an explicit Save button
// (useProjectSave) for a manual flush. An untouched empty "Untitled" project
// is never written — no file litter from just launching.
export function ProjectsMenu() {
  const { locale, messages: t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const resetProject = useProjectStore((s) => s.resetProject);
  const setTtsEngine = useProjectStore((s) => s.setTtsEngine);
  const savedSnapshot = useProjectStore((s) => s.savedSnapshot);
  const markSaved = useProjectStore((s) => s.markSaved);
  const setDemoProgress = useProjectStore((s) => s.setDemoProgress);
  const demoProgress = useProjectStore((s) => s.demoProgress);
  const engines = useProjectStore((s) => s.model.engines);

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Panel position, computed from the trigger on open. The panel renders in a
  // portal on document.body: the TopBar's backdrop-blur creates a stacking
  // context, so an in-place absolute dropdown gets painted over by the
  // timeline no matter its z-index.
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  const dirty = savedSnapshot
    ? JSON.stringify(project) !== savedSnapshot
    : project.tracks.length > 0 ||
      project.voices.length > 0 ||
      !isDefaultProjectName(project.name);

  // Debounced autosave: any change to the project persists ~1 s later.
  // Reads the store at fire time, never a render-captured value.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const current = useProjectStore.getState().project;
      const snapshot = JSON.stringify(current);
      setSaving(true);
      saveProject(current)
        .then(() => {
          markSaved(snapshot);
          if (open) void refreshList();
        })
        .catch((e) => {
          console.error("autosave failed", e);
          setError(String(e));
        })
        .finally(() => setSaving(false));
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, dirty]);

  useEffect(() => {
    if (!open) return;
    void refreshList();
    const btn = rootRef.current?.querySelector("button");
    if (btn) {
      const r = btn.getBoundingClientRect();
      setPanelPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    }
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function refreshList() {
    try {
      setItems(await listProjects());
    } catch (e) {
      console.error("list_projects failed", e);
      setError(String(e));
    }
  }

  /** Flush any unsaved changes immediately (before switching projects). */
  async function flushSave() {
    const current = useProjectStore.getState().project;
    const snapshot = JSON.stringify(current);
    if (snapshot === useProjectStore.getState().savedSnapshot) return;
    const hasContent =
      current.tracks.length > 0 ||
      current.voices.length > 0 ||
      !isDefaultProjectName(current.name);
    if (!hasContent) return;
    await saveProject(current);
    markSaved(snapshot);
  }

  /** Autosave makes switching always safe: flush, then run the action. */
  function guarded(action: () => Promise<void>) {
    void runBusy(async () => {
      await flushSave();
      await action();
    });
  }

  async function runBusy(action: () => Promise<void>, closeAfter = true) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (closeAfter) setOpen(false);
    } catch (e) {
      console.error("project action failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function actionNew() {
    resetProject();
  }

  async function actionLoad(id: string) {
    const json = await loadProject(id);
    const loaded = JSON.parse(json) as Project;
    setProject(loaded);
    markSaved(JSON.stringify(loaded));
  }

  async function actionDemo() {
    const built = await buildDemoProject();
    // Stable id: repeated demo loads + autosave converge on one saved file
    // instead of littering a new project per load.
    const p = {
      ...built,
      id: "demo-scene",
      name: t.defaults.demoProject,
      voices: built.voices.map((voice, index) =>
        index === 0
          ? { ...voice, name: t.defaults.narratorVoice }
          : index === 1
            ? { ...voice, name: t.defaults.antagonistVoice }
            : voice,
      ),
      tracks: built.tracks.map((track) =>
        track.kind === "video" ? { ...track, name: t.defaults.demoVideoTrack } : track,
      ),
    };
    setProject(p);
    // The demo is a starting point, not a saved file — mark it clean so
    // closing it without edits doesn't prompt, but any edit makes it dirty.
    markSaved(JSON.stringify(p));
    setDemoProgress(null);
  }

  async function actionHindiDemo() {
    const built = await buildHindiDemoProject();
    const p = {
      ...built,
      id: "demo-hindi-voice-clone",
      name: t.defaults.hindiDemoProject,
      voices: built.voices.map((voice, index) =>
        index === 0
          ? { ...voice, name: t.defaults.hindiVoice }
          : index === 1
            ? { ...voice, name: t.defaults.hindiVoice2 }
            : voice,
      ),
      tracks: built.tracks.map((track) =>
        track.kind === "video"
          ? { ...track, name: t.defaults.hindiDemoVideoTrack }
          : track.kind === "speaker"
            ? {
                ...track,
                name:
                  track.voiceId === built.voices[0].id
                    ? t.defaults.hindiSpeakerTrack
                    : t.defaults.hindiSpeakerTrack2,
              }
            : track,
      ),
    };
    setProject(p);
    markSaved(JSON.stringify(p));
    setDemoProgress(null);
    if (engines.some((engine) => engine.id === "indic-mio")) {
      setTtsEngine("indic-mio");
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={t.projects.title}
      >
        {busy ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
        )}
        {busy && demoProgress
          ? `${demoProgress.current}/${demoProgress.total} — ${localizeDemoProgressMessage(locale, demoProgress.message)}`
          : t.projects.button}
        {(saving || dirty) && (
          <span className="ml-1 text-amber-400" title={t.projects.saving}>•</span>
        )}
        <ChevronDown className="ml-1 h-3 w-3" />
      </Button>

      {open && panelPos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: panelPos.top, right: panelPos.right }}
            className="z-50 w-72 rounded-md border border-border bg-popover p-1 shadow-lg"
          >
          <MenuRow
            icon={<FilePlus2 className="h-3.5 w-3.5" />}
            label={t.projects.newProject}
            onClick={() => guarded(actionNew)}
          />
          <MenuRow
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label={t.projects.demoScene}
            onClick={() => guarded(actionDemo)}
          />
          <MenuRow
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label={t.projects.hindiDemoScene}
            onClick={() => guarded(actionHindiDemo)}
          />
          <div className="my-1 border-t border-border/60" />
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground">
            {saving || dirty ? (
              <>
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {t.projects.saving}
              </>
            ) : (
              <>
                <Check className="h-2.5 w-2.5 text-emerald-400" />
                {t.projects.allSaved}
              </>
            )}
          </div>
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t.projects.savedProjects}
          </div>
          {items.length === 0 && (
            <div className="px-2 pb-1.5 text-xs text-muted-foreground">
              {t.projects.noneYet}
            </div>
          )}
          {items.map((m) => (
            <div key={m.id} className="group flex items-center">
              <MenuRow
                className="flex-1"
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                label={(m.id === project.id ? project.name : m.name) || t.defaults.untitledProject}
                sub={
                  m.id === project.id
                    ? t.projects.openNow
                    : m.savedAt
                      ? new Date(m.savedAt).toLocaleString(dateLocale(locale))
                      : undefined
                }
                onClick={() => guarded(() => actionLoad(m.id))}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                title={t.projects.deleteTitle}
                aria-label={t.projects.deleteAria(m.name)}
                onClick={() =>
                  void runBusy(async () => {
                    await deleteProject(m.id);
                    await refreshList();
                  })
                }
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          {error && (
            <div className="px-2 py-1 text-[11px] text-destructive" title={error}>
              {error}
            </div>
          )}
          </div>,
          document.body,
        )}

    </div>
  );
}

function MenuRow({
  icon,
  label,
  sub,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/40 " +
        (className ?? "")
      }
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-[10px] text-muted-foreground">{sub}</span>}
      </span>
    </button>
  );
}
