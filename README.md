# Panel Geopolítico GDELT — Netlify Scheduled Functions + Netlify Blobs

Arquitectura: **todo dentro de Netlify**, sin servidor propio ni GitHub Actions.

```
┌─────────────────────────┐   1×/hora   ┌───────────────┐
│ fetch-gdelt-scheduled    │ ─────────▶ │  Netlify Blobs │
│ (Scheduled Function)     │  escribe   │  (key: gdelt)  │
└─────────────────────────┘             └───────┬────────┘
                                                  │ lee
                                                  ▼
┌─────────────────────────┐   fetch()   ┌───────────────────┐
│ public/index.html        │ ─────────▶ │ get-geopolitical-  │
│ (el panel, en el navegador)│           │ data (Function)    │
└─────────────────────────┘             └───────────────────┘
```

- **`netlify/functions/fetch-gdelt-scheduled.mjs`** — Netlify la invoca sola cada hora (`config.schedule = "@hourly"`). Hace las 3 llamadas a GDELT, fusiona el resultado con el histórico ya guardado y lo escribe en Netlify Blobs. No es accesible por URL pública.
- **`netlify/functions/get-geopolitical-data.mjs`** — endpoint `GET /api/geopolitical-data`. Lee el blob y lo devuelve. Es lo único que llama el navegador.
- **`netlify/functions/_lib/gdelt.mjs`** — lógica compartida (parseo de fechas GDELT, fusión de series históricas, orquestación). El prefijo `_` hace que Netlify no la trate como una función propia.
- **`public/index.html`** — el panel. Ya no llama a `api.gdeltproject.org`; solo llama a `/api/geopolitical-data`.

Con esto, da igual cuánta gente tenga el panel abierto: GDELT solo recibe tráfico de la función programada, una vez por hora.

## Desplegar

1. Sube este proyecto a un repo de GitHub.
2. En Netlify: **Add new site → Import an existing project → GitHub** y selecciona el repo. Netlify detecta `netlify.toml` solo (build settings ya configurados: `publish = "public"`, `functions = "netlify/functions"`).
3. Despliega. Netlify Blobs no necesita configuración ni claves: está disponible automáticamente para cualquier sitio desplegado en Netlify.
4. La función programada empezará a correr sola cada hora desde el primer despliegue. Hasta que corra la primera vez, `/api/geopolitical-data` devolverá `{"error": "Aún no hay datos..."}` y el panel lo mostrará como estado de error — es esperable, se resuelve solo en ≤1h.

### Disparar la primera carga sin esperar 1 hora

Con el sitio ya desplegado y **Netlify CLI** instalado y logueado (`npm i -g netlify-cli && netlify login && netlify link`):

```bash
netlify functions:invoke fetch-gdelt-scheduled
```

## Desarrollo local

```bash
npm install
npm run dev        # netlify dev — emula Functions y Blobs en local
```

`netlify dev` sirve `public/index.html` y las funciones juntas en `http://localhost:8888`, con Blobs emulados en disco (no toca tu sitio real en Netlify). Para forzar una ejecución manual de la función programada en local:

```bash
netlify functions:invoke fetch-gdelt-scheduled
```

## Tests

```bash
npm test
```

Verifica (con `fetch` simulado, sin red real): parseo de fechas GDELT, fusión de histórico (`mergeSeries` no pierde datos antiguos al desplazarse la ventana de 7/14 días y sí actualiza los que coinciden), y que un fallo en un país no rompe el resto de la carga.

> No se ha podido probar contra la GDELT real ni contra Netlify Blobs real desde este entorno de trabajo (sin salida de red hacia `api.gdeltproject.org` ni sesión de Netlify). Sí se confirmó que `@netlify/blobs` v8.2 expone `getStore().get()` / `.setJSON()` tal como se usan aquí. Verifica el resto con `netlify dev` como se indica arriba.

## Ajustes rápidos

- **Frecuencia de refresco de GDELT**: cambia `schedule` en `fetch-gdelt-scheduled.mjs` (sintaxis cron o `@hourly`/`@daily`).
- **Cuánto histórico se conserva por país**: `MAX_DAYS_KEPT` en `_lib/gdelt.mjs` (por defecto 180 días).
- **Frecuencia de refresco del panel** (solo relee la caché, es barato): `REFRESH_MS` en `public/index.html`.
- **Caducidad de la caché HTTP** del endpoint: `cache-control` en `get-geopolitical-data.mjs` (por defecto 5 min).
