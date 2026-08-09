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
  COUNTRIES,
  TASKS,
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
      const data = Array.from({ length: days }, (_, i) => ({
        date: `202608${String(i + 1).padStart(2, "0")}T000000Z`,
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
    assert.equal(payload.iranExtended14d.length, 14);
    assert.equal(payload.iranArticles.length, 12);
    assert.equal(payload.lastErrors.length, 0);
    // todas las tareas quedan selladas con su fecha de ejecución
    for (const id of ALL_TASK_IDS) {
      assert.ok(payload.taskUpdatedAt[id], `falta sello de ${id}`);
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
    assert.equal(second.iranArticles.length, 12);
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
    assert.equal(payload.taskUpdatedAt.SYR, undefined); // sigue "stale": se reintentará
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
  } finally {
    restore();
  }
});

test("stalestTaskIds: primero las nunca ejecutadas, luego las más antiguas", () => {
  // Sin histórico: respeta el orden de TASKS
  assert.deepEqual(stalestTaskIds(null, 2), [TASKS[0].id, TASKS[1].id]);

  // Con sellos: las que faltan van primero, luego la de sello más viejo
  const taskUpdatedAt = {};
  for (const t of TASKS) taskUpdatedAt[t.id] = "2026-08-09T10:00:00.000Z";
  delete taskUpdatedAt.QAT; // nunca ejecutada
  taskUpdatedAt.OMN = "2026-08-09T08:00:00.000Z"; // la más vieja
  const ids = stalestTaskIds({ taskUpdatedAt }, 2);
  assert.deepEqual(ids, ["QAT", "OMN"]);
});
