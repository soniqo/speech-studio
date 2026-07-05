import { useState } from "react";
import { Lock, Unlock, Trash2, RefreshCw, History, Loader2 } from "lucide-react";
import { useProjectStore } from "../state/projectStore";
import { ScriptEditor } from "./ScriptEditor";
import { synthesizeClip } from "../ipc/commands";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { cn } from "@/lib/utils";
import { clipAudioVersion } from "../lib/clipAudio";
import { mediaFileSrc } from "../lib/mediaSrc";
import { dateLocale, type Messages } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";

function Section({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
function Value({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { className?: string }) {
  return (
    <div className={cn("text-sm text-foreground/85", className)} {...rest}>
      {children}
    </div>
  );
}

function trackKindLabel(kind: string, messages: Messages): string {
  if (kind === "video") return messages.tracks.kindVideo;
  if (kind === "speaker") return messages.tracks.kindSpeaker;
  if (kind === "audio") return messages.tracks.kindAudio;
  return kind;
}

function voiceSourceLabel(sourceKind: string, messages: Messages): string {
  if (sourceKind === "library") return messages.voices.sourceKind.library;
  if (sourceKind === "clip-clone") return messages.voices.sourceKind.clipClone;
  if (sourceKind === "track-clone") return messages.voices.sourceKind.trackClone;
  return sourceKind;
}

export function Inspector() {
  const { locale, messages: t } = useI18n();
  const selection = useProjectStore((s) => s.selection);
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const updateClip = useProjectStore((s) => s.updateClip);
  const assignVoiceToTrack = useProjectStore((s) => s.assignVoiceToTrack);
  const removeClip = useProjectStore((s) => s.removeClip);
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const seek = useProjectStore((s) => s.seek);
  const engine = useProjectStore((s) => s.model.engine);
  const modelLanguage = useProjectStore((s) => s.model.language);
  const activeEngine = useProjectStore((s) =>
    s.model.engines.find((candidate) => candidate.id === s.model.engine),
  );
  // Regenerate-state hooks must live at the top, BEFORE any early return.
  // Putting them inside the `selection.kind === 'clip'` branch violates the
  // Rules of Hooks — when the user clicks a clip after the pane was on a
  // different selection, the hook count changes and React unmounts the tree.
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [regenTiming, setRegenTiming] = useState<string | null>(null);

  if (selection.kind === "none") {
    const clipExtent = project.tracks.reduce((max, t) => {
      if (t.kind !== "speaker") return max;
      return t.clips.reduce((m, c) => Math.max(m, c.endSec), max);
    }, 0);
    return (
      <aside className="flex w-[320px] flex-col border-l border-border bg-card/40">
        <header className="flex items-center justify-between border-b border-border px-3.5 py-2">
          <span className="text-sm font-medium">{t.inspector.project}</span>
          <span className="text-xs text-muted-foreground truncate">{project.name}</span>
        </header>
        <div className="flex-1 space-y-4 px-3.5 py-3">
          <Section>
            <Label>{t.inspector.lengthSec}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={5}
                step={1}
                value={project.durationSec}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  setProject({ ...project, durationSec: Math.max(5, v) });
                }}
                className="w-24"
              />
              {clipExtent > project.durationSec && (
                <span className="text-xs text-destructive">
                  {t.inspector.clipsExtendTo(clipExtent.toFixed(1))}
                </span>
              )}
            </div>
          </Section>
          <Section>
            <Label>{t.inspector.tracks}</Label>
            <Value>{project.tracks.length}</Value>
          </Section>
          <Section>
            <Label>{t.inspector.voices}</Label>
            <Value>{project.voices.length}</Value>
          </Section>
          <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
            {t.inspector.emptyHint}
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === "track") {
    const track = project.tracks.find((t) => t.id === selection.id);
    if (!track) return null;
    return (
      <aside className="flex w-[320px] flex-col border-l border-border bg-card/40">
        <header className="flex items-center justify-between border-b border-border px-3.5 py-2">
          <span className="text-sm font-medium">{t.inspector.track}</span>
          <span className="text-xs text-muted-foreground">
            {trackKindLabel(track.kind, t)}
          </span>
        </header>
        <div className="flex-1 space-y-4 px-3.5 py-3">
          <Section>
            <Label>{t.inspector.name}</Label>
            <Value>{track.name}</Value>
          </Section>
          {track.kind === "speaker" && (
            <Section>
              <Label>{t.inspector.voice}</Label>
              <Select
                value={track.voiceId ?? "__none__"}
                onValueChange={(value) =>
                  assignVoiceToTrack(track.id, value === "__none__" ? undefined : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t.common.none} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t.common.none}</SelectItem>
                  {project.voices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Section>
          )}
          {track.kind === "video" && (
            <Section>
              <Label>{t.inspector.source}</Label>
              <Value className="break-all">{track.sourcePath}</Value>
            </Section>
          )}
        </div>
      </aside>
    );
  }

  if (selection.kind === "voice") {
    const voice = project.voices.find((v) => v.id === selection.id);
    if (!voice) return null;
    return (
      <aside className="flex w-[320px] flex-col border-l border-border bg-card/40">
        <header className="flex items-center justify-between border-b border-border px-3.5 py-2">
          <span className="text-sm font-medium">{t.inspector.voicePanel}</span>
          <span className="text-xs text-muted-foreground">
            {voiceSourceLabel(voice.sourceKind, t)}
          </span>
        </header>
        <div className="flex-1 space-y-4 px-3.5 py-3">
          <Section>
            <Label>{t.inspector.name}</Label>
            <Input
              value={voice.name}
              onChange={(e) =>
                useProjectStore.setState((s) => ({
                  project: {
                    ...s.project,
                    voices: s.project.voices.map((v) =>
                      v.id === voice.id ? { ...v, name: e.target.value } : v,
                    ),
                  },
                }))
              }
            />
          </Section>
          <Section>
            <Label>{t.inspector.referenceAudio}</Label>
            <Value className="truncate" title={voice.referenceAudioPath}>
              {voice.referenceAudioPath?.split("/").pop() ?? "—"}
            </Value>
          </Section>
          <Section>
            <Label>
              {t.inspector.referenceTranscript}{" "}
              <span className="ml-1 normal-case tracking-normal text-muted-foreground/60">
                {t.inspector.optional}
              </span>
            </Label>
            <Textarea
              value={voice.referenceText}
              onChange={(e) =>
                useProjectStore.setState((s) => ({
                  project: {
                    ...s.project,
                    voices: s.project.voices.map((v) =>
                      v.id === voice.id ? { ...v, referenceText: e.target.value } : v,
                    ),
                  },
                }))
              }
              placeholder={t.inspector.referencePlaceholder}
              className="min-h-[88px]"
            />
          </Section>
          <Section>
            <Label>{t.inspector.created}</Label>
            <Value>{new Date(voice.createdAt).toLocaleString(dateLocale(locale))}</Value>
          </Section>
        </div>
      </aside>
    );
  }

  // selection.kind === 'clip'
  const clip = project.tracks
    .flatMap((t) => (t.kind === "speaker" ? t.clips : []))
    .find((c) => c.id === selection.id);
  if (!clip) return null;

  const parentTrack = project.tracks.find(
    (t) => t.kind === "speaker" && t.clips.some((c) => c.id === clip.id),
  );
  const trackVoiceId = parentTrack && parentTrack.kind === "speaker" ? parentTrack.voiceId : undefined;
  const effectiveVoiceId = clip.voiceOverrideId ?? trackVoiceId;
  const effectiveVoice = project.voices.find((v) => v.id === effectiveVoiceId);
  const current = clip;
  const needsReferenceTranscript =
    activeEngine?.requiresReferenceTranscript ??
    (engine === "cosyvoice" || engine === "qwen3" || engine === "fish-audio");
  const language = activeEngine?.requiresLanguage ? modelLanguage : undefined;
  const transcriptEngineName = activeEngine?.displayName ?? t.inspector.selectedEngine;
  const canRegenerate =
    !isRegenerating &&
    !!effectiveVoice &&
    !!effectiveVoice.referenceAudioPath &&
    (!needsReferenceTranscript || !!effectiveVoice.referenceText.trim()) &&
    current.text.trim().length > 0;

  async function regenerate() {
    if (!effectiveVoice || !effectiveVoice.referenceAudioPath) return;
    setPlaying(false);
    seek(current.startSec);
    setIsRegenerating(true);
    setRegenError(null);
    setRegenTiming(null);
    try {
      const out = await synthesizeClip({
        clipId: current.id,
        engine,
        text: current.text,
        voiceId: effectiveVoice.id,
        referenceAudioPath: effectiveVoice.referenceAudioPath,
        referenceText: effectiveVoice.referenceText,
        language,
      });
      const take = {
        id: crypto.randomUUID(),
        audioPath: out.audioPath,
        text: current.text,
        createdAt: new Date().toISOString(),
        settings: { voiceId: effectiveVoice.id },
      };
      updateClip(current.id, {
        renderedAudioPath: out.audioPath,
        history: [take, ...current.history],
        ...(out.durationSec > 0 ? { endSec: current.startSec + out.durationSec } : {}),
      });
      setRegenTiming(
        t.common.generatedTiming(out.durationSec.toFixed(1), out.elapsedSec.toFixed(1)),
      );
    } catch (e) {
      console.error("synthesize_clip failed", e);
      setRegenError(String(e));
    } finally {
      setIsRegenerating(false);
    }
  }

  function regenerateTitle(): string {
    if (isRegenerating) return t.inspector.generating;
    if (!effectiveVoice) return t.inspector.assignVoiceFirst;
    if (!effectiveVoice.referenceAudioPath) return t.inspector.missingReference;
    if (needsReferenceTranscript && !effectiveVoice.referenceText.trim()) {
      return t.inspector.referenceTranscriptNeeded(transcriptEngineName);
    }
    if (current.text.trim().length === 0) return t.inspector.writeSomethingFirst;
    return t.inspector.generateAudio;
  }

  return (
    <aside className="flex w-[320px] flex-col border-l border-border bg-card/40">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-2">
        <span className="text-sm font-medium">{t.inspector.clip}</span>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto px-3.5 py-3">
        <Section>
          <Label>{t.inspector.voiceOverride}</Label>
          <Select
            value={clip.voiceOverrideId ?? "__inherit__"}
            onValueChange={(value) =>
              updateClip(clip.id, {
                voiceOverrideId: value === "__inherit__" ? undefined : value,
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder={t.common.inheritFromTrack} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit__">{t.common.inheritFromTrack}</SelectItem>
              {project.voices.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <ScriptEditor value={clip.text} onChange={(text) => updateClip(clip.id, { text })} />

        <Section>
          <Label>{t.inspector.timing}</Label>
          <Value>
            {t.common.secondsShort(clip.startSec.toFixed(2))} →{" "}
            {t.common.secondsShort(clip.endSec.toFixed(2))} (
            {t.common.secondsShort((clip.endSec - clip.startSec).toFixed(2))})
          </Value>
        </Section>

        <div className="flex flex-wrap gap-2">
          <Button onClick={regenerate} disabled={!canRegenerate} title={regenerateTitle()}>
            {isRegenerating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isRegenerating ? t.inspector.generating : t.inspector.regenerate}
          </Button>
          <Button
            variant="secondary"
            onClick={() => updateClip(clip.id, { locked: !clip.locked })}
          >
            {clip.locked ? <Unlock className="mr-1.5 h-3.5 w-3.5" /> : <Lock className="mr-1.5 h-3.5 w-3.5" />}
            {clip.locked ? t.inspector.unlock : t.inspector.lock}
          </Button>
          <Button variant="ghost" onClick={() => removeClip(clip.id)} disabled={isRegenerating}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t.inspector.delete}
          </Button>
        </div>
        {regenError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {regenError}
          </div>
        )}
        {regenTiming && !regenError && (
          <div className="rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground">
            {regenTiming}
          </div>
        )}

        {clip.renderedAudioPath && (
          <Section>
            <Label>{t.inspector.preview}</Label>
            <audio
              key={`${clip.renderedAudioPath}:${clipAudioVersion(clip) ?? ""}`}
              src={mediaFileSrc(clip.renderedAudioPath, clipAudioVersion(clip))}
              controls
              className="w-full"
            />
            <Value className="truncate text-xs text-muted-foreground" title={clip.renderedAudioPath}>
              {clip.renderedAudioPath.split("/").pop()}
            </Value>
          </Section>
        )}

        {clip.history.length > 0 && (
          <Section>
            <Label>
              <span className="inline-flex items-center gap-1">
                <History className="h-3 w-3" />
                {t.inspector.history(clip.history.length)}
              </span>
            </Label>
            <Value>{t.common.previousTakes(clip.history.length)}</Value>
          </Section>
        )}
      </div>
    </aside>
  );
}
