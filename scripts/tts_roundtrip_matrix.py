#!/usr/bin/env python3
"""Run a multilingual TTS -> ASR intelligibility matrix against the Swift sidecar.

The matrix is intentionally a smoke benchmark: one short sentence per
model/language pair, synthesized through the sidecar protocol, transcribed by
the local `speech` CLI, then scored with token precision/recall and WER.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "swift-sidecar/.build/debug/soniqo-tts-sidecar"
REGISTRY_PATH = ROOT / "model-registry.json"
REF_TEXT = (
    "Hello. This is a clean reference voice spoken slowly and clearly for "
    "speech synthesis testing."
)

TEXTS: dict[str, str] = {
    "ar": "اليوم نختبر ما إذا كان الكلام واضحا وسهل الفهم.",
    "da": "I dag tester vi, om talen er klar og let at forstå.",
    "de": "Heute testen wir, ob die Sprache klar und leicht zu verstehen ist.",
    "el": "Σήμερα ελέγχουμε αν η ομιλία είναι καθαρή και εύκολη στην κατανόηση.",
    "en": "Today we test whether the speech is clear and easy to understand.",
    "es": "Hoy probamos si el habla es clara y fácil de entender.",
    "fi": "Tänään testaamme, onko puhe selkeää ja helppoa ymmärtää.",
    "fr": "Aujourd'hui, nous testons si la parole est claire et facile à comprendre.",
    "he": "היום אנחנו בודקים אם הדיבור ברור וקל להבנה.",
    "hi": "आज हम जाँचते हैं कि आवाज़ साफ़ और समझने में आसान है या नहीं।",
    "id": "Hari ini kami menguji apakah ucapan jelas dan mudah dipahami.",
    "it": "Oggi testiamo se il parlato è chiaro e facile da capire.",
    "ja": "今日は音声が明瞭で理解しやすいかをテストします。",
    "km": "ថ្ងៃនេះយើងសាកល្បងថាសំឡេងច្បាស់ និងងាយស្រួលយល់ឬអត់។",
    "ko": "오늘 우리는 음성이 명확하고 이해하기 쉬운지 테스트합니다.",
    "lo": "ມື້ນີ້ພວກເຮົາທົດສອບວ່າສຽງຊັດເຈນ ແລະ ເຂົ້າໃຈງ່າຍຫຼືບໍ່.",
    "ms": "Hari ini kami menguji sama ada pertuturan jelas dan mudah difahami.",
    "my": "ဒီနေ့ အသံက ရှင်းလင်းပြီး နားလည်ရလွယ်မလွယ် စမ်းသပ်ပါမယ်။",
    "nl": "Vandaag testen we of de spraak duidelijk en gemakkelijk te begrijpen is.",
    "no": "I dag tester vi om talen er klar og lett å forstå.",
    "pl": "Dzisiaj sprawdzamy, czy mowa jest wyraźna i łatwa do zrozumienia.",
    "pt": "Hoje testamos se a fala é clara e fácil de entender.",
    "ru": "Сегодня мы проверяем, является ли речь четкой и легкой для понимания.",
    "sv": "I dag testar vi om talet är tydligt och lätt att förstå.",
    "sw": "Leo tunajaribu kama hotuba iko wazi na ni rahisi kuelewa.",
    "th": "วันนี้เราทดสอบว่าเสียงพูดชัดเจนและเข้าใจง่ายหรือไม่",
    "tl": "Ngayon sinusubukan natin kung malinaw at madaling maunawaan ang pagsasalita.",
    "tr": "Bugün konuşmanın net ve kolay anlaşılır olup olmadığını test ediyoruz.",
    "vi": "Hôm nay chúng tôi kiểm tra xem giọng nói có rõ ràng và dễ hiểu không.",
    "zh": "今天我们测试语音是否清晰且容易理解。",
}

COSY_LANGUAGE = {
    "zh": "chinese",
    "en": "english",
    "ja": "japanese",
    "ko": "korean",
    "de": "german",
    "es": "spanish",
    "fr": "french",
    "it": "italian",
    "ru": "russian",
}


@dataclass(frozen=True)
class EngineSpec:
    id: str
    display_name: str
    model_id: str
    precision: str
    runtime: str
    command: str
    languages: tuple[str, ...]
    benchmark_languages: tuple[str, ...]
    requires_language: bool
    reference_text_required: bool


def registry_platform_key() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def load_engine_specs(path: Path = REGISTRY_PATH) -> dict[str, EngineSpec]:
    registry = json.loads(path.read_text(encoding="utf-8"))
    platform = registry_platform_key()
    engines: dict[str, EngineSpec] = {}
    for raw in registry.get("ttsEngines", []):
        item = dict(raw)
        if item.get("macosOnly") and platform != "macos":
            continue
        override = (item.get("platformOverrides") or {}).get(platform) or {}
        item.update(override)
        engines[item["id"]] = EngineSpec(
            id=item["id"],
            display_name=item["displayName"],
            model_id=item["modelId"],
            precision=item["precision"],
            runtime=item["runtime"],
            command=item["sidecarCommand"],
            languages=tuple(item["languages"]),
            benchmark_languages=tuple(item.get("benchmarkLanguages") or item["languages"]),
            requires_language=bool(item["requiresLanguage"]),
            reference_text_required=bool(item["requiresReferenceTranscript"]),
        )
    return engines


ENGINES: dict[str, EngineSpec] = load_engine_specs()


@dataclass
class Case:
    engine: EngineSpec
    language: str
    text: str

    @property
    def key(self) -> str:
        return f"{self.engine.id}__{self.language}"


@dataclass
class Attempt:
    case: Case
    seed: int
    ok: bool = False
    error: str = ""
    audio_path: str = ""
    duration_sec: float = 0.0
    synth_sec: float = 0.0
    sample_rate: int = 0
    transcript: str = ""
    asr_sec: float = 0.0
    asr_rtf: float = 0.0
    precision: float = 0.0
    recall: float = 0.0
    wer: float = 1.0
    accuracy: float = 0.0
    pass_intelligibility: bool = False
    verdict: str = "failed"
    regression: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def stem(self) -> str:
        return safe_name(f"{self.case.engine.id}__{self.case.language}__s{self.seed}")


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def run(cmd: list[str], *, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def ensure_reference(outdir: Path) -> Path:
    ref_path = outdir / "ref-samantha.wav"
    if ref_path.exists():
        return ref_path
    cp = run(
        [
            "say",
            "-v",
            "Samantha",
            "-o",
            str(ref_path),
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            REF_TEXT,
        ],
        timeout=30,
    )
    if cp.returncode != 0:
        raise RuntimeError(f"failed to generate reference with say:\n{cp.stdout}")
    return ref_path


class Sidecar:
    def __init__(self, binary: Path, log_path: Path):
        if not binary.exists():
            raise FileNotFoundError(f"sidecar binary not found: {binary}")
        self.log_file = log_path.open("w", encoding="utf-8")
        self.proc = subprocess.Popen(
            [str(binary)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log_file,
            text=True,
            bufsize=1,
        )
        self._responses: queue.Queue[str] = queue.Queue()
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._responses.put(line)

    def request(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        if self.proc.poll() is not None:
            raise RuntimeError(f"sidecar exited with code {self.proc.returncode}")
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        try:
            line = self._responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError(f"sidecar timeout for {payload.get('id')}") from exc
        return json.loads(line)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.log_file.close()


def target_word_count(text: str) -> int:
    tokens = tokenize(text)
    return max(1, len(tokens))


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def language_payload(engine: EngineSpec, language: str, routing: str) -> str | None:
    if routing == "production" and not engine.requires_language:
        return None
    if engine.id == "cosyvoice":
        return COSY_LANGUAGE.get(language, language)
    if engine.id in {"omnivoice", "indic-mio"} and language == "hi":
        return "hindi"
    if engine.id == "indic-mio" and language == "en":
        return "english"
    return language


def synthesize(
    sidecar: Sidecar,
    case: Case,
    seed: int,
    ref_path: Path,
    audio_dir: Path,
    routing: str,
    timeout: float,
) -> Attempt:
    attempt = Attempt(case=case, seed=seed)
    lang_dir = audio_dir / case.language
    lang_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    words = target_word_count(case.text)
    max_tokens = clamp(words * 12 + 40, 60, 320)
    min_stop_steps = clamp(words * 5 // 2, 8, max_tokens - 16)
    payload: dict[str, Any] = {
        "id": attempt.stem,
        "command": case.engine.command,
        "engine": case.engine.id,
        "modelId": case.engine.model_id,
        "text": case.text,
        "voiceId": f"matrix-{case.engine.id}",
        "referenceAudioPath": str(ref_path),
        "seed": seed,
        "cfgValue": 2.0,
        "maxTokens": max_tokens,
        "minStopSteps": min_stop_steps,
    }
    if case.engine.reference_text_required:
        payload["referenceText"] = REF_TEXT
    language = language_payload(case.engine, case.language, routing)
    if language:
        payload["language"] = language
    attempt.metadata["languageSent"] = language or ""
    attempt.metadata["maxTokens"] = max_tokens
    attempt.metadata["minStopSteps"] = min_stop_steps

    try:
        response = sidecar.request(payload, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - preserve error in report
        attempt.error = str(exc)
        attempt.synth_sec = time.monotonic() - started
        return attempt

    attempt.synth_sec = time.monotonic() - started
    if response.get("ok") is not True:
        attempt.error = str(response.get("error") or "synthesis failed")
        return attempt
    result = response.get("result") or {}
    src = result.get("audioPath")
    if not src or not Path(src).exists():
        attempt.error = f"missing output audio: {src}"
        return attempt
    dest = lang_dir / f"{attempt.stem}.wav"
    shutil.copyfile(src, dest)
    attempt.audio_path = str(dest)
    attempt.duration_sec = float(result.get("durationSec") or 0.0)
    attempt.sample_rate = int(result.get("sampleRate") or 0)
    attempt.ok = True
    return attempt


def is_cjk_char(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0x3040 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
    )


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    out: list[str] = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat[0] in {"L", "N", "M"} or is_cjk_char(ch):
            out.append(ch)
        else:
            out.append(" ")
    return re.sub(r"\s+", " ", "".join(out)).strip()


def tokenize(text: str) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    cjk_count = sum(1 for ch in normalized if is_cjk_char(ch))
    if cjk_count >= max(2, len(normalized.replace(" ", "")) // 3):
        return [ch for ch in normalized if not ch.isspace()]
    return normalized.split()


def edit_distance(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(
                min(
                    prev[j] + 1,
                    cur[j - 1] + 1,
                    prev[j - 1] + (0 if x == y else 1),
                )
            )
        prev = cur
    return prev[-1]


def score(reference: str, hypothesis: str) -> tuple[float, float, float, float]:
    ref = tokenize(reference)
    hyp = tokenize(hypothesis)
    if not ref:
        return 0.0, 0.0, 1.0, 0.0
    overlap = sum((Counter(ref) & Counter(hyp)).values())
    precision = overlap / len(hyp) if hyp else 0.0
    recall = overlap / len(ref)
    wer = edit_distance(ref, hyp) / len(ref)
    accuracy = max(0.0, 1.0 - wer)
    return precision, recall, wer, accuracy


def classify_intelligibility(attempt: Attempt) -> str:
    if not attempt.ok or attempt.error or not attempt.transcript.strip():
        return "failed"
    if attempt.precision >= 0.90 and attempt.recall >= 0.90 and attempt.wer <= 0.15:
        return "exact"
    if attempt.pass_intelligibility:
        return "intelligible"
    if attempt.precision >= 0.45 and attempt.recall >= 0.40 and attempt.accuracy >= 0.25:
        return "word-drift"
    return "failed"


def parse_asr_jsonl(stdout: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "file" in item:
            out[str(item["file"])] = item
    return out


def transcribe_by_language(
    attempts: list[Attempt],
    audio_dir: Path,
    asr_dir: Path,
    asr_engine: str,
    asr_model: str,
) -> None:
    by_lang: dict[str, list[Attempt]] = defaultdict(list)
    for attempt in attempts:
        if attempt.ok and attempt.audio_path:
            by_lang[attempt.case.language].append(attempt)

    for language, items in sorted(by_lang.items()):
        lang_audio_dir = audio_dir / language
        lang_asr_dir = asr_dir / language
        lang_asr_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            "speech",
            "transcribe-batch",
            str(lang_audio_dir),
            "--output-dir",
            str(lang_asr_dir),
            "--engine",
            asr_engine,
            "--language",
            language,
            "--jsonl",
        ]
        if asr_engine == "qwen3":
            cmd.extend(["--model", asr_model])
        started = time.monotonic()
        cp = run(cmd)
        elapsed = time.monotonic() - started
        if cp.returncode != 0:
            for item in items:
                item.error = item.error or f"ASR failed for language {language}: {cp.stdout[-500:]}"
                item.verdict = classify_intelligibility(item)
            continue
        parsed = parse_asr_jsonl(cp.stdout)
        for item in items:
            row = parsed.get(item.stem)
            if not row:
                item.error = item.error or f"ASR missing result for {item.stem}"
                item.verdict = classify_intelligibility(item)
                continue
            item.transcript = str(row.get("text") or "").strip()
            item.asr_sec = float(row.get("time") or 0.0)
            item.asr_rtf = float(row.get("rtf") or 0.0)
            item.metadata["asrBatchWallSec"] = elapsed
            p, r, wer, acc = score(item.case.text, item.transcript)
            item.precision = p
            item.recall = r
            item.wer = wer
            item.accuracy = acc
            item.pass_intelligibility = (
                item.precision >= 0.55
                and item.recall >= 0.60
                and item.accuracy >= 0.45
            )
            item.verdict = classify_intelligibility(item)


def select_cases(models: list[str], languages: list[str]) -> list[Case]:
    selected_engines = ENGINES.keys() if models == ["all"] else models
    cases: list[Case] = []
    for engine_id in selected_engines:
        if engine_id not in ENGINES:
            raise ValueError(f"unknown engine {engine_id}; choose {', '.join(ENGINES)}")
        engine = ENGINES[engine_id]
        selected_langs = (
            engine.benchmark_languages if languages == ["all"] else tuple(languages)
        )
        for language in selected_langs:
            if language not in engine.languages:
                continue
            if language not in TEXTS:
                raise ValueError(f"missing test text for language {language}")
            cases.append(Case(engine=engine, language=language, text=TEXTS[language]))
    return cases


def asr_model_descriptor(asr_engine: str, asr_model: str) -> tuple[str, str]:
    if asr_engine == "qwen3":
        model_ids = {
            "0.6B": ("aufklarer/Qwen3-ASR-0.6B-MLX-4bit", "4bit"),
            "0.6B-8bit": ("aufklarer/Qwen3-ASR-0.6B-MLX-8bit", "8bit"),
            "1.7B": ("aufklarer/Qwen3-ASR-1.7B-MLX-8bit", "8bit"),
            "1.7B-4bit": ("aufklarer/Qwen3-ASR-1.7B-MLX-4bit", "4bit"),
        }
        return model_ids.get(asr_model, (asr_model, "unknown"))
    if asr_engine == "parakeet":
        return ("aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s", "int8")
    return (asr_model or asr_engine, "unknown")


def write_reports(
    attempts: list[Attempt],
    outdir: Path,
    baseline: dict[str, Any] | None,
    asr_engine: str,
    asr_model: str,
) -> None:
    asr_model_id, asr_precision = asr_model_descriptor(asr_engine, asr_model)
    rows = []
    for attempt in attempts:
        key = f"{attempt.case.engine.id}/{attempt.case.language}"
        tts_rtf = (
            attempt.synth_sec / attempt.duration_sec
            if attempt.ok and attempt.duration_sec > 0
            else 0.0
        )
        if baseline and key in baseline:
            base_acc = float(baseline[key].get("accuracy") or 0.0)
            delta = attempt.accuracy - base_acc
            if delta <= -0.15:
                attempt.regression = f"regressed {delta * 100:.0f}pp"
            else:
                attempt.regression = f"{delta * 100:+.0f}pp"
        rows.append(
            {
                "engine": attempt.case.engine.id,
                "displayName": attempt.case.engine.display_name,
                "modelId": attempt.case.engine.model_id,
                "modelPrecision": attempt.case.engine.precision,
                "runtime": attempt.case.engine.runtime,
                "language": attempt.case.language,
                "languageSent": attempt.metadata.get("languageSent", ""),
                "seed": attempt.seed,
                "ok": attempt.ok,
                "pass": attempt.pass_intelligibility,
                "verdict": attempt.verdict,
                "precision": round(attempt.precision, 4),
                "recall": round(attempt.recall, 4),
                "wer": round(attempt.wer, 4),
                "accuracy": round(attempt.accuracy, 4),
                "durationSec": round(attempt.duration_sec, 3),
                "synthSec": round(attempt.synth_sec, 3),
                "ttsRtf": round(tts_rtf, 4),
                "asrSec": round(attempt.asr_sec, 3),
                "asrRtf": round(attempt.asr_rtf, 4),
                "asrEngine": asr_engine,
                "asrModel": asr_model,
                "asrModelId": asr_model_id,
                "asrPrecision": asr_precision,
                "audioPath": attempt.audio_path,
                "target": attempt.case.text,
                "transcript": attempt.transcript,
                "error": attempt.error,
                "regression": attempt.regression,
            }
        )

    csv_path = outdir / "tts-roundtrip-matrix.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
        writer.writeheader()
        writer.writerows(rows)

    json_path = outdir / "tts-roundtrip-matrix.json"
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    summary: dict[str, Any] = {}
    for engine_id in ENGINES:
        engine_rows = [r for r in rows if r["engine"] == engine_id]
        if not engine_rows:
            continue
        warm_rows = engine_rows[1:] if len(engine_rows) > 1 else engine_rows
        verdict_counts = Counter(str(r["verdict"]) for r in engine_rows)
        summary[engine_id] = {
            "modelId": ENGINES[engine_id].model_id,
            "precision": ENGINES[engine_id].precision,
            "runtime": ENGINES[engine_id].runtime,
            "cases": len(engine_rows),
            "passed": sum(1 for r in engine_rows if r["pass"]),
            "passRate": sum(1 for r in engine_rows if r["pass"]) / len(engine_rows),
            "verdicts": {
                "exact": verdict_counts.get("exact", 0),
                "intelligible": verdict_counts.get("intelligible", 0),
                "word-drift": verdict_counts.get("word-drift", 0),
                "failed": verdict_counts.get("failed", 0),
            },
            "meanPrecision": sum(float(r["precision"]) for r in engine_rows) / len(engine_rows),
            "meanRecall": sum(float(r["recall"]) for r in engine_rows) / len(engine_rows),
            "meanWer": sum(float(r["wer"]) for r in engine_rows) / len(engine_rows),
            "meanTtsRtf": sum(float(r["ttsRtf"]) for r in engine_rows) / len(engine_rows),
            "warmMeanTtsRtf": sum(float(r["ttsRtf"]) for r in warm_rows) / len(warm_rows),
            "meanAsrRtf": sum(float(r["asrRtf"]) for r in engine_rows) / len(engine_rows),
            "exactLanguages": [r["language"] for r in engine_rows if r["verdict"] == "exact"],
            "intelligibleLanguages": [
                r["language"] for r in engine_rows if r["verdict"] == "intelligible"
            ],
            "wordDriftLanguages": [
                r["language"] for r in engine_rows if r["verdict"] == "word-drift"
            ],
            "failedLanguages": [
                r["language"] for r in engine_rows if r["verdict"] == "failed"
            ],
            "failures": [
                f"{r['language']} acc={float(r['accuracy']) * 100:.0f}% p={float(r['precision']) * 100:.0f}%"
                for r in engine_rows
                if r["verdict"] == "failed"
            ],
            "languageResults": "; ".join(
                f"{r['language']} {r['verdict']} "
                f"P{float(r['precision']) * 100:.0f} "
                f"R{float(r['recall']) * 100:.0f} "
                f"WER{float(r['wer']) * 100:.0f}"
                for r in engine_rows
            ),
        }
    (outdir / "tts-roundtrip-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    md = [
        "# TTS Roundtrip Matrix",
        "",
        f"Generated: {dt.datetime.now().isoformat(timespec='seconds')}",
        "",
        "Scores are ASR-derived intelligibility proxies: precision/recall are token overlap; WER is edit distance over normalized tokens or CJK characters.",
        f"ASR scorer: `{asr_engine}` `{asr_model}` -> `{asr_model_id}` ({asr_precision}).",
        "TTS RTF is wall-clock synthesis seconds divided by generated audio seconds. Warm RTF excludes the first row per engine because the sidecar loads that model lazily on first synthesis.",
        "Verdicts: `exact` is a high-overlap transcript; `intelligible` passes the regression threshold with minor wording drift; `word-drift` is related/understandable but not exact enough for a pass; `failed` is empty, unintelligible, wrong-language, or unrelated output.",
        "",
        "| Engine | TTS artifact | Model precision | Roundtrip per language | Verdicts E/I/D/F | Cases | Passed | Pass rate | Mean ASR precision | Mean recall | Mean WER | TTS RTF | Warm TTS RTF | ASR RTF |",
        "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for engine_id, item in summary.items():
        md.append(
            "| {engine} | `{model}` | {model_precision} | {language_results} | {verdicts} | {cases} | {passed} | {pass_rate:.0%} | {precision:.0%} | {recall:.0%} | {wer:.0%} | {tts_rtf:.2f} | {warm_tts_rtf:.2f} | {asr_rtf:.2f} |".format(
                engine=ENGINES[engine_id].display_name,
                model=item["modelId"],
                model_precision=item["precision"],
                language_results=item["languageResults"],
                verdicts="{exact}/{intelligible}/{drift}/{failed}".format(
                    exact=item["verdicts"]["exact"],
                    intelligible=item["verdicts"]["intelligible"],
                    drift=item["verdicts"]["word-drift"],
                    failed=item["verdicts"]["failed"],
                ),
                cases=item["cases"],
                passed=item["passed"],
                pass_rate=item["passRate"],
                precision=item["meanPrecision"],
                recall=item["meanRecall"],
                wer=item["meanWer"],
                tts_rtf=item["meanTtsRtf"],
                warm_tts_rtf=item["warmMeanTtsRtf"],
                asr_rtf=item["meanAsrRtf"],
            )
        )
    md.extend(
        [
            "",
            "## Per Case",
            "",
            "| Engine | Model precision | Lang | Sent | Verdict | Pass | ASR precision | Recall | WER | Duration | Synth | TTS RTF | ASR RTF | Transcript | Error |",
            "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for r in rows:
        transcript = str(r["transcript"]).replace("|", "\\|")
        if len(transcript) > 80:
            transcript = transcript[:77] + "..."
        error = str(r["error"]).replace("|", "\\|")
        if len(error) > 80:
            error = error[:77] + "..."
        md.append(
            "| {engine} | {model_precision} | {lang} | {sent} | {verdict} | {passed} | {precision:.0%} | {recall:.0%} | {wer:.0%} | {duration:.1f}s | {synth:.1f}s | {tts_rtf:.2f} | {asr_rtf:.2f} | {transcript} | {error} |".format(
                engine=r["displayName"],
                model_precision=r["modelPrecision"],
                lang=r["language"],
                sent=r["languageSent"] or "-",
                verdict=r["verdict"],
                passed="yes" if r["pass"] else "no",
                precision=float(r["precision"]),
                recall=float(r["recall"]),
                wer=float(r["wer"]),
                duration=float(r["durationSec"]),
                synth=float(r["synthSec"]),
                tts_rtf=float(r["ttsRtf"]),
                asr_rtf=float(r["asrRtf"]),
                transcript=transcript,
                error=error,
            )
        )
    (outdir / "tts-roundtrip-report.md").write_text("\n".join(md) + "\n", encoding="utf-8")


def load_baseline(path: Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    rows = json.loads(path.read_text(encoding="utf-8"))
    return {f"{row['engine']}/{row['language']}": row for row in rows}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default="all", help="Comma list or all")
    parser.add_argument("--languages", default="all", help="Comma list or all")
    parser.add_argument("--outdir", default="")
    parser.add_argument("--sidecar", default=str(SIDECAR))
    parser.add_argument("--asr-engine", default="qwen3")
    parser.add_argument("--asr-model", default="0.6B")
    parser.add_argument("--seed", type=int, default=1000)
    parser.add_argument("--timeout-sec", type=float, default=600)
    parser.add_argument(
        "--routing",
        choices=("production", "declared"),
        default="production",
        help="production sends language only when requiresLanguage=true; declared sends it whenever the model-side API accepts one",
    )
    parser.add_argument("--baseline-json", default="")
    args = parser.parse_args()

    models = [x.strip() for x in args.models.split(",") if x.strip()]
    languages = [x.strip() for x in args.languages.split(",") if x.strip()]
    outdir = Path(args.outdir) if args.outdir else Path("/tmp/speech-studio-roundtrip") / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir.mkdir(parents=True, exist_ok=True)
    audio_dir = outdir / "audio"
    asr_dir = outdir / "asr"
    audio_dir.mkdir(exist_ok=True)
    asr_dir.mkdir(exist_ok=True)

    cases = select_cases(models, languages)
    ref_path = ensure_reference(outdir)
    print(f"[matrix] output: {outdir}")
    print(f"[matrix] cases: {len(cases)}")
    print(f"[matrix] reference: {ref_path}")

    attempts: list[Attempt] = []
    sidecar = Sidecar(Path(args.sidecar), outdir / "sidecar.stderr.log")
    try:
        for index, case in enumerate(cases, 1):
            print(
                f"[matrix] synth {index}/{len(cases)} {case.engine.id}/{case.language}",
                flush=True,
            )
            attempt = synthesize(
                sidecar,
                case,
                args.seed,
                ref_path,
                audio_dir,
                args.routing,
                args.timeout_sec,
            )
            if attempt.ok:
                print(
                    f"  ok {attempt.duration_sec:.2f}s audio in {attempt.synth_sec:.1f}s",
                    flush=True,
                )
            else:
                print(f"  failed: {attempt.error}", flush=True)
            attempts.append(attempt)
    finally:
        sidecar.close()

    print("[matrix] transcribing by language...", flush=True)
    transcribe_by_language(attempts, audio_dir, asr_dir, args.asr_engine, args.asr_model)
    write_reports(
        attempts,
        outdir,
        load_baseline(Path(args.baseline_json)) if args.baseline_json else None,
        args.asr_engine,
        args.asr_model,
    )

    passed = sum(1 for item in attempts if item.pass_intelligibility)
    print(f"[matrix] pass: {passed}/{len(attempts)}")
    print(f"[matrix] report: {outdir / 'tts-roundtrip-report.md'}")
    print(f"[matrix] csv: {outdir / 'tts-roundtrip-matrix.csv'}")
    return 0 if passed == len(attempts) else 2


if __name__ == "__main__":
    raise SystemExit(main())
