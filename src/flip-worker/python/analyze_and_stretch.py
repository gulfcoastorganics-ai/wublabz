#!/usr/bin/env python3
import argparse
import json
import sys

import librosa
import numpy as np
import soundfile as sf


MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def detect_key(y, sr):
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    profile = chroma.mean(axis=1)
    best_score = -1e9
    best = "C major"
    for i in range(12):
        maj = np.corrcoef(np.roll(MAJOR, i), profile)[0, 1]
        minor = np.corrcoef(np.roll(MINOR, i), profile)[0, 1]
        if maj > best_score:
            best_score = maj
            best = f"{NOTES[i]} major"
        if minor > best_score:
            best_score = minor
            best = f"{NOTES[i]} minor"
    return best


def detect_bpm(y, sr):
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = np.atleast_1d(tempo)[0]
    return float(tempo)


def stretch_vocals(vocal_path, output_path, sr, detected_bpm):
    y, vocal_sr = librosa.load(vocal_path, sr=sr, mono=False)
    rate = 140.0 / detected_bpm if detected_bpm > 0 else 1.0
    try:
        import pyrubberband as pyrb
        stretched = pyrb.time_stretch(y, vocal_sr, rate)
    except Exception:
        if y.ndim == 1:
            stretched = librosa.effects.time_stretch(y, rate=rate)
        else:
            stretched = np.vstack([librosa.effects.time_stretch(channel, rate=rate) for channel in y])
    sf.write(output_path, stretched.T if stretched.ndim > 1 else stretched, vocal_sr)
    return rate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["analyze", "stretch", "analyze-and-stretch"], default="analyze-and-stretch")
    parser.add_argument("--input", required=True)
    parser.add_argument("--vocals")
    parser.add_argument("--output")
    parser.add_argument("--bpm", type=float)
    args = parser.parse_args()

    if args.mode in ("analyze", "analyze-and-stretch"):
        y, sr = librosa.load(args.input, sr=None, mono=True)
        bpm = detect_bpm(y, sr)
        key = detect_key(y, sr)
    else:
        sr = librosa.get_samplerate(args.input)
        bpm = args.bpm
        key = None

    if args.mode == "analyze":
        print(json.dumps({"key": key, "bpm": round(bpm)}))
        return

    if not args.vocals or not args.output:
        raise ValueError("--vocals and --output are required for stretch mode")
    rate = stretch_vocals(args.vocals, args.output, sr, bpm)
    payload = {"bpm": round(bpm), "stretchRate": rate, "acapellaPath": args.output}
    if key is not None:
        payload["key"] = key
    print(json.dumps(payload))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
