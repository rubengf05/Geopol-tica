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
import { TASKS, updateTasks } from "./_lib/gdelt.mjs";

export default async (req) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const target = new URL(req.url).searchParams.get("target");

  if (!target) {
    return json({ tasks: TASKS.map((t) => t.id) });
  }
  if (!TASKS.some((t) => t.id === target)) {
    return json({ ok: false, error: `Tarea desconocida: ${target}` }, 400);
  }

  const store = getStore("gdelt");

  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null;
  }

  // Una sola llamada GDELT por invocación: presupuesto y timeout holgados.
  const payload = await updateTasks(existing, [target], { budgetMs: 9000, timeoutMs: 7000 });
  await store.setJSON("geopolitical-data", payload);

  return json({
    ok: payload.lastErrors.length === 0,
    target,
    updatedAt: payload.updatedAt,
    errors: payload.lastErrors,
  });
};

export const config = {
  path: "/api/trigger-fetch",
};
