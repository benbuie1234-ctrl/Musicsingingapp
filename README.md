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
    "../web/public/maps/your-song.json" --title "Title" --artist "Artist" \
    --accompaniment "../separated/htdemucs/your-song/no_vocals.wav"
python3 segment_notes.py "../web/public/maps/your-song.json"
```

Passing `--accompaniment` is optional but strongly recommended — see *Only the singer*
below.

Then put the **full mix** at `web/audio/<id>.m4a` and add an entry to `web/songs.json`
with a matching `id`. Separation takes about 20 seconds for a 3-minute track on Apple
silicon (use `-d cpu` if MPS is unavailable).

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

A note counts as hit if you held it within 0.7 semitones for at least 40% of its
length. That tolerance is exactly the on-screen thickness of the block, so the rule is
simply: if the ball is inside the block, you are in tune.

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
