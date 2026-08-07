// test/gdelt.test.mjs
// Ejecutar con: node --test test/
//
// No llama a la GDELT real (este entorno no tiene salida de red a
// api.gdeltproject.org) ni a Netlify Blobs real: simula global.fetch con
// respuestas GDELT de muestra para verificar el parseo, el merge histórico
// y la orquestación de las 3 llamadas.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGdeltDate,
  mergeSeries,
  buildUpdatedPayload,
  COUNTRIES,
} from "../netlify/functions/_lib/gdelt.mjs";

test("parseGdeltDate: formato GDELT -> ISO", () => {
  assert.equal(parseGdeltDate("20260802T153000Z"), "2026-08-02T15:30:00.000Z");
  assert.equal(parseGdeltDate(null), null);
  assert.equal(parseGdeltDate("basura"), null);
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
      return { ok: true, json: async () => ({ timeline: [{ series: "Average Tone", data }] }) };
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
      return { ok: true, json: async () => ({ articles }) };
    }
    throw new Error("modo no soportado en el mock: " + mode);
  };
  return () => { globalThis.fetch = original; };
}

test("buildUpdatedPayload: primera ejecución (sin histórico previo)", async () => {
  const restore = installFakeFetch();
  try {
    const payload = await buildUpdatedPayload(null, { sleepFn: async () => {} });
    assert.equal(payload.meta.length, COUNTRIES.length);
    assert.equal(Object.keys(payload.countries).length, COUNTRIES.length);
    for (const c of COUNTRIES) {
      assert.equal(payload.countries[c.code].length, 7);
    }
    assert.equal(payload.iranExtended14d.length, 14);
    assert.equal(payload.iranArticles.length, 12);
    assert.equal(payload.lastErrors.length, 0);
  } finally {
    restore();
  }
});

test("buildUpdatedPayload: segunda ejecución acumula histórico en vez de perderlo", async () => {
  const restore = installFakeFetch();
  try {
    const first = await buildUpdatedPayload(null, { sleepFn: async () => {} });
    // Simulamos que ya había MÁS histórico guardado que lo que devuelve la
    // ventana de 7 días (p.ej. de días anteriores ya archivados).
    const existingWithExtraHistory = {
      ...first,
      countries: {
        ...first.countries,
        IRN: [{ date: "2026-07-20T00:00:00.000Z", tone: -9.9 }, ...first.countries.IRN],
      },
    };
    const second = await buildUpdatedPayload(existingWithExtraHistory, { sleepFn: async () => {} });
    // El día antiguo (fuera de la ventana de 7d que devuelve GDELT) se conserva
    assert.ok(second.countries.IRN.some((p) => p.date === "2026-07-20T00:00:00.000Z"));
    // y sigue habiendo 8 puntos (7 nuevos + 1 antiguo) para IRN
    assert.equal(second.countries.IRN.length, 8);
  } finally {
    restore();
  }
});

test("buildUpdatedPayload: si GDELT falla para un país, no rompe el resto", async () => {
  const restore = installFakeFetch();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes(encodeURIComponent('"Russia"'))) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return original(url);
  };
  try {
    const payload = await buildUpdatedPayload(null, { sleepFn: async () => {} });
    assert.ok(payload.lastErrors.some((e) => e.startsWith("RUS:")));
    assert.equal(payload.countries.RUS, undefined); // no se guarda nada roto
    assert.equal(payload.countries.IRN.length, 7); // el resto sigue funcionando
  } finally {
    restore();
  }
});
