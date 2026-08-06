// netlify/functions/fetch-gdelt-scheduled.mjs
//
// Netlify Scheduled Function. Netlify la invoca sola según `config.schedule`
// (no es accesible por URL pública). Lee el histórico guardado en Netlify
// Blobs, pide a GDELT los datos frescos, los fusiona y vuelve a guardar.

import { getStore } from "@netlify/blobs";
import { buildUpdatedPayload } from "./_lib/gdelt.mjs";

export default async () => {
  const store = getStore("gdelt");

  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null; // primera ejecución: aún no hay nada guardado
  }

  const payload = await buildUpdatedPayload(existing);
  await store.setJSON("geopolitical-data", payload);

  const summary =
    payload.lastErrors.length === 0
      ? "sin errores"
      : `${payload.lastErrors.length} error(es): ${payload.lastErrors.join("; ")}`;
  console.log(`[fetch-gdelt-scheduled] actualizado ${payload.updatedAt} — ${summary}`);

  return new Response("OK");
};

export const config = {
  schedule: "@hourly",
};
