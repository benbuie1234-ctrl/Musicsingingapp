"""Segment a pitch contour into discrete note blocks for the scrolling display.

Segmentation is the step that usually wrecks these pipelines, but doing it on a
cleaned contour rather than on audio makes it tractable: the input is already
monophonic, already voiced-gated, and already octave-repaired. The contour stays
in the file alongside the notes -- the blocks drive the visuals and the scoring
target, while the contour drives the smooth ball position.

Usage:
    python3 segment_notes.py <contour.json>   # rewrites the file with notes[]
"""
import json
import sys

import numpy as np

MIN_NOTE_MS = 120       # shorter than this is a transient, not a sung note
CHANGE_ST = 0.75        # pitch move that starts a new note
CHANGE_FRAMES = 5       # ...sustained this long (50 ms), to ignore vibrato
MERGE_GAP_MS = 80       # join notes separated by less than this
MERGE_ST = 0.5          # ...if they're this close in pitch
PLAUSIBLE = (45.0, 84.0)  # A2-C6: outside this is an octave error, not a voice

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(midi):
    m = int(round(midi))
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def voiced_runs(midi):
    runs, start = [], None
    for i, v in enumerate(midi):
        if v is not None and start is None:
            start = i
        elif v is None and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(midi)))
    return runs


def split_run(pitch, lo):
    """Break one voiced run wherever the pitch settles somewhere new."""
    bounds = [0]
    anchor = pitch[0]
    held = 0
    for i in range(1, len(pitch)):
        if abs(pitch[i] - anchor) > CHANGE_ST:
            held += 1
            if held >= CHANGE_FRAMES:
                # the note began when the pitch first left the old anchor
                bounds.append(max(bounds[-1] + 1, i - held + 1))
                anchor = float(np.median(pitch[i - held + 1:i + 1]))
                held = 0
        else:
            held = 0
            # let the anchor drift with slow, in-note movement
            anchor = 0.9 * anchor + 0.1 * pitch[i]
    bounds.append(len(pitch))
    return [(lo + bounds[k], lo + bounds[k + 1]) for k in range(len(bounds) - 1)]


def main():
    path = sys.argv[1]
    doc = json.load(open(path))
    hop = doc["hopSeconds"]
    midi = doc["midi"]
    arr = np.array([np.nan if x is None else x for x in midi])

    raw = []
    for lo, hi in voiced_runs(midi):
        seg = arr[lo:hi]
        if len(seg) < 2:
            continue
        for a, b in split_run(seg, lo):
            if b - a <= 0:
                continue
            raw.append({"a": a, "b": b, "pitch": float(np.median(arr[a:b]))})

    # merge neighbours that are really one note broken by a brief dropout
    merged = []
    for n in raw:
        if merged:
            prev = merged[-1]
            gap_ms = (n["a"] - prev["b"]) * hop * 1000.0
            if gap_ms <= MERGE_GAP_MS and abs(n["pitch"] - prev["pitch"]) <= MERGE_ST:
                prev["b"] = n["b"]
                span = arr[prev["a"]:prev["b"]]
                prev["pitch"] = float(np.nanmedian(span))
                continue
        merged.append(dict(n))

    notes = []
    for n in merged:
        dur_ms = (n["b"] - n["a"]) * hop * 1000.0
        if dur_ms < MIN_NOTE_MS:
            continue
        if not (PLAUSIBLE[0] <= n["pitch"] <= PLAUSIBLE[1]):
            continue
        notes.append({
            "start": round(n["a"] * hop, 3),
            "end": round(n["b"] * hop, 3),
            "midi": round(n["pitch"], 2),
            "name": note_name(n["pitch"]),
        })

    doc["notes"] = notes
    json.dump(doc, open(path, "w"), separators=(",", ":"))

    durs = np.array([n["end"] - n["start"] for n in notes])
    pitches = np.array([n["midi"] for n in notes])
    print(f"{len(raw)} raw -> {len(merged)} merged -> {len(notes)} notes kept")
    print(f"  duration  median {np.median(durs):.2f}s  p90 {np.percentile(durs,90):.2f}s  max {durs.max():.2f}s")
    print(f"  pitch     {pitches.min():.1f}-{pitches.max():.1f} MIDI ({note_name(pitches.min())}-{note_name(pitches.max())})")
    print(f"  coverage  {100*durs.sum()/doc['durationSeconds']:.1f}% of track")
    off = pitches - np.round(pitches)
    print(f"  median offset from equal temperament: {100*np.median(off):+.1f} cents")
    print("\n  first 12 notes:")
    for n in notes[:12]:
        print(f"    {n['start']:6.2f}-{n['end']:6.2f}s  {n['name']:>4}  ({n['midi']:.2f})")


if __name__ == "__main__":
    main()
