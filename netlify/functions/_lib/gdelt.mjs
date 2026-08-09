// netlify/functions/_lib/gdelt.mjs
//
// Lógica pura, sin dependencias de Netlify (@netlify/blobs) ni de la Response
// del runtime, para que sea fácil de testear (ver test/gdelt.test.mjs) y de
// reutilizar entre funciones.
// NOTA: el prefijo "_" en la carpeta hace que Netlify NO la trate como una
// función propia (convención de "código compartido").
//
// ARQUITECTURA DE TAREAS: GDELT limita mucho el ritmo de peticiones (429 si
// van seguidas) y las funciones de Netlify tienen 10 s de límite, así que es
// imposible refrescar todo en una sola ejecución. En su lugar, el trabajo se
// divide en TASKS (una llamada GDELT cada una) y cada ejecución procesa unas
// pocas — las más antiguas primero — fusionando el resultado con lo guardado.

export const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

// Cuántos días de histórico por país conservamos como máximo en el blob.
// GDELT solo devuelve "los últimos N días" en cada llamada; el merge de
// abajo evita perder lo ya guardado cuando la ventana se desplaza.
export const MAX_DAYS_KEPT = 180;

// OJO con las queries: GDELT rechaza frases entrecomilladas de UNA sola
// palabra ("Iran" -> «The specified phrase is too short»). Palabras sueltas
// van SIN comillas; las comillas solo para frases de varias palabras.
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

// Cada tarea = exactamente UNA llamada a GDELT.
export const TASKS = [
  ...COUNTRIES.map((c) => ({ id: c.code, kind: "country", query: c.query, days: 7 })),
  { id: "IRN14D", kind: "iran14d", query: "Iran", days: 14 },
  { id: "IRNNEWS", kind: "articles", query: "Iran", max: 12 },
];

export function parseGdeltDate(s) {
  // "20260802T000000Z" -> ISO 8601 UTC
  if (!s || s.length < 15) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const H = +s.slice(9, 11), M = +s.slice(11, 13);
  const date = new Date(Date.UTC(y, m, d, H, M));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// GDELT a veces responde 200 con texto plano de error ("The specified phrase
// is too short.", avisos de rate limit…), así que no basta con res.json().
async function gdeltJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.status === 429 ? " (rate limit de GDELT)" : ""}`);
  }
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

// Fusiona la serie histórica guardada con los puntos nuevos, dedupe por
// fecha (el nuevo gana si coincide), ordena y recorta a MAX_DAYS_KEPT.
export function mergeSeries(oldSeries, newPoints, maxDays = MAX_DAYS_KEPT) {
  const map = new Map((oldSeries || []).map((p) => [p.date, p]));
  for (const p of newPoints || []) {
    if (p.date) map.set(p.date, p);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxDays);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Devuelve los ids de las `n` tareas con el dato más antiguo (las que nunca
// se han ejecutado van primero). Es lo que usa la función programada para
// rotar por todas las tareas a lo largo de varias ejecuciones.
export function stalestTaskIds(existing, n) {
  const stamps = existing?.taskUpdatedAt || {};
  return TASKS
    .map((t, i) => ({ id: t.id, i, at: stamps[t.id] || "" }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i)
    .slice(0, n)
    .map((t) => t.id);
}

// Ejecuta las tareas indicadas (en orden) y devuelve el payload completo a
// guardar en Netlify Blobs. Nunca pierde lo ya guardado: cada tarea solo
// actualiza su trozo. `budgetMs` corta antes de empezar una tarea nueva si
// ya no queda tiempo (límite de 10 s de las funciones de Netlify); la tarea
// omitida queda como "stale" y la recoge la siguiente ejecución programada.
export async function updateTasks(
  existing,
  taskIds,
  { sleepFn = defaultSleep, delayMs = 800, budgetMs = 5000, timeoutMs = 3000 } = {}
) {
  const payload = {
    updatedAt: new Date().toISOString(),
    meta: COUNTRIES.map(({ code, name, flag, region }) => ({ code, name, flag, region })),
    countries: { ...(existing?.countries || {}) },
    iranExtended14d: existing?.iranExtended14d || [],
    iranArticles: existing?.iranArticles || [],
    taskUpdatedAt: { ...(existing?.taskUpdatedAt || {}) },
    lastErrors: [],
  };

  const started = Date.now();
  let first = true;
  for (const id of taskIds) {
    if (!first && Date.now() - started >= budgetMs) {
      payload.lastErrors.push(`${id}: omitida (sin tiempo en esta ejecución)`);
      continue;
    }
    if (!first) await sleepFn(delayMs); // no saturar la API pública de GDELT
    first = false;

    const task = TASKS.find((t) => t.id === id);
    if (!task) {
      payload.lastErrors.push(`${id}: tarea desconocida`);
      continue;
    }
    try {
      if (task.kind === "articles") {
        payload.iranArticles = await fetchArticles(task.query, task.max, timeoutMs);
      } else {
        const points = await fetchTimelineTone(task.query, task.days, timeoutMs);
        if (task.kind === "iran14d") {
          payload.iranExtended14d = mergeSeries(payload.iranExtended14d, points);
        } else {
          payload.countries[task.id] = mergeSeries(payload.countries[task.id], points);
        }
      }
      payload.taskUpdatedAt[task.id] = new Date().toISOString();
    } catch (e) {
      payload.lastErrors.push(`${id}: ${e.message}`);
    }
  }

  return payload;
}
