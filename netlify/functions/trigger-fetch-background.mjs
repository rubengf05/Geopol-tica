// netlify/functions/trigger-fetch-background.mjs
//
// Endpoint público: POST /api/trigger-fetch-background
// Background function de Netlify (sufijo -background): responde 202
// de inmediato y sigue corriendo hasta 15 min, sin el timeout HTTP de
// una función síncrona. Dispara manualmente la carga de GDELT (sin
// esperar a que corra la función programada cada hora). Útil para
// cargar datos iniciales tras el despliegue o refrescar a demanda.

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

                        // En una background function el cuerpo de la respuesta se ignora
                          // (el cliente ya recibió un 202 al invocarla), pero lo dejamos por
                            // claridad y para los logs de Netlify.
                              return new Response(JSON.stringify({ ok: true, updatedAt: payload.updatedAt, errors: payload.lastErrors }), {
                                  headers: { "content-type": "application/json; charset=utf-8" },
                                    });
                                    };

                                    export const config = {
                                      path: "/api/trigger-fetch-background",
                                      };
