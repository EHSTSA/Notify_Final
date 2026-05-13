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

// ── EmailJS ───────────────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = "TSA-Sound-Detector";
const EMAILJS_TEMPLATE_ID = "template_fa9wwjj";

async function sendEmail(sound, score) {
  const emailSetting      = document.getElementById("emailSetting");
  const emailAddressInput = document.getElementById("emailAddress");
  if (!emailSetting?.checked) return;
  const toEmail = emailAddressInput?.value.trim();
  if (!toEmail) { addLog("📧 Email failed: no email address entered."); return; }
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      email: toEmail, sound: sound.label, emoji: sound.emoji,
      score: score.toFixed(3), time: new Date().toLocaleString(),
    });
    addLog(`📧 Email sent for ${sound.label} to ${toEmail}`);
  } catch (e) {
    console.error("EmailJS send failed:", e);
    addLog(`📧 Email failed: ${e?.text || e?.message || "unknown error"}`);
  }
}

// ── Auth DOM ──────────────────────────────────────────────────────────────────
const authScreen       = document.getElementById("authScreen");
const mainApp          = document.getElementById("mainApp");
const authErrorEl      = document.getElementById("authError");
const userEmailEl      = document.getElementById("userEmail");
const tabSignIn        = document.getElementById("tabSignIn");
const tabSignUp        = document.getElementById("tabSignUp");
const emailInput       = document.getElementById("emailInput");
const passInput        = document.getElementById("passInput");
const passConfirmInput = document.getElementById("passConfirmInput");
const signInBtn        = document.getElementById("signInBtn");
const signUpBtn        = document.getElementById("signUpBtn");
const signOutBtn       = document.getElementById("signOutBtn");

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
    "auth/user-not-found":         "No account found with that email.",
    "auth/wrong-password":         "Incorrect password.",
    "auth/invalid-credential":     "Incorrect email or password.",
    "auth/email-already-in-use":   "An account with that email already exists.",
    "auth/invalid-email":          "Please enter a valid email address.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/popup-closed-by-user":   "Sign-in popup was closed.",
    "auth/network-request-failed": "Network error — check your connection.",
  })[code] || `Error: ${code}`;
}

tabSignIn.onclick = () => {
  tabSignIn.classList.add("active"); tabSignUp.classList.remove("active");
  passConfirmInput.style.display = "none";
  signInBtn.style.display = "block"; signUpBtn.style.display = "none";
  authErr("");
};
tabSignUp.onclick = () => {
  tabSignUp.classList.add("active"); tabSignIn.classList.remove("active");
  passConfirmInput.style.display = "block";
  signUpBtn.style.display = "block"; signInBtn.style.display = "none";
  authErr("");
};
signInBtn.onclick = async () => {
  authErr(""); setBusy(signInBtn, true);
  try { await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value); }
  catch (e) { authErr(niceError(e.code)); }
  finally   { setBusy(signInBtn, false); }
};
signUpBtn.onclick = async () => {
  authErr("");
  if (passInput.value !== passConfirmInput.value) { authErr("Passwords don't match."); return; }
  setBusy(signUpBtn, true);
  try { await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value); }
  catch (e) { authErr(niceError(e.code)); }
  finally   { setBusy(signUpBtn, false); }
};
signOutBtn.onclick = () => { stopListening(); signOut(auth); };

onAuthStateChanged(auth, user => {
  if (user) {
    authScreen.style.display = "none";
    mainApp.style.display    = "block";
    userEmailEl.textContent  = user.displayName || user.email;
  } else {
    authScreen.style.display = "flex";
    mainApp.style.display    = "none";
    stopListening();
  }
});

// ── Sound definitions ─────────────────────────────────────────────────────────
// YAMNet outputs 521 classes. Each sound maps one or more class indices so
// that any related class can trigger the alert. We take MAX across all indices.
// Full class list:
// https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv
const SOUNDS = [
  {
    id: "firealarm", tier: "danger", emoji: "🚨", label: "Fire Alarm",
    notif: "Fire alarm detected — check your surroundings!",
    idx: [388, 389, 390, 393, 394, 396, 397, 398],
    // 388=Smoke detector, 389=Fire alarm, 390=Alarm, 393=Buzzer,
    // 394=Alarm clock, 396=Siren, 397=Civil defense siren, 398=Whistle
  },
  {
    id: "glass", tier: "danger", emoji: "💥", label: "Glass Breaking",
    notif: "Glass breaking detected!",
    idx: [60, 61],
    // 60=Glass, 61=Shatter
  },
  {
    id: "baby", tier: "warn", emoji: "👶", label: "Baby Crying",
    notif: "Baby crying detected.",
    idx: [14, 15],
    // 14=Crying, sobbing, 15=Baby cry, infant cry
  },
  {
    id: "carhorn", tier: "warn", emoji: "📯", label: "Car Horn",
    notif: "Car horn detected nearby.",
    idx: [325, 326, 327],
    // 325=Car horn, honking, 326=Toot, 327=Truck horn
  },
  {
    id: "doorbell", tier: "info", emoji: "🔔", label: "Doorbell",
    notif: "Someone rang the doorbell.",
    idx: [379, 380],
    // 379=Doorbell, 380=Ding-dong
  },
  {
    id: "dog", tier: "info", emoji: "🐕", label: "Dog Barking",
    notif: "Dog barking detected.",
    idx: [74, 75, 76, 77],
    // 74=Dog, 75=Bark, 76=Yip, 77=Howl
  },
];

const enabled = Object.fromEntries(SOUNDS.map(s => [s.id, true]));

// ── App DOM ───────────────────────────────────────────────────────────────────
const statusEl        = document.getElementById("status");
const statusOrb       = document.getElementById("statusOrb");
const startBtn        = document.getElementById("startBtn");
const stopBtn         = document.getElementById("stopBtn");
const alertBox        = document.getElementById("alertBox");
const eventLog        = document.getElementById("eventLog");
const settingsBtn     = document.getElementById("settingsBtn");
const settingsPanel   = document.getElementById("settingsPanel");
const notifSetting    = document.getElementById("notifSetting");
const darkSetting     = document.getElementById("darkSetting");
const thresholdSlider = document.getElementById("thresholdSlider");
const thresholdVal    = document.getElementById("thresholdVal");
const clearLogBtn     = document.getElementById("clearLog");

// ── Sound toggles ─────────────────────────────────────────────────────────────
(function buildToggles() {
  const container = document.getElementById("soundToggles");
  [["🚨 Emergency","danger"],["⚠️ Safety","warn"],["ℹ️ Everyday","info"]].forEach(([label, tier]) => {
    const hdr = document.createElement("div");
    hdr.className = "sound-group-label"; hdr.textContent = label;
    container.appendChild(hdr);
    SOUNDS.filter(s => s.tier === tier).forEach(s => {
      const row = document.createElement("div");
      row.className = "setting-row";
      row.innerHTML = `
        <div class="setting-label">${s.emoji} ${s.label}</div>
        <label class="toggle">
          <input type="checkbox" id="snd-${s.id}" checked>
          <span class="toggle-slider"></span>
        </label>`;
      container.appendChild(row);
      row.querySelector("input").onchange = e => { enabled[s.id] = e.target.checked; };
    });
  });
})();

// ── UI helpers ────────────────────────────────────────────────────────────────
function addLog(msg) {
  const ts = new Date().toLocaleTimeString();
  eventLog.textContent += `[${ts}] ${msg}\n`;
  eventLog.scrollTop = eventLog.scrollHeight;
}
clearLogBtn.onclick = () => { eventLog.textContent = ""; };
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
  alertBox.className   = `alert-${sound.tier}`;
  alertBox.textContent = `${sound.emoji}  ${sound.label} detected (${score.toFixed(3)})`;
  alertBox.style.display   = "block";
  alertBox.style.animation = "none";
  void alertBox.offsetWidth; // force reflow so CSS animation restarts
  alertBox.style.animation = "";
  alertTO = setTimeout(() => { alertBox.style.display = "none"; }, 8000);
}

async function notify(sound) {
  if (!notifSetting.checked || !("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") {
    new Notification(`${sound.emoji} ${sound.label}`, { body: sound.notif });
  }
}

// FIX 2: Beep gets its own short-lived AudioContext so it never touches or
// closes the mic AudioContext that must stay alive during listening.
function beep(tier) {
  try {
    const bCtx = new AudioContext();
    const o = bCtx.createOscillator();
    const g = bCtx.createGain();
    o.frequency.value = tier === "danger" ? 880 : tier === "warn" ? 660 : 440;
    o.type = tier === "danger" ? "square" : "sine";
    g.gain.setValueAtTime(0.0001, bCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08,   bCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, bCtx.currentTime + 0.35);
    o.connect(g); g.connect(bCtx.destination);
    o.start(); o.stop(bCtx.currentTime + 0.4);
    setTimeout(() => bCtx.close(), 1000);
  } catch (e) { console.error("Beep error:", e); }
}

async function saveSoundEvent(sound, score) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await addDoc(collection(db, "sound_events"), {
      userId: user.uid, soundLabel: sound.label,
      confidence: Number(score), detectedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("Failed to save sound event:", e);
    addLog(`Cloud save failed: ${e?.message || "unknown error"}`);
  }
}

// ── YAMNet inference pipeline ─────────────────────────────────────────────────
// FIX 1: Replaced deprecated ScriptProcessor + plain Array with an AnalyserNode
//        + fixed-size Float32Array ring buffer. No more O(n²) spread copies or
//        GC pauses from growing arrays.
// FIX 3: resampleTo16k() now uses a single OfflineAudioContext at YAMNET_SR,
//        feeding it a buffer created at fromSR. The browser's sinc resampler
//        handles the rate conversion implicitly — no double-context overhead.
// FIX 4: YAMNet returns [scores, embeddings, log_mel_spectrogram]. We always
//        grab index 0 safely and dispose all output tensors.
// FIX 5: lastHit is now a per-sound map so a dog bark can't suppress a
//        simultaneous fire alarm detection.

const YAMNET_SR  = 16000;   // YAMNet required input rate
const WINDOW_S   = 1.5;     // seconds of audio per inference call
const POLL_MS    = 500;     // inference frequency (ms)
const CAPTURE_MS = 46;      // frame capture interval (~2048 samples @ 44.1kHz)
const COOLDOWN   = 3000;    // ms between alerts for the same sound
const MODEL_URL  = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1";

let THRESHOLD = 0.20;

let model         = null;
let audioCtx      = null;
let micStream     = null;
let srcNode       = null;
let analyser      = null;
let silentGain    = null;
let nativeSR      = 44100;
let ringBuffer    = null;   // Float32Array — fixed-size ring buffer
let ringHead      = 0;      // next write index
let ringFull      = false;  // true once buffer has wrapped at least once
let captureTimer  = null;
let inferenceTimer = null;
let listening     = false;
let lastHit       = {};     // { soundId: lastAlertTimestamp }

async function loadModel() {
  statusEl.textContent = "Loading YAMNet…";
  addLog("Fetching YAMNet from TF Hub (first load ~5 s on slow connections)…");
  try {
    model = await window.tf.loadGraphModel(MODEL_URL, { fromTFHub: true });
    // Warm-up: one zero-input pass so the first real inference isn't slow
    const dummy  = window.tf.zeros([YAMNET_SR]);
    const warmOut = model.execute({ waveform: dummy });
    (Array.isArray(warmOut) ? warmOut : [warmOut]).forEach(t => t.dispose());
    dummy.dispose();
    addLog("✅ YAMNet ready.");
    statusEl.textContent = "Ready";
  } catch (e) {
    addLog("❌ YAMNet load failed: " + e.message);
    statusEl.textContent = "Load failed";
    throw e;
  }
}

// FIX 3: Single OfflineAudioContext at target rate. Browser resamples for us.
async function resampleTo16k(float32, fromSR) {
  if (fromSR === YAMNET_SR) return float32;
  const outLen = Math.ceil(float32.length * YAMNET_SR / fromSR);
  const offCtx = new OfflineAudioContext(1, outLen, YAMNET_SR);
  const buf    = offCtx.createBuffer(1, float32.length, fromSR);
  buf.getChannelData(0).set(float32);
  const src = offCtx.createBufferSource();
  src.buffer = buf;
  src.connect(offCtx.destination);
  src.start(0);
  const rendered = await offCtx.startRendering();
  return rendered.getChannelData(0);
}

// Read the ring buffer in chronological order (oldest → newest).
function readRing() {
  if (!ringFull) return ringBuffer.slice(0, ringHead);
  const out = new Float32Array(ringBuffer.length);
  out.set(ringBuffer.subarray(ringHead));
  out.set(ringBuffer.subarray(0, ringHead), ringBuffer.length - ringHead);
  return out;
}

// FIX 1: Capture via AnalyserNode.getFloatTimeDomainData — gives raw PCM
// in [-1, 1] range, which is exactly what YAMNet wants after resampling.
function captureFrame() {
  if (!analyser) return;
  const chunk = new Float32Array(analyser.fftSize); // 2048 samples
  analyser.getFloatTimeDomainData(chunk);
  for (let i = 0; i < chunk.length; i++) {
    ringBuffer[ringHead] = chunk[i];
    ringHead = (ringHead + 1) % ringBuffer.length;
    if (ringHead === 0) ringFull = true;
  }
}

async function runInference() {
  if (!model || !listening) return;

  const needed = Math.ceil(nativeSR * WINDOW_S);
  if (!ringFull && ringHead < needed) return; // not enough audio yet

  const all  = readRing();
  const snap = all.length >= needed ? all.slice(all.length - needed) : all;

  let wv, outTensors, scores;
  try {
    const s16     = await resampleTo16k(snap, nativeSR);
    const clamped = s16.map(v => Math.max(-1, Math.min(1, v)));
    wv = window.tf.tensor1d(clamped);

    // FIX 4: always treat output as array, grab scores at index 0
    outTensors = model.execute({ waveform: wv });
    const scoresTensor = Array.isArray(outTensors) ? outTensors[0] : outTensors;
    const meanScores   = window.tf.mean(scoresTensor, 0); // avg over frames → [521]
    scores = await meanScores.array();
    meanScores.dispose();
  } catch (e) {
    addLog("⚠️ Inference error: " + e.message);
    return;
  } finally {
    wv?.dispose();
    (Array.isArray(outTensors) ? outTensors : [outTensors]).forEach(t => t?.dispose());
  }

  // Top-5 debug output — open browser DevTools console to see live scores
  const top5 = scores
    .map((v, i) => [i, v])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  console.log("YAMNet top-5:", top5.map(([i, v]) => `[${i}] ${v.toFixed(3)}`).join("  "));

  const now = Date.now();
  let best = null, bestScore = 0;

  for (const s of SOUNDS) {
    if (!enabled[s.id]) continue;
    // FIX 5: independent cooldown per sound
    if (now - (lastHit[s.id] ?? 0) < COOLDOWN) continue;
    const sc = Math.max(...s.idx.map(i => scores[i] ?? 0));
    if (sc >= THRESHOLD && sc > bestScore) { best = s; bestScore = sc; }
  }

  if (best) {
    lastHit[best.id] = now;
    showAlert(best, bestScore);
    addLog(`${best.emoji} ${best.label} — score ${bestScore.toFixed(3)}`);
    beep(best.tier);
    notify(best);
    await sendEmail(best, bestScore);
    await saveSoundEvent(best, bestScore);
    await flashScreen(3);
  }
}

async function startListening() {
  if (!model) await loadModel();
  if (listening) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // must be off — processing mangles YAMNet input
        noiseSuppression: false,
        autoGainControl:  false,
        channelCount:     1,
      },
      video: false,
    });
  } catch (e) {
    addLog("Mic error: " + e.message);
    statusEl.textContent = "Mic denied";
    return;
  }

  try {
    micStream = stream;
    audioCtx  = new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    nativeSR  = audioCtx.sampleRate;

    srcNode  = audioCtx.createMediaStreamSource(stream);

    // FIX 1: AnalyserNode replaces ScriptProcessor
    analyser = audioCtx.createAnalyser();
    analyser.fftSize               = 2048;  // 2048 PCM samples per capture tick
    analyser.smoothingTimeConstant = 0;     // raw, unsmoothed

    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0; // don't echo mic to speakers

    srcNode.connect(analyser);
    analyser.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    // Allocate ring buffer for 6 s of audio
    ringBuffer = new Float32Array(nativeSR * 6);
    ringHead   = 0;
    ringFull   = false;
    lastHit    = {};
    listening  = true;

    captureTimer   = setInterval(captureFrame,  CAPTURE_MS);
    inferenceTimer = setInterval(runInference,  POLL_MS);

    startBtn.disabled = true;
    stopBtn.disabled  = false;
    statusEl.textContent = "Listening…";
    statusOrb.classList.add("listening");
    addLog(`🎤 Mic active at ${nativeSR} Hz → resampling to ${YAMNET_SR} Hz for YAMNet.`);
  } catch (e) {
    console.error("Audio setup error:", e);
    addLog("Audio system error: " + e.message);
    statusEl.textContent = "Audio error";
    stopListening();
  }
}

function stopListening() {
  clearInterval(captureTimer);
  clearInterval(inferenceTimer);
  captureTimer = inferenceTimer = null;

  try { srcNode?.disconnect();    } catch {}
  try { analyser?.disconnect();   } catch {}
  try { silentGain?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { if (audioCtx?.state !== "closed") audioCtx?.close(); } catch {}

  srcNode = analyser = silentGain = micStream = audioCtx = null;
  ringBuffer = null; ringHead = 0; ringFull = false;
  listening  = false;

  if (startBtn)  startBtn.disabled  = false;
  if (stopBtn)   stopBtn.disabled   = true;
  if (statusEl)  statusEl.textContent  = "Stopped";
  if (statusOrb) statusOrb.classList.remove("listening");
  addLog("⏹ Stopped.");
}

startBtn.onclick = startListening;
stopBtn.onclick  = stopListening;

async function flashScreen(times = 3) {
  const overlay = document.getElementById("flashOverlay");
  if (!overlay) return;
  for (let i = 0; i < times; i++) {
    overlay.style.opacity = "1";
    await new Promise(r => setTimeout(r, 100));
    overlay.style.opacity = "0";
    await new Promise(r => setTimeout(r, 150));
  }
}
