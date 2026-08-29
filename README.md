# Music Singing App

A browser-based pitch-training tool. Load a song, sing along, and see in real time
whether you're on pitch — with a score at the end.

## How it works

Two halves, deliberately split:

**Offline (Python, run once per song).** Source-separate the vocal out of a mix with
Demucs, track the fundamental frequency of that isolated vocal to produce a
continuous pitch contour, then segment the contour and syllable onsets into note
blocks. The contour and blocks are written to one local JSON file.

**Online (browser, no app server).** The web app loads the full mix plus its JSON map,
captures the mic, runs the same pitch-tracking algorithm live, and draws your pitch
against scrolling note blocks. Scoring measures how much of each block was held.

### Why retain the contour as well as note blocks

Pitch bends, scoops, vibrato, repeated syllables, and stacked harmonies make note
segmentation the fragile part of this kind of project. The original continuous
contour stays in the map for diagnosis and regeneration; the game uses corrected,
phrase-tiling note blocks so the target is readable while singing.

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

For an automatically cross-checked local chart, use the end-to-end command:

```bash
python3 extract/prepare_song.py "your-song.wav" --id your-song \
    --title "Title" --artist "Artist"
```

It runs both standard Demucs and the four-model fine-tuned ensemble, extracts the chart
from the standard stem, cross-checks it against the independent ensemble, converts the
browser mix, and updates the local-only catalog. Matching alternate evidence can
automatically recover quiet notes that the first separation rejected. Disagreement is
kept only as diagnostic evidence: automatically deleting every disagreement would
remove real breathy notes too.

The individual pipeline consists of these steps:

```bash
python3 -m demucs --two-stems=vocals -d mps -o separated "your-song.m4a"
cd extract
python3 extract_contour.py "../separated/htdemucs/your-song/vocals.wav" \
    "../web/public/maps/your-song.json" --title "Title" --artist "Artist" \
    --accompaniment "../separated/htdemucs/your-song/no_vocals.wav"
python3 segment_notes.py "../web/public/maps/your-song.json"
```

Passing `--accompaniment` is optional but strongly recommended — see *Only the singer*
below.

Then put the **full mix** at `web/audio/<id>.m4a` and add an entry to `web/songs.json`
with a matching `id`. Separation takes about 20 seconds for a 3-minute track on Apple
silicon (use `-d cpu` if MPS is unavailable).

For commercial songs that must remain local, add the entry to
`web/songs.local.json` instead. That gitignored catalog takes precedence on localhost;
the public deployment falls back to `web/songs.json`.

The generated result is immediately playable. Separator agreement and vocal dominance
are resolved by the pipeline itself; there is no separate browser chart-review step.

The two halves come from different audio on purpose: you hear the full commercial mix,
while the notes you are asked to hit come from the separated vocal alone.

## Running locally

Mic access requires a secure origin, so `file://` will not work.

```bash
python3 serve.py
```

Then open <http://localhost:8000> and press Sing. **Use headphones**, otherwise the mic
hears the backing track and scores the song against itself.

### On a phone

`localhost` is a secure origin; your phone reaching this machine by LAN IP is not, and
the browser will refuse the microphone without even prompting. So serve over TLS:

```bash
python3 serve.py --https
```

That generates a self-signed certificate and prints the address to open on the phone.
Accept the certificate warning once and the mic works. Wired headphones are worth it —
Bluetooth adds 100-300 ms that the browser under-reports.

After microphone permission is granted, the app checks the active track's device label
and reported capture latency. Recognized wireless headsets (including AirPods, Beats,
Buds, Bose and Jabra devices) get conservative fallback input and output compensation
when the browser reports less. This is necessarily a heuristic: the web platform does
not expose the Bluetooth transport or a measured round-trip latency. `?debug` exposes
the result as `window.__sing.audioProfile`.

## Layout

Built mobile first. The display is laid out in **time and semitones**, not pixels: the
scroll speed follows the viewport width so roughly 3.2 seconds of upcoming melody stays
on screen at any size, and the visible pitch range narrows on short screens so blocks
keep a height you can actually aim at. A phone sees the same stretch of music as a
desktop rather than a cropped slice of it.

Measured across sizes — seconds visible ahead / semitones shown / block height:

| | ahead | semitones | block |
|---|---|---|---|
| iPhone SE portrait (320x568) | 3.2 s | 17 | 30 px |
| iPhone portrait (375x812) | 3.2 s | 17 | 46 px |
| iPhone landscape (812x375) | 3.2 s | 15.7 | 22 px |
| laptop (1280x760) | 3.9 s | 17 | 43 px |

The single CSS media query at 700 px only adds back what there is room for — the artist
name, the best score, side-by-side cards. It is the same design with more space.

Append `?debug` to the URL to expose `window.__sing` with the song clock, the audio
context and the live scoring state.

Blocks are drawn 150 ms later than the literal vocal timestamp, matching the scoring
grace zone so a singer reacting at the line does not see the target already behind
them. Playback, map timestamps and scoring remain exact. For timing experiments,
`?debug&debugOffset=0` overrides that visual guidance delay. The value is clamped to
±500 ms and is intentionally not a user-facing latency control.

## Audio is not in this repo

`.gitignore` excludes `web/audio/` along with every other audio path, and the generated
contour JSON too. A contour is a machine-readable transcription of a copyrighted
melody, nearer to sheet music than to analysis, and this repo is public.

This means a Cloudflare Pages deploy gets the app but not the song. Fine for tracks you
own the rights to; for anything else the app is a local tool.

## Sync

The target notes have to line up with what you hear, so each link in the chain was
measured rather than assumed:

- **Decode alignment.** The track's container declares a 2112-sample start offset — the
  standard AAC encoder delay. If ffmpeg and the browser disagreed about trimming it,
  every block would sit ~48 ms out. Cross-correlating the two decodes' energy envelopes
  puts the peak at lag 0 with r = 0.996.
- **Playback clock.** Position comes from the Web Audio clock, not an `<audio>`
  element's `currentTime`, which only updates near frame rate and drifts. Measured
  drift is about 1 ms over 3 seconds.
- **Output latency** is subtracted, so the display follows what reaches your ears
  rather than what was submitted to the sound card.
- **Capture latency** is subtracted separately when scoring, since the mic reading in
  hand is always slightly older than the moment being drawn.

## How scoring works

**Pitch class, not register.** The sung pitch is folded to whichever octave sits
nearest the target before it is compared, so a voice that cannot reach the record's
register still scores the line correctly. This is not a free pass: folding accepts
octaves and nothing else — a fifth off still fails.

A note counts as hit if you held it within **0.5 semitones** for at least **50%** of
its length. Half a semitone is the midpoint to the neighbouring note: a singer gets
normal room for attacks and vibrato, but the adjacent note never counts. The rule is
still visible rather than mysterious: if the centre of the ball is inside the block,
you are in tune.

The game also tracks a tighter **perfect** zone within 0.2 semitones (20 cents). It is
used for bonus points and feedback, never as the minimum needed to pass a note. A hit
earns 100 points, centred notes add 50, and a sustained streak adds up to 100 more per
note. The final accuracy remains the plain percentage of notes hit.

**Timing has 150 ms of slack either side.** A singer reacting to a block arriving is
always slightly behind it, and that lag is not a pitch error. Only the note's own span
counts towards the denominator, so the ratio is clamped rather than inflated. Measured
against a simulated singer, a lag anywhere from 0 to 180 ms costs nothing; being a beat
late still does.

Notes that pass without ever being observed — a hidden tab, a frame-rate collapse — are
excluded from the score rather than counted as misses.

## Note blocks

Blocks tile each sung phrase: within a phrase they meet edge to edge, so a block ends
exactly where the singer moves to the next note. Segments that come out too short are
absorbed into whichever neighbour is closer in pitch, never dropped — dropping them
punched holes mid-phrase, where the singer is plainly still singing but nothing was
being asked of them.

**One block per note sung, including repeats.** Pitch alone cannot find the boundary
when a singer repeats the same note across syllables: "LAY-ING IN MY BED" is one flat
line to a pitch tracker and would come out as a single long block. Each syllable does
restart the vocal's energy, so `onsets.py` finds those boundaries with spectral flux,
and they are used alongside pitch changes to split notes — and to block the merge step
from gluing repeated notes back together.

A gap between blocks therefore means one thing: nobody is singing.

### Diagnosing a map

Automatic segmentation produces a reviewable first pass, not an excuse to tune one
global threshold around every unusual lyric. Ask the segmenter for a compact timestamp
queue of short notes, large leaps and isolated spikes:

```bash
python3 extract/segment_notes.py web/public/maps/too-much.json --diagnose
```

If a specific timestamp is reported later, a compact correction file can live beside
the map and is reapplied automatically every time the map is segmented:

```json
{
  "version": 1,
  "edits": [
    {"at": 22.12, "midi": 55.1},
    {"at": 32.15, "start": 32.18, "end": 32.38},
    {"at": 90.42, "delete": true}
  ],
  "add": [
    {"start": 91.0, "end": 91.2, "midi": 63.0}
  ]
}
```

`at` identifies the generated block containing that timestamp, so corrections remain
stable when earlier segmentation changes move array indices. Corrected blocks are
validated for positive duration and overlaps before the map is written.

## Only the singer

Separation leaves residue, and residue is what puts note blocks on top of instruments.
The fix uses the other half of what Demucs already produced: comparing the vocal stem
against `no_vocals.wav` frame by frame gives a per-note measure of how far the voice
stands above the backing. A lead vocal is mixed loud and sits near or above the
accompaniment; leakage sits far below it. Notes whose median falls under -14 dB are
discarded.

On this track that removes 74 notes, and clears the instrumental stretches outright.
The threshold is deliberately not tighter: tightening to -8 dB would drop another 86
notes that are genuinely sung.
