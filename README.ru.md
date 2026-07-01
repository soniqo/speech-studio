# Speech Studio

[English](README.md) · **Русский** · [简体中文](README.zh-CN.md)

> Проект [Soniqo](https://soniqo.audio).

Открытое настольное приложение для авторов контента. Клонируйте голос по короткому референсному фрагменту, пишите сценарий по репликам и синтезируйте весь материал этим голосом — с встроенными маркерами эмоций для управления интонацией.

## 30-секундное демо

Слепой тест A/B/C: реальный голос, тот же голос, локально клонированный Speech Studio на MacBook, и тот же голос, клонированный ElevenLabs в облаке. Сможете отличить?

[![Speech Studio — open-source voice cloning on a MacBook](https://i.ytimg.com/vi/EuIU8tOWyzg/maxresdefault.jpg)](https://www.youtube.com/watch?v=EuIU8tOWyzg)

[Смотреть на YouTube →](https://youtu.be/EuIU8tOWyzg) (30 с)

> **Статус:** v0 — MVP только для аудио. Работает на macOS 15+ (Apple Silicon) и Windows / Linux (x86_64): на macOS клонирование идёт через MLX, на Windows/Linux — через локальный LiteRT-бэкенд `speech-core`. Воспроизведение видео на таймлайне и экспорт аудио поверх видео находятся в дорожной карте.

## Что умеет приложение

1. **Перетащите короткий референсный клип** с голосом диктора → зарегистрируйте клонированный голос. Повторите для любого числа дикторов.
2. **Напишите по одной реплике на клип** и выберите, какой диктор её произносит. Оберните строку в маркер эмоции — `(whispering) Just stay quiet for a moment, please.` — и синтезатор учтёт это указание.
3. **Нажмите «Синтезировать»**, чтобы отрендерить каждую реплику назначенным клонированным голосом. Конвейер синтеза локально проверяет каждый дубль через ASR и пробует другой seed, если строка получилась неверно.
4. **Воспроизведите сценарий**, чтобы услышать всю сцену подряд. Экспорт в единый WAV-микс сейчас в процессе подключения.

Клонирование выполняется локально. Синтез выполняется локально. Аудио не покидает вашу машину.

## Стек

- **Tauri 2** как оболочка (Rust + нативный WebView операционной системы), поэтому распространяемое приложение — небольшой нативный бинарник, а не форк Chromium.
- **React + Vite** для фронтенда таймлайна, библиотеки голосов и редактора сценария.
- **Постоянный sidecar-процесс** держит речевой движок загруженным, поэтому после первого прогрева построчный синтез выполняется быстро. Tauri запускает его один раз и общается с ним через stdin/stdout по NDJSON. На macOS это **Swift sidecar** (`swift-sidecar/`, MLX), на Windows/Linux — **C++ sidecar** (`core-sidecar/`, LiteRT).
- **VoxCPM2** — движок по умолчанию на всех платформах: через [`speech-swift`](https://github.com/soniqo/speech-swift) (MLX) на macOS и [`speech-core`](https://github.com/soniqo/speech-core) (LiteRT) на Windows/Linux. На macOS движок можно переключить в панели инструментов: **CosyVoice3**, **Qwen3-TTS**, **Chatterbox** (многоязычное клонирование на 23 языках), **OmniVoice** (клонирование на 600+ языках), **Indic-Mio** (эмоциональные теги для Hindi/Indic) и **Fish Audio S2 Pro** (экспериментальное клонирование + маркеры в квадратных скобках). Эти MLX-движки доступны только на macOS; Windows/Linux используют VoxCPM2.

## Движки

Переключайте движок в выпадающем списке панели инструментов (только macOS — Windows/Linux всегда используют VoxCPM2, поэтому список не отображается).

| Движок | Платформы | Бэкенд | Клонирование голоса | Маркеры эмоций | Языки |
|---|---|---|:---:|---|:---:|
| **VoxCPM2** · по умолчанию | macOS · Windows · Linux | MLX / LiteRT | ✅ | стилевые инструкции | 30 |
| **CosyVoice 3** | только macOS | MLX | ✅ | стилевые инструкции | 9 |
| **Qwen3-TTS** | только macOS | MLX | ✅ (ICL) | — | 10 |
| **Chatterbox** | только macOS | MLX | ✅ | только интенсивность¹ | 23 |
| **OmniVoice** | только macOS | MLX | ✅ | ограниченный instruct² | 600+ |
| **Indic-Mio** | только macOS | MLX | ✅³ | суффиксные теги | Indic |
| **Fish Audio S2 Pro** | только macOS | MLX | ✅⁴ | теги в квадратных скобках | 80+ |

MLX-движки (CosyVoice 3, Qwen3-TTS, Chatterbox, OmniVoice, Indic-Mio, Fish Audio S2 Pro) доступны **только на macOS**; Windows/Linux запускают VoxCPM2 через LiteRT-бэкенд speech-core.

¹ У Chatterbox нет свободного текстового поля для стиля: маркеры эмоций преобразуются в уровень выразительности/интенсивности (сильнее или мягче), а не в конкретную эмоцию.

² OmniVoice поддерживает широкие параметры голосового дизайна: акцент, возраст, пол, высоту тона и шёпот. Studio передаёт только допустимые элементы словаря `instruct`: `whisper` мапится напрямую, а маркеры эмоций приближённо преобразуются в подсказки высоты тона (`high pitch`, `low pitch` и т. п.). Сильные эмоции — приближение, а не полноценная актёрская эмоциональность.

³ Indic-Mio подключён как экспериментальный движок для Hindi/Indic с маркерами эмоций. Он использует суффиксные теги вроде `<happy>` / `<angry>` и клонирует по референсному аудио через WavLM → глобальные speaker embeddings MioCodec. Транскрипт референса не нужен.

⁴ Fish Audio S2 Pro использует маркеры в квадратных скобках, например `[excited]`, `[angry]` и `[whisper]`. Для клонирования нужен точный транскрипт референса, а публичные веса предназначены для исследовательского/некоммерческого использования, если нет отдельной лицензии.

## Маркеры эмоций

Оберните строку в тег в круглых скобках, чтобы управлять просодией:

```
(dramatic) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

Поддерживаемые теги: `soft`, `warm`, `whispering`, `intense`, `excited`, `happy`, `calm`, `serious`, `surprised`, `sad`, `angry`, `dramatic`, `laughs`.

Способ применения маркера зависит от движка: **VoxCPM2** и **CosyVoice 3** превращают его в короткую естественно-языковую инструкцию стиля (пользовательские теги вроде `(slow and dreamy)` передаются как есть); **OmniVoice** мапит только известные маркеры на фиксированный словарь `instruct` (`whisper` или подсказки высоты тона), а неподдерживаемые отбрасывает; **Chatterbox** мапит маркеры на уровень выразительности/интенсивности (без точного контроля эмоций, только «сильнее» или «мягче»); **Indic-Mio** добавляет поддерживаемые суффиксные теги вроде `<happy>`; **Fish Audio S2 Pro** добавляет теги в квадратных скобках вроде `[excited]`; **Qwen3-TTS** игнорирует маркеры, удаляя их из текста.

## Исследовательская заметка: клонирование сильных эмоций на хинди

Текущие открытые локальные кандидаты для клонирования голоса на хинди с более сильным контролем эмоций:

- **VoxCPM2** остаётся лучшей продуктовой базовой линией для Speech Studio: Apache-2.0, локальный запуск, поддержка хинди и управление клонированным голосом через естественно-языковые стилевые подсказки. Перед заявлениями о широком диапазоне актёрских эмоций ему всё ещё нужен сравнительный прогон эмоций на хинди с моделями ниже.
- **Fish Audio S2 Pro** выглядит самым сильным вариантом для выразительного контроля: 80+ языков, клонирование по короткому референсу и inline-теги эмоций/просодии свободной формы, например `[angry]`, `[sad]`, `[whisper]` и `[shouting]`. Сейчас он доступен как экспериментальный macOS-движок, но публичная лицензия модели исследовательская/некоммерческая без отдельного коммерческого разрешения, поэтому он не входит в путь по умолчанию.
- **Svara-TTS v1** — самый релевантный Indic-ориентированный открытый вариант: Apache-2.0, 19 индийских языков, теги вроде `<happy>`, `<sad>`, `<anger>` и `<fear>`, а также zero-shot пути адаптации. Точность сходства с диктором хуже доказана, чем у VoxCPM2/Fish, но модель выглядит хорошим кандидатом для дообучения эмоций на хинди.
- **Chatterbox Multilingual Hindi** — небольшой fallback с разрешительной лицензией: MIT, отдельный чекпойнт для хинди и zero-shot клонирование. Его контроль скорее про выразительность/интенсивность, чем про явное актёрское angry/sad/crying-исполнение.
- **OmniVoice** лучше оставить для широкого языкового покрытия. Его пространство инструкций фиксировано параметрами голосового дизайна, поэтому Studio считает whisper реальным контролем, а остальные маркеры лишь приближённо мапит на высоту тона.

Полезные ссылки: [VoxCPM2](https://github.com/OpenBMB/VoxCPM), [Fish Audio S2 Pro](https://huggingface.co/fishaudio/s2-pro), [Svara-TTS v1](https://huggingface.co/kenpath/svara-tts-v1), [Chatterbox Hindi](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-hi), [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice).

## Скачать

Последнюю сборку можно взять на [**странице релизов**](https://github.com/soniqo/speech-studio/releases/latest):

| Платформа | Артефакт | Статус |
|---|---|---|
| **macOS** (Apple Silicon) | [`.dmg`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Опубликовано |
| **Windows** (x86_64) | [`.msi` / `.exe`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Опубликовано |
| **Linux** (x86_64) | [`.deb` / `.AppImage`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ Опубликовано |

На каждой платформе речевая модель **скачивается при первом запуске** и кэшируется, поэтому установщики остаются небольшими:

- **macOS** — `.dmg` (~46 MB); перетащите в `/Applications`. Первый запуск скачает ~2.75 GB весов MLX в `~/Library/Caches/qwen3-speech/`.
- **Windows** — `.msi` или NSIS `-setup.exe`. Первый запуск скачает бандл VoxCPM2-LiteRT (~8.8 GB) в `%LOCALAPPDATA%\speech-core`.
- **Linux** — `.deb` или `.AppImage`. Первый запуск скачает тот же бандл в `~/.cache/speech-core`.

Бандл LiteRT для Windows/Linux хранится в fp16 и требует **~10 GiB свободной RAM** для загрузки; машине с 8 GB памяти может не хватить.

**Сборка для macOS подписана и нотариализована** (начиная с v0.0.5) — открывается как обычное приложение, без обхода Gatekeeper. Windows-установщики пока не подписаны: SmartScreen потребует *More info → Run anyway*.

### Ручная загрузка модели (macOS)

Если встроенная загрузка постоянно падает на нестабильной или медленной сети (`Download stalled for …: no progress` / `Failed to download …`), скачайте модель самостоятельно и положите её туда, где приложение её ищет. Нужны две части: веса модели и небольшой набор файлов токенизатора.

**Вариант A — CLI `hf` (рекомендуется: умеет продолжать прерванные загрузки):**

```bash
pip install -U huggingface_hub

hf download aufklarer/VoxCPM2-MLX-int8 \
  --local-dir ~/Library/Caches/qwen3-speech/models/aufklarer/VoxCPM2-MLX-int8

hf download openbmb/VoxCPM2 \
  config.json tokenizer.json tokenizer_config.json \
  tokenization_voxcpm2.py special_tokens_map.json \
  --local-dir ~/Library/Caches/qwen3-speech-voxcpm2-tokenizer/models/openbmb/VoxCPM2
```

**Вариант B — браузер:** скачайте файлы из [aufklarer/VoxCPM2-MLX-int8](https://huggingface.co/aufklarer/VoxCPM2-MLX-int8/tree/main) и [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2/tree/main) в те же две директории. Минимальный набор: директории модели нужны `config.json` и все файлы `*.safetensors`; директории токенизатора нужны пять файлов из команды выше.

При следующем запуске приложение обнаружит файлы и полностью пропустит загрузку. Если вы переопределяли `SONIQO_VOXCPM2_MODEL_ID`, замените repo id в пути модели. Для сборок из исходников, запущенных из терминала, можно увеличить терпимость к зависшей загрузке через `HF_DOWNLOAD_STALL_TIMEOUT=<seconds>`.

## Сборка из исходников

### Требования

Общие: Rust 1.95+ через `rustup` (`. "$HOME/.cargo/env"`, если `cargo` не в `PATH`), Node 20+ и `pnpm` 11+.

- **macOS:** macOS 15+ на Apple Silicon (M1/M2/M3/M4), Xcode 26+ (toolchain Swift 6.0).
- **Windows / Linux (x86_64):** toolchain C++17 + CMake 3.16+, а также checkout [`speech-core`](https://github.com/soniqo/speech-core), собранный с LiteRT-бэкендом (`-DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=...`) и бандлом модели `VoxCPM2-LiteRT`.

### Цикл разработки — macOS

```bash
pnpm install                          # installs the frontend + Tauri CLI
cd swift-sidecar && swift build       # builds the Swift sidecar
cd .. && pnpm tauri dev               # launches the app, hot-reloads the UI
```

При первом синтезе скачивается тот же объём модели (~2.75 GB) в `~/Library/Caches/qwen3-speech/`; если сеть нестабильна, смотрите [ручную загрузку модели](#ручная-загрузка-модели-macos).

### Цикл разработки — Windows / Linux

```bash
pnpm install
# Build the C++ sidecar against your speech-core checkout (defaults to ../speech-core):
cmake -B core-sidecar/build core-sidecar -DSPEECH_CORE_DIR=../speech-core
cmake --build core-sidecar/build --config Release
# Point it at the VoxCPM2-LiteRT bundle, then launch:
export SONIQO_VOXCPM2_BUNDLE_DIR=/path/to/speech-core/scripts/models-voxcpm2
pnpm tauri dev
```

### Потребление памяти

Измерения на Mac с Apple Silicon (M-серия, unified memory). Колонка **Resident (real)** — реальная память процесса (Activity Monitor, «Memory» — физический footprint по `vmmap`), именно её стоит сравнивать с объёмом RAM. **MLX active/peak** — собственный учёт MLX (peak за многострочную сессию). Важно: обычный `ps rss` на Apple Silicon занижает показатель примерно в 3 раза — Metal-буферы unified memory не входят в RSS, поэтому ориентируйтесь на resident-значения ниже.

Движок **VoxCPM2** по умолчанию:

| Вариант | Диск | MLX active | MLX peak | Resident (real) | По умолчанию |
|---|---|---|---|---|---|
| `aufklarer/VoxCPM2-MLX-int8`  | 2.75 GB | 3.1 GB | 5.4 GB | **~4–5 GB** | ✅ |
| `aufklarer/VoxCPM2-MLX-bf16`  | 4.6 GB  | 9.1 GB | 11.4 GB | ~12 GB | |

Остальные macOS-движки загружаются отдельно при выборе; одновременно резидентен только один движок (при переключении предыдущий выгружается): **Chatterbox** ~4 GB resident (1.3 GB на диске), **CosyVoice 3** легче, **Qwen3-TTS** (1.7B bf16) тяжелее. OmniVoice скачивается и загружается отдельно при выборе.

Кэш буферов MLX ограничен 1 GB (`SONIQO_MLX_CACHE_MB` позволяет переопределить). Без этого лимита пик на длинных сессиях растёт до десятков GB из-за накопления буферов разных форм. Чтобы использовать более качественные веса, задайте `SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-bf16`.

### Попробовать демо

Нажмите **«Загрузить демо»** в верхней панели. Приложение подготовит сцену «Scene 04» с двумя клонированными голосами (Anna и Marek) и четырьмя репликами — каждая со своим маркером эмоции — а затем синтезирует всё через VoxCPM2.

### Упаковка собственного .app / .dmg

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # produces .app + .dmg under src-tauri/target/release/bundle/
```

## Соседние репозитории

- [`speech-swift`](https://github.com/soniqo/speech-swift) — речевые движки для Apple Silicon (VoxCPM2, CosyVoice3, Qwen3-TTS, Chatterbox, OmniVoice, Indic-Mio, Fish Audio S2 Pro, Parakeet, Silero VAD).
- [`speech-core`](https://github.com/soniqo/speech-core) — C++-движки (клонирование VoxCPM2 на Windows/Linux, а также STT, VAD и шумоподавление).

## Участие в разработке

Правила проекта описаны в `AGENTS.md`. Коротко: ветка → PR → merge, без force-push, без AI co-author trailers, коммиты только при явной договорённости.

## Лицензия

[Apache License 2.0](LICENSE) — такая же, как у [speech-swift](https://github.com/soniqo/speech-swift) и [speech-core](https://github.com/soniqo/speech-core).
