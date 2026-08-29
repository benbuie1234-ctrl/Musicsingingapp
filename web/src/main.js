import { Game } from "./game.js";
import { Mic } from "./mic.js";

const $ = (id) => document.getElementById(id);
const bestKey = (id) => `best:${id}`;

const mic = new Mic();
let ctx = null;      // one AudioContext shared by playback and the mic
let source = null;   // the currently playing AudioBufferSourceNode
let game = null;
let startedAt = 0;   // ctx.currentTime when playback began
let current = null;  // { entry, map, buffer }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pctText = (v) => (v == null ? "—" : `${v}%`);

function show(view) {
  for (const id of ["library", "song", "player"]) $(id).hidden = id !== view;
}

// ---------- library ----------

async function loadLibrary() {
  // A local catalog can include commercial tracks whose audio and maps must
  // never ship with the public repository. Production falls back to songs.json.
  let list;
  try {
    const local = await fetch("songs.local.json", { cache: "no-store" });
    if (!local.ok) throw new Error("no local catalog");
    list = await local.json();
  } catch {
    list = await fetch("songs.json").then((r) => r.json());
  }

  const box = $("songs");
  box.innerHTML = "";

  for (const entry of list) {
    let map = null;
    try {
      const r = await fetch(`public/maps/${entry.id}.json`);
      if (r.ok) map = await r.json();
    } catch { /* map not generated yet */ }

    const best = localStorage.getItem(bestKey(entry.id));
    const tile = document.createElement("button");
    tile.className = "tile" + (map ? "" : " pending");
    tile.innerHTML = `
      <div class="tile-art">
        <img src="art/${entry.id}.jpg" alt="" loading="lazy"
             onerror="this.remove()">
        <span class="tile-badge">${best ? `${best}%` : "0"}</span>
      </div>
      <b>${esc(entry.title)}</b>
      <span>${map ? esc(entry.artist) : "Pitch map missing"}</span>`;
    if (map) tile.onclick = () => openSong(entry, map);
    else tile.disabled = true;
    box.append(tile);
  }
}

// ---------- song page ----------

function openSong(entry, map) {
  current = { entry, map, buffer: null };
  $("song-bg").style.backgroundImage = `url("art/${entry.id}.jpg")`;
  $("song-title").textContent = map.title || entry.title;
  $("song-artist").textContent = map.artist || entry.artist;
  $("song-best").textContent = pctText(localStorage.getItem(bestKey(entry.id)));
  show("song");
}

$("song-back").onclick = () => { current = null; show("library"); loadLibrary(); };
$("song-play").onclick = () => enterPlayer();

// ---------- player ----------

async function enterPlayer() {
  const { entry, map } = current;
  show("player");
  $("best").textContent = pctText(localStorage.getItem(bestKey(entry.id)));
  $("score").textContent = "0%";

  overlay("Loading", "Decoding the track…", null);

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buffer;
  try {
    const bytes = await fetch(`audio/${entry.id}.m4a`).then((r) => {
      if (!r.ok) throw new Error(`audio missing (${r.status})`);
      return r.arrayBuffer();
    });
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    overlay("Audio not found", `Put the track at web/audio/${entry.id}.m4a — it is kept out of the repo on purpose.`, ["Back", leavePlayer]);
    return;
  }

  game = new Game($("stage"), map, { get currentTime() { return songTime(); } }, mic);

  // Internal A/B aid only: overrides the built-in guidance delay without
  // changing playback or scoring. Not a user preference.
  const visualParam = new URLSearchParams(location.search).get("debugOffset");
  const visualMs = visualParam == null ? null : Number(visualParam);
  if (Number.isFinite(visualMs)) game.visualOffset = Math.max(-0.5, Math.min(0.5, visualMs / 1000));

  game.onScore = (state) => { $("score").textContent = `${state.percent}%`; };

  const preview = new URLSearchParams(location.search).has("preview");
  overlay("Ready", preview
    ? "Visual preview — playback runs without microphone scoring."
    : "Headphones on, or the mic hears the backing track and scores the song against itself.",
  ["Start", () => begin(buffer, preview)]);
}

// Position in the song reaching the listener's ears right now. Taken from the
// audio clock rather than an <audio> element's currentTime, which only updates
// around frame rate and drifts against what you actually hear.
function songTime() {
  if (!ctx || !startedAt) return 0;
  return ctx.currentTime - startedAt - (ctx.outputLatency || 0) - mic.outputDelayExtra;
}

async function begin(buffer, preview = false) {
  try {
    await ctx.resume();
    if (!preview) await mic.enable(ctx);
  } catch {
    overlay("Microphone blocked", "Allow mic access and try again. Browsers also refuse outright on a file:// page — serve the folder over localhost.", ["Back", leavePlayer]);
    return;
  }
  game.micDelay = preview ? 0 : mic.captureDelay;
  if (!preview && mic.profile.wireless) showAudioStatus("Wireless audio detected · timing adjusted");

  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => finish();

  $("overlay").hidden = true;
  startedAt = ctx.currentTime + 0.12;   // a beat of headroom so playback starts clean
  source.start(startedAt);
  game.start();
  checkOrientation();
}

let audioStatusTimer = null;
function showAudioStatus(message) {
  const el = $("audio-status");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(audioStatusTimer);
  audioStatusTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// The scrolling display needs width to give useful warning of a coming note.
function checkOrientation() {
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  $("rotate-hint").hidden = !portrait || $("player").hidden;
}
window.addEventListener("resize", checkOrientation);
window.addEventListener("orientationchange", checkOrientation);

function finish() {
  if (!game || !current) return;
  const pct = game.percent;
  const prev = Number(localStorage.getItem(bestKey(current.entry.id)) || 0);
  const best = pct > prev;
  if (best) localStorage.setItem(bestKey(current.entry.id), String(pct));
  overlay(`${pct}%`, `${game.hits} of ${game.judged} notes${best ? " — new best" : ""}.`, ["Back to song", leavePlayer]);
}

function overlay(title, body, action) {
  $("ov-title").textContent = title;
  $("ov-body").textContent = body;
  const btn = $("ov-action");
  if (action) {
    btn.hidden = false;
    btn.textContent = action[0];
    btn.onclick = action[1];
  } else {
    btn.hidden = true;
  }
  $("overlay").hidden = false;
}

function leavePlayer() {
  if (source) { try { source.onended = null; source.stop(); } catch {} }
  if (game) game.destroy();
  mic.stop();
  if (ctx) ctx.close();
  ctx = null; source = null; game = null; startedAt = 0;
  clearTimeout(audioStatusTimer);
  $("audio-status").hidden = true;
  $("overlay").hidden = true;
  $("rotate-hint").hidden = true;
  if (current) {
    $("song-best").textContent = pctText(localStorage.getItem(bestKey(current.entry.id)));
    show("song");
  } else {
    show("library");
    loadLibrary();
  }
}

$("back").onclick = leavePlayer;

// Sync is the thing most worth being able to inspect, so ?debug exposes the
// clock and the scoring state rather than making you add prints to find them.
if (new URLSearchParams(location.search).has("debug")) {
  window.__sing = {
    songTime,
    get ctx() { return ctx; },
    get game() { return game; },
    get audioProfile() { return mic.profile; },
    get startedAt() { return startedAt; },
  };
}

loadLibrary();
