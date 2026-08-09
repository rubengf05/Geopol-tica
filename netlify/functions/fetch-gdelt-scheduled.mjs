// netlify/functions/fetch-gdelt-scheduled.mjs
//
// Netlify Scheduled Function. Netlify la invoca sola según `config.schedule`
// (no es accesible por URL pública). Cada ejecución procesa las 2 tareas con
// el dato más antiguo (rotación), fusiona con el histórico de Netlify Blobs
// y guarda. GDELT exige ~1 petición cada 5 s (429 si no) y las funciones de
// Netlify tienen 10 s de límite: 2 tareas espaciadas 4,5 s caben justas.
// Con 15 tareas y una ejecución cada 5 min, el panel entero se refresca en
// ~40 min.

import { getStore } from "@netlify/blobs";
import { updateTasks, stalestTaskIds } from "./_lib/gdelt.mjs";

export default async () => {
  const store = getStore("gdelt");

  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null; // primera ejecución: aún no hay nada guardado
  }

  const ids = stalestTaskIds(existing, 2);
  const payload = await updateTasks(existing, ids, { delayMs: 4500, budgetMs: 5000, timeoutMs: 2500 });
  await store.setJSON("geopolitical-data", payload);

  const summary =
    payload.lastErrors.length === 0
      ? "sin errores"
      : `${payload.lastErrors.length} error(es): ${payload.lastErrors.join("; ")}`;
  console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — ${summary}`);

  return new Response("OK");
};

export const config = {
  schedule: "*/5 * * * *",
};
