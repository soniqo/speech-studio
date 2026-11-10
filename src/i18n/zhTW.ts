import type { Messages } from "./messages";

export const zhTW: Messages = {
  locale: { english: "English", russian: "Русский", traditionalChinese: "繁體中文", selectorTitle: "介面語言" },
  defaults: {
    untitledProject: "未命名", speakerTrack: (index) => `講者 ${index}`, exportFileBase: "soniqo-export",
    demoProject: "示範 — 場景 04", demoVideoTrack: "場景 04 — 最終剪輯", narratorVoice: "旁白（Anna）",
    antagonistVoice: "反派（Marek）", hindiDemoProject: "印地語示範 — 聲音克隆", hindiDemoVideoTrack: "印地語聲音克隆測試",
    hindiVoice: "印地語參考音色（男）", hindiVoice2: "印地語參考音色（女）", hindiSpeakerTrack: "印地語旁白", hindiSpeakerTrack2: "印地語旁白 2",
  },
  common: {
    none: "— 無 —", inheritFromTrack: "— 使用音軌設定 —", secondsShort: (value) => `${value} 秒`,
    generatedTiming: (duration, elapsed) => `耗時 ${elapsed} 秒，生成 ${duration} 秒音訊`, previousTakes: (count) => `${count} 個先前版本`,
  },
  model: {
    ready: (engine, suffix) => `${engine} 已就緒${suffix}`, loading: (engine) => `正在載入 ${engine}…`, error: (engine) => `${engine} 發生錯誤`, idle: (engine) => `${engine} 閒置中`,
    statusTitle: (status) => `模型狀態：${status}`, loadingTitle: (engine) => `正在載入 ${engine}。首次使用可能需要下載數 GB 的檔案。`,
    preparingDownload: "正在準備下載模型", loadingModel: "正在載入模型", downloadingWeights: "正在下載權重",
  },
  update: { failedTitle: "更新失敗，請下次啟動時再試，或從 GitHub 發行頁面手動下載", failedLabel: "更新失敗", title: (version) => `更新至 v${version} 並重新啟動`, updatingPercent: (percent) => `更新中 ${percent}%`, updating: "更新中…", updateTo: (version) => `更新至 v${version}` },
  topBar: {
    synthProgress: (current, total, elapsed, label) => `生成 ${current}/${total} ${elapsed} — ${label}`, synthesizing: "生成中…", synthMissing: (count) => `生成（${count}）`, resynthesizeAll: "重新生成全部",
    nothingToSynthesize: "沒有可生成的片段：請輸入文字並指定音色（已鎖定片段會跳過）", clipsFailed: (failed, total) => `${failed}/${total} 個片段生成失敗，請查看活動紀錄`,
    exportMixTitle: "將混音匯出為 WAV", wavAudio: "WAV 音訊", exportFailed: (error) => `匯出失敗：${error}`, switchLoadingEngine: (engine) => `切換引擎並中斷 ${engine} 載入`,
    switchEngineTitle: "切換載入的聲音克隆引擎", pickAnotherModel: "選擇其他模型", pickAnotherModelTitle: (engine) => `${engine} 載入失敗，請選擇其他引擎`,
    synthesisLanguageTitle: "多語言引擎的生成語言", variantLabel: "模型權重", variantTitle: (engine) => `${engine} 權重：較低精度使用較少記憶體；切換會重新載入模型`,
    variantDisk: (gb) => `${gb} GB`, variantRam: (gib) => `約 ${gib} GiB 記憶體`, waitModel: (engine) => `請等候 ${engine} 載入完成`, loadProjectFirst: "請先載入專案",
    synthesizeMissingTitle: (count) => `生成 ${count} 個尚無音訊的片段`, resynthesizeTitle: "重新生成所有未鎖定的片段", exportDisabledTitle: "請至少生成一個片段後再匯出",
    exportTitle: (count) => `將 ${count} 個片段的混音匯出為 WAV`, exportButton: "匯出", save: "儲存", saved: "已儲存", saveTitle: "立即儲存專案（變更也會自動儲存）",
  },
  projects: { title: "專案 — 儲存、開啟或建立新專案", button: "專案", saving: "儲存中…", newProject: "新增專案", demoScene: "示範場景（內建）", hindiDemoScene: "印地語聲音克隆示範", allSaved: "所有變更均已自動儲存", savedProjects: "已儲存的專案", noneYet: "尚無專案，請按儲存以建立。", openNow: "目前已開啟", deleteTitle: "刪除已儲存的專案檔", deleteAria: (name) => `刪除 ${name}` },
  rail: { tracks: "音軌", voices: "音色", dictation: "聽寫" },
  tracks: { title: "音軌", addSpeaker: "講者", addSpeakerTitle: "新增講者音軌", empty: "尚無音軌，請新增講者。", kindVideo: "影片", kindSpeaker: "講者", kindAudio: "音訊", voiceMeta: (voiceName) => `音色：${voiceName}`, noVoice: "尚未指定音色", deleteTitle: "刪除音軌及其中的片段", deleteAria: "刪除音軌", addLineTitle: "新增台詞到此音軌", addLineAria: "新增台詞" },
  voices: {
    title: "音色", addReference: "參考音檔", addReferenceTitle: "從參考音檔克隆聲音", empty: "尚無克隆音色，請新增一段參考音檔。", fallbackName: "音色", decodeFailed: (error) => `無法解碼參考音訊：${error}`,
    nearlySilentTitle: "這段錄音幾乎沒有聲音", nearlySilentBody: (name, db) => `「${name}」的平均音量為 ${db}，遠低於一般語音。用它克隆可能導致音質不佳和雜音。請使用原始錄音，或以正常音量重新匯出。`,
    useAnyway: "仍要使用", chooseAnother: "選擇其他檔案", quietTitle: "參考音檔音量偏低，生成時引擎會自動放大；建議以正常音量重新錄製", nearlySilentReference: "參考音檔幾乎無聲", quietReference: "參考音檔音量偏低（自動放大）", noReferenceAudio: "沒有參考音訊", stop: "停止", playReference: "播放參考音檔", stopReference: "停止播放參考音檔", deleteTitle: "刪除音色（使用它的音軌和片段將不再指定音色）", deleteAria: "刪除音色", sourceKind: { library: "音色庫", clipClone: "片段克隆", trackClone: "音軌克隆" },
  },
  dictation: { title: "聽寫", loadingModel: "語音辨識", modelPending: "正在載入轉寫模型清單", modelMeta: (runtime, size) => `${runtime.toUpperCase()} · ${size}`, record: "錄音", recordTitle: "開始使用麥克風錄音", stop: "停止", stopTitle: "停止錄音並轉寫", transcribing: "轉寫中", unsupported: "此 WebView 不支援麥克風錄音。", micFailed: (error) => `麥克風發生錯誤：${error}`, tooShort: "錄音太短。", transcribeFailed: (error) => `轉寫失敗：${error}`, empty: "尚無聽寫錄音。", captureMeta: (duration, elapsed) => `${duration} 秒音訊 · 轉寫耗時 ${elapsed} 秒`, playCapture: "播放錄音", stopPlayback: "停止播放錄音", insertIntoFlow: "將轉寫文字插入時間軸", insertedClip: "已將轉寫文字插入所選片段。", insertedTimeline: "已將轉寫文字加入時間軸。", copyText: "複製轉寫文字", emptyTranscript: "（無轉寫文字）" },
  emptyState: { title: "尚無音軌", beforeDemo: "請從左側新增講者音軌並指定克隆音色，或按上方的", loadDemo: "載入示範", afterDemo: "建立含有兩個克隆音色和情緒標記的四句對話。" },
  timeline: { zoom: "縮放", duration: (value) => `長度 ${value}`, clickToSeek: "點擊以移動播放位置", doubleClickAddClip: "連按兩下以新增片段" },
  transport: { loadProjectFirst: "請先載入專案", synthesizeBeforePlaying: "請至少生成一個片段後再播放", waitSynthesizing: "生成尚未完成，請稍候", pause: "暫停", play: "播放" },
  clip: { emptyPreview: "（空白）", emptyTitle: "空白片段" },
  inspector: {
    project: "專案", lengthSec: "長度（秒）", clipsExtendTo: (seconds) => `片段延伸至 ${seconds} 秒`, tracks: "音軌", voices: "音色", emptyHint: "選擇片段、音軌或音色以查看更多選項。", track: "音軌", name: "名稱", voice: "音色", source: "來源", lines: (count) => `台詞（${count}）`, addLine: "新增台詞", voicePanel: "音色", referenceAudio: "參考音訊", referenceTranscript: "參考音檔逐字稿", optional: "（選填）", referencePlaceholder: "CosyVoice、Qwen3-TTS 和 Fish Audio 需要逐字稿以克隆聲音；VoxCPM2 僅需參考音訊。", created: "建立時間", clip: "片段", voiceOverride: "為此片段指定音色", timing: "時間", generating: "生成中…", assignVoiceFirst: "請先指定音色", missingReference: "音色缺少參考音檔", referenceTranscriptNeeded: (engine) => `${engine} 需要參考音檔逐字稿`, writeSomethingFirst: "請先輸入文字", generateAudio: "生成音訊", regenerate: "重新生成", unlock: "解除鎖定", lock: "鎖定", delete: "刪除", preview: "預覽", history: (count) => `歷史版本（${count}）`, selectedEngine: "所選引擎",
  },
  script: { label: "台詞", placeholder: "輸入台詞，或使用麥克風聽寫。選擇下方情緒以調整語氣。", removeMarker: (marker) => `移除 ${marker} 標記`, setMarker: (marker) => `將這句台詞的語氣設為 ${marker}`, dictate: "聽寫", dictateStop: "停止", dictateTranscribing: "…", dictateTitle: "使用麥克風聽寫這句台詞", dictateStopTitle: "停止錄音並將轉寫結果填入台詞", styleHints: { instruction: "標記可引導這句台詞的語氣。", controlledVocabulary: "此引擎只接受固定的風格詞彙，情緒標記為近似效果。", intensity: "Chatterbox 的標記只能調整表現強度，不能指定具體情緒。", suffixTag: "Indic-Mio 使用 <happy> 等後綴標記，並根據參考音訊克隆聲音。", bracketTag: "Fish Audio 使用 [excited] 等方括號標記，克隆時需要參考音檔逐字稿。", none: "此引擎會忽略情緒標記。" } },
  dev: { pinging: "連線測試中…", pingSidecar: "測試 sidecar 連線" },
  synth: { referenceTranscriptRequired: (engine) => `${engine} 需要每個生成音色的準確參考音檔逐字稿` },
  appShell: { preparingDownload: "正在準備下載模型" },
  activity: { title: "活動紀錄", toggleTitle: "顯示語音引擎的紀錄和記憶體使用量", processShort: (gb) => `${gb} GB`, copy: "複製", copied: "已複製", copyTitle: "複製畫面上的紀錄", reveal: "紀錄檔", noLogFile: "本次工作階段沒有紀錄檔", clear: "清除", clearTitle: "清除畫面上的紀錄（紀錄檔仍會保留）", close: "關閉", empty: "尚無紀錄，請載入模型或生成片段。", noMemoryYet: "記憶體：等待引擎", memory: (active, peak, process) => process == null ? `MLX ${active} GB · 峰值 ${peak} GB` : `MLX ${active} GB · 峰值 ${peak} GB · 程序 ${process} GB` },
};
