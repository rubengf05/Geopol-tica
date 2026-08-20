# Panel Geopolítico GDELT — Netlify Scheduled Functions + Netlify Blobs

Panel de tono mediático (GDELT) de 13 focos: Oriente Medio y actores clave.
Arquitectura: **todo dentro de Netlify**, sin servidor propio ni GitHub Actions.

```
┌──────────────────────────┐  cada 3 min  ┌────────────────┐
│ fetch-gdelt-scheduled     │ ───────────▶ │  Netlify Blobs │
│ (2 tareas por ejecución,  │   escribe    │  (key: gdelt)  │
│  rotando por las 27)      │              └───────┬────────┘
└──────────────────────────┘                       │ lee
                                                   ▼
┌──────────────────────────┐   fetch()   ┌────────────────────┐
│ public/index.html         │ ─────────▶ │ get-geopolitical-   │
│ public/pais.html          │            │ data (Function)     │
│ (en el navegador)         │            └────────────────────┘
└──────────────────────────┘
```

## Las dos vistas

- **`public/index.html`** — la rejilla. Solo cifras por país (hoy, media de 7
  días, delta semanal): **sin gráficos**, para que se lea de un vistazo.
  Cada tarjeta es un enlace que abre la ficha del país **en una pestaña nueva**.
- **`public/pais.html?code=IRN`** — la ficha de un país, a página completa:
  gráfico grande de AvgTone arriba (con selector 7 días / 30 días / todo el
  histórico y tooltip al pasar el ratón) y **las noticias de ese país debajo**.
  Incluye "⚡ Actualizar este país", que pide a GDELT solo las consultas de ese
  país desde el navegador.
- **`public/app.js`** — código compartido por las dos: formato, métricas, el
  gráfico SVG y la ingesta manual desde GDELT.

### Los ejes del gráfico

El gráfico usa una escala *nice* (marcas en múltiplos de 1/2/2,5/5·10ⁿ) en vez
de repartir el rango de los datos en cuatro trozos. Esto es lo que evita que
los ejes cambien en cada refresco: mientras los datos no crucen una marca, los
topes y las etiquetas siguen siendo los mismos. Además el eje Y siempre incluye
el 0 (la referencia de lectura del tono), las marcas del eje X caen en
intervalos de calendario (horas, días, semanas, meses) sin repetirse, las
etiquetas de los extremos se anclan para no salirse del lienzo, y el SVG escala
con `viewBox` + `width:100%` sin alto fijo (antes quedaba encajado en una caja
de otra proporción). `test/chart.test.mjs` fija estas propiedades.

## Por qué "tareas" en vez de una sola carga

GDELT limita el tráfico a **~1 petición cada 5 segundos por IP** (devuelve
429 si no se respeta) y además **rechaza frases entrecomilladas de una sola
palabra** (`"Iran"` → «The specified phrase is too short»; hay que pedir
`Iran` sin comillas). Las funciones de Netlify tienen un límite de **10 s**
por ejecución, así que es imposible hacer las 27 consultas de golpe.

Solución: cada consulta GDELT es una **tarea** (13 series de países + el
histórico largo de Irán + 13 bloques de titulares, uno por país = 27 tareas).
El histórico vive en Netlify Blobs y cada tarea solo actualiza su trozo:

- **`fetch-gdelt-scheduled.mjs`** — cada 3 min ejecuta las 2 tareas más
  antiguas (rotación por sello `taskUpdatedAt`). El panel completo se
  refresca en ~40 min de forma continua. Al añadir los titulares por país se
  subió la **frecuencia** de la rotación (de `*/5` a `*/3`) en vez del número
  de consultas por ejecución: es lo que mantiene el ciclo en ~40 min sin
  acercarse al rate limit de GDELT.
- **`trigger-fetch.mjs`** — `GET /api/trigger-fetch` devuelve los
  descriptores de las tareas; `POST /api/trigger-fetch?target=<id>` ejecuta
  una en el servidor (solo viable cuando GDELT responde rápido).
- **`ingest-gdelt.mjs`** — `POST /api/ingest?target=<id>`. GDELT a veces
  tarda **más de 10 s** en responder (por encima del límite de las funciones
  síncronas de Netlify), así que el botón "⚡ Cargar GDELT ahora" descarga
  las consultas **desde el navegador** (sin ese límite, con ~7 s de pausa
  entre ellas) y las envía aquí; la función valida todo (fechas, rangos de
  tono, URLs, tamaños) antes de fusionar y guardar.
- **`get-geopolitical-data.mjs`** — `GET /api/geopolitical-data`: lee el
  blob y lo devuelve. Es lo único que llama el navegador para pintar.
- **`_lib/gdelt.mjs`** — lógica compartida y testeable (tareas, merge del
  histórico, parseo GDELT). El prefijo `_` evita que Netlify la trate como
  función.

### Forma del blob

```jsonc
{
  "updatedAt": "…",
  "meta": [{ "code": "IRN", "name": "Irán", "flag": "🇮🇷", "region": "…", "query": "Iran" }],
  "countries": { "IRN": [{ "date": "…", "tone": -6.1 }] },  // serie por país
  "articles":  { "IRN": [{ "title": "…", "url": "…" }] },   // titulares por país
  "iranExtended14d": [ … ],   // histórico largo de Irán (desde feb. 2026)
  "iranArticles":    [ … ],   // espejo de articles.IRN (compatibilidad)
  "taskUpdatedAt": { "IRN": "…", "IRNNEWS": "…" },
  "lastErrors": []
}
```

Los blobs anteriores (que solo tenían `iranArticles`) se migran solos: al
primer guardado, `basePayload` copia esos titulares a `articles.IRN`.

## Desplegar

1. Sube este proyecto a un repo de GitHub.
2. En Netlify: **Add new site → Import an existing project → GitHub** y
   selecciona el repo. Netlify detecta `netlify.toml` solo.
3. Despliega. Netlify Blobs no necesita configuración ni claves.
4. Abre el panel y pulsa **⚡ Cargar GDELT ahora** para la carga inicial
   (~3 min: son 27 consultas espaciadas ~7 s). Si no, la función programada
   lo rellena sola en ~40 min.

## Desarrollo local

```bash
npm install
npm run dev        # netlify dev — emula Functions y Blobs en local
```

## Tests

```bash
npm test
```

`test/gdelt.test.mjs` verifica (con `fetch` simulado, sin red real): parseo de
fechas GDELT, validez de las queries (nada de frases entrecomilladas de una
palabra), fusión de histórico sin pérdidas, titulares guardados por país,
migración de blobs antiguos, aislamiento de errores por tarea, corte por
presupuesto de tiempo y orden de rotación por antigüedad.

`test/chart.test.mjs` verifica los ejes: marcas redondas, marcas estables
cuando el dato cambia un poco, marcas temporales alineadas y sin repetir,
etiquetas que no se salen del lienzo y la media de 7 días calculada sobre 7
días reales (no sobre los últimos N puntos, que con resolución horaria eran
7 horas).

## Ajustes rápidos

- **Frecuencia de la rotación**: `schedule` en `fetch-gdelt-scheduled.mjs`
  (`*/3 * * * *`) y nº de tareas por ejecución (`stalestTaskIds(existing, 2)`).
  Ojo al subir el segundo número: GDELT devuelve 429 si las peticiones van a
  menos de ~5 s y la función se corta a los 10 s.
- **Titulares por país**: `ARTICLES_PER_COUNTRY` en `_lib/gdelt.mjs` (6). No
  afecta al rate limit — una consulta `artlist` devuelve N artículos con una
  sola llamada; lo que consume cuota es tener una tarea por país.
- **Cuánto histórico se conserva por serie**: `MAX_POINTS_KEPT` en
  `_lib/gdelt.mjs` (por defecto 1000 puntos; GDELT devuelve resolución
  horaria, así que son ~41 días).
- **Países/consultas**: array `COUNTRIES` en `_lib/gdelt.mjs`. Ojo: palabras
  sueltas sin comillas; comillas solo para frases de varias palabras.
- **Frecuencia de refresco del panel** (solo relee la caché): `REFRESH_MS`
  en `public/app.js`.
