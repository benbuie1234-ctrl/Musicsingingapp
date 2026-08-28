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

## Preparing a song

Three steps, all offline and one-time per track:

```bash
python3 -m demucs --two-stems=vocals -d mps -o separated "your-song.m4a"
cd extract
python3 extract_contour.py "../separated/htdemucs/your-song/vocals.wav" \
    "../web/public/maps/your-song.json" --title "Title" --artist "Artist"
python3 segment_notes.py "../web/public/maps/your-song.json"
```

Then add an entry to `web/songs.json` with a matching `id`. Separation takes about
20 seconds for a 3-minute track on Apple silicon (use `-d cpu` if MPS is unavailable).

## Running locally

Mic access requires a secure origin, so `file://` will not work.

```bash
python3 serve.py
```

Then open <http://localhost:8000>, pick the audio file once — it is cached in the
browser, since audio is not in the repo — and sing. **Use headphones**, otherwise the
mic hears the backing track and scores the song against itself.

## How scoring works

A note counts as hit if you held it within 0.7 semitones for at least half its length.
That tolerance is exactly the on-screen thickness of the block, so the rule is simply:
if the ball is inside the block, you are in tune.

Notes that pass without ever being observed — a hidden tab, a seek, a frame-rate
collapse — are excluded from the score rather than counted as misses.

Two controls matter and are easy to overlook:

- **Latency** — mic capture and playback each add delay, so your pitch reads late. The
  slider is seeded from what the browser reports about itself, then saved.
- **Transpose** / **Ignore octave** — this song's hook sits high. Shift the target into
  your range rather than being told you are wrong while singing it correctly.
