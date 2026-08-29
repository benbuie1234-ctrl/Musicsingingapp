"""Score a note map without needing a hand-made ground truth.

Every previous change to this pipeline was judged by eye or by circular
measures -- "covers 91% of voiced time" is satisfying only because the same
tracker defined which frames were voiced. These three numbers are independent
of the pitch tracker, so they can actually adjudicate a change:

  recall     of the time the singer is clearly audible, how much is charted.
             Low recall is the "you're missing notes" complaint.
  precision  of the time we put a block on screen, how much is real singing.
             Low precision is the "these notes aren't the singer" complaint.
  in-key     how often note pitches land in the song's key. A tracker following
             the voice lands in key; one following noise does not.

Audibility comes from comparing the vocal stem against the accompaniment, which
is why extract_contour.py should be run with --accompaniment.

Usage:
    python3 evaluate_map.py ../web/public/maps/song.json [--key Db]
"""
import argparse
import json

import numpy as np

# semitone classes of a major scale, rooted at C
MAJOR = [0, 2, 4, 5, 7, 9, 11]
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ALIASES = {"Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10}

AUDIBLE_DOM_DB = -8.0    # vocal this far above the backing = clearly the singer
AUDIBLE_LEVEL_DB = -22.0


def key_classes(key):
    root = ALIASES.get(key, NAMES.index(key) if key in NAMES else None)
    if root is None:
        raise SystemExit(f"unknown key {key!r}")
    return {(root + s) % 12 for s in MAJOR}


def best_key(pitches):
    """The major key the notes fit best -- a stand-in when none is given."""
    pc = np.round(pitches).astype(int) % 12
    hist = np.bincount(pc, minlength=12) / len(pc)
    scores = [(sum(hist[(r + s) % 12] for s in MAJOR), r) for r in range(12)]
    score, root = max(scores)
    return NAMES[root], score * 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("map")
    ap.add_argument("--key", default=None, help="e.g. Db; inferred when omitted")
    args = ap.parse_args()

    doc = json.load(open(args.map))
    notes, hop = doc["notes"], doc["hopSeconds"]
    frames = doc["frameCount"]
    pitches = np.array([n["midi"] for n in notes])

    if "dominanceDb" not in doc:
        raise SystemExit("map has no dominanceDb -- re-run extract_contour.py with --accompaniment")
    dom = np.array(doc["dominanceDb"])
    lvl = np.array(doc["levelDb"])
    audible = (dom > AUDIBLE_DOM_DB) & (lvl > AUDIBLE_LEVEL_DB)

    charted = np.zeros(frames, bool)
    for n in notes:
        a = int(n["start"] / hop)
        charted[a:max(a + 1, int(n["end"] / hop))] = True

    both = (charted & audible).sum()
    recall = 100 * both / max(1, audible.sum())
    precision = 100 * both / max(1, charted.sum())

    if args.key:
        key, classes = args.key, key_classes(args.key)
        in_key = 100 * np.mean([(round(p) % 12) in classes for p in pitches])
    else:
        key, in_key = best_key(pitches)

    print(f"{args.map}")
    print(f"  notes        {len(notes)}")
    print(f"  audible      {100 * audible.mean():.1f}% of the track")
    print(f"  recall       {recall:.1f}%   (of audible singing, how much is charted)")
    print(f"  precision    {precision:.1f}%   (of charted time, how much is singing)")
    print(f"  in-key       {in_key:.1f}%   (key of {key})")
    durs = np.array([n["end"] - n["start"] for n in notes])
    print(f"  durations    median {np.median(durs):.2f}s  p90 {np.percentile(durs, 90):.2f}s")


if __name__ == "__main__":
    main()
