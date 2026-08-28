import assert from "node:assert/strict";
import { isLikelyWirelessAudio, latencyProfile } from "../web/src/mic.js";

const ctx = { sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02 };
const track = (label, latency) => ({
  label,
  getSettings: () => latency == null ? {} : { latency },
});

assert.equal(isLikelyWirelessAudio("Ben's AirPods Pro"), true);
assert.equal(isLikelyWirelessAudio("MacBook Pro Microphone"), false);

const airpods = latencyProfile(track("Ben's AirPods Pro"), ctx);
assert.equal(airpods.wireless, true);
assert.equal(airpods.captureDelay, 0.12);
assert.ok(Math.abs(airpods.outputDelayExtra - 0.16) < 1e-9);

const reported = latencyProfile(track("Bluetooth headset", 0.21), ctx);
assert.equal(reported.captureDelay, 0.21, "credible browser capture latency wins");

const builtIn = latencyProfile(track("MacBook Pro Microphone", 0.04), ctx);
assert.equal(builtIn.wireless, false);
assert.equal(builtIn.captureDelay, 0.04);
assert.equal(builtIn.outputDelayExtra, 0);

console.log("mic latency tests passed");
