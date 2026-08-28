import { Game } from "./game.js";
import { Mic } from "./mic.js";

const $ = (id) => document.getElementById(id);
const mic = new Mic();
let game = null, audio = null, objectUrl = null;

// ---------- audio blobs live in IndexedDB, since they can't live in the repo ----------

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("sing", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("audio");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function putAudio(id, blob) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").put(blob, id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function getAudio(id) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("audio", "readonly");
    const q = tx.objectStore("audio").get(id);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
  });
}

// ---------- dashboard ----------

const bestKey = (id) => `best:${id}`;

async function loadSongs() {
  const list = await fetch("songs.json").then((r) => r.json());
  const box = $("songs");
  box.innerHTML = "";

  for (const entry of list) {
    let map = null;
    try {
      const r = await fetch(`public/maps/${entry.id}.json`);
      if (r.ok) map = await r.json();
    } catch { /* map simply isn't generated yet */ }

    const blob = await getAudio(entry.id);
    const card = document.createElement("div");
    card.className = "song";

    const best = localStorage.getItem(bestKey(entry.id));
    const meta = !map
      ? `<div class="song-meta warn">No pitch map yet — run the extract pipeline for this song.</div>`
      : `<div class="song-meta">${map.notes.length} notes · ${fmt(map.durationSeconds)}${best ? ` · best ${best}%` : ""}</div>`;

    card.innerHTML = `
      <div class="song-main">
        <b>${escape(entry.title)}</b>
        <span>${escape(entry.artist)}</span>
        ${meta}
      </div>`;

    const pick = document.createElement("button");
    pick.textContent = blob ? "Replace audio" : "Choose audio…";
    pick.onclick = () => chooseAudio(entry);

    const play = document.createElement("button");
    play.className = "primary";
    play.textContent = "Sing";
    play.disabled = !map || !blob;
    play.title = !map ? "Pitch map missing" : !blob ? "Choose the audio file first" : "";
    play.onclick = () => enterPlayer(entry, map, blob);

    card.append(pick, play);
    box.append(card);
  }
}

function chooseAudio(entry) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    await putAudio(entry.id, f);
    loadSongs();
  };
  input.click();
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- player ----------

async function enterPlayer(entry, map, blob) {
  $("dashboard").hidden = true;
  $("player").hidden = false;
  $("hud-title").textContent = map.title || entry.title;
  $("hud-artist").textContent = map.artist || entry.artist;
  const best = localStorage.getItem(bestKey(entry.id));
  $("best").textContent = best ? `${best}%` : "--";

  objectUrl = URL.createObjectURL(blob);
  audio = new Audio(objectUrl);
  audio.preload = "auto";

  game = new Game($("stage"), map, audio, mic);
  game.onScore = (hits, judged) => {
    const pct = judged ? Math.round((hits / judged) * 100) : 0;
    $("score").textContent = `${pct}%`;
    $("score-detail").textContent = `${hits} / ${judged} notes`;
  };

  bindTuning();

  $("ov-title").textContent = "Ready";
  $("ov-body").textContent = "Headphones on, or the mic will hear the backing track and score the song against itself.";
  $("ov-action").textContent = "Start";
  $("overlay").hidden = false;

  $("ov-action").onclick = async () => {
    try {
      await mic.enable();
    } catch (e) {
      $("ov-title").textContent = "Microphone blocked";
      $("ov-body").textContent = "Allow mic access and try again. On a plain file:// page browsers refuse outright — serve the folder over localhost.";
      return;
    }
    // seed the latency slider from what the browser reports about itself
    const ms = Math.round(mic.latencyEstimate * 1000);
    const saved = localStorage.getItem("latency");
    const start = saved !== null ? Number(saved) : ms;
    $("latency").value = start;
    $("latency").dispatchEvent(new Event("input"));

    $("overlay").hidden = true;
    audio.play();
    game.start();
  };

  // rAF stops in a hidden tab while audio keeps playing, so pause together.
  // (Notes that slip past unobserved are already excluded from scoring.)
  document.addEventListener("visibilitychange", onVisibility);

  audio.onended = () => {
    const pct = game.judged ? Math.round((game.hits / game.judged) * 100) : 0;
    const prev = Number(localStorage.getItem(bestKey(entry.id)) || 0);
    if (pct > prev) localStorage.setItem(bestKey(entry.id), String(pct));
    $("ov-title").textContent = `${pct}%`;
    $("ov-body").textContent = `${game.hits} of ${game.judged} notes hit${pct > prev ? " — new best" : ""}.`;
    $("ov-action").textContent = "Back to songs";
    $("ov-action").onclick = leavePlayer;
    $("overlay").hidden = false;
  };
}

function onVisibility() {
  if (!audio || audio.ended) return;
  if (document.hidden && !audio.paused) {
    audio.pause();
    $("ov-title").textContent = "Paused";
    $("ov-body").textContent = "The tab lost focus, so the display stopped. Nothing was counted against you.";
    $("ov-action").textContent = "Resume";
    $("ov-action").onclick = () => { $("overlay").hidden = true; audio.play(); };
    $("overlay").hidden = false;
  }
}

function bindTuning() {
  const lat = $("latency"), tr = $("transpose"), oct = $("octave");
  lat.oninput = () => {
    $("latency-out").textContent = `${lat.value} ms`;
    localStorage.setItem("latency", lat.value);
    if (game) game.latency = Number(lat.value) / 1000;
  };
  tr.oninput = () => {
    $("transpose-out").textContent = tr.value > 0 ? `+${tr.value}` : tr.value;
    if (game) game.transpose = Number(tr.value);
  };
  oct.onchange = () => { if (game) game.ignoreOctave = oct.checked; };
  tr.dispatchEvent(new Event("input"));
}

function leavePlayer() {
  if (audio) { audio.pause(); audio.src = ""; }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (game) game.destroy();
  document.removeEventListener("visibilitychange", onVisibility);
  game = null; audio = null; objectUrl = null;
  $("overlay").hidden = true;
  $("player").hidden = true;
  $("dashboard").hidden = false;
  loadSongs();
}

$("back").onclick = leavePlayer;

navigator.permissions?.query({ name: "microphone" }).then((p) => {
  const label = { granted: "Microphone ready", denied: "Microphone blocked in browser settings" };
  $("mic-state").textContent = label[p.state] || "Microphone will be requested when you start";
}).catch(() => {});

loadSongs();
