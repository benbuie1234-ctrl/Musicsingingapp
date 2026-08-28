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

  async enable() {
    if (this.ctx) return;
    // Every one of these processors is designed to make speech intelligible,
    // and every one of them distorts pitch. They stay off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FRAME;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.yin = new Yin(this.ctx.sampleRate, FRAME);
  }

  // Round-trip delay between a sound happening and us measuring it, in seconds.
  get latencyEstimate() {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency || 0;
    const out = this.ctx.outputLatency || 0;
    // the analysis window is centred half a frame back in time
    return base + out + FRAME / 2 / this.ctx.sampleRate;
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
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
  }
}
