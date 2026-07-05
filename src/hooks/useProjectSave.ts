import { useState } from "react";
import { saveProject } from "../ipc/commands";
import { useProjectStore } from "../state/projectStore";
import { isDefaultProjectName } from "../i18n/messages";
import type { Project } from "../types/project";

/**
 * True when the project holds anything worth writing to disk. An untouched
 * empty "Untitled" project is never saved — no file litter from just
 * launching the app.
 */
export function projectHasSaveableContent(project: Project): boolean {
  return (
    project.tracks.length > 0 ||
    project.voices.length > 0 ||
    !isDefaultProjectName(project.name)
  );
}

/**
 * Dirty state + explicit save. Shared by the TopBar Save button and the
 * Projects menu (whose debounced autosave and flush-before-switch use the
 * same dirty definition).
 */
export function useProjectSave() {
  const project = useProjectStore((s) => s.project);
  const savedSnapshot = useProjectStore((s) => s.savedSnapshot);
  const markSaved = useProjectStore((s) => s.markSaved);
  const [saving, setSaving] = useState(false);

  const dirty = savedSnapshot
    ? JSON.stringify(project) !== savedSnapshot
    : projectHasSaveableContent(project);

  async function saveNow() {
    const current = useProjectStore.getState().project;
    const snapshot = JSON.stringify(current);
    if (snapshot === useProjectStore.getState().savedSnapshot) return;
    if (!projectHasSaveableContent(current)) return;
    setSaving(true);
    try {
      await saveProject(current);
      markSaved(snapshot);
    } finally {
      setSaving(false);
    }
  }

  return { dirty, saving, saveNow };
}
