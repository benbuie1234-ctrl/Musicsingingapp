"""Compare pitch tracking on the raw mix vs the separated vocal stem.

The question this answers: does the tracker follow a *voice*, or does it just
lock onto whatever is loudest and most periodic? Run it over a section with no
vocal and a section with one, and see whether it can tell them apart.
"""
import sys
import numpy as np
from audio_io import load_mono
from yin import track

SR = 44100
HOP = 441  # 10 ms


def stats(x, sr, label):
    f0, aper, rms = track(x, sr, HOP)
    voiced = (aper < 0.35) & (rms > 1e-3)
    pct = 100.0 * voiced.mean()
    if voiced.sum() < 8:
        print(f"  {label:<26} voiced {pct:5.1f}%   (too little to characterize)")
        return
    midi = 69 + 12 * np.log2(np.maximum(f0[voiced], 1e-9) / 440.0)
    jump = np.abs(np.diff(midi))
    print(
        f"  {label:<26} voiced {pct:5.1f}%   "
        f"median MIDI {np.median(midi):5.1f}   "
        f"median jump {np.median(jump):4.2f} st   "
        f"in Bb3-Eb5 {100.0 * ((midi >= 58) & (midi <= 75)).mean():4.0f}%"
    )


def main():
    mix_path, voc_path = sys.argv[1], sys.argv[2]
    mix, _ = load_mono(mix_path, SR)
    voc, _ = load_mono(voc_path, SR)

    # (label, start_sec, end_sec)
    windows = [("intro 0-8s (no lead vocal)", 0, 8), ("hook 60-75s", 60, 75)]
    for label, a, b in windows:
        print(f"\n{label}")
        stats(mix[a * SR:b * SR], SR, "raw mix")
        stats(voc[a * SR:b * SR], SR, "separated vocal")


if __name__ == "__main__":
    main()
