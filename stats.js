/**
 * stats.js — Audio Detector stats dashboard
 *
 * KEY FIXES vs previous version:
 *  1. No compound Firestore index needed — queries only on userId,
 *     then filters by date client-side. Avoids the "missing index" error
 *     that was silently killing the page.
 *  2. Errors are shown on-screen, not swallowed.
 *  3. showState() uses both .hidden AND display style so it works
 *     regardless of what styles.css does to those elements.
 *  4. detectedAt is null-safe (serverTimestamp() is null on the client
 *     briefly after addDoc — we skip those docs instead of crashing).
 */

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// ── Colours ───────────────────────────────────────────────────────────────────
const COLORS = ["#4f9cf9","#f97b4f","#4ff9b6","#f9d44f","#c97bf9","#f94f7b","#7bf94f","#4fc5f9"];

// ── State ─────────────────────────────────────────────────────────────────────
let allDetections = [];
let activeDays    = 7;
let charts        = {};

// ── DOM ───────────────────────────────────────────────────────────────────────
const loadingEl = document.getElementById("loadingState");
const emptyEl   = document.getElementById("emptyState");
const contentEl = document.getElementById("statsContent");
const emailEl   = document.getElementById("userEmail");

// ── Auth ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  if (!user) { window.location.href = "index.html"; return; }
  emailEl.textContent = user.email;
  document.getElementById("signOutBtn").onclick = () => signOut(auth);
  loadData(user.uid, activeDays);
});

// ── Period buttons ────────────────────────────────────────────────────────────
document.querySelectorAll(".filter-btn[data-days]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn[data-days]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeDays = parseInt(btn.dataset.days, 10);
    if (auth.currentUser) loadData(auth.currentUser.uid, activeDays);
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────
document.getElementById("exportCsvBtn").addEventListener("click", () => {
  if (!allDetections.length) return;
  const csv = [
    ["timestamp","label","confidence"].join(","),
    ...allDetections.map(d =>
      [new Date(d.ts).toISOString(), `"${d.label}"`, d.confidence.toFixed(4)].join(",")
    )
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `detections_${activeDays}d.csv`;
  a.click();
});

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData(uid, days) {
  showState("loading");
  destroyCharts();

  const cutoff = Date.now() - days * 86400_000;

  try {
    // Single-field query — no composite index required
    const snap = await getDocs(
      query(collection(db, "sound_events"), where("userId", "==", uid))
    );

    allDetections = snap.docs
      .map(doc => {
        const d = doc.data();
        // detectedAt can be null right after addDoc (serverTimestamp pending)
        const ts = d.detectedAt?.toDate?.().getTime() ?? null;
        if (!ts) return null;
        return {
          label:      d.soundLabel  ?? "Unknown",
          confidence: typeof d.confidence === "number" ? d.confidence : 0,
          ts,
        };
      })
      .filter(d => d !== null && d.ts >= cutoff)
      .sort((a, b) => a.ts - b.ts);

    if (!allDetections.length) {
      showState("empty");
      return;
    }

    showState("content");
    renderDashboard(allDetections, days);

  } catch (err) {
    console.error("Firestore error:", err);
    showError(err.message || String(err));
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderDashboard(data, days) {
  const labels   = [...new Set(data.map(d => d.label))];
  const colorMap = Object.fromEntries(labels.map((l, i) => [l, COLORS[i % COLORS.length]]));
  renderKPIs(data, days);
  renderTimeline(data, labels, colorMap);
  renderDonut(data, labels, colorMap);
  renderScatter(data, labels, colorMap);
  renderHeatmap(data);
  renderTable(data, labels, colorMap);
}

function renderKPIs(data, days) {
  const total   = data.length;
  const hc      = Array(24).fill(0);
  data.forEach(d => hc[new Date(d.ts).getHours()]++);
  const peakH = hc.indexOf(Math.max(...hc));
  const lc = {};
  data.forEach(d => lc[d.label] = (lc[d.label] ?? 0) + 1);
  const topLabel = Object.entries(lc).sort((a,b) => b[1]-a[1])[0]?.[0] ?? "—";

  document.getElementById("kpiStrip").innerHTML = [
    { v: total,             l: `Detections (${days}d)`, c: "#4f9cf9" },
    { v: fmtHour(peakH),    l: "Peak hour",             c: "#f9d44f" },
    { v: topLabel,          l: "Top sound",             c: "#f97b4f" },
  ].map(k => `
    <div class="kpi" style="--accent-color:${k.c}">
      <div class="kpi-value">${k.v}</div>
      <div class="kpi-label">${k.l}</div>
    </div>
  `).join("");
}

function renderTimeline(data, labels, colorMap) {
  const buckets = {};
  data.forEach(d => {
    const day = dayKey(d.ts);
    buckets[day] ??= {};
    buckets[day][d.label] = (buckets[day][d.label] ?? 0) + 1;
  });
  const days = Object.keys(buckets).sort(compareDayKeys);

  charts.timeline = new Chart(document.getElementById("timelineChart"), {
    type: "bar",
    data: {
      labels: days,
      datasets: labels.map(lbl => ({
        label: lbl,
        data:  days.map(k => buckets[k]?.[lbl] ?? 0),
        backgroundColor: hex2rgba(colorMap[lbl], 0.75),
        borderColor: colorMap[lbl],
        borderWidth: 1,
        borderRadius: 3,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: legendOpts() },
      scales: {
        x: { stacked: true, ...axisOpts() },
        y: { stacked: true, ...axisOpts(), ticks: { ...tickOpts(), stepSize: 1 } },
      }
    }
  });
}

function renderDonut(data, labels, colorMap) {
  const counts = {};
  data.forEach(d => counts[d.label] = (counts[d.label] ?? 0) + 1);
  charts.donut = new Chart(document.getElementById("donutChart"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: labels.map(l => counts[l] ?? 0),
        backgroundColor: labels.map(l => colorMap[l]),
        borderWidth: 0,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "65%",
      plugins: { legend: { ...legendOpts(), position: "right" } }
    }
  });
}

function renderScatter(data, labels, colorMap) {
  charts.scatter = new Chart(document.getElementById("scatterChart"), {
    type: "scatter",
    data: {
      datasets: labels.map(lbl => ({
        label: lbl,
        data: data.filter(d => d.label === lbl)
                  .map(d => ({ x: d.ts, y: +(d.confidence * 100).toFixed(1) })),
        backgroundColor: hex2rgba(colorMap[lbl], 0.65),
        pointRadius: 4, pointHoverRadius: 6,
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: legendOpts() },
      scales: {
        x: { type: "time", time: { tooltipFormat: "MMM d, h:mm a" }, ...axisOpts() },
        y: {
          min: 0, max: 100,
          title: { display: true, text: "Confidence %", color: "#6b7280", font: { size: 10 } },
          ticks: { ...tickOpts(), callback: v => v + "%" },
          grid: { color: "#252933" }
        }
      }
    }
  });
}

function renderHeatmap(data) {
  const DAYS  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const count = Array.from({length:7}, () => Array(24).fill(0));
  data.forEach(d => { const dt = new Date(d.ts); count[dt.getDay()][dt.getHours()]++; });
  const max = Math.max(1, ...count.flat());
  const el  = document.getElementById("heatmapContainer");

  const hrLabels = Array.from({length:24}, (_,h) =>
    `<div class="heatmap-hour-label">${h===0?"12a":h<12?h+"a":h===12?"12p":(h-12)+"p"}</div>`
  ).join("");

  const rows = DAYS.map((day, dow) => {
    const cells = Array.from({length:24}, (_,h) => {
      const v = count[dow][h];
      const bg = v > 0 ? `rgba(79,156,249,${(0.12 + v/max*0.88).toFixed(2)})` : "var(--stats-border)";
      return `<div class="heatmap-cell" style="background:${bg}" title="${day} ${fmtHour(h)}: ${v}"></div>`;
    }).join("");
    return `<div class="heatmap-day-label">${day}</div>${cells}`;
  }).join("");

  el.innerHTML = `
    <div class="heatmap-hour-labels"><div></div>${hrLabels}</div>
    <div class="heatmap-grid">${rows}</div>
  `;
}

function renderTable(data, labels, colorMap) {
  document.getElementById("summaryTableBody").innerHTML = labels.map(lbl => {
    const rows    = data.filter(d => d.label === lbl);
    const count   = rows.length;
    const lastTs  = Math.max(...rows.map(d => d.ts));
    const hc      = Array(24).fill(0);
    rows.forEach(d => hc[new Date(d.ts).getHours()]++);
    const peak = hc.indexOf(Math.max(...hc));
    return `<tr>
      <td><div class="sound-pill">
        <span class="sound-dot" style="background:${colorMap[lbl]}"></span>${lbl}
      </div></td>
      <td>${count}</td>
      <td>${fmtHour(peak)}</td>
      <td>${fmtRelTime(lastTs)}</td>
    </tr>`;
  }).join("");
}

// ── UI state ──────────────────────────────────────────────────────────────────
function showState(state) {
  // Use both hidden attribute AND display style to defeat any CSS interference
  const states = { loading: loadingEl, empty: emptyEl, content: contentEl };
  Object.entries(states).forEach(([s, el]) => {
    const active = s === state;
    el.hidden = !active;
    el.style.display = active ? (s === "content" ? "block" : "") : "none";
  });
}

function showError(msg) {
  loadingEl.hidden = true;
  loadingEl.style.display = "none";
  emptyEl.hidden = false;
  emptyEl.style.display = "";
  emptyEl.textContent = `Error loading data: ${msg}`;
}

function destroyCharts() {
  Object.values(charts).forEach(c => { try { c.destroy(); } catch {} });
  charts = {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()}`;
}
function compareDayKeys(a, b) {
  const [am,ad] = a.split("/").map(Number);
  const [bm,bd] = b.split("/").map(Number);
  return am !== bm ? am - bm : ad - bd;
}
function hex2rgba(hex, a) {
  const [r,g,b] = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  return `rgba(${r},${g},${b},${a})`;
}
function fmtHour(h) {
  if (h===0)  return "12 AM";
  if (h<12)   return `${h} AM`;
  if (h===12) return "12 PM";
  return `${h-12} PM`;
}
function fmtRelTime(ts) {
  const m = Math.floor((Date.now()-ts)/60000);
  if (m<1)   return "Just now";
  if (m<60)  return `${m}m ago`;
  if (m<1440) return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}
function legendOpts() {
  return { labels: { color:"#6b7280", font:{family:"DM Mono",size:11}, boxWidth:10 } };
}
function tickOpts() {
  return { color:"#6b7280", font:{family:"DM Mono",size:10} };
}
function axisOpts() {
  return { ticks: tickOpts(), grid: { color:"#252933" } };
}
