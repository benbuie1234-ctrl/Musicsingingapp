// The scrolling pitch display: note blocks travel right-to-left past a fixed
// "now" line, and a ball rides at the height of whatever you are singing.
const TOL = 0.5;          // semitones: closer to this note than its neighbour
const PERFECT_TOL = 0.2;  // tightly centred, but never required to pass
const HIT_RATIO = 0.5;    // hold at least half of the note to count it
const MISS_RATIO = 0.2;   // below this the block goes red
const GRACE = 0.15;       // seconds of timing slack on either side of a note
const TRAIL_SEC = 0.4;
const ATTACK_FRAMES = 2;  // reject one-frame pitch flashes when the voice starts
const RELEASE_SEC = 0.22; // keep/fade the last good pitch across tiny dropouts
const OUTLIER_ST = 3.5;   // a larger move must persist before the ball follows it
const OUTLIER_FRAMES = 3;
const GUIDANCE_DELAY = GRACE; // blocks arrive at the far edge of the strike zone
const FOLLOW = 0.035;     // how fast the pitch axis chases the melody
const LOOKAHEAD = 3.0;    // seconds of upcoming melody the axis aims to fit

// The display is laid out in TIME and SEMITONES, not pixels, so a phone shows
// the same stretch of music as a desktop rather than a cropped slice of it.
// Scroll speed and the visible pitch range are derived from the viewport to
// keep these two constant; only then are they clamped to stay readable.
const SEE_AHEAD_SEC = 3.2;   // how much of the coming melody stays on screen
const MIN_SEMITONE_PX = 16;  // below this a block is too thin to aim at
const MAX_WINDOW_ST = 17;    // semitones visible at once, at most
const BEATS_PER_BAR = 4;

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
      ...n, hit: 0, perfect: 0, passed: 0, done: false, scored: false, hitRanges: [],
    }));
    this.contour = song.midi;
    this.hop = song.hopSeconds;

    this.trail = [];
    this.smooth = null;
    this.scorePitch = null;
    this.ballAlpha = 0;
    this.lastPitchAt = -Infinity;
    this.lastFrameAt = null;
    this.pitchHistory = [];
    this.pendingPitch = null;
    this.pendingFrames = 0;
    this.hadTrailGap = true;
    // Debug-only visual experiment. It never changes the audio clock or score.
    this.visualOffset = GUIDANCE_DELAY;
    this.center = null;   // centre of the visible pitch window, in MIDI
    this.hits = 0;
    this.judged = 0;
    this.points = 0;
    this.streak = 0;
    this.maxStreak = 0;
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
    this.mapH = clamp(h * 0.065, 30, 58);
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
    this.stars = Array.from({ length: 72 }, () => ({
      x: rng() * w, y: rng() * h, r: 0.7 + rng() * 1.8,
      a: 0.06 + rng() * 0.24, speed: 2 + rng() * 8,
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
    // Prefer the note whose real span contains this moment. Grace windows can
    // overlap at a boundary; returning the first match made the ball cling to
    // the old note just as the melody moved to the new one.
    for (const n of this.notes) {
      if (at >= n.start && at <= n.end) return n.midi;
    }
    for (const n of this.notes) {
      if (at >= n.start - GRACE && at <= n.end + GRACE) return n.midi;
    }
    return this.center != null ? this.center : (this.mapLo + this.mapHi) / 2;
  }

  _activeNote(at) {
    for (const n of this.notes) {
      if (at >= n.start && at <= n.end) return n;
    }
    return null;
  }

  get semitonePx() {
    return (this.h - this.padTop - this.padBottom) / (this.hi - this.lo);
  }

  _medianPitch(raw) {
    this.pitchHistory.push(raw);
    if (this.pitchHistory.length > 3) this.pitchHistory.shift();
    const sorted = [...this.pitchHistory].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  _acceptPitch(raw, now, scoreNow) {
    const active = this._activeNote(scoreNow);
    const reference = active?.midi ?? this._reference(scoreNow);
    let folded = Game.fold(this._medianPitch(raw), reference);

    // Of the octave-equivalent positions, keep the one nearest the existing
    // ball while it is still compatible with the current target. This stops a
    // boundary/noise frame from flipping the display by twelve semitones.
    if (this.smooth != null) {
      const near = folded + 12 * Math.round((this.smooth - folded) / 12);
      if (Math.abs(near - reference) <= 6) folded = near;
    }

    const jump = this.smooth == null ? 0 : Math.abs(folded - this.smooth);
    if (jump > OUTLIER_ST) {
      if (this.pendingPitch == null || Math.abs(folded - this.pendingPitch) > 1.2) {
        this.pendingPitch = folded;
        this.pendingFrames = 1;
        return false;
      }
      this.pendingPitch = (this.pendingPitch + folded) / 2;
      if (++this.pendingFrames < OUTLIER_FRAMES) return false;
      folded = this.pendingPitch;
    } else if (this.smooth == null) {
      if (this.pendingPitch == null || Math.abs(folded - this.pendingPitch) > 1.2) {
        this.pendingPitch = folded;
        this.pendingFrames = 1;
        return false;
      }
      this.pendingPitch = (this.pendingPitch + folded) / 2;
      if (++this.pendingFrames < ATTACK_FRAMES) return false;
      folded = this.pendingPitch;
    }

    this.pendingPitch = null;
    this.pendingFrames = 0;
    // Once the singer is already inside a target, visually damp its tiny YIN
    // fluctuations toward the block centre. This is display-only: scoring uses
    // the untouched reading from this frame.
    let displayPitch = folded;
    if (active && Math.abs(folded - active.midi) <= TOL) {
      displayPitch = active.midi + (folded - active.midi) * 0.28;
    }

    const dt = this.lastFrameAt == null ? 1 / 60 : clamp(now - this.lastFrameAt, 1 / 240, 0.1);
    const distance = this.smooth == null ? Infinity : Math.abs(displayPitch - this.smooth);
    const tau = distance > 1.2 ? 0.035 : 0.095;
    const alpha = this.smooth == null ? 1 : 1 - Math.exp(-dt / tau);
    this.smooth = this.smooth == null ? displayPitch : this.smooth + alpha * (displayPitch - this.smooth);
    this.lastPitchAt = now;
    this.ballAlpha = 1;
    this.lastFrameAt = now;
    this.trail.push({ t: now, m: this.smooth, gap: this.hadTrailGap });
    this.hadTrailGap = false;
    return true;
  }


  _frame() {
    if (!this.running) return;
    // `now` is the moment of the song currently reaching the listener's ears.
    // The mic reading in hand is older than that, so scoring looks slightly
    // further back than the display does.
    const now = this.audio.currentTime;
    const scoreNow = now - this.micDelay;
    const raw = this.mic.read();
    this.scorePitch = null;

    let accepted = false;
    if (raw != null) {
      // Visual filtering must never make the scoring algorithm more lenient or
      // cost a fast note. _score folds this original reading per target note.
      this.scorePitch = raw;
      accepted = this._acceptPitch(raw, now, scoreNow);
    }
    if (!accepted) {
      this.pitchHistory.length = 0;
      if (raw == null) {
        this.pendingPitch = null;
        this.pendingFrames = 0;
      }
      const silentFor = now - this.lastPitchAt;
      this.ballAlpha = clamp(1 - silentFor / RELEASE_SEC, 0, 1);
      if (silentFor >= RELEASE_SEC && this.smooth != null) {
        this.smooth = null;
        this.hadTrailGap = true;
      }
    }
    while (this.trail.length && this.trail[0].t < now - TRAIL_SEC) this.trail.shift();

    this._score(scoreNow, this.scorePitch);
    this._updateWindow(now);
    this._draw(now, scoreNow);
    requestAnimationFrame(this._frame);
  }

  _score(now, sung) {
    for (const n of this.notes) {
      if (n.done) continue;
      // Credit is given over a slightly wider window than the note itself: a
      // singer reacting to a block arriving is always a little behind it, and
      // that lag is not a pitch error. Only the note's own span counts towards
      // the denominator, so the ratio is clamped rather than inflated.
      if (now >= n.start - GRACE && now <= n.end + GRACE) {
        if (now >= n.start && now <= n.end) n.passed++;
        if (sung != null) {
          const error = Math.abs(Game.fold(sung, n.midi) - n.midi);
          if (error <= TOL) {
            n.hit++;
            const t = clamp(now, n.start, n.end);
            const last = n.hitRanges[n.hitRanges.length - 1];
            if (last && t - last[1] < 0.06) last[1] = t;
            else n.hitRanges.push([t, t]);
          }
          if (error <= PERFECT_TOL) n.perfect++;
        }
      } else if (now > n.end + GRACE) {
        n.done = true;
        n.ratio = n.passed ? Math.min(1, n.hit / n.passed) : 0;
        // A note we never actually observed -- the tab was hidden, the song was
        // seeked past it, or the frame rate dropped out -- is not a miss. It
        // never got a fair chance, so it stays out of the score entirely.
        if (!n.scored && n.passed > 0) {
          n.scored = true;
          this.judged++;
          if (n.ratio >= HIT_RATIO) {
            this.hits++;
            this.streak++;
            this.maxStreak = Math.max(this.maxStreak, this.streak);
            const precision = n.passed ? n.perfect / n.passed : 0;
            n.grade = precision >= 0.55 && n.ratio >= 0.75 ? "perfect" : "good";
            this.points += 100 + Math.min(4, this.streak - 1) * 25 + (n.grade === "perfect" ? 50 : 0);
          } else {
            n.grade = "miss";
            this.streak = 0;
          }
          this.onScore(this.scoreState);
        }
      }
    }
  }

  get percent() {
    return this.judged ? Math.round(this.hits / this.judged * 100) : 0;
  }

  get scoreState() {
    return {
      hits: this.hits, judged: this.judged, points: this.points,
      streak: this.streak, maxStreak: this.maxStreak,
      percent: this.judged ? Math.round(this.hits / this.judged * 100) : 0,
    };
  }

  _draw(now, scoreNow) {
    const g = this.ctx, w = this.w, h = this.h;
    if (w <= 0 || h <= 0) { this._resize(); return; }
    const nowX = this.nowX;
    const PPS = this.pps, PAD_TOP = this.padTop, PAD_BOTTOM = this.padBottom;

    g.fillStyle = "#050506";
    g.fillRect(0, 0, w, h);

    const visualNow = now - this.visualOffset;
    this._drawBeatGrid(visualNow, nowX);

    for (const s of this.stars) {
      g.globalAlpha = s.a;
      g.fillStyle = "#fff";
      g.beginPath();
      const sx = ((s.x - now * s.speed) % w + w) % w;
      g.arc(sx, s.y, s.r, 0, 6.284);
      g.fill();
    }
    g.globalAlpha = 1;

    const floor = g.createLinearGradient(0, h * .58, 0, h - PAD_BOTTOM + 20);
    floor.addColorStop(0, "rgba(5,5,6,0)");
    floor.addColorStop(1, "rgba(5,5,6,.72)");
    g.fillStyle = floor;
    g.fillRect(0, h * .58, w, h * .42);

    this._drawNotes(visualNow, nowX);
    this._drawTrail(now, nowX);
    this._drawBall(nowX, scoreNow);
    this._drawMinimap(now);
  }

  _drawBeatGrid(now, nowX) {
    const g = this.ctx, beats = this.song.beatSeconds || [];
    const top = this.padTop - 24, bottom = this.h - this.padBottom + 22;
    const visibleStart = now - nowX / this.pps;
    const visibleEnd = now + (this.w - nowX) / this.pps;
    if (beats.length > 8) {
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < visibleStart - 2 || t > visibleEnd + 2) continue;
        const x = nowX + (t - now) * this.pps;
        if (i % BEATS_PER_BAR === 0) {
          const end = beats[Math.min(i + BEATS_PER_BAR, beats.length - 1)];
          const x1 = nowX + (end - now) * this.pps;
          if ((Math.floor(i / BEATS_PER_BAR) & 1) === 0) {
            const shade = g.createLinearGradient(0, top, 0, bottom);
            shade.addColorStop(0, "rgba(255,255,255,.105)");
            shade.addColorStop(1, "rgba(255,255,255,.025)");
            g.fillStyle = shade;
            g.fillRect(x, top, x1 - x, bottom - top);
          }
        }
        g.strokeStyle = i % BEATS_PER_BAR === 0 ? "rgba(255,255,255,.17)" : "rgba(255,255,255,.085)";
        g.lineWidth = i % BEATS_PER_BAR === 0 ? 1.3 : 1;
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      }
    } else {
      const first = Math.floor(visibleStart);
      for (let t = first; t <= visibleEnd + 1; t++) {
        const x = nowX + (t - now) * this.pps;
        if ((t % 4 + 4) % 4 === 0) {
          g.fillStyle = "rgba(255,255,255,.055)";
          g.fillRect(x, top, this.pps * 4, bottom - top);
        }
        g.strokeStyle = "rgba(255,255,255,.08)";
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      }
    }
  }

  _drawNotes(now, nowX) {
    const g = this.ctx;
    const barH = Math.max(14, 1.05 * this.semitonePx);
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
      let base = "rgba(188,188,192,.72)";
      if (n.done && n.scored) {
        base = ratio >= HIT_RATIO ? "rgba(172,172,178,.62)"
             : ratio < MISS_RATIO ? "rgba(118,118,124,.28)"
             : "rgba(150,150,158,.42)";
      } else if (n.done) {
        base = "rgba(150,150,162,.14)";   // passed unobserved; not judged
      }
      const radius = Math.min(10, barH / 2);
      g.fillStyle = base;
      roundRect(g, x0, top, width, barH, radius);
      g.fill();

      // Fill only the exact time spans that were sung in tune.
      if (n.hitRanges.length) {
        g.save();
        roundRect(g, x0, top, width, barH, radius);
        g.clip();
        g.fillStyle = "rgba(91,198,48,.96)";
        for (const [a, b] of n.hitRanges) {
          const rx0 = nowX + (a - now) * PPS;
          const rx1 = nowX + (Math.max(b, a + .018) - now) * PPS;
          g.fillRect(rx0, top, Math.max(2, rx1 - rx0), barH);
        }
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
      if (a.m == null || b.m == null || b.gap) continue;
      const f = 1 - (now - b.t) / TRAIL_SEC;   // 1 at the ball, 0 at the tail
      if (f <= 0) continue;
      g.strokeStyle = `rgba(255,255,255,${(0.94 * f * f).toFixed(3)})`;
      g.lineWidth = (0.6 + 7.4 * f * f) * this.ui;
      g.beginPath();
      g.moveTo(nowX - (now - a.t) * this.pps, this.y(a.m));
      g.lineTo(nowX - (now - b.t) * this.pps, this.y(b.m));
      g.stroke();
    }
  }

  _drawBall(nowX, scoreNow) {
    const g = this.ctx;
    if (this.smooth == null || this.ballAlpha <= 0) return;
    const y = this.y(this.smooth);
    g.save();
    g.globalAlpha = this.ballAlpha;

    // is the ball currently inside a block?
    let inTune = false;
    for (const n of this.notes) {
      if (scoreNow >= n.start - GRACE && scoreNow <= n.end + GRACE) {
        if (Math.abs(Game.fold(this.smooth, n.midi) - n.midi) <= TOL) inTune = true;
        break;
      }
    }

    if (inTune) {
      g.fillStyle = "rgba(255,255,255,.18)";
      g.beginPath();
      g.arc(nowX, y, this.ballR * 2.6, 0, 6.284);
      g.fill();
    }
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(nowX, y, this.ballR, 0, 6.284);
    g.fill();
    g.restore();
  }

  _drawMinimap(now) {
    const g = this.ctx;
    const hgt = this.mapH;
    const y0 = this.h - this.padBottom + Math.max(9, this.padBottom * 0.12);
    const x0 = this.margin, wid = this.w - this.margin * 2;
    const dur = this.song.durationSeconds;
    const lo = this.mapLo, hi = this.mapHi;
    const px = x0 + clamp(now / dur, 0, 1) * wid;

    const tickY = (n) => y0 + hgt - 7 - ((n.midi - lo) / Math.max(1, hi - lo)) * (hgt - 14);
    const tickX = (n) => x0 + (n.start / dur) * wid;
    const tickW = (n) => Math.max(1.5, ((n.end - n.start) / dur) * wid);

    // notes still to come: faint marks on bare background
    for (const n of this.notes) {
      if (tickX(n) < px) continue;
      g.fillStyle = "rgba(255,255,255,.30)";
      roundRect(g, tickX(n), tickY(n), tickW(n), 3.5, 2); g.fill();
    }

    // the part of the song already played, as a lit capsule that grows
    const grad = g.createLinearGradient(x0, 0, px, 0);
    grad.addColorStop(0, "rgba(255,255,255,.10)");
    grad.addColorStop(1, "rgba(255,255,255,.30)");
    g.fillStyle = grad;
    roundRect(g, x0, y0, px - x0, hgt, hgt / 2);
    g.fill();

    for (const n of this.notes) {
      if (tickX(n) >= px) continue;
      g.fillStyle = n.scored
        ? (n.ratio >= HIT_RATIO ? "rgba(30,214,125,.98)" : "rgba(255,255,255,.22)")
        : "rgba(255,255,255,.45)";
      roundRect(g, tickX(n), tickY(n), tickW(n), 3.5, 2); g.fill();
    }
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
