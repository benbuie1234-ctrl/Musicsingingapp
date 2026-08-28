// Microphone capture and live pitch tracking.
import { Yin, hzToMidi } from "./yin.js";

const FRAME = 2048;
const WIRELESS_OUTPUT_SEC = 0.18;
const WIRELESS_CAPTURE_SEC = 0.12;
const WIRELESS_LABEL = /airpods?|bluetooth|beats|buds|freebuds|jabra|bose|soundcore|quietcomfort|wh-\w+|wf-\w+/i;

export const isLikelyWirelessAudio = (label = "") => WIRELESS_LABEL.test(label);

export function latencyProfile(track, ctx) {
  const label = track?.label || "";
  const settings = track?.getSettings?.() || {};
  const reportedCapture = Number.isFinite(settings.latency) ? Math.max(0, settings.latency) : 0;
  const normalCapture = (ctx?.baseLatency || 0) + FRAME / 2 / (ctx?.sampleRate || 48000);
  const wireless = isLikelyWirelessAudio(label);
  const reportedOutput = ctx?.outputLatency || 0;
  return {
    wireless,
    label,
    reportedCapture,
    captureDelay: Math.max(normalCapture, reportedCapture, wireless ? WIRELESS_CAPTURE_SEC : 0),
    // songTime already subtracts reported outputLatency. Add only the missing
    // portion of a conservative wireless estimate, never the whole value twice.
    outputDelayExtra: wireless ? Math.max(0, WIRELESS_OUTPUT_SEC - reportedOutput) : 0,
  };
}

export class Mic {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buf = new Float32Array(FRAME);
    this.yin = null;
    this.stream = null;
    this.profile = { wireless: false, label: "", reportedCapture: 0, captureDelay: 0, outputDelayExtra: 0 };
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
    this.profile = latencyProfile(this.stream.getAudioTracks()[0], ctx);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FRAME;
    ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.yin = new Yin(ctx.sampleRate, FRAME);
  }

  // How far in the past the sound we are analysing right now actually happened.
  get captureDelay() {
    return this.profile.captureDelay;
  }

  get outputDelayExtra() {
    return this.profile.outputDelayExtra;
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
    this.profile = { wireless: false, label: "", reportedCapture: 0, captureDelay: 0, outputDelayExtra: 0 };
  }
}
