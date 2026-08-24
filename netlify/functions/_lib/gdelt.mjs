// netlify/functions/_lib/gdelt.mjs

export const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

// Subido a 2000 para que nunca recorte el histórico de la guerra
export const MAX_POINTS_KEPT = 2000;

export const COUNTRIES = [
  { code: "ISR", name: "Israel", flag: "🇮🇱", region: "Oriente Medio", query: "Israel" },
  { code: "IRN", name: "Irán", flag: "🇮🇷", region: "Oriente Medio", query: "Iran" },
  { code: "USA", name: "Estados Unidos", flag: "🇺🇸", region: "América", query: '"United States"' },
  { code: "LBN", name: "Líbano (Hezbolá)", flag: "🇱🇧", region: "Oriente Medio", query: "(Lebanon OR Hezbollah)" },
  { code: "YEM", name: "Yemen (Hutíes)", flag: "🇾🇪", region: "Oriente Medio", query: "(Yemen OR Houthi)" },
  { code: "SYR", name: "Siria", flag: "🇸🇾", region: "Oriente Medio", query: "Syria" },
  { code: "IRQ", name: "Irak", flag: "🇮🇶", region: "Oriente Medio", query: "Iraq" },
  { code: "SAU", name: "Arabia Saudita", flag: "🇸🇦", region: "Oriente Medio", query: '"Saudi Arabia"' },
  { code: "ARE", name: "Emiratos Árabes Unidos", flag: "🇦🇪", region: "Oriente Medio", query: '"United Arab Emirates"' },
  { code: "QAT", name: "Catar", flag: "🇶🇦", region: "Oriente Medio", query: "Qatar" },
  { code: "KWT", name: "Kuwait", flag: "🇰🇼", region: "Oriente Medio", query: "Kuwait" },
  { code: "BHR", name: "Baréin", flag: "🇧🇭", region: "Oriente Medio", query: "Bahrain" },
  { code: "OMN", name: "Omán", flag: "🇴🇲", region: "Oriente Medio", query: "Oman" },
];

// Cálculo automático de días desde febrero de 2026
const FEB_2026_START = new Date("2026-02-01T00:00:00Z");
const DAYS_SINCE_WAR_START = Math.max(
  14, 
  Math.ceil((Date.now() - FEB_2026_START.getTime()) / (1000 * 60 * 60 * 24))
);

export const ARTICLES_PER_COUNTRY = 6;

export const TASKS = [
  ...COUNTRIES.map((c) => ({ id: c.code, kind: "country", query: c.query, days: 7 })),
  // Tarea de histórico largo de Irán desde el inicio del conflicto:
  { id: "IRN14D", kind: "iran14d", query: "Iran", days: DAYS_SINCE_WAR_START },
  ...COUNTRIES.map((c) => ({
    id: `${c.code}NEWS`,
    kind: "articles",
    country: c.code,
    query: c.query,
    max: ARTICLES_PER_COUNTRY,
  })),
];

export function basePayload(existing, errors = []) {
  const payload = {
    updatedAt: new Date().toISOString(),
    meta: COUNTRIES.map(({ code, name, flag, region, query }) => ({ code, name, flag, region, query })),
    countries: { ...(existing?.countries || {}) },
    articles: { ...(existing?.articles || {}) },
    iranExtended14d: existing?.iranExtended14d || [],
    iranArticles: existing?.iranArticles || [],
    taskUpdatedAt: { ...(existing?.taskUpdatedAt || {}) },
    lastErrors: [...errors],
  };
  if (!payload.articles.IRN && payload.iranArticles.length) {
    payload.articles.IRN = payload.iranArticles;
  }
  return payload;
}

function applyOneTask(payload, task, data) {
  if (task.kind === "articles") {
    const code = task.country || "IRN";
    payload.articles[code] = data;
    if (code === "IRN") payload.iranArticles = data;
  } else if (task.kind === "iran14d") {
    payload.iranExtended14d = mergeSeries(payload.iranExtended14d, data);
  } else {
    payload.countries[task.id] = mergeSeries(payload.countries[task.id], data);
  }
  payload.taskUpdatedAt[task.id] = new Date().toISOString();
}

export function parseGdeltDate(s) {
  if (!s || s.length < 15) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const H = +s.slice(9, 11), M = +s.slice(11, 13);
  const date = new Date(Date.UTC(y, m, d, H, M));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function gdeltJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limit de GDELT)" : ""}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GDELT: ${text.slice(0, 80).trim()}`);
  }
}

export async function fetchTimelineTone(query, days, timeoutMs = 8000) {
  const url = `${GDELT_BASE}?query=${encodeURIComponent(query)}&mode=timelinetone&timespan=${days}d&format=json`;
  const j = await gdeltJson(url, timeoutMs);
  const series = j.timeline?.[0]?.data || [];
  return series.map((p) => ({ date: parseGdeltDate(p.date), tone: p.value })).filter((p) => p.date);
}

export async function fetchArticles(query, max, timeoutMs = 8000) {
  const url = `${GDELT_BASE}?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${max}&sort=DateDesc&format=json`;
  const j = await gdeltJson(url, timeoutMs);
  return (j.articles || []).map((a) => ({
    title: a.title,
    url: a.url,
    domain: a.domain,
    date: parseGdeltDate(a.seendate),
    tone: a.tone !== undefined && a.tone !== "" ? parseFloat(a.tone) : null,
    language: a.language,
  }));
}

export function mergeSeries(oldSeries, newPoints, maxPoints = MAX_POINTS_KEPT) {
  const map = new Map((oldSeries || []).map((p) => [p.date, p]));
  for (const p of newPoints || []) {
    if (p.date) map.set(p.date, p);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxPoints);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stalestTaskIds(existing, n) {
  const stamps = existing?.taskUpdatedAt || {};
  return TASKS
    .map((t, i) => ({ id: t.id, i, at: stamps[t.id] || "" }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i)
    .slice(0, n)
    .map((t) => t.id);
}

const clampNum = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
const cleanStr = (v, maxLen) => (typeof v === "string" ? v.slice(0, maxLen) : null);

export function sanitizeTimelinePoints(raw) {
  if (!Array.isArray(raw)) throw new Error("points debe ser un array");
  return raw
    .slice(0, MAX_POINTS_KEPT) // Seguro para series de cientos de días
    .map((p) => ({ date: parseGdeltDate(cleanStr(p?.date, 20)), tone: clampNum(p?.value, -100, 100) }))
    .filter((p) => p.date && p.tone !== null);
}

export function sanitizeArticles(raw, max) {
  if (!Array.isArray(raw)) throw new Error("articles debe ser un array");
  return raw
    .slice(0, max)
    .map((a) => {
      const url = cleanStr(a?.url, 1000);
      const tone = a?.tone === undefined || a?.tone === "" ? null : parseFloat(a?.tone);
      return {
        title: cleanStr(a?.title, 300),
        url: url && /^https?:\/\//i.test(url) ? url : null,
        domain: cleanStr(a?.domain, 200),
        date: parseGdeltDate(cleanStr(a?.seendate, 20)),
        tone: clampNum(tone, -100, 100),
        language: cleanStr(a?.language, 50),
      };
    })
    .filter((a) => a.title && a.url);
}

export function ingestTaskData(existing, taskId, body) {
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`Tarea desconocida: ${taskId}`);
  const payload = basePayload(existing);
  let data;
  if (task.kind === "articles") {
    data = sanitizeArticles(body?.articles, task.max);
    if (data.length === 0) throw new Error("sin artículos válidos");
  } else {
    data = sanitizeTimelinePoints(body?.points);
    if (data.length === 0) throw new Error("sin puntos válidos");
  }
  applyOneTask(payload, task, data);
  return payload;
}

export async function fetchTaskResults(
  taskIds,
  { sleepFn = defaultSleep, delayMs = 800, budgetMs = 5000, timeoutMs = 3000 } = {}
) {
  const results = {};
  const errors = [];
  const started = Date.now();
  let first = true;
  for (const id of taskIds) {
    if (!first && Date.now() - started >= budgetMs) {
      errors.push(`${id}: omitida (sin tiempo en esta ejecución)`);
      continue;
    }
    if (!first) await sleepFn(delayMs);
    first = false;

    const task = TASKS.find((t) => t.id === id);
    if (!task) {
      errors.push(`${id}: tarea desconocida`);
      continue;
    }
    try {
      results[id] =
        task.kind === "articles"
          ? await fetchArticles(task.query, task.max, timeoutMs)
          : await fetchTimelineTone(task.query, task.days, timeoutMs);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }
  return { results, errors };
}

export function applyTaskResults(existing, results, errors = []) {
  const payload = basePayload(existing, errors);
  for (const [id, data] of Object.entries(results || {})) {
    const task = TASKS.find((t) => t.id === id);
    if (!task) continue;
    applyOneTask(payload, task, data);
  }
  return payload;
}

export async function updateTasks(existing, taskIds, opts = {}) {
  const { results, errors } = await fetchTaskResults(taskIds, opts);
  return applyTaskResults(existing, results, errors);
}
