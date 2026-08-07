// netlify/functions/trigger-fetch.mjs
//
// Endpoint público: POST /api/trigger-fetch
// Dispara manualmente la carga de GDELT (sin esperar a que corra
// la función programada cada hora). Útil para cargar datos iniciales
// tras el despliegue o para refrescar a demanda desde el panel.

import { buildUpdatedPayload } from "./_lib/gdelt.mjs";
import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("gdelt");

  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null;
  }

  const payload = await buildUpdatedPayload(existing);
  await store.setJSON("geopolitical-data", payload);

  return new Response(JSON.stringify({ ok: true, updatedAt: payload.updatedAt, errors: payload.lastErrors }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};

export const config = {
  path: "/api/trigger-fetch",
};
