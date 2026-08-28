"""Turn an isolated vocal stem into a pitch contour the browser app can score against.

Output is a continuous curve, not a list of notes. Note segmentation is where
this kind of pipeline usually breaks: scoops, bends, vibrato and stacked
harmonies all defeat it, and the resulting map is wrong often enough to make a
practice tool feel broken. A curve has no segmentation step to get wrong, and it
treats expressive pitch movement as something to match rather than an error.

Usage:
    python3 extract_contour.py <vocal-stem.wav> <out.json> [--title T] [--artist A]
"""
import argparse
import json
import sys

import numpy as np

from audio_io import load_mono
from yin import track

SR = 44100
HOP = 441                 # 10 ms
APERIODICITY_MAX = 0.45   # above this, YIN isn't confident it found a period
LEVEL_FLOOR_DB = -26.0    # relative to the stem's 95th-percentile level
MIN_RUN_MS = 60           # drop voiced islands shorter than this
MAX_GAP_MS = 120          # bridge unvoiced gaps shorter than this


def _bridge_and_prune(voiced, hop_ms, max_gap_ms, min_run_ms):
    """Close pinhole gaps, then drop runs too short to be a sung note."""
    v = voiced.copy()
    max_gap = int(max_gap_ms / hop_ms)
    min_run = int(min_run_ms / hop_ms)

    def runs(mask, value):
        out, start = [], None
        for i, m in enumerate(mask):
            if m == value and start is None:
                start = i
            elif m != value and start is not None:
                out.append((start, i))
                start = None
        if start is not None:
            out.append((start, len(mask)))
        return out

    for a, b in runs(v, False):
        if a > 0 and b < len(v) and (b - a) <= max_gap:
            v[a:b] = True
    for a, b in runs(v, True):
        if (b - a) < min_run:
            v[a:b] = False
    return v


def _repair_octaves(midi, voiced):
    """YIN occasionally halves or doubles the period. Pull outliers back."""
    out = midi.copy()
    idx = np.nonzero(voiced)[0]
    if len(idx) < 9:
        return out
    win = 15  # +/- 150 ms of context
    fixed = 0
    source = midi  # context comes from the unmodified input, not partial output
    for pos, i in enumerate(idx):
        lo, hi = max(0, pos - win), min(len(idx), pos + win + 1)
        ref = np.median(source[idx[lo:hi]])
        for shift in (12.0, -12.0, 24.0, -24.0):
            if abs(out[i] - ref) > 7.0 and abs(out[i] + shift - ref) < 3.0:
                out[i] += shift
                fixed += 1
                break
    if fixed:
        print(f"  octave repairs: {fixed}")
    return out


def _median_filter(x, voiced, k=7):
    """Light smoothing that never averages across a voiced/unvoiced boundary."""
    out = x.copy()
    half = k // 2
    for i in np.nonzero(voiced)[0]:
        lo, hi = max(0, i - half), min(len(x), i + half + 1)
        seg = x[lo:hi][voiced[lo:hi]]
        if len(seg):
            out[i] = np.median(seg)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stem")
    ap.add_argument("out")
    ap.add_argument("--title", default="")
    ap.add_argument("--artist", default="")
    args = ap.parse_args()

    print(f"loading {args.stem}")
    x, sr = load_mono(args.stem, SR)
    print(f"  {len(x)/sr:.1f}s")

    print("tracking pitch (YIN)")
    f0, aper, rms = track(x, sr, HOP)

    db = 20.0 * np.log10(rms + 1e-12)
    reference = np.percentile(db, 95)
    rel = db - reference

    voiced = (aper < APERIODICITY_MAX) & (rel > LEVEL_FLOOR_DB) & (f0 > 0)
    raw_pct = 100.0 * voiced.mean()
    voiced = _bridge_and_prune(voiced, HOP / SR * 1000.0, MAX_GAP_MS, MIN_RUN_MS)

    midi = np.zeros_like(f0)
    has_pitch = voiced & (f0 > 0)
    midi[has_pitch] = 69.0 + 12.0 * np.log2(f0[has_pitch] / 440.0)
    # Frames voiced only because a pinhole gap was bridged have no f0 of their
    # own; interpolate them from the pitched frames on either side.
    bridged = voiced & ~has_pitch
    if bridged.any():
        src_idx = np.nonzero(has_pitch)[0]
        if len(src_idx):
            midi[bridged] = np.interp(
                np.nonzero(bridged)[0], src_idx, midi[src_idx]
            )
        else:
            voiced = has_pitch
        print(f"  bridged frames interpolated: {int(bridged.sum())}")
    midi = _repair_octaves(midi, voiced)
    midi = _median_filter(midi, voiced)

    sung = midi[voiced]
    print(f"  voiced {raw_pct:.1f}% -> {100.0*voiced.mean():.1f}% after cleanup")
    if len(sung):
        lo, hi = np.percentile(sung, [2, 98])
        print(f"  range p2-p98: MIDI {lo:.1f}-{hi:.1f}  median {np.median(sung):.1f}")
        print(f"  median frame-to-frame move: {np.median(np.abs(np.diff(sung))):.3f} st")

    payload = {
        "version": 1,
        "title": args.title,
        "artist": args.artist,
        "hopSeconds": HOP / SR,
        "frameCount": int(len(midi)),
        "durationSeconds": round(len(x) / sr, 3),
        # null marks unvoiced: no lead vocal to match at that instant
        "midi": [round(float(m), 2) if v else None for m, v in zip(midi, voiced)],
        "levelDb": [round(float(r), 1) for r in rel],
    }
    with open(args.out, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
