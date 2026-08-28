// YIN pitch detection -- a direct port of extract/yin.py.
//
// Keeping the two implementations in lockstep is the point: the target contour
// and your live voice are measured by identical math, so any bias the algorithm
// has applies to both and cancels out instead of reading as pitch error.

export const FMIN = 65.0;
export const FMAX = 1200.0;
export const THRESHOLD = 0.15;

export class Yin {
  constructor(sampleRate, frameSize = 2048) {
    this.sr = sampleRate;
    this.w = frameSize;
    this.tauMin = Math.max(2, Math.floor(sampleRate / FMAX));
    this.tauMax = Math.min(frameSize >> 1, Math.floor(sampleRate / FMIN) + 2);
    this.diff = new Float32Array(this.tauMax);
    this.cmnd = new Float32Array(this.tauMax);
  }

  // Returns { f0, aperiodicity, rms }. f0 is 0 when no period was found.
  detect(buf) {
    const { w, tauMin, tauMax, diff, cmnd } = this;

    let mean = 0;
    for (let i = 0; i < w; i++) mean += buf[i];
    mean /= w;

    let energy = 0;
    for (let i = 0; i < w; i++) {
      const v = buf[i] - mean;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / w);
    if (rms < 1e-5) return { f0: 0, aperiodicity: 1, rms };

    // d(tau) = sum over j < w-tau of (x[j] - x[j+tau])^2
    for (let tau = 0; tau < tauMax; tau++) {
      let sum = 0;
      const n = w - tau;
      for (let j = 0; j < n; j++) {
        const d = (buf[j] - mean) - (buf[j + tau] - mean);
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // cumulative mean normalization
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau < tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 1e-12 ? (diff[tau] * tau) / running : 1;
    }

    // First local minimum below threshold. If nothing clears it we fall back to
    // the global minimum and report its aperiodicity rather than giving up --
    // breathy and transitional frames rarely clear a hard threshold, and
    // discarding them threw away over half of a real vocal.
    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (cmnd[t] < THRESHOLD) {
        while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin; t < tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      tau = best;
    }

    // parabolic refinement of the minimum
    let refined = tau;
    if (tau > 0 && tau < tauMax - 1) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
      const denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-12) {
        refined = tau + Math.max(-1, Math.min(1, (c - a) / denom));
      }
    }
    return { f0: this.sr / refined, aperiodicity: cmnd[tau], rms };
  }
}

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiToName = (m) => {
  const r = Math.round(m);
  return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
};
