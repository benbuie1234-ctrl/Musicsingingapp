# Music Singing App

A browser-based pitch-training tool. Load a song, sing along, and see in real time
whether you're on pitch — with a score at the end.

## How it works

Two halves, deliberately split:

**Offline (Python, run once per song).** Source-separate the vocal out of a mix with
Demucs, then track the fundamental frequency of that isolated vocal to produce a
*continuous pitch contour* — a frequency reading roughly every 10 ms, plus a
voiced/unvoiced flag. That contour is written out as JSON.

**Online (browser, no server).** The web app loads the audio plus its JSON contour,
captures the mic, runs the same pitch-tracking algorithm live, and draws your pitch
against the target as a scrolling ribbon. Scoring compares the two curves.

### Why a contour and not discrete notes

Quantizing an extracted vocal into note rectangles is where this kind of project
usually falls apart: pitch bends, scoops, vibrato, and stacked harmonies all break
note segmentation, and the resulting map is wrong often enough to be maddening.
Comparing curve-to-curve skips segmentation entirely, and treats expressive pitch
movement as something to match rather than something to fix.

## Layout

```
extract/            offline analysis pipeline (Python)
web/                the browser app (static, no build step required)
web/public/maps/    generated pitch-contour JSON, one per song
```

## Reference audio is not in this repo

`.gitignore` excludes all audio: commercial tracks and any stems separated from them
stay on local disk.

Generated contour JSON is also ignored by default. A pitch contour is effectively a
machine-readable transcription of a copyrighted melody — nearer to sheet music than
to analysis — and this repo is public, so third-party maps stay local too. Maps for
your own songs can be committed with `git add -f`.

## Running locally

Mic access requires a secure origin, so `file://` will not work. Serve the folder:

```bash
cd web && python3 -m http.server 8000
```

Then open <http://localhost:8000>. **Use headphones** — otherwise the mic hears the
backing track and scores the song against itself.
