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
import argparse
import json
from pathlib import Path

import numpy as np

MIN_NOTE_MS = 100       # a segment shorter than this gets absorbed by a neighbour
MIN_PHRASE_MS = 90      # a whole phrase shorter than this is a blip, not a note
CHANGE_ST = 0.8         # pitch move that starts a new note
CHANGE_FRAMES = 6       # ...sustained this long (60 ms), so vibrato doesn't split
MERGE_GAP_MS = 120      # join notes across a gap this short
MERGE_ST = 0.6          # ...if they're this close in pitch
MIN_DOMINANCE_DB = -14  # below this the vocal stem is leakage, not the singer
PLAUSIBLE = (45.0, 84.0)  # A2-C6: outside this is an octave error, not a voice

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(midi):
    m = int(round(midi))
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def apply_overrides(notes, path):
    """Apply durable, timestamp-addressed human corrections.

    An edit's ``at`` time identifies the generated block that contains it (or
    the nearest block within 500 ms). This survives small segmentation changes
    much better than identifying a note by array index.
    """
    with open(path) as fh:
        doc = json.load(fh)
    if doc.get("version") != 1:
        raise ValueError(f"unsupported override version in {path}")
    if "replace" in doc:
        out = []
        for item in doc["replace"]:
            n = {key: float(item[key]) for key in ("start", "end", "midi")}
            n["start"], n["end"] = round(n["start"], 3), round(n["end"], 3)
            n["midi"] = round(n["midi"], 2)
            n["name"] = note_name(n["midi"])
            out.append(n)
        out.sort(key=lambda n: (n["start"], n["end"]))
        validate_notes(out)
        return out, len(out), 0
    out = [dict(n) for n in notes]
    used = set()
    for edit in doc.get("edits", []):
        at = float(edit["at"])
        candidates = [
            (0 if n["start"] <= at <= n["end"] else min(abs(at - n["start"]), abs(at - n["end"])), i)
            for i, n in enumerate(out) if i not in used
        ]
        distance, i = min(candidates, default=(float("inf"), -1))
        if distance > 0.5:
            raise ValueError(f"override at {at:.3f}s did not match a note within 500 ms")
        used.add(i)
        if edit.get("delete"):
            out[i]["_delete"] = True
            continue
        for key in ("start", "end", "midi"):
            if key in edit:
                out[i][key] = round(float(edit[key]), 3 if key != "midi" else 2)
        out[i]["name"] = note_name(out[i]["midi"])

    out = [n for n in out if not n.pop("_delete", False)]
    for added in doc.get("add", []):
        n = {key: float(added[key]) for key in ("start", "end", "midi")}
        n["start"], n["end"] = round(n["start"], 3), round(n["end"], 3)
        n["midi"] = round(n["midi"], 2)
        n["name"] = note_name(n["midi"])
        out.append(n)
    out.sort(key=lambda n: (n["start"], n["end"]))
    validate_notes(out)
    return out, len(doc.get("edits", [])), len(doc.get("add", []))


def validate_notes(notes):
    for i, n in enumerate(notes):
        if n["start"] < 0 or n["end"] <= n["start"]:
            raise ValueError(f"invalid corrected note at {n['start']:.3f}s")
        if i and n["start"] < notes[i - 1]["end"] - 0.001:
            raise ValueError(f"corrected notes overlap near {n['start']:.3f}s")


def suspicious_notes(notes):
    """Return a compact review queue without pretending heuristics are edits."""
    flagged = []
    for i, n in enumerate(notes):
        reasons = []
        dur = n["end"] - n["start"]
        if dur < 0.115:
            reasons.append(f"very short ({dur * 1000:.0f} ms)")
        if i and n["start"] - notes[i - 1]["end"] < 0.001:
            leap = abs(n["midi"] - notes[i - 1]["midi"])
            if leap > 9:
                reasons.append(f"{leap:.1f} st leap from previous")
        if 0 < i < len(notes) - 1:
            left = abs(n["midi"] - notes[i - 1]["midi"])
            right = abs(n["midi"] - notes[i + 1]["midi"])
            if left > 6 and right > 6 and abs(notes[i - 1]["midi"] - notes[i + 1]["midi"]) < 2:
                reasons.append("isolated pitch spike")
        if reasons:
            flagged.append((i, n, reasons))
    return flagged


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


def split_phrase(pitch, onsets_in_phrase):
    """Boundaries within one phrase, as indices relative to its start.

    Two independent sources. Pitch changes catch a move to a different note;
    syllable onsets catch a repeated note, which pitch cannot see at all --
    "LAY-ING IN MY BED" holds one pitch across four syllables and has to come
    out as four blocks, not one.
    """
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
    bounds.extend(int(o) for o in onsets_in_phrase)
    bounds.append(len(pitch))
    return sorted(set(b for b in bounds if 0 <= b <= len(pitch)))


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("map")
    parser.add_argument("--overrides", help="correction JSON; defaults to <map>.overrides.json when present")
    parser.add_argument("--diagnose", action="store_true", help="print timestamps worth human review")
    args = parser.parse_args()
    path = args.map
    doc = json.load(open(path))
    hop = doc["hopSeconds"]
    midi = doc["midi"]
    arr = np.array([np.nan if x is None else x for x in midi])
    onsets = np.array(doc.get("onsets", []), dtype=int)
    dominance = np.array(doc["dominanceDb"]) if "dominanceDb" in doc else None

    min_frames = int(MIN_NOTE_MS / 1000 / hop)
    min_phrase = int(MIN_PHRASE_MS / 1000 / hop)

    raw = []
    for lo, hi in phrases(midi):
        if hi - lo < min_phrase:
            continue
        pitch = arr[lo:hi]
        local = onsets[(onsets > lo) & (onsets < hi)] - lo
        bounds = split_phrase(pitch, local)
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
            # never merge across a syllable onset: that is a new note being sung,
            # even when it lands on exactly the same pitch as the one before
            spans_onset = bool(((onsets >= prev["b"] - 2) & (onsets <= n["a"] + 2)).any())
            if not spans_onset and gap_ms <= MERGE_GAP_MS and abs(n["pitch"] - prev["pitch"]) <= MERGE_ST:
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
        # Repeated passes: fixing one note improves the context its neighbours
        # are judged against, so a cluster of errors unwinds from the outside in.
        for _ in range(3):
            base = [n["pitch"] for n in merged]
            changed = 0
            for i, n in enumerate(merged):
                lo, hi = max(0, i - 6), min(len(merged), i + 7)
                ref = float(np.median([base[k] for k in range(lo, hi) if k != i]))
                for shift in (12.0, -12.0, 24.0, -24.0):
                    if abs(n["pitch"] - ref) > 7.0 and abs(n["pitch"] + shift - ref) < 4.5:
                        n["pitch"] += shift
                        changed += 1
                        break
            fixed += changed
            if not changed:
                break
        print(f"  note-level octave fixes: {fixed}")

    notes = []
    rejected = []
    dropped_leak = 0
    for n in merged:
        evidence = {
            "pitchSpreadSt": round(float(np.percentile(arr[n["a"]:n["b"]], 90) -
                                                np.percentile(arr[n["a"]:n["b"]], 10)), 2)
        }
        if dominance is not None:
            dom = dominance[n["a"]:max(n["a"] + 1, n["b"])]
            evidence["vocalDominanceDb"] = round(float(np.median(dom)), 1)
            evidence["vocalDominanceP10Db"] = round(float(np.percentile(dom, 10)), 1)
        if not (PLAUSIBLE[0] <= n["pitch"] <= PLAUSIBLE[1]):
            rejected.append({
                "start": round(n["a"] * hop, 3), "end": round(n["b"] * hop, 3),
                "midi": round(n["pitch"], 2), "name": note_name(n["pitch"]),
                "reason": "outside vocal range", "evidence": evidence,
            })
            continue
        if dominance is not None:
            if evidence["vocalDominanceDb"] < MIN_DOMINANCE_DB:
                dropped_leak += 1
                rejected.append({
                    "start": round(n["a"] * hop, 3), "end": round(n["b"] * hop, 3),
                    "midi": round(n["pitch"], 2), "name": note_name(n["pitch"]),
                    "reason": "possible accompaniment leakage", "evidence": evidence,
                })
                continue
        notes.append({
            "start": round(n["a"] * hop, 3),
            "end": round(n["b"] * hop, 3),
            "midi": round(n["pitch"], 2),
            "name": note_name(n["pitch"]),
            "evidence": evidence,
        })

    override_path = Path(args.overrides) if args.overrides else Path(path).with_suffix(".overrides.json")
    if args.overrides and not override_path.exists():
        raise FileNotFoundError(f"override file not found: {override_path}")
    if override_path.exists():
        notes, edited, added = apply_overrides(notes, override_path)
        print(f"  applied overrides: {edited} edits, {added} additions from {override_path}")
    doc["notes"] = notes
    doc["rejectedNotes"] = rejected
    json.dump(doc, open(path, "w"), separators=(",", ":"))

    durs = np.array([n["end"] - n["start"] for n in notes])
    pitches = np.array([n["midi"] for n in notes])
    total = doc["durationSeconds"]
    # how much of the sung material ends up inside a block?
    voiced_s = sum(1 for m in midi if m is not None) * hop
    if dominance is not None:
        print(f"  dropped as leakage (not the singer): {dropped_leak}")
    print(f"{len(raw)} segments -> {len(merged)} merged -> {len(notes)} notes")
    print(f"  duration  median {np.median(durs):.2f}s  p10 {np.percentile(durs,10):.2f}s  p90 {np.percentile(durs,90):.2f}s  max {durs.max():.2f}s")
    print(f"  pitch     {pitches.min():.1f}-{pitches.max():.1f} ({note_name(pitches.min())}-{note_name(pitches.max())})")
    print(f"  coverage  {100*durs.sum()/total:.1f}% of track, {100*durs.sum()/voiced_s:.1f}% of voiced time")
    gaps = np.array([notes[i+1]["start"] - notes[i]["end"] for i in range(len(notes)-1)])
    print(f"  gaps      median {np.median(gaps):.2f}s, {int((gaps<0.001).sum())} of {len(gaps)} are edge-to-edge")
    if args.diagnose:
        flagged = suspicious_notes(notes)
        print(f"  review    {len(flagged)} suspicious notes")
        for i, n, reasons in flagged:
            print(f"    #{i:03d} {n['start']:7.3f}-{n['end']:7.3f}s {n['name']:>3}  {'; '.join(reasons)}")


if __name__ == "__main__":
    main()
