import { Game } from "./game.js";
import { Mic } from "./mic.js";

const $ = (id) => document.getElementById(id);
const bestKey = (id) => `best:${id}`;

const mic = new Mic();
let ctx = null;      // one AudioContext shared by playback and the mic
let source = null;   // the currently playing AudioBufferSourceNode
let game = null;
let startedAt = 0;   // ctx.currentTime when playback began

// ---------- dashboard ----------

async function loadSongs() {
  const list = await fetch("songs.json").then((r) => r.json());
  const box = $("songs");
  box.innerHTML = "";

  for (const entry of list) {
    let map = null;
    try {
      const r = await fetch(`public/maps/${entry.id}.json`);
      if (r.ok) map = await r.json();
    } catch { /* map not generated yet */ }

    const best = localStorage.getItem(bestKey(entry.id));
    const card = document.createElement("div");
    card.className = "song";
    card.innerHTML = `
      <div class="song-main">
        <b>${esc(entry.title)}</b>
        <span>${esc(entry.artist)}</span>
        <div class="song-meta${map ? "" : " warn"}">${
          map
            ? `${map.notes.length} notes · ${fmt(map.durationSeconds)}${best ? ` · best ${best}%` : ""}`
            : "No pitch map yet — run the extract pipeline for this song."
        }</div>
      </div>`;

    const play = document.createElement("button");
    play.className = "primary";
    play.textContent = "Sing";
    play.disabled = !map;
    play.onclick = () => enterPlayer(entry, map);
    card.append(play);
    box.append(card);
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- player ----------

async function enterPlayer(entry, map) {
  $("dashboard").hidden = true;
  $("player").hidden = false;
  $("hud-title").textContent = map.title || entry.title;
  $("hud-artist").textContent = map.artist || entry.artist;
  const best = localStorage.getItem(bestKey(entry.id));
  $("best").textContent = best ? `${best}%` : "--";
  $("score").textContent = "0%";
  $("score-detail").textContent = "0 / 0 notes";

  overlay("Loading", "Decoding the track…", null);

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buffer;
  try {
    const bytes = await fetch(`audio/${entry.id}.m4a`).then((r) => {
      if (!r.ok) throw new Error(`audio missing (${r.status})`);
      return r.arrayBuffer();
    });
    buffer = await ctx.decodeAudioData(bytes);
  } catch (e) {
    overlay("Audio not found", `Put the track at web/audio/${entry.id}.m4a — it is kept out of the repo on purpose.`, ["Back to songs", leavePlayer]);
    return;
  }

  game = new Game($("stage"), map, { get currentTime() { return songTime(); } }, mic);
  // Internal A/B aid only: ?debugOffset=150 moves blocks 150 ms later without
  // changing playback or scoring. It is deliberately not a user preference.
  const visualMs = Number(new URLSearchParams(location.search).get("debugOffset") || 0);
  if (Number.isFinite(visualMs)) game.visualOffset = Math.max(-0.5, Math.min(0.5, visualMs / 1000));
  game.onScore = (hits, judged) => {
    $("score").textContent = `${judged ? Math.round((hits / judged) * 100) : 0}%`;
    $("score-detail").textContent = `${hits} / ${judged} notes`;
  };

  overlay("Ready", "Headphones on, or the mic will hear the backing track and score the song against itself.", ["Start", () => begin(entry, buffer)]);
}

// Position in the song that is reaching the listener's ears right now.
// Derived from the audio clock rather than an <audio> element's currentTime,
// which only updates around frame rate and drifts against what you hear.
function songTime() {
  if (!ctx || !startedAt) return 0;
  return ctx.currentTime - startedAt - (ctx.outputLatency || 0) - mic.outputDelayExtra;
}

async function begin(entry, buffer) {
  try {
    await ctx.resume();
    await mic.enable(ctx);
  } catch (e) {
    overlay("Microphone blocked", "Allow mic access and try again. Browsers also refuse outright on a file:// page — serve the folder over localhost.", ["Back to songs", leavePlayer]);
    return;
  }
  game.micDelay = mic.captureDelay;
  if (mic.profile.wireless) showAudioStatus("Wireless audio detected · timing adjusted");

  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => finish(entry);

  $("overlay").hidden = true;
  startedAt = ctx.currentTime + 0.12;   // a beat of headroom so playback starts clean
  source.start(startedAt);
  game.start();
}

let audioStatusTimer = null;
function showAudioStatus(message) {
  const el = $("audio-status");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(audioStatusTimer);
  audioStatusTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function finish(entry) {
  if (!game) return;
  const pct = game.judged ? Math.round((game.hits / game.judged) * 100) : 0;
  const prev = Number(localStorage.getItem(bestKey(entry.id)) || 0);
  if (pct > prev) localStorage.setItem(bestKey(entry.id), String(pct));
  overlay(`${pct}%`, `${game.hits} of ${game.judged} notes hit${pct > prev ? " — new best" : ""}.`, ["Back to songs", leavePlayer]);
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
  $("player").hidden = true;
  $("dashboard").hidden = false;
  loadSongs();
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

loadSongs();
