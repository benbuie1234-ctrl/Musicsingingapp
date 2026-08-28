// The scrolling pitch display: note blocks travel right-to-left past a fixed
// "now" line, and a ball rides at the height of whatever you are singing.
import { midiToName } from "./yin.js";

const TOL = 0.7;          // semitones; also the half-height of a note block
const HIT_RATIO = 0.4;    // fraction of a note you must hold to count it
const MISS_RATIO = 0.2;   // below this the block goes red
const GRACE = 0.15;       // seconds of timing slack on either side of a note
const TRAIL_SEC = 0.4;
const FOLLOW = 0.035;     // how fast the pitch axis chases the melody
const LOOKAHEAD = 3.0;    // seconds of upcoming melody the axis aims to fit

// The display is laid out in TIME and SEMITONES, not pixels, so a phone shows
// the same stretch of music as a desktop rather than a cropped slice of it.
// Scroll speed and the visible pitch range are derived from the viewport to
// keep these two constant; only then are they clamped to stay readable.
const SEE_AHEAD_SEC = 3.2;   // how much of the coming melody stays on screen
const MIN_SEMITONE_PX = 16;  // below this a block is too thin to aim at
const MAX_WINDOW_ST = 17;    // semitones visible at once, at most

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Game {
  constructor(canvas, song, audio, mic) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = song;
    this.audio = audio;
    this.mic = mic;

    // How far behind real time the mic reading is. Set from the audio stack's
    // own reported latency -- there is no slider, because there is nothing here
    // a listener could tune by ear better than the browser can report.
    this.micDelay = 0;

    this.notes = song.notes.map((n) => ({
      ...n, hit: 0, passed: 0, done: false, scored: false,
    }));
    this.contour = song.midi;
    this.hop = song.hopSeconds;

    this.trail = [];
    this.smooth = null;
    this.center = null;   // centre of the visible pitch window, in MIDI
    this.hits = 0;
    this.judged = 0;
    this.stars = null;
    this.running = false;
    this.onScore = () => {};

    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();
  }

  // Everything size-dependent, derived once per resize.
  _layout() {
    const { w, h } = this;
    const small = Math.min(w, h);
    this.ui = clamp(small / 420, 0.78, 1.3);      // one scale factor for chrome

    this.nowX = clamp(w * 0.2, 52, 260);
    // hold the seconds-on-screen constant, then clamp so it stays sane
    this.pps = clamp((w - this.nowX) / SEE_AHEAD_SEC, 78, 260);

    this.padTop = clamp(h * 0.13, 52, 100);
    this.padBottom = clamp(h * 0.19, 72, 150);
    const usable = Math.max(40, h - this.padTop - this.padBottom);
    // fewer semitones on a short screen, so blocks keep a touchable height
    this.windowSt = clamp(usable / MIN_SEMITONE_PX, 8, MAX_WINDOW_ST);

    this.margin = clamp(w * 0.035, 10, 26);
    this.mapH = clamp(h * 0.032, 14, 26);
    this.fontPx = Math.round(clamp(11 * this.ui, 9, 14));
    this.ballR = clamp(6.5 * this.ui, 5, 9);
  }

  destroy() {
    this.running = false;
    window.removeEventListener("resize", this._resize);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || this.w || 0;
    const h = this.canvas.clientHeight || this.h || 0;
    if (w <= 0 || h <= 0) { this.w = 0; this.h = 0; return; }
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this._layout();

    const pitches = this.notes.map((n) => n.midi);
    this.mapLo = Math.min(...pitches);
    this.mapHi = Math.max(...pitches);

    // a fixed starfield, so the background doesn't shimmer between frames
    const rng = mulberry(20240828);
    this.stars = Array.from({ length: 90 }, () => ({
      x: rng() * w, y: rng() * h, r: 0.6 + rng() * 1.5, a: 0.05 + rng() * 0.22,
    }));
  }

  start() {
    this.running = true;
    requestAnimationFrame(this._frame);
  }

  // The song spans over three octaves between the rap verses and the hook.
  // Fitting all of it on screen at once makes every block unreadably thin, so
  // the axis glides to follow whatever is coming up, the way Yousician does.
  _updateWindow(now) {
    let sum = 0, n = 0;
    for (const note of this.notes) {
      if (note.end > now - 1 && note.start < now + LOOKAHEAD) {
        sum += note.midi;
        n++;
      }
    }
    const target = n ? sum / n : (this.center ?? (this.mapLo + this.mapHi) / 2);
    this.center = this.center == null ? target : this.center + FOLLOW * (target - this.center);
    this.lo = this.center - this.windowSt / 2;
    this.hi = this.center + this.windowSt / 2;
  }

  y(midi) {
    const span = this.hi - this.lo;
    const usable = this.h - this.padTop - this.padBottom;
    return this.padTop + (1 - (midi - this.lo) / span) * usable;
  }

  // What matters is the note, not the octave. A voice that cannot reach the
  // register of the record can still sing the line correctly, so the sung pitch
  // is folded to whichever octave sits nearest the target before comparing.
  static fold(sung, reference) {
    return sung - 12 * Math.round((sung - reference) / 12);
  }

  // The target the ball should be measured against right now: the note being
  // sung if there is one, otherwise the middle of the visible window.
  _reference(at) {
    for (const n of this.notes) {
      if (at >= n.start - GRACE && at <= n.end + GRACE) return n.midi;
    }
    return this.center != null ? this.center : (this.mapLo + this.mapHi) / 2;
  }

  get semitonePx() {
    return (this.h - this.padTop - this.padBottom) / (this.hi - this.lo);
  }


  _frame() {
    if (!this.running) return;
    // `now` is the moment of the song currently reaching the listener's ears.
    // The mic reading in hand is older than that, so scoring looks slightly
    // further back than the display does.
    const now = this.audio.currentTime;
    const scoreNow = now - this.micDelay;
    const raw = this.mic.read();

    if (raw != null) {
      const folded = Game.fold(raw, this._reference(scoreNow));
      // light smoothing so the ball glides instead of twitching -- but a fold to
      // a new octave is a jump, not a glide, so don't slur across it
      this.smooth = (this.smooth == null || Math.abs(folded - this.smooth) > 6)
        ? folded
        : this.smooth + 0.35 * (folded - this.smooth);
      this.trail.push({ t: now, m: this.smooth });
    } else {
      this.smooth = null;
      this.trail.push({ t: now, m: null });
    }
    while (this.trail.length && this.trail[0].t < now - TRAIL_SEC) this.trail.shift();

    this._score(scoreNow);
    this._updateWindow(now);
    this._draw(now, scoreNow);
    requestAnimationFrame(this._frame);
  }

  _score(now) {
    const sung = this.smooth;
    for (const n of this.notes) {
      if (n.done) continue;
      // Credit is given over a slightly wider window than the note itself: a
      // singer reacting to a block arriving is always a little behind it, and
      // that lag is not a pitch error. Only the note's own span counts towards
      // the denominator, so the ratio is clamped rather than inflated.
      if (now >= n.start - GRACE && now <= n.end + GRACE) {
        if (now >= n.start && now <= n.end) n.passed++;
        if (sung != null && Math.abs(Game.fold(sung, n.midi) - n.midi) <= TOL) n.hit++;
      } else if (now > n.end + GRACE) {
        n.done = true;
        n.ratio = n.passed ? Math.min(1, n.hit / n.passed) : 0;
        // A note we never actually observed -- the tab was hidden, the song was
        // seeked past it, or the frame rate dropped out -- is not a miss. It
        // never got a fair chance, so it stays out of the score entirely.
        if (!n.scored && n.passed > 0) {
          n.scored = true;
          this.judged++;
          if (n.ratio >= HIT_RATIO) this.hits++;
          this.onScore(this.hits, this.judged);
        }
      }
    }
  }

  _draw(now, scoreNow) {
    const g = this.ctx, w = this.w, h = this.h;
    if (w <= 0 || h <= 0) { this._resize(); return; }
    const nowX = this.nowX;
    const PPS = this.pps, PAD_TOP = this.padTop, PAD_BOTTOM = this.padBottom;

    g.fillStyle = "#050506";
    g.fillRect(0, 0, w, h);

    for (const s of this.stars) {
      g.globalAlpha = s.a;
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(s.x, s.y, s.r, 0, 6.284);
      g.fill();
    }
    g.globalAlpha = 1;

    // vertical time grid, one line per second, scrolling with the music
    g.strokeStyle = "rgba(255,255,255,.05)";
    g.lineWidth = 1;
    const first = Math.ceil(now - nowX / PPS);
    for (let t = first; t < now + (w - nowX) / PPS; t++) {
      const x = nowX + (t - now) * PPS;
      g.beginPath();
      g.moveTo(x, PAD_TOP - 20);
      g.lineTo(x, h - PAD_BOTTOM + 20);
      g.stroke();
    }

    // the now-line: where a block has to be for you to be singing it
    const grad = g.createLinearGradient(nowX - this.ballR * 4, 0, nowX + this.ballR * 4, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,.05)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    const lane = Math.max(18, this.ballR * 4);
    g.fillRect(nowX - lane, PAD_TOP - 20, lane * 2, h - PAD_BOTTOM - PAD_TOP + 40);
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(nowX, PAD_TOP - 20);
    g.lineTo(nowX, h - PAD_BOTTOM + 20);
    g.stroke();

    this._drawNotes(now, nowX);
    this._drawTrail(now, nowX);
    this._drawBall(nowX, scoreNow);
    this._drawMinimap(now);
  }

  _drawNotes(now, nowX) {
    const g = this.ctx;
    const barH = Math.max(15, TOL * 2 * this.semitonePx);
    g.textBaseline = "middle";
    g.font = `600 ${this.fontPx}px -apple-system, system-ui, sans-serif`;

    for (const n of this.notes) {
      const PPS = this.pps;
      const x0 = nowX + (n.start - now) * PPS;
      const x1 = nowX + (n.end - now) * PPS;
      if (x1 < -40 || x0 > this.w + 40) continue;

      const yc = this.y(n.midi);
      const top = yc - barH / 2;
      const width = Math.max(6, x1 - x0);
      const ratio = n.passed ? n.hit / n.passed : 0;

      // base block
      let base = "rgba(150,150,162,.34)";
      if (n.done && n.scored) {
        base = ratio >= HIT_RATIO ? "rgba(53,208,127,.30)"
             : ratio < MISS_RATIO ? "rgba(226,83,75,.26)"
             : "rgba(150,150,162,.24)";
      } else if (n.done) {
        base = "rgba(150,150,162,.14)";   // passed unobserved; not judged
      }
      const radius = Math.min(10, barH / 2);
      g.fillStyle = base;
      roundRect(g, x0, top, width, barH, radius);
      g.fill();

      // green fill over the portion already sung, scaled by how much landed
      const passedW = Math.max(0, Math.min(x1, nowX) - x0);
      if (passedW > 0 && ratio > 0) {
        g.save();
        roundRect(g, x0, top, width, barH, radius);
        g.clip();
        g.fillStyle = ratio >= HIT_RATIO ? "rgba(53,208,127,.92)" : "rgba(53,208,127,.55)";
        g.fillRect(x0, top, passedW * ratio, barH);
        g.restore();
      }

      if (width > this.fontPx * 2.6) {
        g.fillStyle = "rgba(255,255,255,.82)";
        g.fillText(n.name.replace(/\d+$/, ""), x0 + Math.max(5, this.fontPx * 0.7), yc + 0.5);
      }
    }
  }

  // A comet, not a graph line: the tail narrows and fades away behind the ball
  // over a few hundred milliseconds.
  _drawTrail(now, nowX) {
    const g = this.ctx;
    g.lineCap = "round";
    const pts = this.trail;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.m == null || b.m == null) continue;
      const f = 1 - (now - b.t) / TRAIL_SEC;   // 1 at the ball, 0 at the tail
      if (f <= 0) continue;
      g.strokeStyle = `rgba(255,255,255,${(0.85 * f * f).toFixed(3)})`;
      g.lineWidth = (0.8 + 5.2 * f * f) * this.ui;
      g.beginPath();
      g.moveTo(nowX - (now - a.t) * this.pps, this.y(a.m));
      g.lineTo(nowX - (now - b.t) * this.pps, this.y(b.m));
      g.stroke();
    }
  }

  _drawBall(nowX, scoreNow) {
    const g = this.ctx;
    if (this.smooth == null) return;
    const y = this.y(this.smooth);

    // is the ball currently inside a block?
    let inTune = false;
    for (const n of this.notes) {
      if (scoreNow >= n.start - GRACE && scoreNow <= n.end + GRACE) {
        if (Math.abs(Game.fold(this.smooth, n.midi) - n.midi) <= TOL) inTune = true;
        break;
      }
    }

    if (inTune) {
      g.fillStyle = "rgba(53,208,127,.25)";
      g.beginPath();
      g.arc(nowX, y, this.ballR * 2.6, 0, 6.284);
      g.fill();
    }
    g.fillStyle = inTune ? "#35d07f" : "#fff";
    g.beginPath();
    g.arc(nowX, y, this.ballR, 0, 6.284);
    g.fill();
  }

  _drawMinimap(now) {
    const g = this.ctx;
    const hgt = this.mapH;
    const y0 = this.h - this.padBottom + Math.max(10, this.padBottom * 0.18);
    const x0 = this.margin, wid = this.w - this.margin * 2;
    const dur = this.song.durationSeconds;
    const lo = this.mapLo, hi = this.mapHi;

    g.fillStyle = "rgba(255,255,255,.04)";
    roundRect(g, x0, y0, wid, hgt, 8);
    g.fill();

    for (const n of this.notes) {
      const nx = x0 + (n.start / dur) * wid;
      const nw = Math.max(1.5, ((n.end - n.start) / dur) * wid);
      const ny = y0 + hgt - 4 - ((n.midi - lo) / Math.max(1, hi - lo)) * (hgt - 8);
      g.fillStyle = n.scored
        ? (n.ratio >= HIT_RATIO ? "rgba(53,208,127,.95)" : "rgba(255,255,255,.18)")
        : "rgba(255,255,255,.34)";
      g.fillRect(nx, ny, nw, 2.5);
    }

    const px = x0 + Math.min(1, now / dur) * wid;
    g.strokeStyle = "rgba(255,255,255,.75)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(px, y0 - 3);
    g.lineTo(px, y0 + hgt + 3);
    g.stroke();
  }
}

function roundRect(g, x, y, w, h, r) {
  w = Math.max(0, w);
  h = Math.max(0, h);
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
