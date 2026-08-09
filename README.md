# Panel Geopolítico GDELT — Netlify Scheduled Functions + Netlify Blobs

Panel de tono mediático (GDELT) de 13 focos: Oriente Medio y actores clave.
Arquitectura: **todo dentro de Netlify**, sin servidor propio ni GitHub Actions.

```
┌─────────────────────────┐  cada 5 min  ┌───────────────┐
│ fetch-gdelt-scheduled    │ ───────────▶ │  Netlify Blobs │
│ (2 tareas por ejecución, │   escribe    │  (key: gdelt)  │
│  rotando por las 15)     │              └───────┬────────┘
└─────────────────────────┘                       │ lee
                                                  ▼
┌─────────────────────────┐   fetch()   ┌───────────────────┐
│ public/index.html        │ ─────────▶ │ get-geopolitical-  │
│ (el panel, en el navegador)│           │ data (Function)    │
└─────────────────────────┘             └───────────────────┘
```

## Por qué "tareas" en vez de una sola carga

GDELT limita el tráfico a **~1 petición cada 5 segundos por IP** (devuelve
429 si no se respeta) y además **rechaza frases entrecomilladas de una sola
palabra** (`"Iran"` → «The specified phrase is too short»; hay que pedir
`Iran` sin comillas). Las funciones de Netlify tienen un límite de **10 s**
por ejecución, así que es imposible hacer las 15 consultas de golpe.

Solución: cada consulta GDELT es una **tarea** (13 países + timeline 14d de
Irán + titulares de Irán = 15 tareas). El histórico vive en Netlify Blobs y
cada tarea solo actualiza su trozo:

- **`fetch-gdelt-scheduled.mjs`** — cada 5 min ejecuta las 2 tareas más
  antiguas (rotación por sello `taskUpdatedAt`). El panel completo se
  refresca en ~40 min de forma continua.
- **`trigger-fetch.mjs`** — `GET /api/trigger-fetch` lista las tareas;
  `POST /api/trigger-fetch?target=<id>` ejecuta una. El botón
  "⚡ Cargar GDELT ahora" del panel las recorre una a una con ~4 s de pausa
  (~1-2 min en total) e informa del progreso.
- **`get-geopolitical-data.mjs`** — `GET /api/geopolitical-data`: lee el
  blob y lo devuelve. Es lo único que llama el navegador para pintar.
- **`_lib/gdelt.mjs`** — lógica compartida y testeable (tareas, merge del
  histórico, parseo GDELT). El prefijo `_` evita que Netlify la trate como
  función.

## Desplegar

1. Sube este proyecto a un repo de GitHub.
2. En Netlify: **Add new site → Import an existing project → GitHub** y
   selecciona el repo. Netlify detecta `netlify.toml` solo.
3. Despliega. Netlify Blobs no necesita configuración ni claves.
4. Abre el panel y pulsa **⚡ Cargar GDELT ahora** para la carga inicial
   (~1-2 min). Si no, la función programada lo rellena sola en ~40 min.

## Desarrollo local

```bash
npm install
npm run dev        # netlify dev — emula Functions y Blobs en local
```

## Tests

```bash
npm test
```

Verifica (con `fetch` simulado, sin red real): parseo de fechas GDELT,
validez de las queries (nada de frases entrecomilladas de una palabra),
fusión de histórico sin pérdidas, aislamiento de errores por tarea, corte
por presupuesto de tiempo y orden de rotación por antigüedad.

## Ajustes rápidos

- **Frecuencia de la rotación**: `schedule` en `fetch-gdelt-scheduled.mjs`
  (`*/5 * * * *`) y nº de tareas por ejecución (`stalestTaskIds(existing, 2)`).
- **Cuánto histórico se conserva por país**: `MAX_DAYS_KEPT` en
  `_lib/gdelt.mjs` (por defecto 180 días).
- **Países/consultas**: array `COUNTRIES` en `_lib/gdelt.mjs`. Ojo: palabras
  sueltas sin comillas; comillas solo para frases de varias palabras.
- **Frecuencia de refresco del panel** (solo relee la caché): `REFRESH_MS`
  en `public/index.html`.
