// All tunable detection parameters live here. Tune values without touching code.
//
// SOUND_GROUPS — user-facing categories. Each group's `yamnetLabels` lists
// exact display_name strings from yamnet_class_map.csv. The resolver in
// classMap.js converts these to indices at startup and throws if any label
// is missing (no silent drops). Per-group score = max over member class scores.
//
// THRESHOLD_DEFAULT — used for any group whose `threshold` is unset.
// Per-class values are the source of truth; the UI slider acts as a global
// multiplier (see THRESHOLD_MULTIPLIER_RANGE).
//
// Thresholds below are starting points only — they MUST be tuned empirically
// against real recordings. Use diagnostic mode (?debug=1) to capture top-5
// frame predictions and pick values that separate signal from noise.

export const THRESHOLD_DEFAULT = 0.20;
export const THRESHOLD_MULTIPLIER_RANGE = { min: 0.5, max: 2.0, default: 1.0 };

// Aggregation across multiple inference frames to suppress single-frame noise.
//   strategy "average":     mean per-class score across the buffer ≥ threshold
//   strategy "consecutive": within the last (N + allowGapsUpTo) trailing frames,
//                           ≥ N must clear threshold. With allowGapsUpTo=0 this
//                           is strict consecutive; >0 lets one frame dip without
//                           breaking the run (helps with short audio dropouts).
//   windowSec:              how many seconds of frames to keep in the buffer
//   N:                      required hit count (only used in "consecutive")
//   allowGapsUpTo:          tolerated misses within the tail window
export const AGGREGATION = {
  strategy: "consecutive",
  N: 3,
  allowGapsUpTo: 1,
  windowSec: 3.0,
};

// Cooldown between alerts for the same group (ms).
export const COOLDOWN_MS = 3000;

// Inference window / poll cadence.
// WINDOW_S = 1.92 yields ~3 YAMNet frames per call (hop = 0.48s, frame = 0.96s)
// which is a sweet spot — smoother aggregation than 1.5s without much extra cost.
export const WINDOW_S = 1.92;
export const POLL_MS = 750;

// Silence gate: skip inference entirely when the input window's RMS is below
// this floor. Prevents YAMNet from emitting noisy low-confidence predictions
// on pure background hiss. Tune lower if the room is unusually quiet and you
// want extra sensitivity. Set to 0 to disable.
export const MIN_RMS = 0.004;

// Top-K eligibility: a group is only considered if at least one of its member
// classes appears in the top-K of at least one contributing frame. Keeps
// pure-noise frames (where the target isn't even close) from leaking through.
// Set to 521 (or a large number) to effectively disable.
export const TOP_K_GATE = 30;

// Debug mode: enable via ?debug=1 in URL or localStorage.setItem("notify.debug","1").
// When on, every frame's top-5 predictions are appended to an in-memory ring
// buffer (exportable as JSONL) and printed to console.debug.
export const DEBUG = (() => {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("debug") === "1") return true;
    if (localStorage.getItem("notify.debug") === "1") return true;
  } catch {}
  return false;
})();

export const DEBUG_RING_SIZE = 2000;

// User-facing groups. yamnetLabels must match display_name in
// yamnet_class_map.csv exactly (case + punctuation). Resolver fails loudly
// on any mismatch.
//
// labelWeights: optional per-member multiplier in [0, 1+]. The score that
// contributes to the group max is `frameScore[label] * weight`. Use weights
// to keep useful-but-broad labels in the group without letting them trigger
// alone — e.g. "Beep, bleep" stays in smoke_alarm but at 0.6× so a generic
// beep can't fire the fire alarm by itself. Defaults to 1.0.
export const SOUND_GROUPS = [
  // --- danger ---
  {
    id: "smoke_alarm",
    label: "Fire Alarm",
    emoji: "🚨",
    tier: "danger",
    notif: "Fire alarm detected — check your surroundings!",
    threshold: 0.20,
    yamnetLabels: [
      "Smoke detector, smoke alarm",
      "Fire alarm",
      "Alarm",
      "Beep, bleep",
    ],
    labelWeights: {
      "Alarm": 0.75,           // generic alarm — could be many things
      "Beep, bleep": 0.55,     // very generic — microwaves, timers, notifications
    },
  },
  {
    id: "glass_breaking",
    label: "Glass Shatter",
    emoji: "💥",
    tier: "danger",
    notif: "Glass breaking detected!",
    threshold: 0.20,
    yamnetLabels: ["Glass", "Shatter"],
    labelWeights: { "Glass": 0.85 }, // "Shatter" is more specific
  },

  // --- warn ---
  {
    id: "baby_crying",
    label: "Baby Crying",
    emoji: "👶",
    tier: "warn",
    notif: "Baby crying detected.",
    threshold: 0.20,
    yamnetLabels: ["Baby cry, infant cry", "Crying, sobbing"],
    labelWeights: { "Crying, sobbing": 0.80 }, // adult crying ≠ baby; trust the specific class more
  },
  {
    id: "siren",
    label: "Siren",
    emoji: "🚓",
    tier: "warn",
    notif: "Emergency siren detected nearby.",
    threshold: 0.20,
    yamnetLabels: [
      "Siren",
      "Emergency vehicle",
      "Police car (siren)",
      "Ambulance (siren)",
    ],
  },
  {
    id: "horn",
    label: "Horn",
    emoji: "📯",
    tier: "warn",
    notif: "Horn detected nearby.",
    threshold: 0.20,
    yamnetLabels: [
      "Vehicle horn, car horn, honking",
      "Toot",
      "Air horn, truck horn",
    ],
    labelWeights: { "Toot": 0.70 }, // very generic short sound
  },
  {
    id: "reversing",
    label: "Reversing Beeps",
    emoji: "🔁",
    tier: "warn",
    notif: "Reversing vehicle detected.",
    threshold: 0.20,
    yamnetLabels: ["Reversing beeps"],
  },

  // --- info ---
  {
    id: "doorbell",
    label: "Doorbell",
    emoji: "🔔",
    tier: "info",
    notif: "Someone rang the doorbell.",
    threshold: 0.20,
    yamnetLabels: ["Doorbell", "Ding-dong", "Bell"],
    labelWeights: { "Bell": 0.60 }, // covers church/cow/jingle bells; downweight
  },
  {
    id: "knock",
    label: "Knock",
    emoji: "✊",
    tier: "info",
    notif: "Knocking detected.",
    threshold: 0.25,                 // single-class group — slightly stricter
    yamnetLabels: ["Knock"],
  },
  {
    id: "phone_ringing",
    label: "Telephone Ringing",
    emoji: "📞",
    tier: "info",
    notif: "Telephone ringing.",
    threshold: 0.20,
    yamnetLabels: ["Telephone bell ringing", "Ringtone", "Telephone"],
    labelWeights: { "Telephone": 0.55 }, // matches general phone audio (e.g. someone on a call)
  },
  {
    id: "alarm_clock",
    label: "Alarm Clock",
    emoji: "⏰",
    tier: "info",
    notif: "Alarm clock going off.",
    threshold: 0.25,
    yamnetLabels: ["Alarm clock"],
  },
  {
    id: "dog_barking",
    label: "Dog Barking",
    emoji: "🐕",
    tier: "info",
    notif: "Dog barking detected.",
    threshold: 0.20,
    yamnetLabels: ["Bark", "Dog", "Yip"],
    labelWeights: { "Dog": 0.75 },   // "Dog" can hit on panting/whining; "Bark" is the strong signal
  },
  {
    id: "microwave",
    label: "Microwave",
    emoji: "📡",
    tier: "info",
    notif: "Microwave beep detected.",
    threshold: 0.30,
    yamnetLabels: ["Microwave oven"],
  },
  {
    id: "vacuum",
    label: "Vacuum Cleaner",
    emoji: "🌀",
    tier: "info",
    notif: "Vacuum cleaner detected.",
    threshold: 0.35,
    yamnetLabels: ["Vacuum cleaner"],
  },
];
