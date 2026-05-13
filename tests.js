// Zero-dep tests for detection logic. Open tests.html to run.
import {
  ScoreBuffer,
  groupScoreOnFrame,
  groupInTopK,
  aggregateAverage,
  aggregateConsecutive,
  aggregate,
  pickBestFiring,
  effectiveThreshold,
  resolveGroups,
  CooldownGate,
} from "./detection.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: e?.message || String(e) });
  }
}
function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b} got ${a}`);
}
function approx(a, b, tol = 1e-6, msg = "") {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} expected ~${b} got ${a}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
function falsy(v, msg) { if (v) throw new Error(msg || "expected falsy"); }

// Test fixtures: 521-vec scores. Group indices [0, 1, 2].
function frame(values = {}) {
  const f = new Float32Array(521);
  for (const [k, v] of Object.entries(values)) f[+k] = v;
  return f;
}
const G = { id: "g", indices: [0, 1, 2], threshold: 0.2, yamnetLabels: [] };

// ── groupScoreOnFrame ────────────────────────────────────────────────────────
test("groupScoreOnFrame returns max over member indices", () => {
  const f = frame({ 0: 0.1, 1: 0.7, 2: 0.3, 100: 0.99 });
  approx(groupScoreOnFrame(G, f), 0.7);
});

test("groupScoreOnFrame returns 0 when all members are 0", () => {
  approx(groupScoreOnFrame(G, frame()), 0);
});

// ── ScoreBuffer ──────────────────────────────────────────────────────────────
test("ScoreBuffer evicts frames older than windowSec", () => {
  const b = new ScoreBuffer(1.0); // 1 second
  b.push(frame({ 0: 0.5 }), 1000);
  b.push(frame({ 0: 0.6 }), 1500);
  b.push(frame({ 0: 0.7 }), 2200); // evicts t=1000 (cutoff = 1200)
  eq(b.size(), 2);
});

// ── aggregateAverage ─────────────────────────────────────────────────────────
test("aggregateAverage fires when mean clears threshold", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.3 }), 1000);
  b.push(frame({ 1: 0.5 }), 1500);
  b.push(frame({ 2: 0.4 }), 2000);
  const r = aggregateAverage(G, b, 0.3);
  truthy(r.fired, "should fire: mean=0.4");
  approx(r.score, 0.4, 1e-6);
});

test("aggregateAverage does not fire below threshold", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.1 }), 1000);
  b.push(frame({ 0: 0.1 }), 1500);
  const r = aggregateAverage(G, b, 0.3);
  falsy(r.fired);
});

test("aggregateAverage on empty buffer does not fire", () => {
  const r = aggregateAverage(G, new ScoreBuffer(5), 0.1);
  falsy(r.fired);
  approx(r.score, 0);
});

// ── aggregateConsecutive ─────────────────────────────────────────────────────
test("aggregateConsecutive fires after N trailing frames clear threshold", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.1 }), 1000); // miss
  b.push(frame({ 1: 0.5 }), 1500); // hit
  b.push(frame({ 2: 0.6 }), 2000); // hit
  b.push(frame({ 0: 0.4 }), 2500); // hit
  const r = aggregateConsecutive(G, b, 0.3, 3);
  truthy(r.fired);
  approx(r.score, 0.6);
});

test("aggregateConsecutive (strict) does not fire when run is broken at the tail", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.5 }), 1000);
  b.push(frame({ 0: 0.5 }), 1500);
  b.push(frame({ 0: 0.5 }), 2000);
  b.push(frame({ 0: 0.1 }), 2500); // breaks the run at newest
  const r = aggregateConsecutive(G, b, 0.3, 3, 0); // strict: no gap tolerance
  falsy(r.fired);
});

test("aggregateConsecutive needs at least N frames", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.9 }), 1000);
  b.push(frame({ 0: 0.9 }), 1500);
  const r = aggregateConsecutive(G, b, 0.3, 3);
  falsy(r.fired);
});

// ── effectiveThreshold + multiplier ──────────────────────────────────────────
test("effectiveThreshold multiplies per-class threshold", () => {
  approx(effectiveThreshold({ threshold: 0.2 }, 1.5), 0.30);
  approx(effectiveThreshold({ threshold: 0.4 }, 0.5), 0.20);
});

test("effectiveThreshold falls back to default when threshold unset", () => {
  approx(effectiveThreshold({}, 1.0), 0.20, 1e-9);
});

// ── pickBestFiring ───────────────────────────────────────────────────────────
test("pickBestFiring picks highest-scoring firing group, skips disabled", () => {
  const A = { id: "a", indices: [0], threshold: 0.2 };
  const B = { id: "b", indices: [1], threshold: 0.2 };
  const C = { id: "c", indices: [2], threshold: 0.2 };
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.5, 1: 0.9, 2: 0.4 }), 1000);
  b.push(frame({ 0: 0.5, 1: 0.9, 2: 0.4 }), 1500);
  b.push(frame({ 0: 0.5, 1: 0.9, 2: 0.4 }), 2000);
  const hit = pickBestFiring([A, B, C], b, { a: true, b: false, c: true }, 1.0, {
    strategy: "consecutive", N: 3, windowSec: 5,
  });
  eq(hit.group.id, "a"); // b is disabled even though it scored higher
});

test("pickBestFiring returns null when nothing fires", () => {
  const A = { id: "a", indices: [0], threshold: 0.5 };
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.1 }), 1000);
  const hit = pickBestFiring([A], b, { a: true }, 1.0, {
    strategy: "average", windowSec: 5,
  });
  eq(hit, null);
});

test("pickBestFiring multiplier raises the bar", () => {
  const A = { id: "a", indices: [0], threshold: 0.3 };
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.4 }), 1000);
  b.push(frame({ 0: 0.4 }), 1500);
  b.push(frame({ 0: 0.4 }), 2000);
  const cfg = { strategy: "consecutive", N: 3, windowSec: 5 };
  truthy(pickBestFiring([A], b, { a: true }, 1.0, cfg), "fires at 1.0×");
  eq(pickBestFiring([A], b, { a: true }, 2.0, cfg), null); // 0.3*2=0.6 > 0.4
});

// ── resolveGroups ────────────────────────────────────────────────────────────
test("resolveGroups maps labels to indices in order", () => {
  const classNames = ["Speech", "Bark", "Dog", "Yip"];
  const groups = [{ id: "dog", yamnetLabels: ["Bark", "Dog", "Yip"], threshold: 0.2 }];
  const r = resolveGroups(groups, classNames);
  eq(r[0].indices, [1, 2, 3]);
  eq(r[0].resolvedPairs.length, 3);
});

test("resolveGroups throws on missing label (no silent drop)", () => {
  const classNames = ["Speech", "Bark"];
  const groups = [{ id: "dog", yamnetLabels: ["Bark", "Howl"], threshold: 0.2 }];
  let threw = false;
  try { resolveGroups(groups, classNames); } catch (e) { threw = /Howl/.test(e.message); }
  truthy(threw, "expected throw mentioning the missing label");
});

// ── CooldownGate ─────────────────────────────────────────────────────────────
test("CooldownGate is per-id and respects ms", () => {
  const c = new CooldownGate(1000);
  truthy(c.ready("x", 0));
  c.mark("x", 0);
  falsy(c.ready("x", 500));
  truthy(c.ready("y", 500), "different id is independent");
  truthy(c.ready("x", 1000));
});

// ── per-label weights ────────────────────────────────────────────────────────
test("groupScoreOnFrame applies per-label weights", () => {
  const G2 = { id: "g", indices: [0, 1, 2], weights: [1.0, 0.5, 1.0] };
  // raw scores 0.4, 0.7, 0.3 → weighted 0.4, 0.35, 0.3 → max 0.4 from index 0
  approx(groupScoreOnFrame(G2, frame({ 0: 0.4, 1: 0.7, 2: 0.3 })), 0.4);
});

test("weight downweighting prevents a generic label from triggering alone", () => {
  // smoke_alarm-style: specific=1.0, generic "Beep, bleep"-style=0.55
  const G2 = { id: "smoke", indices: [10, 20], weights: [1.0, 0.55] };
  const f = frame({ 10: 0.10, 20: 0.30 });  // only generic fires raw
  // weighted: 0.10, 0.165 → max 0.165 — below 0.20
  const b = new ScoreBuffer(5);
  b.push(f, 1000); b.push(f, 1500); b.push(f, 2000);
  const r = aggregate(G2, b, 0.20, { strategy: "consecutive", N: 3, windowSec: 5, allowGapsUpTo: 0 });
  falsy(r.fired);
});

// ── gap-tolerant consecutive ─────────────────────────────────────────────────
test("aggregateConsecutive with allowGapsUpTo=1 tolerates one dip", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.4 }), 500);   // hit
  b.push(frame({ 0: 0.1 }), 1000);  // miss (dip)
  b.push(frame({ 0: 0.4 }), 1500);  // hit
  b.push(frame({ 0: 0.5 }), 2000);  // hit  -> 3 hits in last 4 frames
  const r = aggregateConsecutive(G, b, 0.3, 3, 1);
  truthy(r.fired);
  approx(r.score, 0.5);
});

test("aggregateConsecutive with allowGapsUpTo=0 still requires strict run", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.4 }), 500);
  b.push(frame({ 0: 0.1 }), 1000);  // breaks strict run
  b.push(frame({ 0: 0.4 }), 1500);
  b.push(frame({ 0: 0.5 }), 2000);
  const r = aggregateConsecutive(G, b, 0.3, 3, 0);
  falsy(r.fired);
});

// ── groupInTopK ──────────────────────────────────────────────────────────────
test("groupInTopK returns true when a member is among top-K", () => {
  const f = frame({ 0: 0.5, 100: 0.4, 200: 0.3 });
  truthy(groupInTopK(G, f, 3));  // index 0 is the highest
});

test("groupInTopK returns false when all members are outside top-K", () => {
  const f = new Float32Array(521);
  // pack 10 large values at indices 100..109; group indices [0,1,2] all = 0
  for (let i = 100; i < 110; i++) f[i] = 0.5 + i * 0.001;
  falsy(groupInTopK(G, f, 5));
});

test("groupInTopK with K >= 521 always returns true", () => {
  truthy(groupInTopK(G, frame(), 521));
});

// ── pickBestFiring with top-K gate ───────────────────────────────────────────
test("pickBestFiring rejects firing group not in any frame's top-K", () => {
  const A = { id: "a", indices: [0], threshold: 0.2 };
  const b = new ScoreBuffer(5);
  // Group A scores 0.25 but tons of other classes score 0.4+ in same frames
  const buildBig = () => {
    const f = frame({ 0: 0.25 });
    for (let i = 100; i < 200; i++) f[i] = 0.4 + i * 0.0001;
    return f;
  };
  b.push(buildBig(), 1000);
  b.push(buildBig(), 1500);
  b.push(buildBig(), 2000);
  const cfg = { strategy: "consecutive", N: 3, windowSec: 5, allowGapsUpTo: 0 };
  // Without top-K gate (K=521), would fire
  truthy(pickBestFiring([A], b, { a: true }, 1.0, cfg, 521));
  // With strict top-K=10, rejected
  eq(pickBestFiring([A], b, { a: true }, 1.0, cfg, 10), null);
});

// ── resolveGroups with weights ───────────────────────────────────────────────
test("resolveGroups carries labelWeights into weights array", () => {
  const classNames = ["A", "B", "C"];
  const groups = [{
    id: "g", yamnetLabels: ["A", "B", "C"],
    labelWeights: { "B": 0.5, "C": 0.25 },
    threshold: 0.2,
  }];
  const r = resolveGroups(groups, classNames);
  eq(r[0].weights, [1.0, 0.5, 0.25]);
});

test("resolveGroups throws if labelWeights references a non-member label", () => {
  const classNames = ["A", "B"];
  const groups = [{ id: "g", yamnetLabels: ["A"], labelWeights: { "B": 0.5 }, threshold: 0.2 }];
  let threw = false;
  try { resolveGroups(groups, classNames); } catch (e) { threw = /labelWeights/.test(e.message); }
  truthy(threw);
});

// ── aggregate dispatcher ─────────────────────────────────────────────────────
test("aggregate routes by strategy name", () => {
  const b = new ScoreBuffer(5);
  b.push(frame({ 0: 0.5 }), 1000);
  b.push(frame({ 0: 0.5 }), 1500);
  b.push(frame({ 0: 0.5 }), 2000);
  truthy(aggregate(G, b, 0.3, { strategy: "average", windowSec: 5 }).fired);
  truthy(aggregate(G, b, 0.3, { strategy: "consecutive", N: 3, windowSec: 5 }).fired);
  let threw = false;
  try { aggregate(G, b, 0.3, { strategy: "nope" }); } catch { threw = true; }
  truthy(threw, "unknown strategy should throw");
});

// ── Render ───────────────────────────────────────────────────────────────────
const out = document.getElementById("out");
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
const lines = [`${pass}/${results.length} passed${fail ? `, ${fail} FAILED` : ""}`, ""];
for (const r of results) {
  lines.push(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : "\n    " + r.err}`);
}
out.textContent = lines.join("\n");
out.className = fail ? "fail" : "pass";
