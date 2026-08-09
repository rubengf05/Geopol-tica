// netlify/functions/ingest-gdelt.mjs
//
// Endpoint público: POST /api/ingest?target=<id-tarea>
// Body JSON: { points: [...] } (timeline) o { articles: [...] } (titulares),
// con los datos CRUDOS tal como los devuelve GDELT.
//
// Existe porque GDELT a veces tarda >10 s en responder — más que el límite
// de una función síncrona de Netlify — así que la carga manual la hace el
// navegador (que no tiene ese límite) y aquí solo se valida y se guarda.
// Toda la sanitización está en _lib/gdelt.mjs (ingestTaskData): fechas
// parseables, tonos acotados, URLs http(s), tamaños limitados.

import { getStore } from "@netlify/blobs";
import { ingestTaskData } from "./_lib/gdelt.mjs";

export default async (req) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  if (req.method !== "POST") {
    return json({ ok: false, error: "Usa POST" }, 405);
  }
  const target = new URL(req.url).searchParams.get("target");

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body JSON inválido" }, 400);
  }

  const store = getStore("gdelt");
  let existing = null;
  try {
    existing = await store.get("geopolitical-data", { type: "json" });
  } catch {
    existing = null;
  }

  let payload;
  try {
    payload = ingestTaskData(existing, target, body);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }

  await store.setJSON("geopolitical-data", payload);
  return json({ ok: true, target, updatedAt: payload.updatedAt });
};

export const config = {
  path: "/api/ingest",
};
