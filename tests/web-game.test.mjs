import assert from "node:assert/strict";

global.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
global.requestAnimationFrame = () => {};

const { Game } = await import("../web/src/game.js");

const context = new Proxy({}, {
  get(target, key) {
    if (!(key in target)) target[key] = () => {};
    return target[key];
  },
  set(target, key, value) { target[key] = value; return true; },
});
const canvas = { clientWidth: 390, clientHeight: 700, getContext: () => context };
const song = {
  notes: [
    { start: 0, end: 1, midi: 60, name: "C4" },
    { start: 1, end: 2, midi: 64, name: "E4" },
  ],
  midi: [], hopSeconds: 0.01, durationSeconds: 2,
};
const game = new Game(canvas, song, { currentTime: 0 }, { read: () => null });

// A single startup reading is not enough to flash the ball into view.
assert.equal(game._acceptPitch(48, 0.01, 0.01), false);
assert.equal(game.smooth, null);
assert.equal(game._acceptPitch(48.05, 0.02, 0.02), true);
assert.ok(Math.abs(game.smooth - 60.05) < 0.1, "pitch folds to the target octave");

// A large one-frame outlier is ignored; a persistent real move is accepted.
const before = game.smooth;
game._acceptPitch(55, 0.03, 0.03); // three-sample median still reports the old pitch
assert.ok(Math.abs(game.smooth - before) < 0.05);
assert.equal(game._acceptPitch(55.05, 0.04, 0.04), false);
assert.equal(game._acceptPitch(55.1, 0.05, 0.05), true);
assert.ok(Math.abs(game.smooth - before) > 0.1, "confirmed pitch movement advances the ball");

// Visual release does not leak into scoring.
game.scorePitch = null;
game._score(0.5, game.scorePitch);
assert.equal(game.notes[0].hit, 0);

game.destroy();
console.log("web game tests passed");
