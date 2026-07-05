export const LOCALES = ["en", "ru"] as const;
export type AppLocale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = "speech-studio.locale";

function getLocaleStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "ru" || normalized.startsWith("ru-") || normalized.startsWith("ru_")) {
    return "ru";
  }
  if (normalized === "en" || normalized.startsWith("en-") || normalized.startsWith("en_")) {
    return "en";
  }
  return null;
}

export function detectInitialLocale(): AppLocale {
  const storage = getLocaleStorage();
  if (storage && typeof storage.getItem === "function") {
    try {
      const stored = normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY));
      if (stored) return stored;
    } catch {
      // Fall through to navigator detection when persisted preferences are unavailable.
    }
  }
  if (typeof navigator !== "undefined") {
    const preferred = [navigator.language, ...(navigator.languages ?? [])]
      .map(normalizeLocale)
      .find((locale): locale is AppLocale => locale != null);
    if (preferred) return preferred;
  }
  return "en";
}

function ruPlural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

const en = {
  locale: {
    english: "English",
    russian: "Русский",
    selectorTitle: "Interface language",
  },
  defaults: {
    untitledProject: "Untitled",
    speakerTrack: (index: number) => `Speaker ${index}`,
    exportFileBase: "soniqo-export",
    demoProject: "Demo — Scene 04",
    demoVideoTrack: "Scene 04 — final cut",
    narratorVoice: "Narrator (Anna)",
    antagonistVoice: "Antagonist (Marek)",
    hindiDemoProject: "Hindi Demo — Voice Clone",
    hindiDemoVideoTrack: "Hindi voice clone test",
    hindiVoice: "Hindi Reference Voice (Male)",
    hindiVoice2: "Hindi Reference Voice (Female)",
    hindiSpeakerTrack: "Hindi Narration",
    hindiSpeakerTrack2: "Hindi Narration 2",
  },
  common: {
    none: "— None —",
    inheritFromTrack: "— Inherit from track —",
    secondsShort: (value: number | string) => `${value}s`,
    generatedTiming: (duration: string, elapsed: string) =>
      `Generated ${duration}s audio in ${elapsed}s`,
    previousTakes: (count: number) =>
      `${count} previous ${count === 1 ? "take" : "takes"}`,
  },
  model: {
    ready: (engine: string, suffix: string) => `${engine} ready${suffix}`,
    loading: (engine: string) => `${engine} loading…`,
    error: (engine: string) => `${engine} error`,
    idle: (engine: string) => `${engine} idle`,
    statusTitle: (status: string) => `Model status: ${status}`,
    loadingTitle: (engine: string) =>
      `Loading ${engine}. First run may download several GB.`,
    preparingDownload: "Preparing model download",
    loadingModel: "Loading model",
    downloadingWeights: "Downloading weights",
  },
  update: {
    failedTitle:
      "Update failed — try again from the next launch, or download manually from GitHub releases",
    failedLabel: "update failed",
    title: (version: string | null) => `Update to v${version} and restart`,
    updatingPercent: (percent: number) => `Updating ${percent}%`,
    updating: "Updating…",
    updateTo: (version: string | null) => `Update to v${version}`,
  },
  topBar: {
    synthProgress: (current: number, total: number, elapsed: string, label: string) =>
      `Synth ${current}/${total} ${elapsed} — ${label}`,
    synthesizing: "Synthesizing…",
    synthMissing: (count: number) => `Synthesize (${count})`,
    resynthesizeAll: "Resynthesize all",
    nothingToSynthesize:
      "Nothing to synthesize — clips need text and an assigned voice (locked clips are skipped)",
    clipsFailed: (failed: number, total: number) =>
      `${failed}/${total} clips failed — see console`,
    exportMixTitle: "Export mix as WAV",
    wavAudio: "WAV audio",
    exportFailed: (error: string) => `export failed: ${error}`,
    switchLoadingEngine: (engine: string) =>
      `Switch engine and interrupt ${engine} loading`,
    switchEngineTitle: "Switches the loaded voice-cloning engine",
    synthesisLanguageTitle: "Synthesis language for multilingual engines",
    waitModel: (engine: string) => `Wait for ${engine} to finish loading`,
    loadProjectFirst: "Load a project first",
    synthesizeMissingTitle: (count: number) =>
      `Synthesize ${count} clip(s) that don't have audio yet`,
    resynthesizeTitle: "Re-synthesize all non-locked clips",
    exportDisabledTitle: "Synthesize at least one clip before exporting",
    exportTitle: (count: number) =>
      `Export a WAV mix of ${count} clip${count === 1 ? "" : "s"}`,
    exportButton: "Export",
  },
  projects: {
    title: "Projects — save, open, or start fresh",
    button: "Projects",
    saving: "Saving…",
    newProject: "New project",
    demoScene: "Demo scene (built-in)",
    hindiDemoScene: "Hindi voice clone demo",
    allSaved: "All changes saved automatically",
    savedProjects: "Saved projects",
    noneYet: "None yet — Save to create one.",
    openNow: "open now",
    deleteTitle: "Delete saved project file",
    deleteAria: (name: string) => `Delete ${name}`,
  },
  rail: {
    tracks: "tracks",
    voices: "voices",
    dictation: "dictation",
  },
  tracks: {
    title: "Tracks",
    addSpeaker: "Speaker",
    addSpeakerTitle: "Add speaker track",
    empty: "No tracks yet. Add a speaker.",
    kindVideo: "Video",
    kindSpeaker: "Speaker",
    kindAudio: "Audio",
    voiceMeta: (voiceName: string) => `Voice: ${voiceName}`,
    noVoice: "No voice assigned",
    deleteTitle: "Delete track and its clips",
    deleteAria: "Delete track",
  },
  voices: {
    title: "Voices",
    addReference: "Reference",
    addReferenceTitle: "Clone from reference clip",
    empty: "No cloned voices yet. Add a short reference clip to start.",
    fallbackName: "Voice",
    decodeFailed: (error: string) => `Reference audio cannot be decoded: ${error}`,
    nearlySilentTitle: "This recording is nearly silent",
    nearlySilentBody: (name: string, db: string) =>
      `"${name}" measured ${db} average level — far below typical speech. Cloning from it will produce a degraded, noisy voice. Use the original recording if you have it, or re-export this one at normal volume.`,
    useAnyway: "Use anyway",
    chooseAnother: "Choose another file",
    quietTitle:
      "Quiet reference — the engine auto-boosts it during synthesis; re-record at normal volume for best quality",
    nearlySilentReference: "nearly silent reference",
    quietReference: "quiet reference (auto-boosted)",
    noReferenceAudio: "No reference audio",
    stop: "Stop",
    playReference: "Play reference",
    stopReference: "Stop reference",
    deleteTitle: "Delete voice (tracks and clips using it become unassigned)",
    deleteAria: "Delete voice",
    sourceKind: {
      library: "library",
      clipClone: "clip clone",
      trackClone: "track clone",
    },
  },
  dictation: {
    title: "Dictation",
    loadingModel: "ASR",
    modelPending: "Loading transcription model list",
    modelMeta: (runtime: string, size: string) => `${runtime.toUpperCase()} · ${size}`,
    record: "Record",
    recordTitle: "Start microphone recording",
    stop: "Stop",
    stopTitle: "Stop recording and transcribe",
    transcribing: "Transcribing",
    unsupported: "Microphone recording is not available in this WebView.",
    micFailed: (error: string) => `Microphone failed: ${error}`,
    tooShort: "Recording is too short.",
    transcribeFailed: (error: string) => `Transcription failed: ${error}`,
    empty: "No dictation captures yet.",
    captureMeta: (duration: string, elapsed: string) =>
      `${duration}s audio · ${elapsed}s ASR`,
    playCapture: "Play recording",
    stopPlayback: "Stop recording playback",
    insertIntoFlow: "Insert transcript into timeline",
    insertedClip: "Transcript inserted into the selected clip.",
    insertedTimeline: "Transcript added to the timeline.",
    copyText: "Copy transcript",
    emptyTranscript: "(empty transcript)",
  },
  emptyState: {
    title: "No tracks yet",
    beforeDemo:
      "Add a speaker track from the rail on the left and assign it a cloned voice, or hit",
    loadDemo: "Load demo",
    afterDemo:
      "in the top bar to spin up a four-line scene with two cloned voices and emotion markers.",
  },
  timeline: {
    zoom: "Zoom",
    duration: (value: string) => `Duration ${value}`,
    clickToSeek: "Click to seek",
    doubleClickAddClip: "Double-click to add clip",
  },
  transport: {
    loadProjectFirst: "Load a project first",
    synthesizeBeforePlaying: "Synthesize at least one clip before playing",
    waitSynthesizing: "Wait — still synthesizing",
    pause: "Pause",
    play: "Play",
  },
  clip: {
    emptyPreview: "(empty)",
    emptyTitle: "Empty clip",
  },
  inspector: {
    project: "Project",
    lengthSec: "Length (sec)",
    clipsExtendTo: (seconds: string) => `clips extend to ${seconds}s`,
    tracks: "Tracks",
    voices: "Voices",
    emptyHint: "Select a clip, track, or voice for more options.",
    track: "Track",
    name: "Name",
    voice: "Voice",
    source: "Source",
    voicePanel: "Voice",
    referenceAudio: "Reference audio",
    referenceTranscript: "Reference transcript",
    optional: "(optional)",
    referencePlaceholder:
      "Required by CosyVoice, Qwen3-TTS, and Fish Audio to anchor a clone. VoxCPM2 clones from audio alone.",
    created: "Created",
    clip: "Clip",
    voiceOverride: "Voice override",
    timing: "Timing",
    generating: "Generating…",
    assignVoiceFirst: "Assign a voice first",
    missingReference: "Voice is missing a reference clip",
    referenceTranscriptNeeded: (engine: string) => `${engine} needs the reference transcript`,
    writeSomethingFirst: "Write something first",
    generateAudio: "Generate audio",
    regenerate: "Regenerate",
    unlock: "Unlock",
    lock: "Lock",
    delete: "Delete",
    preview: "Preview",
    history: (count: number) => `History (${count})`,
    selectedEngine: "Selected engine",
  },
  script: {
    label: "Script",
    placeholder: "Write the line. Pick an emotion below to set the tone.",
    removeMarker: (marker: string) => `Remove ${marker} marker`,
    setMarker: (marker: string) => `Set this line's tone to ${marker}`,
    styleHints: {
      instruction: "Markers steer this line's tone.",
      controlledVocabulary:
        "This engine only accepts a fixed style vocabulary; emotion markers are approximations.",
      intensity:
        "Chatterbox applies markers as intensity only — more vs. less expressive, not a specific emotion.",
      suffixTag:
        "Indic-Mio uses suffix tags like <happy> and clones from the reference audio.",
      bracketTag:
        "Fish Audio uses bracket tags like [excited] and requires a reference transcript for cloning.",
      none: "This engine ignores emotion markers.",
    },
  },
  dev: {
    pinging: "Pinging…",
    pingSidecar: "Ping sidecar",
  },
  synth: {
    referenceTranscriptRequired: (engine: string) =>
      `${engine} needs an accurate reference transcript for every voice being synthesized`,
  },
  appShell: {
    preparingDownload: "Preparing model download",
  },
} satisfies Record<string, unknown>;

const ru: typeof en = {
  locale: {
    english: "English",
    russian: "Русский",
    selectorTitle: "Язык интерфейса",
  },
  defaults: {
    untitledProject: "Без названия",
    speakerTrack: (index) => `Диктор ${index}`,
    exportFileBase: "soniqo-export",
    demoProject: "Демо — сцена 04",
    demoVideoTrack: "Сцена 04 — финальный монтаж",
    narratorVoice: "Рассказчица (Anna)",
    antagonistVoice: "Антагонист (Marek)",
    hindiDemoProject: "Демо на хинди — клон голоса",
    hindiDemoVideoTrack: "Тест клонирования голоса на хинди",
    hindiVoice: "Референсный голос на хинди (мужской)",
    hindiVoice2: "Референсный голос на хинди (женский)",
    hindiSpeakerTrack: "Диктор на хинди",
    hindiSpeakerTrack2: "Диктор на хинди 2",
  },
  common: {
    none: "— Не выбрано —",
    inheritFromTrack: "— Как у дорожки —",
    secondsShort: (value) => `${value} с`,
    generatedTiming: (duration, elapsed) =>
      `Сгенерировано ${duration} с аудио за ${elapsed} с`,
    previousTakes: (count) =>
      `${count} ${ruPlural(count, "предыдущий дубль", "предыдущих дубля", "предыдущих дублей")}`,
  },
  model: {
    ready: (engine, suffix) => `${engine} готов${suffix}`,
    loading: (engine) => `${engine}: загрузка…`,
    error: (engine) => `${engine}: ошибка`,
    idle: (engine) => `${engine}: ожидание`,
    statusTitle: (status) => `Состояние модели: ${status}`,
    loadingTitle: (engine) =>
      `Загружается ${engine}. При первом запуске может понадобиться скачать несколько ГБ.`,
    preparingDownload: "Подготовка загрузки модели",
    loadingModel: "Загрузка модели",
    downloadingWeights: "Загрузка весов",
  },
  update: {
    failedTitle:
      "Не удалось обновить. Попробуйте при следующем запуске или скачайте релиз вручную на GitHub",
    failedLabel: "ошибка обновления",
    title: (version) => `Обновить до v${version} и перезапустить`,
    updatingPercent: (percent) => `Обновление ${percent}%`,
    updating: "Обновление…",
    updateTo: (version) => `Обновить до v${version}`,
  },
  topBar: {
    synthProgress: (current, total, elapsed, label) =>
      `Синтез ${current}/${total} ${elapsed} — ${label}`,
    synthesizing: "Синтезируем…",
    synthMissing: (count) => `Синтезировать (${count})`,
    resynthesizeAll: "Пересинтезировать всё",
    nothingToSynthesize:
      "Нечего синтезировать: клипам нужны текст и назначенный голос, заблокированные клипы пропускаются",
    clipsFailed: (failed, total) =>
      `Не удалось синтезировать ${failed} из ${total}; подробности в консоли`,
    exportMixTitle: "Экспорт микса в WAV",
    wavAudio: "Аудио WAV",
    exportFailed: (error) => `Не удалось экспортировать: ${error}`,
    switchLoadingEngine: (engine) => `Переключить движок и прервать загрузку ${engine}`,
    switchEngineTitle: "Переключает загруженный движок клонирования голоса",
    synthesisLanguageTitle: "Язык синтеза для многоязычных движков",
    waitModel: (engine) => `Дождитесь завершения загрузки ${engine}`,
    loadProjectFirst: "Сначала загрузите проект",
    synthesizeMissingTitle: (count) =>
      `Синтезировать ${count} ${ruPlural(count, "клип", "клипа", "клипов")} без аудио`,
    resynthesizeTitle: "Повторно синтезировать все незаблокированные клипы",
    exportDisabledTitle: "Перед экспортом синтезируйте хотя бы один клип",
    exportTitle: (count) =>
      `Экспортировать WAV-микс из ${count} ${ruPlural(count, "клипа", "клипов", "клипов")}`,
    exportButton: "Экспорт",
  },
  projects: {
    title: "Проекты: сохранить, открыть или начать заново",
    button: "Проекты",
    saving: "Сохранение…",
    newProject: "Новый проект",
    demoScene: "Демо-сцена (встроенная)",
    hindiDemoScene: "Демо клона голоса на хинди",
    allSaved: "Все изменения сохраняются автоматически",
    savedProjects: "Сохранённые проекты",
    noneYet: "Пока нет проектов. Внесите изменения, чтобы создать первый.",
    openNow: "открыт сейчас",
    deleteTitle: "Удалить файл сохранённого проекта",
    deleteAria: (name) => `Удалить ${name}`,
  },
  rail: {
    tracks: "дорожки",
    voices: "голоса",
    dictation: "диктовка",
  },
  tracks: {
    title: "Дорожки",
    addSpeaker: "Диктор",
    addSpeakerTitle: "Добавить дорожку диктора",
    empty: "Пока нет дорожек. Добавьте диктора.",
    kindVideo: "Видео",
    kindSpeaker: "Диктор",
    kindAudio: "Аудио",
    voiceMeta: (voiceName) => `Голос: ${voiceName}`,
    noVoice: "Голос не назначен",
    deleteTitle: "Удалить дорожку и её клипы",
    deleteAria: "Удалить дорожку",
  },
  voices: {
    title: "Голоса",
    addReference: "Референс",
    addReferenceTitle: "Клонировать по референсному клипу",
    empty: "Пока нет клонированных голосов. Добавьте короткий референсный клип.",
    fallbackName: "Голос",
    decodeFailed: (error) => `Не удалось декодировать референсное аудио: ${error}`,
    nearlySilentTitle: "Запись почти беззвучна",
    nearlySilentBody: (name, db) =>
      `Средний уровень «${name}» — ${db}, что намного тише обычной речи. Клон получится шумным и хуже по качеству. Используйте исходную запись, если она есть, или экспортируйте этот файл заново с нормальной громкостью.`,
    useAnyway: "Всё равно использовать",
    chooseAnother: "Выбрать другой файл",
    quietTitle:
      "Тихий референс: движок усилит его при синтезе, но для лучшего качества лучше записать нормальную громкость",
    nearlySilentReference: "почти беззвучный референс",
    quietReference: "тихий референс (усиливается автоматически)",
    noReferenceAudio: "Нет референсного аудио",
    stop: "Остановить",
    playReference: "Прослушать референс",
    stopReference: "Остановить референс",
    deleteTitle:
      "Удалить голос; дорожки и клипы, которые его используют, останутся без назначенного голоса",
    deleteAria: "Удалить голос",
    sourceKind: {
      library: "библиотека",
      clipClone: "клон из клипа",
      trackClone: "клон из дорожки",
    },
  },
  dictation: {
    title: "Диктовка",
    loadingModel: "ASR",
    modelPending: "Загружается список моделей распознавания",
    modelMeta: (runtime, size) => `${runtime.toUpperCase()} · ${size}`,
    record: "Запись",
    recordTitle: "Начать запись с микрофона",
    stop: "Стоп",
    stopTitle: "Остановить запись и распознать",
    transcribing: "Распознаём",
    unsupported: "Запись с микрофона недоступна в этом WebView.",
    micFailed: (error) => `Не удалось включить микрофон: ${error}`,
    tooShort: "Запись слишком короткая.",
    transcribeFailed: (error) => `Не удалось распознать: ${error}`,
    empty: "Пока нет записей диктовки.",
    captureMeta: (duration, elapsed) => `${duration} с аудио · ${elapsed} с ASR`,
    playCapture: "Прослушать запись",
    stopPlayback: "Остановить запись",
    insertIntoFlow: "Вставить текст в таймлайн",
    insertedClip: "Текст вставлен в выбранный клип.",
    insertedTimeline: "Текст добавлен в таймлайн.",
    copyText: "Скопировать текст",
    emptyTranscript: "(пустой транскрипт)",
  },
  emptyState: {
    title: "Пока нет дорожек",
    beforeDemo:
      "Добавьте дорожку диктора в левой панели и назначьте ей клонированный голос или нажмите",
    loadDemo: "Загрузить демо",
    afterDemo:
      "в верхней панели, чтобы открыть сцену из четырёх реплик с двумя клонированными голосами и маркерами эмоций.",
  },
  timeline: {
    zoom: "Масштаб",
    duration: (value) => `Длительность ${value}`,
    clickToSeek: "Щёлкните, чтобы перейти",
    doubleClickAddClip: "Дважды щёлкните, чтобы добавить клип",
  },
  transport: {
    loadProjectFirst: "Сначала загрузите проект",
    synthesizeBeforePlaying: "Перед воспроизведением синтезируйте хотя бы один клип",
    waitSynthesizing: "Подождите: синтез ещё идёт",
    pause: "Пауза",
    play: "Воспроизвести",
  },
  clip: {
    emptyPreview: "(пусто)",
    emptyTitle: "Пустой клип",
  },
  inspector: {
    project: "Проект",
    lengthSec: "Длительность (с)",
    clipsExtendTo: (seconds) => `клипы доходят до ${seconds} с`,
    tracks: "Дорожки",
    voices: "Голоса",
    emptyHint: "Выберите клип, дорожку или голос, чтобы открыть параметры.",
    track: "Дорожка",
    name: "Название",
    voice: "Голос",
    source: "Источник",
    voicePanel: "Голос",
    referenceAudio: "Референсное аудио",
    referenceTranscript: "Транскрипт референса",
    optional: "(необязательно)",
    referencePlaceholder:
      "Нужен CosyVoice, Qwen3-TTS и Fish Audio, чтобы закрепить клон. VoxCPM2 клонирует только по аудио.",
    created: "Создано",
    clip: "Клип",
    voiceOverride: "Переопределение голоса",
    timing: "Тайминг",
    generating: "Генерация…",
    assignVoiceFirst: "Сначала назначьте голос",
    missingReference: "У голоса нет референсного клипа",
    referenceTranscriptNeeded: (engine) => `${engine} нужен транскрипт референса`,
    writeSomethingFirst: "Сначала введите текст",
    generateAudio: "Сгенерировать аудио",
    regenerate: "Перегенерировать",
    unlock: "Разблокировать",
    lock: "Заблокировать",
    delete: "Удалить",
    preview: "Предпрослушивание",
    history: (count) => `История (${count})`,
    selectedEngine: "Выбранный движок",
  },
  script: {
    label: "Сценарий",
    placeholder: "Напишите реплику. Ниже можно выбрать эмоцию для интонации.",
    removeMarker: (marker) => `Убрать маркер ${marker}`,
    setMarker: (marker) => `Задать интонацию ${marker}`,
    styleHints: {
      instruction: "Маркеры управляют интонацией этой реплики.",
      controlledVocabulary:
        "Этот движок принимает только фиксированный словарь стилей; эмоции передаются приблизительно.",
      intensity:
        "Chatterbox применяет маркеры только как уровень выразительности, а не как конкретную эмоцию.",
      suffixTag:
        "Indic-Mio использует суффиксные теги вроде <happy> и клонирует голос по референсному аудио.",
      bracketTag:
        "Fish Audio использует теги в квадратных скобках вроде [excited] и требует транскрипт референса для клонирования.",
      none: "Этот движок игнорирует маркеры эмоций.",
    },
  },
  dev: {
    pinging: "Пингуем…",
    pingSidecar: "Пинг sidecar",
  },
  synth: {
    referenceTranscriptRequired: (engine) =>
      `${engine} нужен точный транскрипт референса для каждого синтезируемого голоса`,
  },
  appShell: {
    preparingDownload: "Подготовка загрузки модели",
  },
};

export type Messages = typeof en;

export const messages: Record<AppLocale, Messages> = { en, ru };

export function storeLocale(locale: AppLocale) {
  const storage = getLocaleStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Locale switching should still work for the current session without persistence.
  }
}

export function dateLocale(locale: AppLocale): string | undefined {
  return locale === "ru" ? "ru-RU" : undefined;
}

export function isDefaultProjectName(name: string): boolean {
  return name === en.defaults.untitledProject || name === ru.defaults.untitledProject;
}

export function localizeModelProgressMessage(locale: AppLocale, message: string): string {
  if (locale === "en") return message;
  const m = messages.ru.model;
  if (message === messages.en.model.preparingDownload) return m.preparingDownload;
  if (message === messages.en.model.loadingModel) return m.loadingModel;
  return message.replace(messages.en.model.downloadingWeights, m.downloadingWeights);
}

export function localizeDemoProgressMessage(locale: AppLocale, message: string): string {
  if (locale === "en") return message;
  if (message === "Preparing reference voices…") return "Подготовка референсных голосов…";
  return message;
}
