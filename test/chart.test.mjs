// test/chart.test.mjs
//
// Ejes del gráfico: la queja original era que "los ejes no están bien" y que
// bailaban en cada actualización. Estas pruebas fijan las tres propiedades
// que lo arreglan: marcas redondas, marcas ESTABLES ante pequeños cambios de
// los datos, y etiquetas de fecha alineadas, sin repetir y sin cortarse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { niceScale, timeTicks, chartSVG, computeMetrics } from "../public/app.js";

const DAY = 86400000;
const mantissa = (x) => {
  const m = Math.abs(x) / Math.pow(10, Math.floor(Math.log10(Math.abs(x))));
  return +m.toFixed(6);
};

test("niceScale: marcas en múltiplos redondos que cubren los datos", () => {
  for (const [min, max] of [[-6.37, -1.02], [-0.4, 0.3], [2.2, 9.9], [-12, 4], [0, 0]]) {
    const s = niceScale(min, max, 6);
    assert.ok(s.min <= min && s.max >= max, `${min}..${max} fuera del dominio ${s.min}..${s.max}`);
    assert.ok([1, 2, 2.5, 5].includes(mantissa(s.step)), `paso poco redondo: ${s.step}`);
    for (const t of s.ticks) {
      assert.ok(Math.abs(t / s.step - Math.round(t / s.step)) < 1e-6, `marca ${t} no es múltiplo de ${s.step}`);
    }
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 12);
  }
});

test("niceScale: los ejes no bailan cuando el dato cambia un poco", () => {
  const base = niceScale(-6.4, -0.8, 6);
  for (const jitter of [-0.15, -0.05, 0.05, 0.12]) {
    const s = niceScale(-6.4 + jitter, -0.8 + jitter / 2, 6);
    assert.deepEqual(s.ticks, base.ticks, `las marcas cambiaron con un jitter de ${jitter}`);
  }
});

test("niceScale: sobrevive a datos degenerados", () => {
  for (const s of [niceScale(NaN, NaN), niceScale(3, 3), niceScale(5, 1)]) {
    assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max) && s.max > s.min);
    assert.ok(s.ticks.length >= 2);
  }
});

test("timeTicks: alineadas a intervalos de calendario, dentro del rango y sin repetirse", () => {
  const end = Date.UTC(2026, 7, 20);
  for (const spanDays of [1, 3, 14, 60, 200, 900]) {
    const start = end - spanDays * DAY;
    const { ticks, step } = timeTicks(start, end, 7);
    assert.ok(ticks.length >= 2, `pocas marcas con ${spanDays} días`);
    assert.ok(ticks.length <= 9, `demasiadas marcas (${ticks.length}) con ${spanDays} días`);
    assert.ok(ticks[0] >= start && ticks[ticks.length - 1] <= end, "marca fuera del rango");
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i] - ticks[i - 1], step, "marcas no equiespaciadas");
    }
    assert.equal(new Set(ticks).size, ticks.length);
  }
});

function serie(n, stepMs, fn) {
  const end = Date.UTC(2026, 7, 20);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(end - (n - 1 - i) * stepMs),
    tone: fn(i),
  }));
}

test("chartSVG: el eje Y incluye el 0 y el SVG escala sin alto fijo", () => {
  const { html } = chartSVG(serie(30, DAY, (i) => -6 + Math.sin(i) * 0.4));
  assert.ok(html.includes('viewBox="0 0 1000 340"'));
  assert.ok(!/<svg[^>]*\sheight="\d/.test(html), "el SVG no debe llevar alto fijo en píxeles");
  assert.ok(html.includes("width:100%;height:auto"), "debe escalar con el contenedor");
  // La marca del 0 se dibuja resaltada (es la referencia de lectura del tono)
  assert.ok(html.includes('stroke="#46608f"'), "falta la línea del 0");
});

test("chartSVG: las etiquetas de los extremos no se salen del área de dibujo", () => {
  // 8 puntos diarios -> hay marca justo en el primer y el último día, que es
  // cuando una etiqueta centrada se saldría del lienzo.
  const { html } = chartSVG(serie(8, DAY, (i) => -3 + i * 0.05));
  // Etiquetas del eje X: son las que se pintan bajo el área de dibujo (y=320)
  const xLabels = [...html.matchAll(/<text x="([\d.]+)" y="320"[^>]*text-anchor="(start|middle|end)"/g)]
    .map((m) => ({ x: parseFloat(m[1]), anchor: m[2] }));
  assert.ok(xLabels.length >= 3, `pocas etiquetas de fecha: ${xLabels.length}`);
  assert.equal(xLabels[0].anchor, "start", "la primera fecha debe anclarse a la izquierda");
  assert.equal(xLabels[xLabels.length - 1].anchor, "end", "la última fecha debe anclarse a la derecha");
  for (const l of xLabels) assert.ok(l.x >= 0 && l.x <= 1000, `etiqueta fuera del lienzo: x=${l.x}`);

  // Y con una ventana larga, ninguna etiqueta se sale tampoco
  const largo = chartSVG(serie(400, DAY, (i) => -3 + (i % 5) * 0.2));
  for (const m of largo.html.matchAll(/<text x="([\d.]+)" y="320"/g)) {
    const x = parseFloat(m[1]);
    assert.ok(x >= 0 && x <= 1000, `etiqueta fuera del lienzo: x=${x}`);
  }
});

test("chartSVG: con series largas no apelmaza los puntos, y con cortas sí los dibuja", () => {
  const largo = chartSVG(serie(400, 3600000, (i) => -4 + (i % 7) * 0.2));
  const corto = chartSVG(serie(20, DAY, (i) => -4 + (i % 7) * 0.2));
  assert.equal((largo.html.match(/<circle/g) || []).length, 1); // solo el del cursor
  assert.ok((corto.html.match(/<circle/g) || []).length > 15);
  assert.equal(largo.points.length, 400);
});

test("chartSVG: sin datos suficientes avisa en vez de dibujar ejes vacíos", () => {
  const { html, points } = chartSVG([{ date: new Date(), tone: -2 }]);
  assert.ok(html.includes("Sin datos suficientes"));
  assert.equal(points.length, 0);
});

test("computeMetrics: la media de 7 días usa 7 días reales, no los últimos N puntos", () => {
  // 21 días de datos HORARIOS: contando puntos, "7d" solo cubriría 7 horas.
  const pts = serie(21 * 24, 3600000, (i) => (i < 14 * 24 ? -2 : -8));
  const m = computeMetrics(pts);
  assert.ok(Math.abs(m.avg7d - -8) < 1e-6, `avg7d = ${m.avg7d}`);
  assert.ok(Math.abs(m.delta7d - -6) < 0.3, `delta7d = ${m.delta7d}`); // -8 vs -2
  assert.equal(m.last, -8);
});

test("computeMetrics: sin histórico previo sigue dando un delta utilizable", () => {
  const m = computeMetrics(serie(7, DAY, (i) => -3 + i * 0.5));
  assert.ok(Number.isFinite(m.delta7d));
  assert.equal(computeMetrics([]).avg7d, null);
});
