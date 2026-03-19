import {
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  addDoc,
  collection,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// ── EmailJS config ───────────────────────────────────────────────────────────
// Uses Resend under the hood via EmailJS — fires off an email when a sound
// is detected and the user has email alerts turned on in settings.
const EMAILJS_SERVICE_ID = "TSA-Sound-Detector";
const EMAILJS_TEMPLATE_ID = "template_fa9wwjj";

async function sendEmail(sound, score) {
  const emailSetting = document.getElementById("emailSetting");
  const emailAddressInput = document.getElementById("emailAddress");

  if (!emailSetting || !emailSetting.checked) return;

  const toEmail = emailAddressInput?.value.trim();
  if (!toEmail) {
    addLog("📧 Email failed: no email address entered.");
    return;
  }

  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      email: toEmail,
      sound: sound.label,
      emoji: sound.emoji,
      score: score.toFixed(3),
      time: new Date().toLocaleString(),
    });

    addLog(`📧 Email sent for ${sound.label} to ${toEmail}`);
  } catch (e) {
    console.error("EmailJS send failed:", e);
    addLog(`📧 Email failed: ${e?.text || e?.message || "unknown error"}`);
  }
}

// ── Auth DOM ──────────────────────────────────────────────────────────────────
const authScreen = document.getElementById("authScreen");
const mainApp = document.getElementById("mainApp");
const authErrorEl = document.getElementById("authError");
const userEmailEl = document.getElementById("userEmail");
const tabSignIn = document.getElementById("tabSignIn");
const tabSignUp = document.getElementById("tabSignUp");
const emailInput = document.getElementById("emailInput");
const passInput = document.getElementById("passInput");
const passConfirmInput = document.getElementById("passConfirmInput");
const signInBtn = document.getElementById("signInBtn");
const signUpBtn = document.getElementById("signUpBtn");
const signOutBtn = document.getElementById("signOutBtn");

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Thin wrappers so we don't repeat the same show/hide/error logic everywhere.
function authErr(msg) {
  authErrorEl.textContent = msg;
  authErrorEl.style.display = msg ? "block" : "none";
}

function setBusy(btn, busy) {
  btn.disabled = busy;
  if (!btn._t) btn._t = btn.textContent;
  btn.textContent = busy ? "Please wait…" : btn._t;
}

function niceError(code) {
  return ({
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account with that email already exists.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/popup-closed-by-user": "Sign-in popup was closed.",
    "auth/network-request-failed": "Network error — check your connection.",
  })[code] || `Error: ${code}`;
}

// ── Auth tab switch ───────────────────────────────────────────────────────────
tabSignIn.onclick = () => {
  tabSignIn.classList.add("active");
  tabSignUp.classList.remove("active");
  passConfirmInput.style.display = "none";
  signInBtn.style.display = "block";
  signUpBtn.style.display = "none";
  authErr("");
};

tabSignUp.onclick = () => {
  tabSignUp.classList.add("active");
  tabSignIn.classList.remove("active");
  passConfirmInput.style.display = "block";
  signUpBtn.style.display = "block";
  signInBtn.style.display = "none";
  authErr("");
};

signInBtn.onclick = async () => {
  authErr("");
  setBusy(signInBtn, true);
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    authErr(niceError(e.code));
  } finally {
    setBusy(signInBtn, false);
  }
};

signUpBtn.onclick = async () => {
  authErr("");
  if (passInput.value !== passConfirmInput.value) {
    authErr("Passwords don't match.");
    return;
  }
  setBusy(signUpBtn, true);
  try {
    await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    authErr(niceError(e.code));
  } finally {
    setBusy(signUpBtn, false);
  }
};

signOutBtn.onclick = () => {
  stopListening();
  signOut(auth);
};

onAuthStateChanged(auth, user => {
  if (user) {
    authScreen.style.display = "none";
    mainApp.style.display = "block";
    userEmailEl.textContent = user.displayName || user.email;
  } else {
    authScreen.style.display = "flex";
    mainApp.style.display = "none";
    stopListening();
  }
});

// ── Sound definitions ────────────────────────────────────────────────────────
// Each entry maps one or more YAMNet class indices to a single user-facing label.
// We merge classes that mean the same thing in practice (e.g. smoke detector,
// siren, and buzzer all just mean "fire alarm is going off") so the user gets
// one clear alert instead of three confusing ones.
//
// idx values are YAMNet's 521-class output indices — see the class map at
// https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv
const SOUNDS = [
  // --- danger: things you need to act on immediately ---
  { id: "firealarm", idx: [396, 397, 388, 389, 390, 398], label: "Fire Alarm", emoji: "🚨", tier: "danger", notif: "Fire alarm detected — check your surroundings!" },
  { id: "glass",     idx: [60, 61],                       label: "Glass Shatter", emoji: "💥", tier: "danger", notif: "Glass breaking detected!" },

  // --- warn: not life-threatening but you should know ---
  { id: "baby",      idx: [14, 15],              label: "Baby Crying", emoji: "👶", tier: "warn", notif: "Baby crying detected." },
  { id: "horn",      idx: [325, 326, 302, 303],  label: "Horn",        emoji: "📯", tier: "warn", notif: "Horn detected nearby." },
  { id: "reversing", idx: [329],                  label: "Reversing Beeps", emoji: "🔁", tier: "warn", notif: "Reversing vehicle detected." },

  // --- info: everyday sounds worth surfacing ---
  { id: "doorbell",  idx: [379, 380],  label: "Doorbell",          emoji: "🔔", tier: "info", notif: "Someone rang the doorbell." },
  { id: "phone",     idx: [400, 401],        label: "Telephone Ringing", emoji: "📞", tier: "info", notif: "Telephone ringing." },
  { id: "alarm",     idx: [393, 394],        label: "Alarm Clock",       emoji: "⏰", tier: "info", notif: "Alarm clock going off." },
  { id: "microwave", idx: [375],             label: "Microwave",         emoji: "📡", tier: "info", notif: "Microwave beep detected." },
  { id: "dog",       idx: [74, 75, 76],      label: "Dog Barking",       emoji: "🐕", tier: "info", notif: "Dog barking detected." },
  { id: "vacuum",    idx: [373],             label: "Vacuum Cleaner",    emoji: "🌀", tier: "info", notif: "Vacuum cleaner detected." },
];

const enabled = Object.fromEntries(SOUNDS.map(s => [s.id, true]));

// ── App DOM ───────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status");
const statusOrb = document.getElementById("statusOrb");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const alertBox = document.getElementById("alertBox");
const eventLog = document.getElementById("eventLog");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const notifSetting = document.getElementById("notifSetting");
const darkSetting = document.getElementById("darkSetting");
const thresholdSlider = document.getElementById("thresholdSlider");
const thresholdVal = document.getElementById("thresholdVal");
const clearLogBtn = document.getElementById("clearLog");

// ── Sound toggles ─────────────────────────────────────────────────────────────
(function buildToggles() {
  const container = document.getElementById("soundToggles");

  [
    ["🚨 Emergency", "danger"],
    ["⚠️ Traffic & Safety", "warn"],
    ["ℹ️ Everyday", "info"]
  ].forEach(([label, tier]) => {
    const hdr = document.createElement("div");
    hdr.className = "sound-group-label";
    hdr.textContent = label;
    container.appendChild(hdr);

    SOUNDS.filter(s => s.tier === tier).forEach(s => {
      const row = document.createElement("div");
      row.className = "setting-row";
      row.innerHTML = `
        <div class="setting-label">${s.emoji} ${s.label}</div>
        <label class="toggle">
          <input type="checkbox" id="snd-${s.id}" checked>
          <span class="toggle-slider"></span>
        </label>
      `;
      container.appendChild(row);

      row.querySelector("input").onchange = e => {
        enabled[s.id] = e.target.checked;
      };
    });
  });
})();

// ── UI helpers ────────────────────────────────────────────────────────────────
function addLog(msg) {
  const ts = new Date().toLocaleTimeString();
  eventLog.textContent += `[${ts}] ${msg}\n`;
  eventLog.scrollTop = eventLog.scrollHeight;
}

clearLogBtn.onclick = () => {
  eventLog.textContent = "";
};

settingsBtn.onclick = () => {
  settingsPanel.style.display = settingsPanel.style.display === "block" ? "none" : "block";
};

const savedTheme = localStorage.getItem("audio-detector-theme") || "light";
document.body.classList.toggle("dark", savedTheme === "dark");
darkSetting.checked = savedTheme === "dark";

darkSetting.onchange = () => {
  document.body.classList.toggle("dark", darkSetting.checked);
  localStorage.setItem("audio-detector-theme", darkSetting.checked ? "dark" : "light");
};

thresholdSlider.oninput = () => {
  THRESHOLD = parseFloat(thresholdSlider.value);
  thresholdVal.textContent = THRESHOLD.toFixed(2);
};

let alertTO;

function showAlert(sound, score) {
  clearTimeout(alertTO);
  alertBox.className = `alert-${sound.tier}`;
  alertBox.textContent = `${sound.emoji}  ${sound.label} detected (${score.toFixed(3)})`;
  alertBox.style.display = "block";
  alertBox.style.animation = "none";
  void alertBox.offsetWidth;
  alertBox.style.animation = "";
  alertTO = setTimeout(() => {
    alertBox.style.display = "none";
  }, 8000);
}

async function notify(sound) {
  if (!notifSetting.checked || !("Notification" in window)) return;

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  if (Notification.permission === "granted") {
    new Notification(`${sound.emoji} ${sound.label}`, {
      body: sound.notif
    });
  }
}

// Quick audio cue so the user knows something was detected even if they're
// not looking at the screen. Higher pitch + harsher waveform for danger.
function beep(tier) {
  try {
    if (!audioCtx || audioCtx.state === "closed") return;

    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o.frequency.value = tier === "danger" ? 880 : tier === "warn" ? 660 : 440;
    o.type = tier === "danger" ? "square" : "sine";

    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);

    o.connect(g);
    g.connect(audioCtx.destination);

    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch (e) {
    console.error("Beep error:", e);
  }
}

async function saveSoundEvent(sound, score) {
  const user = auth.currentUser;
  if (!user) return;

  try {
    await addDoc(collection(db, "sound_events"), {
      userId: user.uid,
      soundLabel: sound.label,
      confidence: Number(score),
      detectedAt: serverTimestamp()
    });
  } catch (e) {
    console.error("Failed to save sound event:", e);
    addLog(`Cloud save failed: ${e?.message || "unknown error"}`);
  }
}

// ── YAMNet inference pipeline ─────────────────────────────────────────────────
// YAMNet expects mono 16 kHz audio. Most mics run at 44.1/48 kHz so we
// resample on the fly. We grab 1.5s windows every 750ms (overlapping) to
// balance latency vs. accuracy, and debounce detections with a 3s cooldown
// so we don't spam the user with the same alert.
const YAMNET_SR = 16000;
const WINDOW_S = 1.5;
const POLL_MS = 750;
const COOLDOWN = 3000;
const MODEL_URL = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1";
let THRESHOLD = 0.20;

let model = null;
let audioCtx = null;
let micStream = null;
let srcNode = null;
let procNode = null;
let silentGain = null;
let samples = [];
let nativeSR = 44100;
let timer = null;
let listening = false;
let lastHit = 0;

async function loadModel() {
  statusEl.textContent = "Loading YAMNet…";
  addLog("Fetching YAMNet from TF Hub…");
  model = await window.tf.loadGraphModel(MODEL_URL, { fromTFHub: true });
  addLog("YAMNet ready — 11 sound classes active.");
  statusEl.textContent = "Ready";
}

// Resample from the mic's native rate down to 16 kHz for YAMNet.
// Uses OfflineAudioContext which handles the interpolation for us —
// way simpler (and better quality) than doing it manually.
async function resample(buf, fromSR) {
  if (fromSR === YAMNET_SR) return buf;

  const outLen = Math.ceil(buf.length * YAMNET_SR / fromSR);

  const tmp = new OfflineAudioContext(1, buf.length, fromSR);
  const src = tmp.createBuffer(1, buf.length, fromSR);
  src.getChannelData(0).set(buf);

  const dst = new OfflineAudioContext(1, outLen, YAMNET_SR);
  const n = dst.createBufferSource();
  n.buffer = src;
  n.connect(dst.destination);
  n.start(0);

  return (await dst.startRendering()).getChannelData(0);
}

// Core detection loop — runs every POLL_MS while listening.
// Grabs the latest audio window, feeds it through YAMNet, and checks if any
// of our monitored classes scored above the threshold. Because we merged
// related YAMNet classes (e.g. siren + smoke detector → "Fire Alarm"),
// we take the max score across all indices in a group so any one of them
// firing is enough to trigger the alert.
async function runInference() {
  if (!model || !listening) return;

  const need = Math.ceil(nativeSR * WINDOW_S);
  if (samples.length < need) return;

  const snap = Float32Array.from(samples.slice(-need));

  let wv, s0, sm, arr;
  try {
    const s16 = await resample(snap, nativeSR);
    // clamp to [-1, 1] — occasional mic spikes can push values out of range
    const cl = s16.map(v => Math.max(-1, Math.min(1, v)));
    wv = window.tf.tensor1d(cl);
    const out = model.execute({ waveform: wv });
    // YAMNet can return multiple frames; average them into one 521-d vector
    s0 = Array.isArray(out) ? out[0] : out;
    sm = window.tf.mean(s0, 0);
    arr = await sm.array();
  } catch (e) {
    addLog("Inference error: " + e.message);
    return;
  } finally {
    // always clean up tensors to avoid memory leaks
    wv?.dispose();
    s0?.dispose();
    sm?.dispose();
  }

  const now = Date.now();
  if (now - lastHit <= COOLDOWN) return;

  // helpful for debugging — shows raw top-5 classes in console
  const top5 = arr.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log("Top-5 YAMNet:", top5.map(([i, v]) => `[${i}] ${v.toFixed(3)}`).join("  "));

  // find the highest-scoring enabled sound across all our merged class groups
  let best = null;
  let bestScore = 0;

  for (const s of SOUNDS) {
    if (!enabled[s.id]) continue;
    // max across all indices in this group — any one class can trigger the alert
    const sc = Math.max(...s.idx.map(i => arr[i] ?? 0));
    if (sc >= THRESHOLD && sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }

  if (best) {
    lastHit = now;
    showAlert(best, bestScore);
    addLog(`${best.emoji} ${best.label} — score ${bestScore.toFixed(3)}`);
    beep(best.tier);
    notify(best);
    await sendEmail(best, bestScore);
    await saveSoundEvent(best, bestScore);
    await flashScreen(3);
  }
}

// Spin up the mic, wire it into a ScriptProcessor that feeds our sample buffer,
// and kick off the inference loop. We disable all browser audio processing
// (echo cancel, noise suppression, AGC) because YAMNet needs the raw signal —
// those filters can mangle the frequencies we're trying to classify.
async function startListening() {
  if (!model) await loadModel();
  if (listening) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
  } catch (e) {
    addLog("Mic error: " + e.message);
    statusEl.textContent = "Mic denied";
    return;
  }

  try {
    micStream = stream;
    audioCtx = new AudioContext();

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    nativeSR = audioCtx.sampleRate;
    samples = [];

    srcNode = audioCtx.createMediaStreamSource(stream);
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);

    // route through a silent gain node so audio doesn't play through speakers
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    // keep a rolling buffer of ~6 seconds of audio
    const maxBuf = nativeSR * 6;
    procNode.onaudioprocess = e => {
      const chunk = e.inputBuffer.getChannelData(0);
      samples.push(...chunk);
      if (samples.length > maxBuf) {
        samples = samples.slice(samples.length - maxBuf);
      }
    };

    srcNode.connect(procNode);
    procNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    listening = true;
    timer = setInterval(runInference, POLL_MS);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "Listening…";
    statusOrb.classList.add("listening");
    addLog(`Mic active at ${nativeSR} Hz → 16 kHz.`);
  } catch (e) {
    console.error("AudioContext/startListening error:", e);
    addLog("Audio system error: " + e.message);
    statusEl.textContent = "Audio error";
    stopListening();
  }
}

// Tear down everything — stop mic, kill timers, disconnect audio graph.
// Each disconnect is wrapped in try/catch because some nodes may already
// be disconnected if the browser recycled the context.
function stopListening() {
  clearInterval(timer);
  timer = null;

  try {
    procNode && (procNode.onaudioprocess = null);
    procNode?.disconnect();
  } catch {}

  try {
    srcNode?.disconnect();
  } catch {}

  try {
    silentGain?.disconnect();
  } catch {}

  try {
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
    }
  } catch {}

  try {
    if (audioCtx && audioCtx.state !== "closed") {
      audioCtx.close();
    }
  } catch {}

  procNode = null;
  srcNode = null;
  silentGain = null;
  micStream = null;
  audioCtx = null;
  samples = [];
  listening = false;

  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  if (statusEl) statusEl.textContent = "Stopped";
  if (statusOrb) statusOrb.classList.remove("listening");

  addLog("Stopped.");
}

startBtn.onclick = startListening;
stopBtn.onclick = stopListening;

// Visual flash for deaf/HoH users — briefly whites out the screen so it's
// impossible to miss even in peripheral vision.
async function flashScreen(times = 3) {
  const overlay = document.getElementById("flashOverlay");
  if (!overlay) return;

  for (let i = 0; i < times; i++) {
    overlay.style.opacity = "1";
    await new Promise(r => setTimeout(r, 100)); // flash on

    overlay.style.opacity = "0";
    await new Promise(r => setTimeout(r, 150)); // flash off
  }
}
