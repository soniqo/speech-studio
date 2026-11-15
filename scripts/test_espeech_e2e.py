#!/usr/bin/env python3
"""Check real ESpeech content through the built sidecar and local Parakeet ASR."""
import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
import wave


def word_error_rate(expected, actual):
    def words(text):
        return re.findall(r"\w+", text.replace("+", "").casefold().replace("ё", "е"))
    reference, hypothesis = words(expected), words(actual)
    if not reference:
        raise ValueError("The expected transcript must contain words")
    previous = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        current = [i]
        for j, right in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (left != right)))
        previous = current
    return previous[-1] / len(reference)


class Sidecar:
    def __init__(self, executable, bundle, asr_model, log):
        env = dict(os.environ, SONIQO_ESPEECH_BUNDLE_DIR=str(bundle),
                   SONIQO_PARAKEET_ASR_MODEL_ID=asr_model, SONIQO_MLX_CACHE_MB="256")
        self.stderr = log.open("w")
        self.process = subprocess.Popen([str(executable)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.stderr,
                                        text=True, bufsize=1, env=env)
        self.messages = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                continue
        self.messages.put(None)

    def request(self, command, **fields):
        identifier = "espeech-e2e-" + uuid.uuid4().hex
        self.process.stdin.write(json.dumps({"id": identifier, "command": command, **fields}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=min(30, deadline - time.monotonic()))
            except queue.Empty:
                print(f"Waiting for {command}…", flush=True)
                continue
            if message is None:
                raise RuntimeError(f"Sidecar exited during {command}; inspect its stderr log")
            if message.get("id") != identifier:
                continue
            if not message.get("ok"):
                raise RuntimeError(message.get("error", "Sidecar request failed"))
            return message.get("result")
        raise TimeoutError(f"{command} exceeded five minutes")

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.stderr.close()


def inspect_wav(path):
    with wave.open(str(path)) as audio:
        rate, frames = audio.getframerate(), audio.getnframes()
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or rate != 24000:
            raise AssertionError("ESpeech must return mono 24 kHz PCM16 WAV")
        values = array.array("h", audio.readframes(frames))
    if not 0.5 < frames / rate < 60 or not values or max(map(abs, values)) < 32:
        raise AssertionError("ESpeech returned empty, silent or implausibly long audio")
    return {"durationSec": frames / rate, "sampleRate": rate,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def run(args):
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"seed": 1000, "steps": 24, "maxWer": args.max_wer,
              "bundle": str(args.bundle), "reference": str(args.reference), "cases": []}
    try:
        sidecar = Sidecar(args.sidecar, args.bundle, args.asr_model, args.out / "synthesis.log")
        try:
            sidecar.request("init_model", engine="espeech")
            for name, text in [
                ("plain", "Сегодня мы проверяем качество синтеза речи. Все слова должны быть понятными."),
                ("stress", "Молок+о сто+ит на стол+е. Это кор+откая пров+ерка удар+ений."),
            ]:
                response = sidecar.request("synthesize_espeech", engine="espeech", text=text,
                                           referenceAudioPath=str(args.reference), referenceText=args.transcript,
                                           seed=1000, steps=24, cfgValue=2.0)
                destination = args.out / f"{name}.wav"
                shutil.copyfile(response["audioPath"], destination)
                report["cases"].append({"name": name, "text": text, "audioPath": str(destination),
                                         **inspect_wav(destination)})
        finally:
            sidecar.close()

        # Start ASR in a fresh process so the TTS model has been released.
        sidecar = Sidecar(args.sidecar, args.bundle, args.asr_model, args.out / "transcription.log")
        try:
            control = sidecar.request("transcribe_parakeet", audioPath=str(args.reference), language="russian")
            report["referenceControl"] = {"expected": args.transcript, "transcript": control["text"],
                                           "wer": word_error_rate(args.transcript, control["text"])}
            if report["referenceControl"]["wer"] > args.max_wer:
                raise AssertionError("ASR reference control failed; check the transcript and ASR setup")
            for case in report["cases"]:
                response = sidecar.request("transcribe_parakeet", audioPath=case["audioPath"], language="russian")
                case.update(transcript=response["text"], wer=word_error_rate(case["text"], response["text"]))
                print(f"{case['name']}: WER {case['wer']:.1%}", flush=True)
        finally:
            sidecar.close()
        report["passed"] = all(case["wer"] <= args.max_wer for case in report["cases"])
        return 0 if report["passed"] else 1
    except Exception as error:
        report.update(passed=False, error=str(error))
        print(str(error), flush=True)
        return 2
    finally:
        (args.out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Report: {args.out / 'report.json'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--asr-model", default="aufklarer/Parakeet-TDT-v3-CoreML-INT8-30s")
    parser.add_argument("--max-wer", type=float, default=0.2)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.max_wer <= 1 or not re.search(r"\w", args.transcript):
        parser.error("Use a nonempty transcript and --max-wer between zero and one")
    for name in ["sidecar", "bundle", "reference", "out"]:
        setattr(args, name, getattr(args, name).resolve())
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
