// netlify/functions/trigger-fetch.mjs
//
// Endpoint público: /api/trigger-fetch
//   GET  sin parámetros       -> { tasks: [...] } lista de tareas disponibles
//   POST ?target=<id-tarea>   -> ejecuta SOLO esa tarea (una llamada GDELT),
//                                fusiona con el histórico y guarda.
//
// El panel usa esto para la carga manual: recorre las tareas de una en una
// con una pausa entre llamadas. Así cada invocación queda muy por debajo del
// límite de 10 s de Netlify y GDELT no recibe ráfagas (devuelve 429 si se le
// pide todo de golpe).

import { getStore } from "@netlify/blobs";
import { TASKS, fetchTaskResults, applyTaskResults } from "./_lib/gdelt.mjs";

export default async (req) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const target = new URL(req.url).searchParams.get("target");

  if (!target) {
    // Descriptores completos: el panel los usa para construir las URLs de
    // GDELT y descargar los datos desde el navegador (ver /api/ingest).
    return json({ tasks: TASKS });
  }
  if (!TASKS.some((t) => t.id === target)) {
    return json({ ok: false, error: `Tarea desconocida: ${target}` }, 400);
  }

  // Una sola llamada GDELT por invocación: presupuesto y timeout holgados.
  // Anti-carrera: descargar primero (lo lento), leer el blob justo antes de
  // escribir, y no escribir nada si la descarga falló.
  const { results, errors, attempted } = await fetchTaskResults([target], { budgetMs: 9000, timeoutMs: 7000 });

  if (Object.keys(results).length === 0) {
    return json({ ok: false, target, errors });
  }

  const store = getStore("gdelt");
  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null;
  }

  const payload = applyTaskResults(existing, results, errors, attempted);
  await store.setJSON("geopolitical-data", payload);

  return json({ ok: true, target, updatedAt: payload.updatedAt, errors });
};

export const config = {
  path: "/api/trigger-fetch",
};
