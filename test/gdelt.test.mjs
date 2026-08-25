// test/gdelt.test.mjs
// Ejecutar con: node --test test/
//
// No llama a la GDELT real ni a Netlify Blobs real: simula global.fetch con
// respuestas GDELT de muestra para verificar el parseo, el merge histórico
// y la ejecución incremental por tareas.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGdeltDate,
  mergeSeries,
  updateTasks,
  stalestTaskIds,
  applyTaskResults,
  ingestTaskData,
  sanitizeTimelinePoints,
  sanitizeArticles,
  COUNTRIES,
  TASKS,
  ARTICLES_PER_COUNTRY,
  MAX_POINTS_KEPT,
  basePayload,
} from "../netlify/functions/_lib/gdelt.mjs";

const ALL_TASK_IDS = TASKS.map((t) => t.id);
const noSleep = async () => {};

test("parseGdeltDate: formato GDELT -> ISO", () => {
  assert.equal(parseGdeltDate("20260802T153000Z"), "2026-08-02T15:30:00.000Z");
  assert.equal(parseGdeltDate(null), null);
  assert.equal(parseGdeltDate("basura"), null);
});

test("las queries de una sola palabra van SIN comillas (GDELT las rechaza)", () => {
  // GDELT responde «The specified phrase is too short» a '"Iran"'.
  for (const c of COUNTRIES) {
    if (c.query.startsWith('"')) {
      assert.ok(
        c.query.slice(1, -1).includes(" "),
        `${c.code}: la frase entrecomillada ${c.query} debe tener varias palabras`
      );
    }
  }
});

test("mergeSeries: dedupe por fecha, el nuevo gana, orden cronológico", () => {
  const old = [
    { date: "2026-08-01T00:00:00.000Z", tone: -3.0 },
    { date: "2026-08-02T00:00:00.000Z", tone: -2.5 },
  ];
  const fresh = [
    { date: "2026-08-02T00:00:00.000Z", tone: -1.0 }, // pisa el valor viejo
    { date: "2026-08-03T00:00:00.000Z", tone: -0.5 }, // fecha nueva
  ];
  const merged = mergeSeries(old, fresh);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((p) => p.date),
    ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"]
  );
  assert.equal(merged[1].tone, -1.0); // se actualizó
});

test("mergeSeries: recorta al máximo de días indicado", () => {
  const old = Array.from({ length: 5 }, (_, i) => ({ date: `2026-08-0${i + 1}T00:00:00.000Z`, tone: i }));
  const merged = mergeSeries(old, [], 3);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((p) => p.date),
    ["2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z"]
  );
});

function installFakeFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const mode = u.searchParams.get("mode");
    if (mode === "timelinetone") {
      const days = parseInt(u.searchParams.get("timespan"), 10);
      // Fechas reales y consecutivas: con timespans largos (el histórico de
      // Irán son ya >100 días) un "202608" + índice generaba fechas inválidas
      // y la serie salía recortada.
      const start = Date.UTC(2026, 0, 1);
      const data = Array.from({ length: days }, (_, i) => ({
        date: new Date(start + i * 86400000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
        value: -3 + i * 0.1,
      }));
      return {
        ok: true,
        text: async () => JSON.stringify({ timeline: [{ series: "Average Tone", data }] }),
      };
    }
    if (mode === "artlist") {
      const max = parseInt(u.searchParams.get("maxrecords"), 10);
      const articles = Array.from({ length: max }, (_, i) => ({
        title: `Titular ${i}`,
        url: `https://example.com/a${i}`,
        domain: "example.com",
        seendate: "20260805T120000Z",
        tone: String(-2 - i),
        language: "English",
      }));
      return { ok: true, text: async () => JSON.stringify({ articles }) };
    }
    throw new Error("modo no soportado en el mock: " + mode);
  };
  return () => { globalThis.fetch = original; };
}

test("updateTasks: ejecuta todas las tareas y rellena el payload completo", async () => {
  const restore = installFakeFetch();
  try {
    const payload = await updateTasks(null, ALL_TASK_IDS, { sleepFn: noSleep });
    assert.equal(payload.meta.length, COUNTRIES.length);
    assert.equal(Object.keys(payload.countries).length, COUNTRIES.length);
    for (const c of COUNTRIES) {
      assert.equal(payload.countries[c.code].length, 7);
    }
    const iranTask = TASKS.find((t) => t.kind === "iran14d");
    assert.equal(payload.iranExtended14d.length, Math.min(iranTask.days, MAX_POINTS_KEPT));
    // Titulares: uno por país + el espejo de compatibilidad de Irán
    assert.equal(Object.keys(payload.articles).length, COUNTRIES.length);
    for (const c of COUNTRIES) {
      assert.equal(payload.articles[c.code].length, ARTICLES_PER_COUNTRY, `titulares de ${c.code}`);
    }
    assert.deepEqual(payload.iranArticles, payload.articles.IRN);
    assert.equal(payload.lastErrors.length, 0);
    // todas las tareas quedan selladas con su fecha de ejecución (éxito y, además, intento)
    for (const id of ALL_TASK_IDS) {
      assert.ok(payload.taskUpdatedAt[id], `falta sello de éxito de ${id}`);
      assert.ok(payload.taskAttemptedAt[id], `falta sello de intento de ${id}`);
    }
  } finally {
    restore();
  }
});

test("updateTasks: una tarea solo actualiza su trozo y no pierde el resto", async () => {
  const restore = installFakeFetch();
  try {
    const first = await updateTasks(null, ALL_TASK_IDS, { sleepFn: noSleep });
    // Simulamos que ya había MÁS histórico guardado que lo que devuelve la
    // ventana de 7 días (p.ej. de días anteriores ya archivados).
    const existingWithExtraHistory = {
      ...first,
      countries: {
        ...first.countries,
        IRN: [{ date: "2026-07-20T00:00:00.000Z", tone: -9.9 }, ...first.countries.IRN],
      },
    };
    const second = await updateTasks(existingWithExtraHistory, ["IRN"], { sleepFn: noSleep });
    // El día antiguo (fuera de la ventana de 7d de GDELT) se conserva
    assert.ok(second.countries.IRN.some((p) => p.date === "2026-07-20T00:00:00.000Z"));
    assert.equal(second.countries.IRN.length, 8); // 7 nuevos + 1 antiguo
    // Y el resto de países no se toca ni se pierde
    assert.equal(second.countries.ISR.length, 7);
    assert.equal(second.articles.IRN.length, ARTICLES_PER_COUNTRY);
    assert.equal(second.articles.ISR.length, ARTICLES_PER_COUNTRY);
  } finally {
    restore();
  }
});

test("updateTasks: si GDELT falla en una tarea, no rompe las demás", async () => {
  const restore = installFakeFetch();
  const mocked = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes(encodeURIComponent("Syria"))) {
      return { ok: false, status: 500, text: async () => "boom" };
    }
    return mocked(url);
  };
  try {
    const payload = await updateTasks(null, ALL_TASK_IDS, { sleepFn: noSleep });
    assert.ok(payload.lastErrors.some((e) => e.startsWith("SYR:")));
    assert.equal(payload.countries.SYR, undefined); // no se guarda nada roto
    assert.equal(payload.countries.IRN.length, 7); // el resto sigue funcionando
    assert.equal(payload.taskUpdatedAt.SYR, undefined); // sin dato nuevo: sigue "stale" para los datos
    assert.ok(payload.taskAttemptedAt.SYR); // pero SÍ se marca como intentada
  } finally {
    restore();
  }
});

test("updateTasks: respuestas 200 con texto de error de GDELT se tratan como fallo", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => "The specified phrase is too short." });
  try {
    const payload = await updateTasks(null, ["ISR"], { sleepFn: noSleep });
    assert.ok(payload.lastErrors.some((e) => e.includes("phrase is too short")));
    assert.equal(payload.countries.ISR, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("updateTasks: el presupuesto de tiempo corta antes de empezar tareas nuevas", async () => {
  const restore = installFakeFetch();
  try {
    // budgetMs 0: tras la primera tarea ya no queda presupuesto
    const payload = await updateTasks(null, ["ISR", "IRN", "USA"], { sleepFn: noSleep, budgetMs: 0 });
    assert.equal(payload.countries.ISR.length, 7); // la primera siempre corre
    assert.equal(payload.countries.IRN, undefined);
    assert.equal(payload.countries.USA, undefined);
    assert.equal(payload.lastErrors.length, 2); // las omitidas quedan anotadas
    assert.ok(payload.lastErrors.every((e) => e.includes("omitida")));
    // Las omitidas por presupuesto NO cuentan como "intentadas": deben seguir
    // siendo las más prioritarias en la próxima rotación.
    assert.ok(payload.taskAttemptedAt.ISR);
    assert.equal(payload.taskAttemptedAt.IRN, undefined);
    assert.equal(payload.taskAttemptedAt.USA, undefined);
  } finally {
    restore();
  }
});

test("sanitizeTimelinePoints: filtra basura y acota tonos", () => {
  const clean = sanitizeTimelinePoints([
    { date: "20260801T000000Z", value: -3.2 },        // válido
    { date: "20260802T000000Z", value: "no-numero" }, // tono inválido
    { date: "basura", value: -1 },                     // fecha inválida
    { date: "20260803T000000Z", value: 999 },          // fuera de rango
    null,                                              // entrada corrupta
  ]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].date, "2026-08-01T00:00:00.000Z");
  assert.equal(clean[0].tone, -3.2);
  assert.throws(() => sanitizeTimelinePoints("no-array"));
});

test("sanitizeArticles: exige título y URL http(s), acota campos", () => {
  const clean = sanitizeArticles(
    [
      { title: "Ok", url: "https://x.com/a", domain: "x.com", seendate: "20260805T120000Z", tone: "-2.5", language: "English" },
      { title: "Sin url válida", url: "javascript:alert(1)", domain: "x.com" },
      { url: "https://x.com/b" }, // sin título
    ],
    12
  );
  assert.equal(clean.length, 1);
  assert.equal(clean[0].tone, -2.5);
  assert.equal(clean[0].date, "2026-08-05T12:00:00.000Z");
});

test("ingestTaskData: fusiona lo enviado por el navegador sin perder histórico", () => {
  const existing = {
    countries: { ISR: [{ date: "2026-07-20T00:00:00.000Z", tone: -5 }] },
    iranArticles: [{ title: "viejo", url: "https://x.com/v" }],
    taskUpdatedAt: {},
  };
  const payload = ingestTaskData(existing, "ISR", {
    points: [{ date: "20260808T000000Z", value: -2.1 }],
  });
  assert.equal(payload.countries.ISR.length, 2); // histórico + nuevo
  assert.ok(payload.taskUpdatedAt.ISR);
  assert.equal(payload.iranArticles.length, 1); // el resto no se toca
  assert.equal(payload.meta.length, COUNTRIES.length);
});

test("ingestTaskData: los titulares se guardan por país, no todos en Irán", () => {
  const articles = [
    { title: "Titular sirio", url: "https://x.com/s", domain: "x.com", seendate: "20260805T120000Z", tone: "-4" },
  ];
  const payload = ingestTaskData(null, "SYRNEWS", { articles });
  assert.equal(payload.articles.SYR.length, 1);
  assert.equal(payload.articles.IRN, undefined);   // no pisa los de Irán
  assert.deepEqual(payload.iranArticles, []);      // ni el espejo antiguo
  assert.ok(payload.taskUpdatedAt.SYRNEWS);
});

test("cada país tiene su tarea de titulares y su serie", () => {
  for (const c of COUNTRIES) {
    assert.ok(TASKS.some((t) => t.id === c.code && t.kind === "country"), `falta la serie de ${c.code}`);
    const news = TASKS.find((t) => t.id === `${c.code}NEWS`);
    assert.ok(news && news.kind === "articles" && news.country === c.code, `falta la tarea de titulares de ${c.code}`);
  }
  // El id histórico de Irán se mantiene para no perder su sello de rotación
  assert.ok(TASKS.some((t) => t.id === "IRNNEWS"));
});

test("basePayload: migra blobs antiguos que solo tenían iranArticles", () => {
  const viejo = { iranArticles: [{ title: "antiguo", url: "https://x.com/a" }] };
  const payload = basePayload(viejo);
  assert.equal(payload.articles.IRN.length, 1);
  assert.equal(payload.articles.IRN[0].title, "antiguo");
});

test("ingestTaskData: rechaza tarea desconocida y datos sin nada válido", () => {
  assert.throws(() => ingestTaskData(null, "XXX", { points: [] }), /desconocida/);
  assert.throws(() => ingestTaskData(null, "ISR", { points: [{ date: "basura", value: 1 }] }), /sin puntos/);
  assert.throws(() => ingestTaskData(null, "IRNNEWS", { articles: [{ title: "x", url: "ftp://mal" }] }), /sin artículos/);
});

test("stalestTaskIds: primero las nunca intentadas, luego las más antiguas", () => {
  // Sin histórico: respeta el orden de TASKS
  assert.deepEqual(stalestTaskIds(null, 2), [TASKS[0].id, TASKS[1].id]);

  // Con sellos: las que faltan van primero, luego la de sello más viejo.
  // OJO: se ordena por taskAttemptedAt (intentado), no por taskUpdatedAt
  // (solo éxitos) — es justo lo que evita la inanición de abajo.
  const taskAttemptedAt = {};
  for (const t of TASKS) taskAttemptedAt[t.id] = "2026-08-09T10:00:00.000Z";
  delete taskAttemptedAt.QAT; // nunca intentada
  taskAttemptedAt.OMN = "2026-08-09T08:00:00.000Z"; // la más vieja
  const ids = stalestTaskIds({ taskAttemptedAt }, 2);
  assert.deepEqual(ids, ["QAT", "OMN"]);
});

test("stalestTaskIds/applyTaskResults: una tarea que falla SIEMPRE no bloquea la rotación", () => {
  // Reproduce el bug real visto en producción: ISRNEWS y LBNNEWS no tenían
  // éxito nunca (timeout), y como la rotación se basaba solo en éxitos
  // (taskUpdatedAt), esas 2 tareas se quedaban fijas como "las más viejas"
  // para siempre y acaparaban las 2 plazas de cada ejecución — el resto del
  // panel (incluido Irán) dejaba de refrescarse por completo.
  const FAILING = new Set(["ISRNEWS", "LBNNEWS"]);
  let payload = null;

  for (let round = 0; round < 4; round++) {
    const ids = stalestTaskIds(payload, 2);
    const results = {};
    const errors = [];
    const attempted = [];
    for (const id of ids) {
      attempted.push(id);
      if (FAILING.has(id)) {
        errors.push(`${id}: timeout`);
      } else {
        results[id] = [{ date: "2026-08-20T00:00:00.000Z", tone: -1 }];
      }
    }
    payload = applyTaskResults(payload, results, errors, attempted);
  }

  // Tras 4 rondas (8 plazas) la rotación tuvo que avanzar más allá de las 2
  // tareas que siempre fallan: no puede haber repetido SOLO esas 2.
  const seen = new Set(Object.keys(payload.taskAttemptedAt));
  assert.ok(seen.size > 2, `la rotación se quedó atascada: ${[...seen]}`);
  // Y las que sí tuvieron éxito deben tener datos guardados.
  for (const id of seen) {
    if (!FAILING.has(id)) assert.ok(payload.countries[id] || payload.iranExtended14d.length || payload.articles[id]);
  }
});
