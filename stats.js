import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
  Timestamp,
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

const userEmailEl = document.getElementById("userEmail");
const signOutBtn = document.getElementById("signOutBtn");
const darkSetting = document.getElementById("darkSetting");
const filterButtons = [...document.querySelectorAll(".filter-btn")];
const loadingState = document.getElementById("loadingState");
const emptyState = document.getElementById("emptyState");
const statsContent = document.getElementById("statsContent");
const summaryTableBody = document.getElementById("summaryTableBody");
const barCanvas = document.getElementById("barChart");
const scatterCanvas = document.getElementById("scatterChart");

let selectedDays = 7;
let barChart = null;
let scatterChart = null;
let latestRows = [];

const theme = localStorage.getItem("audio-detector-theme") || "light";
document.body.classList.toggle("dark", theme === "dark");

if (darkSetting) {
  darkSetting.checked = theme === "dark";

  darkSetting.addEventListener("change", () => {
    const isDark = darkSetting.checked;
    document.body.classList.toggle("dark", isDark);
    localStorage.setItem("audio-detector-theme", isDark ? "dark" : "light");

    if (!statsContent.hidden && latestRows.length > 0) {
      renderCharts(latestRows);
    }
  });
}

if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const days = Number(button.dataset.days);
    if (days === selectedDays) return;

    selectedDays = days;
    filterButtons.forEach((btn) => btn.classList.toggle("active", btn === button));

    if (auth.currentUser) {
      loadStats(auth.currentUser.uid);
    }
  });
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  if (userEmailEl) {
    userEmailEl.textContent = user.email || "Signed in";
  }

  loadStats(user.uid);
});

async function loadStats(userId) {
  setState("loading");

  const cutoffDate = new Date(Date.now() - selectedDays * 24 * 60 * 60 * 1000);

  try {
    const eventsQuery = query(
      collection(db, "sound_events"),
      where("userId", "==", userId),
      where("detectedAt", ">=", Timestamp.fromDate(cutoffDate)),
      orderBy("detectedAt", "desc")
    );

    const snapshot = await getDocs(eventsQuery);

    const rows = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const detectedAt = data.detectedAt?.toDate?.();

        if (!detectedAt || Number.isNaN(detectedAt.getTime())) {
          return null;
        }

        return {
          id: doc.id,
          soundLabel: String(data.soundLabel || "Unknown"),
          confidence: clamp(Number(data.confidence ?? 0), 0, 1),
          detectedAt,
        };
      })
      .filter(Boolean);

    latestRows = rows;
    window.__statsRows = rows;

    if (rows.length === 0) {
      destroyCharts();
      summaryTableBody.innerHTML = "";
      setState("empty");
      return;
    }

    renderCharts(rows);
    renderSummaryTable(rows);
    setState("content");
  } catch (error) {
    console.error("Failed to load stats:", error);
    latestRows = [];
    destroyCharts();
    summaryTableBody.innerHTML = `
      <tr>
        <td colspan="4">Failed to load stats: ${escapeHtml(error.message || "Unknown error")}</td>
      </tr>
    `;
    setState("content");
  }
}

function setState(state) {
  loadingState.hidden = state !== "loading";
  emptyState.hidden = state !== "empty";
  statsContent.hidden = state !== "content";
}

function renderCharts(rows) {
  if (typeof Chart === "undefined") {
    console.error("Chart.js is not loaded.");
    summaryTableBody.innerHTML = `
      <tr>
        <td colspan="4">Chart.js failed to load, so the charts cannot be displayed.</td>
      </tr>
    `;
    return;
  }

  const summary = buildSummary(rows);
  renderBarChart(summary);
  renderScatterChart(rows, summary.labels);
}

function buildSummary(rows) {
  const map = new Map();

  for (const row of rows) {
    const existing = map.get(row.soundLabel) || {
      soundLabel: row.soundLabel,
      count: 0,
      lastDetected: row.detectedAt,
      confidenceSum: 0,
    };

    existing.count += 1;
    existing.confidenceSum += row.confidence;

    if (row.detectedAt > existing.lastDetected) {
      existing.lastDetected = row.detectedAt;
    }

    map.set(row.soundLabel, existing);
  }

  const items = [...map.values()].sort(
    (a, b) => b.count - a.count || a.soundLabel.localeCompare(b.soundLabel)
  );

  return {
    items,
    labels: items.map((item) => item.soundLabel),
  };
}

function renderBarChart(summary) {
  if (!barCanvas) return;

  if (barChart) {
    barChart.destroy();
    barChart = null;
  }

  barChart = new Chart(barCanvas, {
    type: "bar",
    data: {
      labels: summary.items.map((item) => item.soundLabel),
      datasets: [
        {
          label: "Detections",
          data: summary.items.map((item) => item.count),
          borderWidth: 1,
          borderRadius: 8,
        },
      ],
    },
    options: chartOptions({
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return `Detections: ${context.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 0,
            minRotation: 0,
            autoSkip: false,
          },
          title: {
            display: true,
            text: "Sound label",
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0,
          },
          title: {
            display: true,
            text: "Detection count",
          },
        },
      },
    }),
  });
}

function renderScatterChart(rows, labels) {
  if (!scatterCanvas) return;

  if (scatterChart) {
    scatterChart.destroy();
    scatterChart = null;
  }

  const labelIndex = new Map(labels.map((label, index) => [label, index]));

  const points = rows
    .map((row) => {
      const yIndex = labelIndex.get(row.soundLabel);
      if (yIndex == null) return null;

      return {
        x: row.detectedAt.getHours() + row.detectedAt.getMinutes() / 60,
        y: yIndex,
        r: 4 + row.confidence * 12,
        soundLabel: row.soundLabel,
        confidence: row.confidence,
        detectedAt: row.detectedAt,
      };
    })
    .filter(Boolean);

  scatterChart = new Chart(scatterCanvas, {
    type: "bubble",
    data: {
      datasets: [
        {
          label: "Detections",
          data: points,
        },
      ],
    },
    options: chartOptions({
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const point = context.raw;
              return `${point.soundLabel} • ${point.detectedAt.toLocaleString()} • confidence ${point.confidence.toFixed(3)}`;
            },
          },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 24,
          ticks: {
            stepSize: 1,
            callback: (value) => `${Math.floor(value)}:00`,
          },
          title: {
            display: true,
            text: "Hour of day",
          },
        },
        y: {
          min: -0.5,
          max: Math.max(labels.length - 0.5, 0.5),
          ticks: {
            stepSize: 1,
            callback: (value) => {
              const index = Math.round(value);
              return labels[index] || "";
            },
          },
          title: {
            display: true,
            text: "Sound label",
          },
        },
      },
    }),
  });
}

function renderSummaryTable(rows) {
  const summary = buildSummary(rows);

  summaryTableBody.innerHTML = summary.items
    .map((item) => {
      const avgConfidence = item.confidenceSum / item.count;

      return `
        <tr>
          <td>${escapeHtml(item.soundLabel)}</td>
          <td>${item.count}</td>
          <td>${escapeHtml(item.lastDetected.toLocaleString())}</td>
          <td>${avgConfidence.toFixed(3)}</td>
        </tr>
      `;
    })
    .join("");
}

function chartOptions(extra = {}) {
  const isDark = document.body.classList.contains("dark");
  const tickColor = isDark ? "#cbd5e1" : "#475569";
  const gridColor = isDark ? "rgba(148, 163, 184, 0.15)" : "rgba(15, 23, 42, 0.08)";

  const mergedScales = {};
  const inputScales = extra.scales || {};

  for (const [key, config] of Object.entries(inputScales)) {
    mergedScales[key] = {
      grid: { color: gridColor },
      ticks: { color: tickColor, ...(config.ticks || {}) },
      title: { color: tickColor, ...(config.title || {}) },
      ...config,
    };
  }

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: mergedScales,
    plugins: {
      legend: {
        labels: { color: tickColor },
      },
      ...(extra.plugins || {}),
    },
    elements: {
      point: {
        hoverRadius: 10,
      },
      ...(extra.elements || {}),
    },
    ...extra,
    scales: mergedScales,
  };
}

function destroyCharts() {
  if (barChart) {
    barChart.destroy();
    barChart = null;
  }

  if (scatterChart) {
    scatterChart.destroy();
    scatterChart = null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
