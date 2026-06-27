# Speech Studio

[English](README.md) · **简体中文**

> 一个 [Soniqo](https://soniqo.audio) 项目。

面向内容创作者的开源桌面应用。用一小段参考音频克隆人声，逐行编写脚本，并用该音色合成全部内容——还能通过行内情感标记控制语气。

## 30 秒演示

一个盲听 A/B/C 对比：真实人声、由 Speech Studio 在 MacBook 上本地克隆的同一音色，以及由 ElevenLabs 在云端克隆的同一音色。你能分辨出哪个是哪个吗？

[![Speech Studio — 在 MacBook 上进行开源人声克隆](https://i.ytimg.com/vi/EuIU8tOWyzg/maxresdefault.jpg)](https://www.youtube.com/watch?v=EuIU8tOWyzg)

[在 YouTube 上观看 →](https://youtu.be/EuIU8tOWyzg)（30 秒）

> **状态：** v0 — 仅音频的 MVP。可运行于 macOS 15+（Apple Silicon）以及 Windows / Linux（x86_64）：macOS 通过 MLX 克隆，Windows/Linux 通过 `speech-core` 的端侧 LiteRT 后端克隆。时间轴上的视频播放，以及把音频叠加到视频的导出步骤，仍在路线图中。

## 功能

1. **拖入一小段说话人的参考音频** → 注册一个克隆音色。需要多少个说话人就重复多少次。
2. **为每个片段编写一行脚本**并选择由哪个说话人朗读。用情感标记包裹该行——`(whispering) Just stay quiet for a moment, please.`——合成时就会遵循该指示。
3. **点击 Synthesize（合成）**，用指定的克隆音色渲染每一行。合成流程会用端侧 ASR 自动为每次生成打分，若结果有误则换一个随机种子重试。
4. **播放脚本**即可连续听到整个场景。导出为单个 WAV 混音（导出功能仍在开发中）。

克隆在本地完成。合成在本地完成。没有任何音频离开你的机器。

## 技术栈

- **Tauri 2** 外壳（Rust + 操作系统原生 WebView），因此发布的应用是一个小巧的原生二进制，而非 Chromium 分支。
- **React + Vite** 前端，负责时间轴、音色库与脚本编辑器。
- **常驻的 sidecar 进程**让语音引擎保持加载状态，因此首次预热后逐行合成很快。Tauri 启动它一次，并通过 stdin/stdout 以 NDJSON 通信。在 macOS 上是 **Swift sidecar**（`swift-sidecar/`，MLX）；在 Windows/Linux 上是 **C++ sidecar**（`core-sidecar/`，LiteRT）。
- **VoxCPM2** 是所有平台上的默认引擎——在 macOS 上经由 [`speech-swift`](https://github.com/soniqo/speech-swift)（MLX），在 Windows/Linux 上经由 [`speech-core`](https://github.com/soniqo/speech-core)（LiteRT）。在 macOS 上可从工具栏切换引擎：**CosyVoice3**、**Qwen3-TTS**、**Chatterbox**（支持 23 种语言的多语言克隆）、**OmniVoice**（600+ 语言克隆）、**Indic-Mio**（Hindi/Indic 情感标签）以及 **Fish Audio S2 Pro**（实验性克隆 + 方括号标记）。这些 MLX 引擎仅限 macOS；Windows/Linux 仅运行 VoxCPM2。

## 引擎

从工具栏下拉框切换引擎（仅 macOS——Windows/Linux 始终使用 VoxCPM2，因此不显示下拉框）。

| 引擎 | 平台 | 后端 | 语音克隆 | 情感标记 | 语言数 |
|---|---|---|:---:|---|:---:|
| **VoxCPM2** · 默认 | macOS · Windows · Linux | MLX / LiteRT | ✅ | 风格指令 | 30 |
| **CosyVoice 3** | 仅 macOS | MLX | ✅ | 风格指令 | 9 |
| **Qwen3-TTS** | 仅 macOS | MLX | ✅（ICL） | — | 10 |
| **Chatterbox** | 仅 macOS | MLX | ✅ | 仅强度¹ | 23 |
| **OmniVoice** | 仅 macOS | MLX | ✅ | 受限指令² | 600+ |
| **Indic-Mio** | 仅 macOS | MLX | ✅³ | 后缀标签 | Indic |
| **Fish Audio S2 Pro** | 仅 macOS | MLX | ✅⁴ | 方括号标签 | 80+ |

MLX 引擎（CosyVoice 3、Qwen3-TTS、Chatterbox、OmniVoice、Indic-Mio、Fish Audio S2 Pro）仅限 **macOS**；Windows/Linux 通过 speech-core 的 LiteRT 后端运行 VoxCPM2。

¹ Chatterbox 没有自由文本风格输入——情感标记映射为表现力/强度级别（更强或更弱），而非具体某种情感。

² OmniVoice 支持口音、年龄、性别、音高、耳语等语音设计属性。Studio 只传入它合法的 `instruct` 词表项：`whisper` 会直接映射，其他情感标记会近似映射为音高提示（如 `high pitch`、`low pitch`）。强情感只是近似，不是真正的情绪表演控制。

³ Indic-Mio 作为实验性 Hindi/Indic 情感标签引擎暴露。它使用 `<happy>` / `<angry>` 这类后缀标签，并通过 WavLM → MioCodec 全局说话人嵌入从参考音频克隆；不需要参考文本。

⁴ Fish Audio S2 Pro 使用 `[excited]`、`[angry]`、`[whisper]` 这类方括号标签。克隆需要准确的参考文本；公开权重为研究/非商业用途，商业使用需要单独授权。

## 情感标记

用圆括号标记包裹一行来引导韵律：

```
(dramatic) I never thought we'd make it this far.
(warm) I knew you would make it, no matter what.
(whispering) Just stay quiet for a moment, please.
(intense) Then we end this together. Tonight.
```

支持的标记包括 `soft`、`warm`、`whispering`、`intense`、`excited`、`happy`、`calm`、`serious`、`surprised`、`sad`、`angry`、`dramatic`、`laughs`。

标记的应用方式因引擎而异：**VoxCPM2** 与 **CosyVoice 3** 会将其转为一句简短的自然语言风格指令（自定义标记如 `(slow and dreamy)` 原样传入）；**OmniVoice** 只会把已知标记映射到固定 `instruct` 词表（`whisper` 或音高提示），无法映射的标记会被丢弃；**Chatterbox** 将其映射为表现力/强度级别（没有具体情感控制，只有更强或更弱）；**Indic-Mio** 追加 `<happy>` 这类受支持的后缀标签；**Fish Audio S2 Pro** 追加 `[excited]` 这类方括号标签；**Qwen3-TTS** 忽略标记（会从文本中剥离）。

## 研究记录：强情感 Hindi 克隆

面向 Hindi 语音克隆 + 更强情感控制，目前值得跟踪的本地开源候选：

- **VoxCPM2** 仍是 Speech Studio 最适合产品化的基线：Apache-2.0、本地运行、支持 Hindi，并支持通过自然语言风格提示控制克隆语音。但在声称“强情绪表演”之前，还需要和下面的模型做 Hindi 情感样例对比。
- **Fish Audio S2 Pro** 看起来情感控制最强：80+ 语言、短参考克隆，并支持 `[angry]`、`[sad]`、`[whisper]`、`[shouting]` 等行内自由文本情感/韵律标签。它现在作为实验性 macOS 引擎可用，但公开权重许可证是研究/非商业用途，商业使用需单独授权，所以仍不作为默认路径。
- **Svara-TTS v1** 是最相关的 Indic 专用开源模型：Apache-2.0、19 种印度语言、支持 `<happy>`、`<sad>`、`<anger>`、`<fear>` 等标签，也提供零样本适配路径。它的精确说话人相似度不如 VoxCPM2/Fish 已被充分验证，但适合作为 Hindi 情绪微调方向。
- **Chatterbox Multilingual Hindi** 是许可宽松的小模型备选：MIT、专用 Hindi checkpoint、支持零样本克隆。它的控制更偏表现力/强度，不是明确的 angry/sad/crying 式表演控制。
- **OmniVoice** 更适合覆盖超多语言。它的指令空间固定为语音设计属性，因此 Studio 把 whisper 当作真实控制，其他标记只近似映射为音高。

参考链接：[VoxCPM2](https://github.com/OpenBMB/VoxCPM)、[Fish Audio S2 Pro](https://huggingface.co/fishaudio/s2-pro)、[Svara-TTS v1](https://huggingface.co/kenpath/svara-tts-v1)、[Chatterbox Hindi](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-hi)、[OmniVoice](https://huggingface.co/k2-fsa/OmniVoice)。

## 下载

从[**发布页**](https://github.com/soniqo/speech-studio/releases/latest)获取最新构建：

| 平台 | 安装包 | 状态 |
|---|---|---|
| **macOS**（Apple Silicon） | [`.dmg`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ 已发布 |
| **Windows**（x86_64） | [`.msi` / `.exe`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ 已发布 |
| **Linux**（x86_64） | [`.deb` / `.AppImage`](https://github.com/soniqo/speech-studio/releases/latest) | ✅ 已发布 |

每个平台都会在**首次运行时下载语音模型**并缓存，因此安装包本身很小：

- **macOS** — `.dmg`（约 46 MB）；拖入 `/Applications`。首次运行会将约 2.75 GB 的 MLX 权重下载到 `~/Library/Caches/qwen3-speech/`。
- **Windows** — `.msi` 或 NSIS `-setup.exe`。首次运行会将约 8.8 GB 的 VoxCPM2-LiteRT 模型包下载到 `%LOCALAPPDATA%\speech-core`。
- **Linux** — `.deb` 或 `.AppImage`。首次运行会将同样的模型包下载到 `~/.cache/speech-core`。

Windows/Linux 的 LiteRT 模型包为 fp16 格式，加载时约需 **10 GiB 空闲内存** —— 8 GB 内存的机器可能不够。

**macOS 构建已签名并经过公证**（自 v0.0.5 起）——像普通应用一样直接打开，无需绕过 Gatekeeper。Windows 安装包仍未签名：SmartScreen 需要点击 *More info → Run anyway*。

### 手动下载模型（macOS）

如果应用内下载在不稳定或缓慢的网络上反复失败（`Download stalled for …: no progress` / `Failed to download …`），可以自行下载模型并放到应用读取的目录。共两部分：模型权重和一小组分词器文件。

**方式 A — `hf` 命令行（推荐：支持断点续传）：**

```bash
pip install -U huggingface_hub

hf download aufklarer/VoxCPM2-MLX-int8 \
  --local-dir ~/Library/Caches/qwen3-speech/models/aufklarer/VoxCPM2-MLX-int8

hf download openbmb/VoxCPM2 \
  config.json tokenizer.json tokenizer_config.json \
  tokenization_voxcpm2.py special_tokens_map.json \
  --local-dir ~/Library/Caches/qwen3-speech-voxcpm2-tokenizer/models/openbmb/VoxCPM2
```

**方式 B — 浏览器：** 从 [aufklarer/VoxCPM2-MLX-int8](https://huggingface.co/aufklarer/VoxCPM2-MLX-int8/tree/main) 和 [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2/tree/main) 下载文件到上述两个目录。最小文件集：模型目录需要 `config.json` 和所有 `*.safetensors` 文件；分词器目录需要上面命令中列出的五个文件。

应用会在下次启动时检测到这些文件并完全跳过下载。如果你覆盖了 `SONIQO_VOXCPM2_MODEL_ID`，请在模型路径中替换为对应的仓库 id。从终端启动的源码构建还可以通过 `HF_DOWNLOAD_STALL_TIMEOUT=<秒数>` 延长应用内下载的停滞容忍时间。

## 从源码构建

### 前置条件

通用：通过 `rustup` 安装的 Rust 1.95+（若 `cargo` 不在 `PATH` 中，执行 `. "$HOME/.cargo/env"`）、Node 20+ 与 `pnpm` 11+。

- **macOS：** Apple Silicon（M1/M2/M3/M4）上的 macOS 15+，Xcode 26+（Swift 6.0 工具链）。
- **Windows / Linux（x86_64）：** C++17 工具链 + CMake 3.16+，以及一个已构建并启用 LiteRT 后端的 [`speech-core`](https://github.com/soniqo/speech-core) 检出（`-DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=...`），外加 `VoxCPM2-LiteRT` 模型包。

### 开发循环 — macOS

```bash
pnpm install                          # 安装前端 + Tauri CLI
cd swift-sidecar && swift build       # 构建 Swift sidecar
cd .. && pnpm tauri dev               # 启动应用，热重载 UI
```

首次合成时同样会下载约 2.75 GB 的模型（位于 `~/Library/Caches/qwen3-speech/`——如果网络不稳定，请参阅[手动下载模型](#手动下载模型macos)）。

### 开发循环 — Windows / Linux

```bash
pnpm install
# 针对你的 speech-core 检出构建 C++ sidecar（默认为 ../speech-core）：
cmake -B core-sidecar/build core-sidecar -DSPEECH_CORE_DIR=../speech-core
cmake --build core-sidecar/build --config Release
# 指向 VoxCPM2-LiteRT 模型包，然后启动：
export SONIQO_VOXCPM2_BUNDLE_DIR=/path/to/speech-core/scripts/models-voxcpm2
pnpm tauri dev
```

### 内存占用

在一台 Apple Silicon Mac（M 系列，统一内存）上测得。**驻留（真实）** 列是实际进程占用（活动监视器的“内存”——`vmmap` 物理足迹），这是你应与 RAM 对照的数字。**MLX 活跃/峰值** 是 MLX 自身的统计（峰值为多行会话期间）。注意：在 Apple Silicon 上 `ps rss` 会少报约 3 倍——Metal 统一内存缓冲不计入 RSS，请以下方驻留数字为准。

默认的 **VoxCPM2** 引擎：

| 变体 | 磁盘 | MLX 活跃 | MLX 峰值 | 驻留（真实） | 默认 |
|---|---|---|---|---|---|
| `aufklarer/VoxCPM2-MLX-int8`  | 2.75 GB | 3.1 GB | 5.4 GB | **约 4–5 GB** | ✅ |
| `aufklarer/VoxCPM2-MLX-bf16`  | 4.6 GB  | 9.1 GB | 11.4 GB | 约 12 GB | |

其他 macOS 引擎在被选中时单独加载——同一时刻只有一个驻留（切换会卸载上一个）：**Chatterbox** 驻留约 4 GB（磁盘 1.3 GB），**CosyVoice 3** 更轻，**Qwen3-TTS**（1.7B bf16）更重。OmniVoice 会在被选中时单独下载并加载。

MLX 缓冲缓存上限为 1 GB（可用 `SONIQO_MLX_CACHE_MB` 覆盖）——若没有该上限，长会话中峰值会随着不同形状的缓冲累积增长到数十 GB。如需更高保真度的权重，用 `SONIQO_VOXCPM2_MODEL_ID=aufklarer/VoxCPM2-MLX-bf16` 覆盖默认模型。

### 试用演示

点击顶栏的 **Load demo（加载演示）**。它会引导出一个 Scene 04 分镜，包含两个克隆音色（Anna 与 Marek）和四行对白——每行带一个情感标记——然后通过 VoxCPM2 合成全部内容。

### 打包你自己的 .app / .dmg

```bash
cd swift-sidecar && swift build -c release
cd .. && pnpm tauri build             # 在 src-tauri/target/release/bundle/ 下生成 .app + .dmg
```

## 同级仓库

- [`speech-swift`](https://github.com/soniqo/speech-swift) — Apple Silicon 语音引擎（VoxCPM2、CosyVoice3、Qwen3-TTS、Chatterbox、OmniVoice、Indic-Mio、Fish Audio S2 Pro、Parakeet、Silero VAD）。
- [`speech-core`](https://github.com/soniqo/speech-core) — C++ 引擎（Windows/Linux 上的 VoxCPM2 克隆，以及 STT、VAD、降噪）。

## 贡献

项目约定见 `AGENTS.md`。简而言之：分支 → PR → 合并，不要 force-push，不要添加 AI 共同作者署名，除非明确要求否则不要提交。

## 许可证

[Apache License 2.0](LICENSE) — 与 [speech-swift](https://github.com/soniqo/speech-swift) 和 [speech-core](https://github.com/soniqo/speech-core) 相同。
