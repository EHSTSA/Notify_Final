
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
import { YAMNET_CLASS_NAMES } from "./yamnet_class_map.js";
import {
  SOUND_GROUPS,
  AGGREGATION,
  COOLDOWN_MS,
  WINDOW_S,
  POLL_MS,
  THRESHOLD_DEFAULT,
  THRESHOLD_MULTIPLIER_RANGE,
  DEBUG,
  DEBUG_RING_SIZE,
  MIN_RMS,
  TOP_K_GATE,
} from "./config.js";
import {
  resolveGroups,
  formatResolutionTable,
  ScoreBuffer,
  pickBestFiring,
  effectiveThreshold,
  CooldownGate,
  groupScoreOnFrame,
} from "./detection.js";

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
// Groups, thresholds, and aggregation strategy live in config.js.
// Indices are resolved from YAMNet's class map at startup so a label typo
// fails loudly instead of silently mapping to the wrong class.
const SOUNDS = resolveGroups(SOUND_GROUPS, YAMNET_CLASS_NAMES);

// Dump the resolved mapping so it can be visually sanity-checked.
console.log(formatResolutionTable(SOUNDS));

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

let THRESHOLD_MULTIPLIER = THRESHOLD_MULTIPLIER_RANGE.default;
thresholdSlider.value = String(THRESHOLD_MULTIPLIER);
thresholdVal.textContent = THRESHOLD_MULTIPLIER.toFixed(2) + "×";
thresholdSlider.oninput = () => {
  THRESHOLD_MULTIPLIER = parseFloat(thresholdSlider.value);
  thresholdVal.textContent = THRESHOLD_MULTIPLIER.toFixed(2) + "×";
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
// YAMNet expects mono 16 kHz float32 audio in [-1, 1]. Most mics run at
// 44.1/48 kHz so we resample (proper interpolation via OfflineAudioContext).
// Windows are WINDOW_S long, polled every POLL_MS. Each inference yields
// multiple YAMNet frames (~0.96s window, 0.48s hop inside the model) which
// we push into a rolling ScoreBuffer for cross-window aggregation — this is
// what suppresses per-frame noise.
const YAMNET_SR = 16000;
const MODEL_URL = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1";

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

const scoreBuffer = new ScoreBuffer();
const cooldown = new CooldownGate(COOLDOWN_MS);

// Diagnostic ring buffer — top-5 per frame with timestamps. Only populated
// when DEBUG is on. Exported as JSONL via the settings button.
const debugRing = [];
function debugPush(entry) {
  if (!DEBUG) return;
  debugRing.push(entry);
  if (debugRing.length > DEBUG_RING_SIZE) debugRing.shift();
}

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

// Compute summary stats over a Float32Array for the pre-inference debug log.
function waveformStats(arr) {
  let mn = Infinity, mx = -Infinity, sum = 0, sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / arr.length;
  const rms = Math.sqrt(sumSq / arr.length);
  return { min: mn, max: mx, mean, rms };
}

// Core detection loop — runs every POLL_MS while listening.
// 1. Snap the most recent WINDOW_S of mic samples, resample to 16 kHz mono float32
// 2. Run YAMNet — yields a [frames × 521] tensor
// 3. Push each frame into the rolling ScoreBuffer (last AGGREGATION.windowSec)
// 4. Aggregate (consecutive-N or average) and check each group's per-class threshold
// 5. Per-group cooldown prevents alert spam
async function runInference() {
  if (!model || !listening) return;

  const need = Math.ceil(nativeSR * WINDOW_S);
  if (samples.length < need) return;

  const snap = Float32Array.from(samples.slice(-need));

  let wv, s0, arr;
  try {
    const s16 = await resample(snap, nativeSR);
    // clamp to [-1, 1] — occasional mic spikes can push values out of range
    const cl = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) cl[i] = Math.max(-1, Math.min(1, s16[i]));

    // Silence gate: skip inference on essentially-silent input to keep noise
    // predictions out of the rolling buffer (one quiet frame can briefly
    // poison an averaging window). Computed before tensor allocation.
    const st = waveformStats(cl);
    if (MIN_RMS > 0 && st.rms < MIN_RMS) {
      console.debug(
        `[YAMNet skip] rms=${st.rms.toFixed(5)} < ${MIN_RMS} (silence gate)`
      );
      return;
    }

    wv = window.tf.tensor1d(cl);
    // Debug log immediately before inference — verifies shape/dtype/range.
    console.debug(
      `[YAMNet input] shape=[${wv.shape.join(",")}] dtype=${wv.dtype} ` +
      `len=${cl.length} min=${st.min.toFixed(4)} max=${st.max.toFixed(4)} ` +
      `mean=${st.mean.toFixed(4)} rms=${st.rms.toFixed(4)}`
    );

    const out = model.execute({ waveform: wv });
    s0 = Array.isArray(out) ? out[0] : out;
    // Keep all frames — push them individually into the rolling buffer so
    // aggregation operates on raw per-frame scores, not within-window means.
    arr = await s0.array(); // [frames, 521]
  } catch (e) {
    addLog("Inference error: " + e.message);
    return;
  } finally {
    wv?.dispose();
    s0?.dispose();
  }

  const tNow = Date.now();
  const frames = Array.isArray(arr[0]) ? arr : [arr];
  // Stagger frame timestamps backwards so the buffer's time-based eviction
  // approximates real frame arrival times (YAMNet hop is ~0.48s).
  const hopMs = 480;
  frames.forEach((f, i) => {
    const t = tNow - (frames.length - 1 - i) * hopMs;
    scoreBuffer.push(f, t);
    if (DEBUG) {
      const top5 = Array.from(f)
        .map((v, idx) => [idx, v])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([idx, v]) => ({ index: idx, label: YAMNET_CLASS_NAMES[idx], score: +v.toFixed(4) }));
      debugPush({ t, top5 });
      console.debug("[frame top5]", new Date(t).toISOString(), top5);
    }
  });

  const hit = pickBestFiring(SOUNDS, scoreBuffer, enabled, THRESHOLD_MULTIPLIER, AGGREGATION, TOP_K_GATE);
  if (!hit) return;
  if (!cooldown.ready(hit.group.id, tNow)) return;
  cooldown.mark(hit.group.id, tNow);

  const { group: best, score: bestScore } = hit;
  showAlert(best, bestScore);
  addLog(
    `${best.emoji} ${best.label} — score ${bestScore.toFixed(3)} ` +
    `(thr ${effectiveThreshold(best, THRESHOLD_MULTIPLIER).toFixed(2)}, ${AGGREGATION.strategy})`
  );
  beep(best.tier);
  notify(best);
  await sendEmail(best, bestScore);
  await saveSoundEvent(best, bestScore);
  await flashScreen(3);
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
  scoreBuffer.clear();
  listening = false;

  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  if (statusEl) statusEl.textContent = "Stopped";
  if (statusOrb) statusOrb.classList.remove("listening");

  addLog("Stopped.");
}

startBtn.onclick = startListening;
stopBtn.onclick = stopListening;

// Diagnostic mode wiring — only revealed when DEBUG is on.
if (DEBUG) {
  const row = document.getElementById("debugRow");
  if (row) row.style.display = "";
  const btn = document.getElementById("downloadDebug");
  if (btn) {
    btn.onclick = () => {
      const body = debugRing.map(e => JSON.stringify(e)).join("\n");
      const blob = new Blob([body], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notify-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }
  addLog(`Diagnostic mode ON — buffering up to ${DEBUG_RING_SIZE} frames.`);
}

// ── Background noise calibration ─────────────────────────────────────────────
// Opens the mic for 10 s, measures the actual noise floor via an AnalyserNode,
// then nudges THRESHOLD_MULTIPLIER so the detector is less hair-trigger in
// noisy rooms and more sensitive in quiet ones.
(function initCalibration() {
  const modal        = document.getElementById("calibModal");
  const backdrop     = document.getElementById("calibBackdrop");
  const startBtn     = document.getElementById("calibStartBtn");
  const doneBtn      = document.getElementById("calibDoneBtn");
  const progressWrap = document.getElementById("calibProgressWrap");
  const resultWrap   = document.getElementById("calibResultWrap");
  const phaseEl      = document.getElementById("calibPhase");
  const levelBar     = document.getElementById("calibLevelBar");
  const progressBar  = document.getElementById("calibProgressBar");
  const countdown    = document.getElementById("calibCountdown");
  const settingDesc  = document.getElementById("calibSettingDesc");
  const launchBtn    = document.getElementById("calibrateBtn");

  const PHASES = [
    { at: 0,    msg: "Recording baseline noise…" },
    { at: 3500, msg: "Analyzing frequency profile…" },
    { at: 6500, msg: "Computing noise compensation…" },
    { at: 8800, msg: "Applying calibration profile…" },
  ];

  function openModal() {
    modal.classList.add("open");
    progressWrap.hidden = true;
    resultWrap.hidden   = true;
    startBtn.hidden     = false;
    doneBtn.hidden      = true;
    document.getElementById("calibModalDesc").textContent =
      "Keep the room at its normal noise level, then start the 10-second recording. The detector will adapt its sensitivity to your environment.";
  }

  function closeModal() { modal.classList.remove("open"); }

  launchBtn.onclick   = openModal;
  backdrop.onclick    = () => { if (!startBtn.hidden || doneBtn.hidden === false) closeModal(); };
  doneBtn.onclick     = closeModal;

  startBtn.onclick = async () => {
    startBtn.hidden = true;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
    } catch {
      document.getElementById("calibModalDesc").textContent =
        "Microphone access denied. Allow microphone access and try again.";
      startBtn.hidden = false;
      return;
    }

    const ctx      = new AudioContext();
    const src      = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    const timeBuf = new Float32Array(analyser.fftSize);
    const DURATION = 10000;
    const start    = Date.now();
    let rmsSum = 0, rmsCount = 0, peakRms = 0, phaseIdx = 0;

    progressWrap.hidden = false;
    phaseEl.textContent = PHASES[0].msg;

    await new Promise(resolve => {
      const tick = () => {
        const elapsed = Date.now() - start;
        const pct     = Math.min(elapsed / DURATION, 1);

        progressBar.style.width = (pct * 100) + "%";
        countdown.textContent   = Math.max(0, Math.ceil((DURATION - elapsed) / 1000)) + "s";

        while (phaseIdx < PHASES.length - 1 && elapsed >= PHASES[phaseIdx + 1].at) {
          phaseIdx++;
          phaseEl.textContent = PHASES[phaseIdx].msg;
        }

        analyser.getFloatTimeDomainData(timeBuf);
        let sumSq = 0;
        for (let i = 0; i < timeBuf.length; i++) sumSq += timeBuf[i] * timeBuf[i];
        const rms = Math.sqrt(sumSq / timeBuf.length);
        rmsSum += rms;
        rmsCount++;
        if (rms > peakRms) peakRms = rms;

        // Scale the live bar so typical room noise (rms ~0.01–0.04) reads 30–80%
        levelBar.style.width = Math.min(rms / 0.05, 1) * 100 + "%";

        pct < 1 ? requestAnimationFrame(tick) : resolve();
      };
      requestAnimationFrame(tick);
    });

    src.disconnect();
    stream.getTracks().forEach(t => t.stop());
    ctx.close();

    const avgRms  = rmsCount > 0 ? rmsSum / rmsCount : 0;
    const floorDb = avgRms  > 0 ? 20 * Math.log10(avgRms)  : -96;
    const peakDb  = peakRms > 0 ? 20 * Math.log10(peakRms) : -96;

    // Noisier rooms need a higher threshold to avoid false positives;
    // quieter rooms can afford a lower one. Adjustment is capped to ±0.25.
    // Floor of -50 dBFS is the neutral point (typical quiet office).
    const rawAdj   = (-floorDb - 50) / 120;
    const adjDelta = Math.max(-0.25, Math.min(0.25, rawAdj));
    const newMult  = Math.max(0.7, Math.min(1.8, THRESHOLD_MULTIPLIER + adjDelta));

    THRESHOLD_MULTIPLIER       = newMult;
    thresholdSlider.value      = String(newMult.toFixed(2));
    thresholdVal.textContent   = newMult.toFixed(2) + "×";

    const profile = { timestamp: Date.now(), floorDb: floorDb.toFixed(1), peakDb: peakDb.toFixed(1), multiplier: newMult.toFixed(2) };
    localStorage.setItem("audio-detector-calibration", JSON.stringify(profile));

    const adjSign = adjDelta >= 0 ? "+" : "";
    const adjPct  = (adjDelta * 100).toFixed(0);

    progressWrap.hidden = true;
    resultWrap.hidden   = false;
    resultWrap.innerHTML = `
      <div class="calib-metric"><span class="calib-metric-label">Noise floor</span><span class="calib-metric-value">${floorDb.toFixed(1)} dBFS</span></div>
      <div class="calib-metric"><span class="calib-metric-label">Peak level</span><span class="calib-metric-value">${peakDb.toFixed(1)} dBFS</span></div>
      <div class="calib-metric"><span class="calib-metric-label">Threshold adjustment</span><span class="calib-metric-value">${adjSign}${adjPct}%</span></div>
      <div class="calib-metric"><span class="calib-metric-label">New sensitivity</span><span class="calib-metric-value">${newMult.toFixed(2)}×</span></div>
    `;

    document.getElementById("calibModalDesc").textContent = "Calibration complete. Detection thresholds have been adjusted for your environment.";
    doneBtn.hidden = false;

    settingDesc.textContent = `Last calibrated · floor ${floorDb.toFixed(1)} dBFS`;
    addLog(`Calibration complete — noise floor ${floorDb.toFixed(1)} dBFS, threshold → ${newMult.toFixed(2)}×`);
  };

  // Restore badge text if a prior calibration exists
  const saved = localStorage.getItem("audio-detector-calibration");
  if (saved) {
    try {
      const p = JSON.parse(saved);
      settingDesc.textContent = `Last calibrated · floor ${p.floorDb} dBFS`;
    } catch {}
  }
})();

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
