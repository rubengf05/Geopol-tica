// netlify/functions/_lib/gdelt.mjs
//
// Lógica pura, sin dependencias de Netlify (@netlify/blobs) ni de la Response
// del runtime, para que sea fácil de testear (ver test/gdelt.test.mjs) y de
// reutilizar entre funciones.
// NOTA: el prefijo "_" en la carpeta hace que Netlify NO la trate como una
// función propia (convención de "código compartido").

export const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

// Cuántos días de histórico por país conservamos como máximo en el blob.
// GDELT solo devuelve "los últimos N días" en cada llamada; el merge de
// abajo evita perder lo ya guardado cuando la ventana se desplaza.
export const MAX_DAYS_KEPT = 180;

export const COUNTRIES = [
  { code: "IRN", name: "Irán", flag: "🇮🇷", region: "Oriente Medio", query: '"Iran"' },
  { code: "RUS", name: "Rusia", flag: "🇷🇺", region: "Europa del Este", query: '"Russia"' },
  { code: "UKR", name: "Ucrania", flag: "🇺🇦", region: "Europa del Este", query: '"Ukraine"' },
  { code: "CHN", name: "China", flag: "🇨🇳", region: "Asia-Pacífico", query: '"China"' },
  { code: "TWN", name: "Taiwán", flag: "🇹🇼", region: "Asia-Pacífico", query: '"Taiwan"' },
  { code: "ISR", name: "Israel", flag: "🇮🇱", region: "Oriente Medio", query: '"Israel"' },
  { code: "PSE", name: "Palestina (Gaza)", flag: "🇵🇸", region: "Oriente Medio", query: '("Gaza" OR "Palestine")' },
  { code: "PRK", name: "Corea del Norte", flag: "🇰🇵", region: "Asia-Pacífico", query: '"North Korea"' },
  { code: "SDN", name: "Sudán", flag: "🇸🇩", region: "África", query: '"Sudan"' },
  { code: "YEM", name: "Yemen", flag: "🇾🇪", region: "Oriente Medio", query: '"Yemen"' },
  { code: "VEN", name: "Venezuela", flag: "🇻🇪", region: "América", query: '"Venezuela"' },
  { code: "USA", name: "EE.UU.", flag: "🇺🇸", region: "América", query: '"United States"' },
  { code: "IND", name: "India", flag: "🇮🇳", region: "Asia-Pacífico", query: '"India"' },
  { code: "DEU", name: "Alemania", flag: "🇩🇪", region: "Europa Occidental", query: '"Germany"' },
  { code: "GBR", name: "Reino Unido", flag: "🇬🇧", region: "Europa Occidental", query: '"United Kingdom"' },
];

export function parseGdeltDate(s) {
  // "20260802T000000Z" -> ISO 8601 UTC
  if (!s || s.length < 15) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const H = +s.slice(9, 11), M = +s.slice(11, 13);
  const date = new Date(Date.UTC(y, m, d, H, M));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function fetchTimelineTone(query, days) {
  const url = `${GDELT_BASE}?query=${encodeURIComponent(query)}&mode=timelinetone&timespan=${days}d&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const series = j.timeline?.[0]?.data || [];
  return series.map((p) => ({ date: parseGdeltDate(p.date), tone: p.value })).filter((p) => p.date);
}

export async function fetchArticles(query, max) {
  const url = `${GDELT_BASE}?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${max}&sort=DateDesc&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
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

// Orquesta las 3 llamadas GDELT solicitadas y devuelve el payload completo
// que se guarda en Netlify Blobs. `sleepFn` es inyectable para poder testear
// sin esperar de verdad entre llamadas.
export async function buildUpdatedPayload(existing, { sleepFn = defaultSleep, delayMs = 800 } = {}) {
  const countries = { ...(existing?.countries || {}) };
  const errors = [];

  for (const c of COUNTRIES) {
    try {
      const points = await fetchTimelineTone(c.query, 7);
      countries[c.code] = mergeSeries(countries[c.code], points);
    } catch (e) {
      errors.push(`${c.code}: ${e.message}`);
    }
    await sleepFn(delayMs); // no saturar la API pública de GDELT
  }

  let iranExtended14d = existing?.iranExtended14d || [];
  try {
    const points14 = await fetchTimelineTone('"Iran"', 14);
    iranExtended14d = mergeSeries(iranExtended14d, points14);
  } catch (e) {
    errors.push(`IRN-14d: ${e.message}`);
  }

  let iranArticles = existing?.iranArticles || [];
  try {
    iranArticles = await fetchArticles('"Iran"', 12);
  } catch (e) {
    errors.push(`IRN-articles: ${e.message}`);
  }

  return {
    updatedAt: new Date().toISOString(),
    meta: COUNTRIES.map(({ code, name, flag, region }) => ({ code, name, flag, region })),
    countries,
    iranExtended14d,
    iranArticles,
    lastErrors: errors,
  };
}
