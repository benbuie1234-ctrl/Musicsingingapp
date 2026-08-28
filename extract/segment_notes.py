"""Segment a pitch contour into the note blocks the display scrolls past.

Two properties matter more than anything else here, because they are what a
singer actually feels:

  * Notes TILE each sung phrase. Within a phrase the blocks meet edge to edge,
    so a block ends exactly where the singer moves to the next note. An earlier
    version dropped segments that came out too short, which punched holes in the
    middle of phrases -- the singer is plainly still singing, but nothing is
    being asked of them.
  * Short segments are ABSORBED, never dropped. A fragment merges into whichever
    neighbour is closer in pitch, so the phrase stays covered.

Gaps between blocks therefore mean one thing only: nobody is singing.

Usage:
    python3 segment_notes.py <contour.json>   # rewrites the file with notes[]
"""
import json
import sys

import numpy as np

MIN_NOTE_MS = 130       # a segment shorter than this gets absorbed by a neighbour
MIN_PHRASE_MS = 90      # a whole phrase shorter than this is a blip, not a note
CHANGE_ST = 0.8         # pitch move that starts a new note
CHANGE_FRAMES = 6       # ...sustained this long (60 ms), so vibrato doesn't split
MERGE_GAP_MS = 120      # join notes across a gap this short
MERGE_ST = 0.6          # ...if they're this close in pitch
PLAUSIBLE = (45.0, 84.0)  # A2-C6: outside this is an octave error, not a voice

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(midi):
    m = int(round(midi))
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def phrases(midi):
    """Contiguous stretches where the singer is producing pitch."""
    out, start = [], None
    for i, v in enumerate(midi):
        if v is not None and start is None:
            start = i
        elif v is None and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(midi)))
    return out


def split_phrase(pitch):
    """Boundaries within one phrase, as indices relative to its start."""
    bounds = [0]
    seg_start = 0
    held = 0
    for i in range(1, len(pitch)):
        anchor = float(np.median(pitch[seg_start:i]))
        if abs(pitch[i] - anchor) > CHANGE_ST:
            held += 1
            if held >= CHANGE_FRAMES:
                seg_start = i - held + 1
                bounds.append(seg_start)
                held = 0
        else:
            held = 0
    bounds.append(len(pitch))
    return bounds


def absorb_short(segs, pitch, min_frames):
    """Merge sub-minimum segments into their nearest-in-pitch neighbour."""
    while len(segs) > 1:
        lengths = [b - a for a, b in segs]
        k = int(np.argmin(lengths))
        if lengths[k] >= min_frames:
            break
        med = lambda s: float(np.median(pitch[s[0]:s[1]]))
        here = med(segs[k])
        if k == 0:
            target = k + 1
        elif k == len(segs) - 1:
            target = k - 1
        else:
            target = k - 1 if abs(med(segs[k - 1]) - here) <= abs(med(segs[k + 1]) - here) else k + 1
        lo = min(segs[k][0], segs[target][0])
        hi = max(segs[k][1], segs[target][1])
        segs[min(k, target)] = (lo, hi)
        del segs[max(k, target)]
    return segs


def main():
    path = sys.argv[1]
    doc = json.load(open(path))
    hop = doc["hopSeconds"]
    midi = doc["midi"]
    arr = np.array([np.nan if x is None else x for x in midi])

    min_frames = int(MIN_NOTE_MS / 1000 / hop)
    min_phrase = int(MIN_PHRASE_MS / 1000 / hop)

    raw = []
    for lo, hi in phrases(midi):
        if hi - lo < min_phrase:
            continue
        pitch = arr[lo:hi]
        bounds = split_phrase(pitch)
        segs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
        segs = absorb_short(segs, pitch, min_frames)
        for a, b in segs:
            raw.append({"a": lo + a, "b": lo + b, "pitch": float(np.median(arr[lo + a:lo + b]))})

    # join notes split by a brief dropout, covering the gap so the block is whole
    merged = []
    for n in raw:
        if merged:
            prev = merged[-1]
            gap_ms = (n["a"] - prev["b"]) * hop * 1000.0
            if gap_ms <= MERGE_GAP_MS and abs(n["pitch"] - prev["pitch"]) <= MERGE_ST:
                prev["b"] = n["b"]
                prev["pitch"] = float(np.nanmedian(arr[prev["a"]:prev["b"]]))
                continue
        merged.append(dict(n))

    # Octave coherence across notes. Frame-level repair works from +/-150 ms of
    # context and cannot fix a stretch that is wrong as a whole; a melody line
    # judged against its neighbouring NOTES can. Pitch class is what gets sung,
    # so a note sitting an octave off its neighbours is an artefact, not a leap.
    if len(merged) > 4:
        fixed = 0
        base = [n["pitch"] for n in merged]
        for i, n in enumerate(merged):
            lo, hi = max(0, i - 4), min(len(merged), i + 5)
            ref = float(np.median([base[k] for k in range(lo, hi) if k != i]))
            for shift in (12.0, -12.0, 24.0, -24.0):
                if abs(n["pitch"] - ref) > 7.0 and abs(n["pitch"] + shift - ref) < 4.0:
                    n["pitch"] += shift
                    fixed += 1
                    break
        print(f"  note-level octave fixes: {fixed}")

    notes = []
    for n in merged:
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
    total = doc["durationSeconds"]
    # how much of the sung material ends up inside a block?
    voiced_s = sum(1 for m in midi if m is not None) * hop
    print(f"{len(raw)} segments -> {len(merged)} merged -> {len(notes)} notes")
    print(f"  duration  median {np.median(durs):.2f}s  p10 {np.percentile(durs,10):.2f}s  p90 {np.percentile(durs,90):.2f}s  max {durs.max():.2f}s")
    print(f"  pitch     {pitches.min():.1f}-{pitches.max():.1f} ({note_name(pitches.min())}-{note_name(pitches.max())})")
    print(f"  coverage  {100*durs.sum()/total:.1f}% of track, {100*durs.sum()/voiced_s:.1f}% of voiced time")
    gaps = np.array([notes[i+1]["start"] - notes[i]["end"] for i in range(len(notes)-1)])
    print(f"  gaps      median {np.median(gaps):.2f}s, {int((gaps<0.001).sum())} of {len(gaps)} are edge-to-edge")


if __name__ == "__main__":
    main()
