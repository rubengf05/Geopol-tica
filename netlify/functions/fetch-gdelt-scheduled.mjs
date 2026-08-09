// netlify/functions/fetch-gdelt-scheduled.mjs
//
// Netlify Scheduled Function. Netlify la invoca sola según `config.schedule`
// (no es accesible por URL pública). Cada ejecución procesa las 2 tareas con
// el dato más antiguo (rotación), fusiona con el histórico de Netlify Blobs
// y guarda. GDELT exige ~1 petición cada 5 s (429 si no) y las funciones de
// Netlify tienen 10 s de límite: 2 tareas espaciadas 4 s caben justas.
// Con 15 tareas y una ejecución cada 5 min, el panel entero se refresca en
// ~40 min.
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
  const { results, errors } = await fetchTaskResults(ids, {
    delayMs: 4000,
    budgetMs: 5000,
    timeoutMs: 2500,
  });

  if (Object.keys(results).length === 0) {
    console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — sin éxitos, no se escribe: ${errors.join("; ")}`);
    return new Response("OK (sin cambios)");
  }

  const fresh = await readExisting(store);
  const payload = applyTaskResults(fresh, results, errors);
  await store.setJSON("geopolitical-data", payload);

  const summary = errors.length === 0 ? "sin errores" : `${errors.length} error(es): ${errors.join("; ")}`;
  console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — ${summary}`);

  return new Response("OK");
};

export const config = {
  schedule: "*/5 * * * *",
};
