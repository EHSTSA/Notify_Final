// Detection helpers: class-map resolution, multi-frame aggregation, thresholding.
// Pure functions where possible so tests.html can exercise them without a model.

import { YAMNET_CLASS_NAMES } from "./yamnet_class_map.js";
import {
  SOUND_GROUPS,
  AGGREGATION,
  THRESHOLD_DEFAULT,
  COOLDOWN_MS,
  TOP_K_GATE,
} from "./config.js";

// ── Class-map resolution ─────────────────────────────────────────────────────
// Build a label → index map once. Used by resolveGroups() to convert each
// group's yamnetLabels into integer indices. Fails loudly on any miss.
function buildLabelIndex(classNames) {
  const m = new Map();
  classNames.forEach((name, i) => m.set(name, i));
  return m;
}

export function resolveGroups(groups = SOUND_GROUPS, classNames = YAMNET_CLASS_NAMES) {
  const labelIndex = buildLabelIndex(classNames);
  const missing = [];
  const resolved = groups.map(g => {
    const indices = [];
    const weights = [];
    const pairs = [];
    const lw = g.labelWeights || {};
    for (const lbl of g.yamnetLabels) {
      const idx = labelIndex.get(lbl);
      if (idx === undefined) {
        missing.push({ group: g.id, label: lbl });
      } else {
        const w = lw[lbl] ?? 1.0;
        indices.push(idx);
        weights.push(w);
        pairs.push({ label: lbl, index: idx, weight: w });
      }
    }
    // Also flag weights that reference labels not actually in the group —
    // catches typos like { "Doorbel": 0.5 } that would otherwise silently no-op.
    for (const k of Object.keys(lw)) {
      if (!g.yamnetLabels.includes(k)) {
        missing.push({ group: g.id, label: `labelWeights["${k}"] (not in yamnetLabels)` });
      }
    }
    return { ...g, indices, weights, resolvedPairs: pairs };
  });

  if (missing.length) {
    const lines = missing.map(m => `  - group "${m.group}": label "${m.label}" not in YAMNet class map`);
    throw new Error(
      "SOUND_GROUPS contains labels missing from yamnet_class_map.csv:\n" +
      lines.join("\n") +
      "\nFix labels in config.js (case + punctuation must match exactly)."
    );
  }
  return resolved;
}

// Print the resolved label → index → weight table for sanity-checking.
export function formatResolutionTable(resolvedGroups) {
  const lines = ["YAMNet class resolution:"];
  for (const g of resolvedGroups) {
    lines.push(`  [${g.id}] ${g.label}  (threshold ${g.threshold ?? THRESHOLD_DEFAULT})`);
    for (const p of g.resolvedPairs) {
      const wTag = p.weight === 1 ? "" : `  ×${p.weight.toFixed(2)}`;
      lines.push(`     ${String(p.index).padStart(3, " ")}  ${p.label}${wTag}`);
    }
  }
  return lines.join("\n");
}

// ── Score buffer ─────────────────────────────────────────────────────────────
// Holds the last `windowSec` worth of per-frame 521-vectors plus their
// timestamps. YAMNet emits one frame per ~0.48 s of audio, so a 2.5 s
// buffer holds ~5 frames.
export class ScoreBuffer {
  constructor(windowSec = AGGREGATION.windowSec) {
    this.windowSec = windowSec;
    this.frames = []; // { t: ms, scores: Float32Array(521) }
  }
  push(scores, tMs = Date.now()) {
    this.frames.push({ t: tMs, scores });
    const cutoff = tMs - this.windowSec * 1000;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }
  clear() { this.frames = []; }
  size() { return this.frames.length; }
}

// Compute the group's score on a single frame as max over (member score × weight).
// Weights default to 1.0 for backward compatibility with groups that omit them.
export function groupScoreOnFrame(group, frameScores) {
  let best = 0;
  const weights = group.weights;
  for (let k = 0; k < group.indices.length; k++) {
    const i = group.indices[k];
    const w = weights ? weights[k] : 1.0;
    const v = (frameScores[i] ?? 0) * w;
    if (v > best) best = v;
  }
  return best;
}

// True if any of the group's member classes appears in the top-K of `frameScores`.
// Used by the top-K eligibility gate — keeps target sounds that the model
// considers very unlikely (not even in top-K) from being raised by noise.
export function groupInTopK(group, frameScores, K = TOP_K_GATE) {
  if (K >= frameScores.length) return true;
  // Build a small set of member indices for O(1) lookup
  const member = new Set(group.indices);
  // Find the K-th highest score with a partial selection
  // (K is small relative to 521, so a single scan w/ min-heap-equivalent works)
  // Simple approach: collect top-K scores via insertion into a sorted array.
  const top = []; // ascending
  for (let i = 0; i < frameScores.length; i++) {
    const s = frameScores[i];
    if (top.length < K) {
      // insert sorted
      let j = top.length;
      while (j > 0 && top[j - 1] > s) { top[j] = top[j - 1]; j--; }
      top[j] = s;
    } else if (s > top[0]) {
      // replace smallest, re-sort one step
      top[0] = s;
      let j = 0;
      while (j + 1 < K && top[j + 1] < top[j]) { const t = top[j]; top[j] = top[j + 1]; top[j + 1] = t; j++; }
    }
  }
  const kthScore = top[0];
  // any member with score ≥ kthScore is in top-K
  for (const i of member) {
    if ((frameScores[i] ?? 0) >= kthScore) return true;
  }
  return false;
}

// ── Aggregation strategies ───────────────────────────────────────────────────
// Both return { fired: bool, score: number } per group.
// `score` is the value used for the alert UI / Firestore.

export function aggregateAverage(group, buffer, effectiveThreshold) {
  if (!buffer.frames.length) return { fired: false, score: 0 };
  let sum = 0;
  for (const f of buffer.frames) sum += groupScoreOnFrame(group, f.scores);
  const avg = sum / buffer.frames.length;
  return { fired: avg >= effectiveThreshold, score: avg };
}

// Within the last (N + allowGapsUpTo) trailing frames, require ≥ N hits.
// allowGapsUpTo = 0 reproduces strict consecutive behavior.
export function aggregateConsecutive(
  group, buffer, effectiveThreshold,
  N = AGGREGATION.N, allowGapsUpTo = AGGREGATION.allowGapsUpTo ?? 0,
) {
  if (buffer.frames.length < N) return { fired: false, score: 0 };
  const tailLen = Math.min(buffer.frames.length, N + allowGapsUpTo);
  let hits = 0, misses = 0, runMax = 0;
  for (let i = buffer.frames.length - 1; i >= buffer.frames.length - tailLen; i--) {
    const s = groupScoreOnFrame(group, buffer.frames[i].scores);
    if (s >= effectiveThreshold) {
      hits++;
      if (s > runMax) runMax = s;
    } else {
      misses++;
      if (misses > allowGapsUpTo) break;
    }
    if (hits >= N) return { fired: true, score: runMax };
  }
  return { fired: false, score: runMax };
}

export function aggregate(group, buffer, effectiveThreshold, cfg = AGGREGATION) {
  if (cfg.strategy === "average") return aggregateAverage(group, buffer, effectiveThreshold);
  if (cfg.strategy === "consecutive") {
    return aggregateConsecutive(group, buffer, effectiveThreshold, cfg.N, cfg.allowGapsUpTo ?? 0);
  }
  throw new Error(`Unknown aggregation strategy: ${cfg.strategy}`);
}

// ── Threshold helpers ────────────────────────────────────────────────────────
export function effectiveThreshold(group, multiplier = 1.0) {
  const base = group.threshold ?? THRESHOLD_DEFAULT;
  return base * multiplier;
}

// Pick the highest-scoring group whose aggregation fires. Returns null otherwise.
// Applies the top-K gate: a firing group must also have at least one member
// class in the top-K of at least one buffered frame.
export function pickBestFiring(
  resolvedGroups, buffer, enabledMap, multiplier,
  cfg = AGGREGATION, topK = TOP_K_GATE,
) {
  let best = null;
  let bestScore = 0;
  for (const g of resolvedGroups) {
    if (enabledMap && enabledMap[g.id] === false) continue;
    const thr = effectiveThreshold(g, multiplier);
    const r = aggregate(g, buffer, thr, cfg);
    if (!r.fired) continue;
    // top-K gate: cheap rejection of "noise floor" detections
    let inTopK = false;
    for (const f of buffer.frames) {
      if (groupInTopK(g, f.scores, topK)) { inTopK = true; break; }
    }
    if (!inTopK) continue;
    if (r.score > bestScore) {
      best = { group: g, score: r.score };
      bestScore = r.score;
    }
  }
  return best;
}

// ── Cooldown gate (per-group) ────────────────────────────────────────────────
export class CooldownGate {
  constructor(ms = COOLDOWN_MS) { this.ms = ms; this.last = new Map(); }
  ready(id, now = Date.now()) {
    if (!this.last.has(id)) return true;
    return now - this.last.get(id) >= this.ms;
  }
  mark(id, now = Date.now()) { this.last.set(id, now); }
}
