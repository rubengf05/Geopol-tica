// netlify/functions/fetch-gdelt-scheduled.mjs
//
// Netlify Scheduled Function. Netlify la invoca sola según `config.schedule`
// (no es accesible por URL pública). Cada ejecución procesa las 2 tareas con
// el dato más antiguo (rotación), fusiona con el histórico de Netlify Blobs
// y guarda. GDELT exige ~1 petición cada 5 s (429 si no) y las funciones de
// Netlify tienen 10 s de límite: 2 tareas espaciadas 4 s caben justas.
// Con 27 tareas (13 series + histórico de Irán + 13 bloques de titulares) y
// una ejecución cada 3 min, el panel entero se refresca en ~40 min, igual que
// antes: se sube la frecuencia de la rotación en vez de meter más llamadas
// por ejecución, que es lo que haría saltar el rate limit de GDELT.
//
// ORDEN ANTI-CARRERA: primero se descarga de GDELT (lo lento), después se
// RELEE el blob y solo entonces se aplica y escribe. Y si ninguna tarea tuvo
// éxito, no se escribe nada: una escritura sin datos nuevos solo serviría
// para pisar ingestas concurrentes de /api/ingest.

import { getStore } from "@netlify/blobs";
import { fetchTaskResults, applyTaskResults, stalestTaskIds } from "./_lib/gdelt.mjs";

const readExisting = async (store) => {
  try {
    return await store.get("geopolitical-data", { type: "json" });
  } catch {
    return null; // primera ejecución: aún no hay nada guardado
  }
};

export default async () => {
  const store = getStore("gdelt");

  const existing = await readExisting(store);
  const ids = stalestTaskIds(existing, 2);
  const { results, errors, attempted } = await fetchTaskResults(ids, {
    delayMs: 4000,
    budgetMs: 5000,
    timeoutMs: 2500,
  });

  // Aunque ninguna tarea tenga éxito, SÍ hay que escribir el sello de
  // "intentado": si no, una tarea que falla siempre (p.ej. por timeout de
  // GDELT) se queda fija como "la más vieja" para siempre y acapara las 2
  // plazas de cada rotación, bloqueando el refresco de las otras 25 tareas.
  // Se relee el blob justo antes de escribir (anti-carrera), igual que en el
  // camino de éxito.
  if (attempted.length === 0) {
    console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — nada que intentar, no se escribe: ${errors.join("; ")}`);
    return new Response("OK (sin cambios)");
  }

  const fresh = await readExisting(store);
  const payload = applyTaskResults(fresh, results, errors, attempted);
  await store.setJSON("geopolitical-data", payload);

  const summary = errors.length === 0 ? "sin errores" : `${errors.length} error(es): ${errors.join("; ")}`;
  console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — ${summary}`);

  return new Response("OK");
};

export const config = {
  schedule: "*/3 * * * *",
};
