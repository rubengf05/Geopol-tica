diff --git a/README.md b/README.md
index 743ff16..5e14537 100644
--- a/README.md
+++ b/README.md
@@ -85,7 +85,8 @@ El histórico vive en Netlify Blobs y cada tarea solo actualiza su trozo:
   "articles":  { "IRN": [{ "title": "…", "url": "…" }] },   // titulares por país
   "iranExtended14d": [ … ],   // histórico largo de Irán (desde feb. 2026)
   "iranArticles":    [ … ],   // espejo de articles.IRN (compatibilidad)
-  "taskUpdatedAt": { "IRN": "…", "IRNNEWS": "…" },
+  "taskUpdatedAt": { "IRN": "…", "IRNNEWS": "…" },     // solo éxitos
+  "taskAttemptedAt": { "IRN": "…", "IRNNEWS": "…" },   // éxito o fallo (evita que una tarea que falla siempre bloquee la rotación)
   "lastErrors": []
 }
 ```
diff --git a/netlify/functions/_lib/gdelt.mjs b/netlify/functions/_lib/gdelt.mjs
index d8485b1..71130da 100644
--- a/netlify/functions/_lib/gdelt.mjs
+++ b/netlify/functions/_lib/gdelt.mjs
@@ -52,6 +52,11 @@ export function basePayload(existing, errors = []) {
     iranExtended14d: existing?.iranExtended14d || [],
     iranArticles: existing?.iranArticles || [],
     taskUpdatedAt: { ...(existing?.taskUpdatedAt || {}) },
+    // Sello de "se intentó" (éxito o fallo), separado de taskUpdatedAt (solo
+    // éxitos). Sin esto, una tarea que falla siempre (p.ej. timeout de GDELT)
+    // se queda para siempre como "la más vieja" y acapara las 2 plazas de
+    // cada rotación, dejando sin refrescar a las otras 25 tareas.
+    taskAttemptedAt: { ...(existing?.taskAttemptedAt || {}) },
     lastErrors: [...errors],
   };
   if (!payload.articles.IRN && payload.iranArticles.length) {
@@ -123,7 +128,10 @@ export function mergeSeries(oldSeries, newPoints, maxPoints = MAX_POINTS_KEPT) {
 const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 
 export function stalestTaskIds(existing, n) {
-  const stamps = existing?.taskUpdatedAt || {};
+  // Se ordena por taskAttemptedAt (intentado, éxito o no), NO por
+  // taskUpdatedAt (solo éxitos): así una tarea que falla siempre pasa al
+  // final de la cola tras cada intento en vez de quedarse fija en cabeza.
+  const stamps = existing?.taskAttemptedAt || {};
   return TASKS
     .map((t, i) => ({ id: t.id, i, at: stamps[t.id] || "" }))
     .sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i)
@@ -183,6 +191,11 @@ export async function fetchTaskResults(
 ) {
   const results = {};
   const errors = [];
+  // ids para los que SÍ se hizo una llamada real a GDELT (éxito o fallo).
+  // Se excluyen las "omitida" (cortadas por presupuesto) y las de tarea
+  // desconocida: esas no cuentan como intento y deben seguir siendo las más
+  // prioritarias en la próxima rotación.
+  const attempted = [];
   const started = Date.now();
   let first = true;
   for (const id of taskIds) {
@@ -198,6 +211,7 @@ export async function fetchTaskResults(
       errors.push(`${id}: tarea desconocida`);
       continue;
     }
+    attempted.push(id);
     try {
       results[id] =
         task.kind === "articles"
@@ -207,11 +221,15 @@ export async function fetchTaskResults(
       errors.push(`${id}: ${e.message}`);
     }
   }
-  return { results, errors };
+  return { results, errors, attempted };
 }
 
-export function applyTaskResults(existing, results, errors = []) {
+export function applyTaskResults(existing, results, errors = [], attempted = []) {
   const payload = basePayload(existing, errors);
+  const now = new Date().toISOString();
+  for (const id of attempted) {
+    payload.taskAttemptedAt[id] = now;
+  }
   for (const [id, data] of Object.entries(results || {})) {
     const task = TASKS.find((t) => t.id === id);
     if (!task) continue;
@@ -221,6 +239,6 @@ export function applyTaskResults(existing, results, errors = []) {
 }
 
 export async function updateTasks(existing, taskIds, opts = {}) {
-  const { results, errors } = await fetchTaskResults(taskIds, opts);
-  return applyTaskResults(existing, results, errors);
+  const { results, errors, attempted } = await fetchTaskResults(taskIds, opts);
+  return applyTaskResults(existing, results, errors, attempted);
 }
diff --git a/netlify/functions/fetch-gdelt-scheduled.mjs b/netlify/functions/fetch-gdelt-scheduled.mjs
index 855d25a..5f1dfcd 100644
--- a/netlify/functions/fetch-gdelt-scheduled.mjs
+++ b/netlify/functions/fetch-gdelt-scheduled.mjs
@@ -31,19 +31,25 @@ export default async () => {
 
   const existing = await readExisting(store);
   const ids = stalestTaskIds(existing, 2);
-  const { results, errors } = await fetchTaskResults(ids, {
+  const { results, errors, attempted } = await fetchTaskResults(ids, {
     delayMs: 4000,
     budgetMs: 5000,
     timeoutMs: 2500,
   });
 
-  if (Object.keys(results).length === 0) {
-    console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — sin éxitos, no se escribe: ${errors.join("; ")}`);
+  // Aunque ninguna tarea tenga éxito, SÍ hay que escribir el sello de
+  // "intentado": si no, una tarea que falla siempre (p.ej. por timeout de
+  // GDELT) se queda fija como "la más vieja" para siempre y acapara las 2
+  // plazas de cada rotación, bloqueando el refresco de las otras 25 tareas.
+  // Se relee el blob justo antes de escribir (anti-carrera), igual que en el
+  // camino de éxito.
+  if (attempted.length === 0) {
+    console.log(`[fetch-gdelt-scheduled] tareas ${ids.join(",")} — nada que intentar, no se escribe: ${errors.join("; ")}`);
     return new Response("OK (sin cambios)");
   }
 
   const fresh = await readExisting(store);
-  const payload = applyTaskResults(fresh, results, errors);
+  const payload = applyTaskResults(fresh, results, errors, attempted);
   await store.setJSON("geopolitical-data", payload);
 
   const summary = errors.length === 0 ? "sin errores" : `${errors.length} error(es): ${errors.join("; ")}`;
diff --git a/netlify/functions/trigger-fetch.mjs b/netlify/functions/trigger-fetch.mjs
index 75889f0..adc3a4c 100644
--- a/netlify/functions/trigger-fetch.mjs
+++ b/netlify/functions/trigger-fetch.mjs
@@ -34,7 +34,7 @@ export default async (req) => {
   // Una sola llamada GDELT por invocación: presupuesto y timeout holgados.
   // Anti-carrera: descargar primero (lo lento), leer el blob justo antes de
   // escribir, y no escribir nada si la descarga falló.
-  const { results, errors } = await fetchTaskResults([target], { budgetMs: 9000, timeoutMs: 7000 });
+  const { results, errors, attempted } = await fetchTaskResults([target], { budgetMs: 9000, timeoutMs: 7000 });
 
   if (Object.keys(results).length === 0) {
     return json({ ok: false, target, errors });
@@ -48,7 +48,7 @@ export default async (req) => {
     existing = null;
   }
 
-  const payload = applyTaskResults(existing, results, errors);
+  const payload = applyTaskResults(existing, results, errors, attempted);
   await store.setJSON("geopolitical-data", payload);
 
   return json({ ok: true, target, updatedAt: payload.updatedAt, errors });
diff --git a/test/gdelt.test.mjs b/test/gdelt.test.mjs
index c58dab7..4951793 100644
--- a/test/gdelt.test.mjs
+++ b/test/gdelt.test.mjs
@@ -12,6 +12,7 @@ import {
   mergeSeries,
   updateTasks,
   stalestTaskIds,
+  applyTaskResults,
   ingestTaskData,
   sanitizeTimelinePoints,
   sanitizeArticles,
@@ -126,9 +127,10 @@ test("updateTasks: ejecuta todas las tareas y rellena el payload completo", asyn
     }
     assert.deepEqual(payload.iranArticles, payload.articles.IRN);
     assert.equal(payload.lastErrors.length, 0);
-    // todas las tareas quedan selladas con su fecha de ejecución
+    // todas las tareas quedan selladas con su fecha de ejecución (éxito y, además, intento)
     for (const id of ALL_TASK_IDS) {
-      assert.ok(payload.taskUpdatedAt[id], `falta sello de ${id}`);
+      assert.ok(payload.taskUpdatedAt[id], `falta sello de éxito de ${id}`);
+      assert.ok(payload.taskAttemptedAt[id], `falta sello de intento de ${id}`);
     }
   } finally {
     restore();
@@ -175,7 +177,8 @@ test("updateTasks: si GDELT falla en una tarea, no rompe las demás", async () =
     assert.ok(payload.lastErrors.some((e) => e.startsWith("SYR:")));
     assert.equal(payload.countries.SYR, undefined); // no se guarda nada roto
     assert.equal(payload.countries.IRN.length, 7); // el resto sigue funcionando
-    assert.equal(payload.taskUpdatedAt.SYR, undefined); // sigue "stale": se reintentará
+    assert.equal(payload.taskUpdatedAt.SYR, undefined); // sin dato nuevo: sigue "stale" para los datos
+    assert.ok(payload.taskAttemptedAt.SYR); // pero SÍ se marca como intentada
   } finally {
     restore();
   }
@@ -203,6 +206,11 @@ test("updateTasks: el presupuesto de tiempo corta antes de empezar tareas nuevas
     assert.equal(payload.countries.USA, undefined);
     assert.equal(payload.lastErrors.length, 2); // las omitidas quedan anotadas
     assert.ok(payload.lastErrors.every((e) => e.includes("omitida")));
+    // Las omitidas por presupuesto NO cuentan como "intentadas": deben seguir
+    // siendo las más prioritarias en la próxima rotación.
+    assert.ok(payload.taskAttemptedAt.ISR);
+    assert.equal(payload.taskAttemptedAt.IRN, undefined);
+    assert.equal(payload.taskAttemptedAt.USA, undefined);
   } finally {
     restore();
   }
@@ -285,15 +293,52 @@ test("ingestTaskData: rechaza tarea desconocida y datos sin nada válido", () =>
   assert.throws(() => ingestTaskData(null, "IRNNEWS", { articles: [{ title: "x", url: "ftp://mal" }] }), /sin artículos/);
 });
 
-test("stalestTaskIds: primero las nunca ejecutadas, luego las más antiguas", () => {
+test("stalestTaskIds: primero las nunca intentadas, luego las más antiguas", () => {
   // Sin histórico: respeta el orden de TASKS
   assert.deepEqual(stalestTaskIds(null, 2), [TASKS[0].id, TASKS[1].id]);
 
-  // Con sellos: las que faltan van primero, luego la de sello más viejo
-  const taskUpdatedAt = {};
-  for (const t of TASKS) taskUpdatedAt[t.id] = "2026-08-09T10:00:00.000Z";
-  delete taskUpdatedAt.QAT; // nunca ejecutada
-  taskUpdatedAt.OMN = "2026-08-09T08:00:00.000Z"; // la más vieja
-  const ids = stalestTaskIds({ taskUpdatedAt }, 2);
+  // Con sellos: las que faltan van primero, luego la de sello más viejo.
+  // OJO: se ordena por taskAttemptedAt (intentado), no por taskUpdatedAt
+  // (solo éxitos) — es justo lo que evita la inanición de abajo.
+  const taskAttemptedAt = {};
+  for (const t of TASKS) taskAttemptedAt[t.id] = "2026-08-09T10:00:00.000Z";
+  delete taskAttemptedAt.QAT; // nunca intentada
+  taskAttemptedAt.OMN = "2026-08-09T08:00:00.000Z"; // la más vieja
+  const ids = stalestTaskIds({ taskAttemptedAt }, 2);
   assert.deepEqual(ids, ["QAT", "OMN"]);
 });
+
+test("stalestTaskIds/applyTaskResults: una tarea que falla SIEMPRE no bloquea la rotación", () => {
+  // Reproduce el bug real visto en producción: ISRNEWS y LBNNEWS no tenían
+  // éxito nunca (timeout), y como la rotación se basaba solo en éxitos
+  // (taskUpdatedAt), esas 2 tareas se quedaban fijas como "las más viejas"
+  // para siempre y acaparaban las 2 plazas de cada ejecución — el resto del
+  // panel (incluido Irán) dejaba de refrescarse por completo.
+  const FAILING = new Set(["ISRNEWS", "LBNNEWS"]);
+  let payload = null;
+
+  for (let round = 0; round < 4; round++) {
+    const ids = stalestTaskIds(payload, 2);
+    const results = {};
+    const errors = [];
+    const attempted = [];
+    for (const id of ids) {
+      attempted.push(id);
+      if (FAILING.has(id)) {
+        errors.push(`${id}: timeout`);
+      } else {
+        results[id] = [{ date: "2026-08-20T00:00:00.000Z", tone: -1 }];
+      }
+    }
+    payload = applyTaskResults(payload, results, errors, attempted);
+  }
+
+  // Tras 4 rondas (8 plazas) la rotación tuvo que avanzar más allá de las 2
+  // tareas que siempre fallan: no puede haber repetido SOLO esas 2.
+  const seen = new Set(Object.keys(payload.taskAttemptedAt));
+  assert.ok(seen.size > 2, `la rotación se quedó atascada: ${[...seen]}`);
+  // Y las que sí tuvieron éxito deben tener datos guardados.
+  for (const id of seen) {
+    if (!FAILING.has(id)) assert.ok(payload.countries[id] || payload.iranExtended14d.length || payload.articles[id]);
+  }
+});
