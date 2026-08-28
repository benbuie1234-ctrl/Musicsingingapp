// Microphone capture and live pitch tracking.
import { Yin, hzToMidi } from "./yin.js";

const FRAME = 2048;

export class Mic {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buf = new Float32Array(FRAME);
    this.yin = null;
    this.stream = null;
  }

  // Shares the caller's AudioContext so the mic and the music read the same clock.
  async enable(ctx) {
    if (this.analyser) return;
    // Every one of these processors exists to make speech intelligible, and
    // every one of them distorts pitch. They stay off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FRAME;
    ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.yin = new Yin(ctx.sampleRate, FRAME);
  }

  // How far in the past the sound we are analysing right now actually happened.
  get captureDelay() {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + FRAME / 2 / this.ctx.sampleRate;
  }

  // Returns MIDI note number, or null when nothing pitched is coming in.
  read() {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buf);
    const { f0, aperiodicity, rms } = this.yin.detect(this.buf);
    if (!f0 || aperiodicity > 0.25 || rms < 0.004) return null;
    return hzToMidi(f0);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.analyser = null;
    this.stream = null;
  }
}
