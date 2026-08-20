// public/app.js
//
// Código compartido por el panel (index.html) y la ficha de país (pais.html):
// formato, métricas, el gráfico SVG y la carga manual desde GDELT.

// ================= CONFIG =================
export const API_URL = "/api/geopolitical-data";
export const REFRESH_MS = 10 * 60 * 1000; // 10 min — barato: solo lee la caché

// ================= FORMATO =================
export const toneColor = (v) =>
  v === null || v === undefined || Number.isNaN(v) ? "#64748b"
  : v <= -6 ? "#f87171" : v <= -3 ? "#fb923c" : v < 1 ? "#facc15" : v < 4 ? "#a3e635" : "#34d399";

export const fmt = (v, digits = 2) =>
  (v === null || v === undefined || Number.isNaN(v)) ? "—" : (v > 0 ? "+" : "") + v.toFixed(digits);

export const fmtDate = (d) => d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
export const fmtTime = (d) => d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
export const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ================= MÉTRICAS =================
// avg7d / delta7d se calculan sobre los últimos 7 días REALES (por fecha), no
// sobre "los últimos N puntos": GDELT devuelve resolución horaria en las
// ventanas cortas, así que contar puntos daba medias de unas pocas horas.
export function computeMetrics(series) {
  const pts = cleanSeries(series);
  if (pts.length === 0) return { last: null, avg7d: null, delta7d: null };

  const end = pts[pts.length - 1].date.getTime();
  const DAY = 86400000;
  const inWindow = (from, to) => pts.filter((p) => p.date.getTime() > end - to * DAY && p.date.getTime() <= end - from * DAY);
  const mean = (arr) => (arr.length ? arr.reduce((a, p) => a + p.tone, 0) / arr.length : null);

  const last = pts[pts.length - 1].tone;
  const week = inWindow(0, 7);
  const prevWeek = inWindow(7, 14);
  const avg7d = mean(week.length ? week : pts);
  const prevAvg = mean(prevWeek);
  // Con histórico suficiente: media de los últimos 7 días vs. los 7 previos.
  // Recién desplegado solo hay una ventana de 7 días, así que se cae al
  // criterio antiguo (último punto vs. la media de los anteriores).
  const delta7d = prevAvg !== null ? avg7d - prevAvg
    : pts.length > 1 ? last - mean(pts.slice(0, -1))
    : null;
  return { last, avg7d, delta7d };
}

export function cleanSeries(series) {
  return (series || [])
    .filter((p) => p && p.date instanceof Date && !Number.isNaN(p.date.getTime()) && Number.isFinite(p.tone))
    .sort((a, b) => a.date - b.date);
}

// ================= EJES =================
// Escala "bonita": marcas en múltiplos redondos (1, 2, 2.5, 5, 10 · 10^n) en
// lugar de repartir el rango de los datos en 4 trozos arbitrarios. Es lo que
// hace que los ejes NO bailen en cada refresco: mientras los datos no crucen
// una marca, los topes y las etiquetas del eje siguen siendo los mismos.
function niceNum(range, round) {
  if (!(range > 0)) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  const nf = round
    ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
    : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}

export function niceScale(min, max, maxTicks = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
  if (min > max) [min, max] = [max, min];
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const step = niceNum(niceNum(max - min, false) / Math.max(maxTicks - 1, 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) ticks.push(+(lo + i * step).toFixed(10));
  return { min: lo, max: hi, step, ticks };
}

// Marcas temporales en intervalos "de calendario" (horas, días, semanas,
// meses) alineadas a múltiplos exactos, no repartiendo el rango en N trozos:
// así las etiquetas caen en fechas redondas y no se repiten entre sí.
const TIME_STEPS = [
  36e5, 2 * 36e5, 3 * 36e5, 6 * 36e5, 12 * 36e5,
  864e5, 2 * 864e5, 7 * 864e5, 14 * 864e5,
  30 * 864e5, 61 * 864e5, 91 * 864e5, 182 * 864e5, 365 * 864e5,
];

export function timeTicks(minT, maxT, maxTicks = 7) {
  const span = Math.max(maxT - minT, 1);
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const ticks = [];
  for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) ticks.push(t);
  if (ticks.length < 2) return { ticks: [minT, maxT], step };
  return { ticks, step };
}

function tickLabel(t, step) {
  const d = new Date(t);
  if (step < 864e5) return fmtTime(d);
  if (step < 30 * 864e5) return fmtDate(d);
  return d.toLocaleDateString("es-ES", { month: "short", year: "2-digit" });
}

// ================= GRÁFICO =================
// Devuelve el SVG y los datos que necesita el tooltip. El SVG no lleva altura
// fija en píxeles: con viewBox + width:100% escala solo y no queda encajado
// dentro de una caja de otra proporción (que era lo que dejaba los ejes
// descolocados al cambiar de tamaño la ventana).
export function chartSVG(series, opts = {}) {
  const W = opts.width ?? 1000;
  const H = opts.height ?? 340;
  const mL = 54, mR = 20, mT = 20, mB = 40;
  const plotW = W - mL - mR;
  const plotH = H - mT - mB;

  const pts = cleanSeries(series);
  if (pts.length < 2) {
    return { html: `<div class="text-xs text-slate-500 italic p-6 text-center">Sin datos suficientes para dibujar el gráfico.</div>`, points: [] };
  }

  const minT = pts[0].date.getTime();
  const maxT = pts[pts.length - 1].date.getTime();
  const tSpan = Math.max(maxT - minT, 1);

  // Dominio Y: rango de los datos + 8% de aire, forzando que el 0 esté
  // siempre dentro (el tono se lee respecto al 0) y redondeado a marcas.
  const ys = pts.map((p) => p.tone);
  const dMin = Math.min(...ys), dMax = Math.max(...ys);
  const pad = Math.max((dMax - dMin) * 0.08, 0.2);
  const scale = niceScale(Math.min(dMin - pad, 0), Math.max(dMax + pad, 0), 6);

  const X = (t) => mL + ((t - minT) / tSpan) * plotW;
  const Y = (v) => mT + (1 - (v - scale.min) / (scale.max - scale.min)) * plotH;

  // --- eje Y ---
  let gridY = "";
  for (const v of scale.ticks) {
    const gy = Y(v);
    const isZero = Math.abs(v) < 1e-9;
    gridY += `<line x1="${mL}" y1="${gy.toFixed(1)}" x2="${mL + plotW}" y2="${gy.toFixed(1)}" stroke="${isZero ? "#46608f" : "#1b2942"}" stroke-width="1"/>`
      + `<text x="${mL - 8}" y="${(gy + 3.5).toFixed(1)}" font-size="11" fill="${isZero ? "#94a3b8" : "#64748b"}" text-anchor="end" font-family="Inter, sans-serif" font-variant-numeric="tabular-nums">${formatTick(v, scale.step)}</text>`;
  }

  // --- eje X ---
  const nTicks = Math.max(2, Math.min(8, Math.round(plotW / 110)));
  const { ticks, step } = timeTicks(minT, maxT, nTicks);
  let gridX = "";
  for (const t of ticks) {
    const gx = X(t);
    const anchor = gx < mL + 26 ? "start" : gx > mL + plotW - 26 ? "end" : "middle";
    const tx = anchor === "start" ? mL : anchor === "end" ? mL + plotW : gx;
    gridX += `<line x1="${gx.toFixed(1)}" y1="${mT}" x2="${gx.toFixed(1)}" y2="${mT + plotH}" stroke="#141f33" stroke-width="1"/>`
      + `<line x1="${gx.toFixed(1)}" y1="${mT + plotH}" x2="${gx.toFixed(1)}" y2="${mT + plotH + 5}" stroke="#3b4d70" stroke-width="1"/>`
      + `<text x="${tx.toFixed(1)}" y="${mT + plotH + 20}" font-size="11" fill="#94a3b8" text-anchor="${anchor}" font-family="Inter, sans-serif">${tickLabel(t, step)}</text>`;
  }

  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${X(p.date.getTime()).toFixed(1)} ${Y(p.tone).toFixed(1)}`).join(" ");
  const baseY = Y(Math.max(scale.min, Math.min(0, scale.max)));
  const areaD = `${d} L ${X(maxT).toFixed(1)} ${baseY.toFixed(1)} L ${X(minT).toFixed(1)} ${baseY.toFixed(1)} Z`;
  const col = toneColor(pts[pts.length - 1].tone);

  // Los puntos solo se dibujan si caben sin apelmazarse; el tooltip funciona
  // igual con series largas (busca el punto más cercano al ratón).
  const dots = pts.length <= plotW / 14
    ? pts.map((p) => `<circle cx="${X(p.date.getTime()).toFixed(1)}" cy="${Y(p.tone).toFixed(1)}" r="2.5" fill="${toneColor(p.tone)}"/>`).join("")
    : "";

  const html = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"
      style="width:100%;height:auto;display:block;overflow:visible" data-chart>
    <rect x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="#0a1223"/>
    ${gridX}${gridY}
    <path d="${areaD}" fill="${col}1f"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <line x1="${mL}" y1="${mT}" x2="${mL}" y2="${mT + plotH}" stroke="#2b3b5b" stroke-width="1"/>
    <line x1="${mL}" y1="${mT + plotH}" x2="${mL + plotW}" y2="${mT + plotH}" stroke="#2b3b5b" stroke-width="1"/>
    <text x="${mL}" y="${mT - 7}" font-size="11" fill="#64748b" font-family="Inter, sans-serif">${escapeHtml(opts.yLabel ?? "AvgTone")}</text>
    <g data-cursor style="display:none">
      <line y1="${mT}" y2="${mT + plotH}" stroke="#64748b" stroke-width="1" stroke-dasharray="3,3"/>
      <circle r="4.5" fill="#0d1525" stroke="#e2e8f0" stroke-width="2"/>
    </g>
    <rect data-hit x="${mL}" y="${mT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"/>
  </svg>`;

  return {
    html,
    points: pts.map((p) => ({ t: p.date.getTime(), v: p.tone, x: X(p.date.getTime()), y: Y(p.tone) })),
    box: { W, H, mL, mR, mT, mB, plotW, plotH },
  };
}

function formatTick(v, step) {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(decimals);
}

// Pinta el gráfico dentro de `container` y engancha el tooltip.
// El lienzo se elige según el ancho disponible: en móvil se usa un viewBox
// más estrecho y proporcionalmente más alto para que las etiquetas de los
// ejes no acaben en 4 px (con un viewBox de 1000 de ancho encogido a 350,
// los números del eje eran ilegibles).
export function renderChart(container, series, opts = {}) {
  const cw = container.clientWidth || 900;
  const dims = cw < 560
    ? { width: 420, height: opts.compactHeight ?? 340 }
    : { width: 1000, height: opts.height ?? 340 };

  // Repintar solo si cambia el formato del lienzo al redimensionar.
  if (!container._chartResize) {
    let last = dims.width;
    container._chartResize = () => {
      const w = (container.clientWidth || 900) < 560 ? 420 : 1000;
      if (w === last) return;
      last = w;
      renderChart(container, container._chartSeries, container._chartOpts);
    };
    addEventListener("resize", container._chartResize);
  }
  container._chartSeries = series;
  container._chartOpts = opts;

  const { html, points, box } = chartSVG(series, { ...opts, ...dims });
  container.style.position = "relative";
  container.innerHTML = html + `<div data-tip class="pointer-events-none absolute hidden z-10 rounded-md px-2.5 py-1.5 text-[11px] leading-tight"
      style="background:#111c31;border:1px solid #2b3b5b;box-shadow:0 6px 18px rgba(0,0,0,.45);white-space:nowrap"></div>`;
  if (!points.length) return;

  const svg = container.querySelector("[data-chart]");
  const hit = svg.querySelector("[data-hit]");
  const cursor = svg.querySelector("[data-cursor]");
  const line = cursor.querySelector("line");
  const dot = cursor.querySelector("circle");
  const tip = container.querySelector("[data-tip]");

  const hide = () => { cursor.style.display = "none"; tip.classList.add("hidden"); };

  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * box.W;
    let best = points[0];
    for (const p of points) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;

    line.setAttribute("x1", best.x); line.setAttribute("x2", best.x);
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y);
    dot.setAttribute("stroke", toneColor(best.v));
    cursor.style.display = "";

    tip.innerHTML = `<div class="text-slate-400">${escapeHtml(fmtDateTime(new Date(best.t)))}</div>`
      + `<div class="font-semibold" style="color:${toneColor(best.v)}">AvgTone ${fmt(best.v, 2)}</div>`;
    tip.classList.remove("hidden");
    const px = (best.x / box.W) * rect.width;
    const py = (best.y / box.H) * rect.height;
    tip.style.left = `${Math.min(Math.max(px + 12, 4), rect.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(py - tip.offsetHeight - 10, 4)}px`;
  });
  hit.addEventListener("mouseleave", hide);
}

// ================= CARGA DE DATOS =================
export async function loadPanelData() {
  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error);

  const meta = payload.meta || [];
  const countries = {};
  for (const c of meta) {
    const series = ((payload.countries && payload.countries[c.code]) || [])
      .map((p) => ({ date: new Date(p.date), tone: p.tone }));
    countries[c.code] = { series, ...computeMetrics(series), error: series.length ? null : "sin dato" };
  }

  // Titulares por país. `iranArticles` es el formato antiguo del blob: se usa
  // como respaldo hasta que la rotación guarde el mapa `articles`.
  const articlesByCode = { ...(payload.articles || {}) };
  if (!articlesByCode.IRN && payload.iranArticles) articlesByCode.IRN = payload.iranArticles;
  const articles = {};
  for (const [code, list] of Object.entries(articlesByCode)) {
    articles[code] = (list || []).map((a) => ({ ...a, date: a.date ? new Date(a.date) : null }));
  }

  return {
    meta,
    countries,
    articles,
    iranExtended: (payload.iranExtended14d || []).map((p) => ({ date: new Date(p.date), tone: p.tone })),
    updatedAtServer: payload.updatedAt ? new Date(payload.updatedAt) : null,
    taskUpdatedAt: payload.taskUpdatedAt || {},
  };
}

// ================= CARGA MANUAL DESDE GDELT =================
// GDELT a veces tarda >10 s en responder (más que el límite de las funciones
// de Netlify), así que la descarga la hace ESTE navegador y luego se manda a
// /api/ingest, que valida y guarda.
const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function gdeltUrl(task) {
  const q = encodeURIComponent(task.query);
  if (task.kind === "articles") {
    return `${GDELT_BASE}?query=${q}&mode=artlist&maxrecords=${task.max}&sort=DateDesc&format=json`;
  }
  return `${GDELT_BASE}?query=${q}&mode=timelinetone&timespan=${task.days}d&format=json`;
}

export async function runTask(task) {
  const res = await fetch(gdeltUrl(task), { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const j = await res.json();
  const body = task.kind === "articles"
    ? { articles: j.articles || [] }
    : { points: j.timeline?.[0]?.data || [] };

  const ing = await fetch(`/api/ingest?target=${encodeURIComponent(task.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ing.ok) throw new Error(`ingest HTTP ${ing.status}`);
  return (await ing.json()).ok;
}

export async function fetchTaskList() {
  const res = await fetch("/api/trigger-fetch");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).tasks || [];
}

// ================= LISTA DE NOTICIAS =================
export function newsListHTML(articles, { empty = "Sin titulares guardados todavía." } = {}) {
  if (!articles || !articles.length) {
    return `<li class="text-slate-500 italic col-span-full">${escapeHtml(empty)}</li>`;
  }
  return articles.map((a) => `
    <li class="card rounded-lg p-3 flex flex-col gap-1.5">
      <a class="headline text-slate-200 leading-snug text-sm font-medium" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title || "(sin título)")}</a>
      <div class="flex items-center justify-between text-[10px] text-slate-500 mt-auto pt-1">
        <span title="Fuente e idioma">${escapeHtml(a.domain || "?")} · ${escapeHtml(a.language || "?")}</span>
        <span title="Fecha de indexación · tono del artículo">${a.date ? escapeHtml(fmtDateTime(a.date)) : ""} · tono <span style="color:${toneColor(a.tone)}">${Number.isFinite(a.tone) ? fmt(a.tone, 1) : "—"}</span></span>
      </div>
    </li>`).join("");
}
